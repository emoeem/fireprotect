/**
 * Per-update runtime: everything a handler needs, assembled once.
 *
 * Two caches are in-memory on purpose. Config is read from KV once a minute per
 * isolate, and the flood window never touches KV at all: Cloudflare's free tier
 * allows 1,000 KV writes per day, and one write per message would exhaust it
 * before lunch while also adding latency to every message. The trade is that
 * both are per-isolate, which is fine for flood shaping (approximate by nature)
 * and acceptable for config (60 s of staleness after an admin changes a rule).
 */
import { LRUCache } from "lru-cache";
import { type ChatConfig, DEFAULT_CONFIG, applyPatch, normalizeLegacy, patchError } from "./rules.ts";
import { memoryStore } from "./store.ts";
import { Telegram } from "./telegram.ts";
import { Screener } from "./external/screen.ts";
import { Vision } from "./ai/vision.ts";
import type { ParseDownloader } from "./parse/service.ts";
import { Previewer } from "./parse/preview.ts";
import { healthMark } from "./db/repo.ts";
import { migrate } from "./db/migrate.ts";
import { bannedUsers } from "./db/schema.ts";
import { eq } from "drizzle-orm";
import type { Db } from "./db/repo.ts";
import type { SqliteHandle } from "./db/connect.ts";
import type { Env, Store, TgChatPermissions, TgUser } from "./types.ts";
import type { OcrEngine } from "./ocr.ts";
import type { FeedParser } from "./rss.ts";
import type { PdfRenderer } from "./pdf-render.ts";

const CONFIG_TTL_MS = 60_000;
const ADMIN_TTL_MS = 10 * 60_000;
const MEMBER_RIGHT_TTL_MS = 5 * 60_000;

export type Right =
  | "can_delete_messages"
  | "can_restrict_members"
  | "can_pin_messages"
  | "can_change_info"
  | "can_invite_users"
  | "can_promote_members";

export type Runtime = {
  env: Env;
  api: Telegram;
  store: Store;
  /** Durable records (drizzle). */
  db: Db;
  sql: SqliteHandle;
  admin: AdminResolver;
  screener: Screener;
  /** Optional image moderation; `configured()` decides whether it is worth a call. */
  vision: Vision;
  /** Link previews for `/parse`; the Worker's only media path. */
  previewer: Previewer;
  now: () => number;
  /** Minutes east of UTC used by night mode. */
  tzOffset: number;
  configFor: (chatId: number) => Promise<ChatConfig>;
  saveConfig: (chatId: number, patch: Record<string, unknown>) => Promise<{ config: ChatConfig; error: string }>;
  invalidate: (chatId: number) => void;
  /** Serialises handlers for one chat so two events cannot punish twice. */
  withChatLock: <T>(chatId: number, fn: () => Promise<T>) => Promise<T>;
  /** Chats whose first-activation preset has been handled in this isolate. */
  initialized: Set<number>;
  /**
   * Image slicing, injected by the Node entry only. `sharp` is native, so the
   * Worker must never import it; the console and `/slice` both check for this.
   */
  /**
   * Image slicing, injected only by the Node entry.
   *
   * The shape is declared here rather than imported from `tools/slice.node.ts`
   * so the Worker dependency graph never reaches a `sharp` module.
   */
  sliceImage?: (
    bytes: Uint8Array,
    height?: number,
  ) => Promise<{
    slices: { index: number; data: Uint8Array; width: number; height: number }[];
    total: number;
    truncated: boolean;
  }>;
  /**
   * Image → text. Injected only by the Node entry (tesseract is a subprocess);
   * `src/ocr.ts` declares this shape so the Worker graph never names the adapter.
   */
  ocr?: OcrEngine;
  /**
   * Feed → items. Injected only by the Node entry (`rss-parser` assumes Node
   * globals). Present iff the deployment can poll RSS at all.
   */
  rssParse?: FeedParser;
  /**
   * Media fetch for `/parse`, injected only by the Node entry.
   *
   * Absent in the Worker, which is what makes `/parse` degrade to an OpenGraph
   * preview instead of failing: the capability decides the behaviour.
   */
  parseDownloader?: ParseDownloader;
  /**
   * PDF → per-page PNGs, injected by both entries with different engines: the
   * Node runner shells out to poppler, the Worker renders with a WASM PDFium
   * build served from Assets. Absent means "this deployment cannot render".
   */
  pdfRender?: PdfRenderer;
};

export type RuntimeDeps = {
  sliceImage?: Runtime["sliceImage"];
  ocr?: Runtime["ocr"];
  pdfRender?: Runtime["pdfRender"];
  rssParse?: Runtime["rssParse"];
  parseDownloader?: ParseDownloader;
  store?: Store;
  api?: Telegram;
  sqlite?: SqliteHandle;
  now?: () => number;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
};

/** Memoised per isolate so the Worker does not re-check the schema every update. */
const migrated = new WeakMap<SqliteHandle, Promise<void>>();

export function createRuntime(env: Env, deps: RuntimeDeps & { sqlite: SqliteHandle }): Runtime {
  const now = deps.now ?? (() => Date.now());
  const api = deps.api ?? new Telegram(env.BOT_TOKEN ?? "");
  const store = deps.store ?? memoryStore();
  const sql = deps.sqlite;
  const db = sql.db;

  const timezone = Number(env.TZ_OFFSET ?? 480);
  const tzOffset = Number.isFinite(timezone) ? timezone : 480;

  const configs = new LRUCache<number, ChatConfig>({ max: 5_000, ttl: CONFIG_TTL_MS });
  const admin = new AdminResolver(env, api, now);

  const screener = new Screener({
    fetchImpl: deps.fetchImpl,
    local: async (userId) => {
      const rows = (await db
        .select({ reason: bannedUsers.reason, source: bannedUsers.source })
        .from(bannedUsers)
        .where(eq(bannedUsers.userId, userId))
        .limit(1)) as { reason: string; source: string }[];
      const hit = rows[0];
      return hit ? { reason: hit.reason, source: hit.source } : null;
    },
    casKey: env.CAS_KEY,
    federationUrl: env.FEDERATION_URL,
    federationToken: env.FEDERATION_TOKEN,
    onHealth: (name, ok, error) => healthMark(db, name, ok, error, now()),
  });

  const vision = new Vision({
    key: env.VISION_KEY,
    url: env.VISION_URL,
    fetchImpl: deps.fetchImpl,
    onHealth: (name, ok, error) => healthMark(db, name, ok, error, now()),
  });

  const previewer = new Previewer({ fetchImpl: deps.fetchImpl });

  const locks = new Map<number, Promise<unknown>>();
  const initialized = new Set<number>();

  const runtime: Runtime = {
    env,
    api,
    store,
    db,
    sql,
    admin,
    screener,
    vision,
    previewer,
    now,
    tzOffset,
    initialized,
    sliceImage: deps.sliceImage,
    ocr: deps.ocr,
    pdfRender: deps.pdfRender,
    rssParse: deps.rssParse,
    parseDownloader: deps.parseDownloader,

    async configFor(chatId) {
      const cached = configs.get(chatId);
      if (cached) return cached;
      const raw = await store.get(`rules:${chatId}`);
      let config = DEFAULT_CONFIG;
      if (raw) {
        try {
          config = applyPatch(DEFAULT_CONFIG, normalizeLegacy(JSON.parse(raw)));
        } catch {
          // A corrupt row must not lock the group out of moderation.
          config = DEFAULT_CONFIG;
        }
      }
      if (!config.logChatId && env.LOG_CHAT_ID) config = { ...config, logChatId: env.LOG_CHAT_ID };
      configs.set(chatId, config);
      return config;
    },

    async saveConfig(chatId, patch) {
      const error = patchError(patch);
      if (error) return { config: await runtime.configFor(chatId), error };
      const current = await runtime.configFor(chatId);
      const next = applyPatch(current, patch);
      await store.put(`rules:${chatId}`, JSON.stringify(next));
      configs.set(chatId, next);
      return { config: next, error: "" };
    },

    invalidate(chatId) {
      configs.delete(chatId);
    },

    async withChatLock<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
      const previous = locks.get(chatId) ?? Promise.resolve();
      const run = previous.then(fn, fn);
      // Keep the chain alive but never let a rejection poison the next update.
      locks.set(
        chatId,
        run.catch(() => undefined),
      );
      try {
        return await run;
      } finally {
        if (locks.get(chatId) === run) locks.delete(chatId);
      }
    },
  };

  // Kick off the schema check without blocking the first update; the promise is
  // shared by every later call in this isolate.
  if (!migrated.has(sql)) {
    migrated.set(
      sql,
      migrate(sql)
        .then(() => undefined)
        .catch((err) => {
          console.log(`migrate failed: ${err instanceof Error ? err.message : String(err)}`);
        }),
    );
  }

  return runtime;
}

/**
 * Awaited by the entry points so a fresh database exists before traffic.
 *
 * 按数据库句柄记一次：worker.ts 在每个 /api/* 请求与 cron tick 前都 await 它，
 * 而 migrate 每次要建 _migrations + 逐条 select（约 9 次 D1 往返）。Worker 的
 * D1 绑定随 isolate 存活，整个生命周期只会 migrate 一遍；新 isolate / 新句柄
 * 自会重跑（测试里的每个内存库也因此互不串扰——不能按进程全局标记）。
 */
const schemaReadyByDb = new WeakSet<SqliteHandle>();
export async function ensureSchema(sql: SqliteHandle): Promise<void> {
  if (schemaReadyByDb.has(sql)) return;
  await migrate(sql);
  schemaReadyByDb.add(sql);
}

// ---------------------------------------------------------------------------
// Admin resolution
// ---------------------------------------------------------------------------

type MemberRights = { status: string; rights: Record<string, boolean>; at: number };

/**
 * Who counts as an admin, and what they may do.
 *
 * Two sources, both needed: `ADMIN_IDS` is the operator's own allow-list and
 * works before the bot has talked to the group; the live member list is the
 * truth after someone is promoted or demoted. If the live lookup fails we fall
 * back to the static list only — failing closed, so a Telegram hiccup can never
 * make a stranger an admin.
 */
export class AdminResolver {
  private readonly env: Env;
  private readonly api: Telegram;
  private readonly now: () => number;
  private readonly cache = new LRUCache<string, MemberRights>({ max: 5_000, ttl: MEMBER_RIGHT_TTL_MS });
  private readonly groupAdmins = new LRUCache<number, { ids: number[]; ok: boolean }>({ max: 2_000, ttl: ADMIN_TTL_MS });

  constructor(env: Env, api: Telegram, now: () => number) {
    this.env = env;
    this.api = api;
    this.now = now;
  }

  staticIds(): number[] {
    return String(this.env.ADMIN_IDS ?? "")
      .split(/[,\s]+/)
      .map((part) => part.trim())
      .filter((part) => /^-?\d+$/.test(part))
      .map(Number);
  }

  isStatic(userId: number): boolean {
    return this.staticIds().includes(userId);
  }

  async isAdmin(chatId: number, userId: number): Promise<boolean> {
    if (!userId) return false;
    if (this.isStatic(userId)) return true;
    const member = await this.member(chatId, userId);
    return member?.status === "creator" || member?.status === "administrator";
  }

  /**
   * Right check, not just "is an admin". A group can promote someone to
   * "delete messages only"; `/ban` must then be refused, or the bot becomes a
   * privilege-escalation path inside the group.
   */
  async can(chatId: number, userId: number, right: Right): Promise<boolean> {
    if (!userId) return false;
    if (this.isStatic(userId)) return true;
    const member = await this.member(chatId, userId);
    if (!member) return false;
    if (member.status === "creator") return true;
    if (member.status !== "administrator") return false;
    // Anonymous admins post as the group, so a command attributed to a real
    // user id from an anonymous admin cannot be verified; deny rather than
    // allow a member to ride on it.
    if (member.rights.is_anonymous === true) return false;
    return member.rights[right] === true;
  }

  /** Drop cached answers for a chat after a promotion/demotion. */
  invalidate(chatId: number): void {
    this.groupAdmins.delete(chatId);
    // Keys are `chat:user`; LRU has no prefix delete, and membership changes are
    // rare enough that clearing the whole member cache is the honest cheap move.
    this.cache.clear();
  }

  async liveIds(chatId: number, refresh = false): Promise<number[]> {
    if (!refresh) {
      const cached = this.groupAdmins.get(chatId);
      if (cached) return cached.ids;
    }
    const res = await this.api.call<{ user: TgUser; status: string }[]>("getChatAdministrators", { chat_id: chatId });
    if (!res.ok) {
      this.groupAdmins.set(chatId, { ids: [], ok: false });
      return [];
    }
    const ids = res.result
      .filter((entry) => entry.status === "creator" || entry.status === "administrator")
      .map((entry) => entry.user.id)
      .filter((id) => Number.isFinite(id) && id > 0);
    this.groupAdmins.set(chatId, { ids, ok: true });
    return ids;
  }

  private async member(chatId: number, userId: number): Promise<MemberRights | null> {
    const key = `${chatId}:${userId}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const res = await this.api.call<{
      status: string;
      is_anonymous?: boolean;
      can_delete_messages?: boolean;
      can_restrict_members?: boolean;
      can_pin_messages?: boolean;
      can_change_info?: boolean;
      can_invite_users?: boolean;
      can_promote_members?: boolean;
    }>("getChatMember", { chat_id: chatId, user_id: userId });
    if (!res.ok) {
      // Not cached: a failed lookup is "no opinion", and caching it would lock
      // an admin out of their own group for five minutes.
      return null;
    }
    const rights: Record<string, boolean> = {
      is_anonymous: res.result.is_anonymous === true,
      can_delete_messages: res.result.can_delete_messages === true,
      can_restrict_members: res.result.can_restrict_members === true,
      can_pin_messages: res.result.can_pin_messages === true,
      can_change_info: res.result.can_change_info === true,
      can_invite_users: res.result.can_invite_users === true,
      can_promote_members: res.result.can_promote_members === true,
    };
    const entry = { status: res.result.status, rights, at: this.now() };
    this.cache.set(key, entry);
    return entry;
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** Every right off. `restrictChatMember` needs the full object, not a diff. */
export const PERMS_MUTED: TgChatPermissions = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

/**
 * What a verified member gets back: the right to talk — not the right to
 * invite, pin or edit the group. `can_invite_users: true` here would override
 * whatever the group set for "who can invite", a much wider grant than the
 * button ever promised.
 */
export const PERMS_MEMBER: TgChatPermissions = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

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
import { healthMark } from "./db/repo.ts";
import { migrate } from "./db/migrate.ts";
import { bannedUsers } from "./db/schema.ts";
import { eq } from "drizzle-orm";
import type { Db } from "./db/repo.ts";
import type { SqliteHandle } from "./db/connect.ts";
import type { Env, Store, TgChatPermissions, TgUser } from "./types.ts";

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
  now: () => number;
  /** Minutes east of UTC used by night mode. */
  tzOffset: number;
  configFor: (chatId: number) => Promise<ChatConfig>;
  saveConfig: (chatId: number, patch: Record<string, unknown>) => Promise<{ config: ChatConfig; error: string }>;
  invalidate: (chatId: number) => void;
  /** Serialises handlers for one chat so two events cannot punish twice. */
  withChatLock: <T>(chatId: number, fn: () => Promise<T>) => Promise<T>;
};

export type RuntimeDeps = {
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

  const locks = new Map<number, Promise<unknown>>();

  const runtime: Runtime = {
    env,
    api,
    store,
    db,
    sql,
    admin,
    screener,
    now,
    tzOffset,

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

/** Awaited by the entry points so a fresh database exists before traffic. */
export async function ensureSchema(sql: SqliteHandle): Promise<void> {
  await migrate(sql);
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

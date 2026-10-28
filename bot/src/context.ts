import { DEFAULT_RULES, mergeRules, type ChatRules } from "./rules.ts";
import { memoryStore } from "./store.ts";
import { Telegram } from "./telegram.ts";
import type { Env, Store, TgChatPermissions, TgUser } from "./types.ts";

/** Everything a handler needs, assembled once per update. */
export type Ctx = {
  env: Env;
  tg: Telegram;
  store: Store;
  admins: AdminResolver;
  now: () => number;
};

export type CtxDeps = {
  store?: Store;
  tg?: Telegram;
  now?: () => number;
};

let fallbackStore: Store | null = null;

export function createContext(env: Env, deps: CtxDeps = {}): Ctx {
  const tg = deps.tg ?? new Telegram(env.BOT_TOKEN ?? "");
  // A deployment whose KV namespace is not attached yet still has to answer:
  // one shared in-memory store keeps it working (per isolate) instead of
  // throwing on the first message.
  if (!deps.store && !fallbackStore) fallbackStore = memoryStore();
  const store = deps.store ?? (fallbackStore as Store);
  const now = deps.now ?? (() => Date.now());
  return {
    env,
    tg,
    store,
    now,
    admins: new AdminResolver(env, tg, store, now),
  };
}

/** Rules for one chat: shipped defaults, overridden by whatever the chat saved. */
export async function rulesFor(ctx: Ctx, chatId: number): Promise<ChatRules> {
  const base: ChatRules = { ...DEFAULT_RULES, logChatId: ctx.env.LOG_CHAT_ID ?? "" };
  const raw = await ctx.store.get(`rules:${chatId}`);
  if (!raw) return base;
  try {
    return mergeRules(base, JSON.parse(raw) as Record<string, unknown>);
  } catch {
    // A corrupt row must not lock the group out of moderation.
    return base;
  }
}

export async function saveRules(
  ctx: Ctx,
  chatId: number,
  patch: Record<string, unknown>,
): Promise<ChatRules> {
  const next = mergeRules(await rulesFor(ctx, chatId), patch);
  await ctx.store.put(`rules:${chatId}`, JSON.stringify(next));
  return next;
}

const ADMIN_CACHE_TTL = 600;
const ADMIN_CACHE_MISS_TTL = 60;

/**
 * Who counts as an admin.
 *
 * Two sources, both needed: `ADMIN_IDS` is the operator's own allow-list and
 * works before the bot has talked to the group; the live admin list is the
 * truth after someone is promoted or demoted in Telegram itself. If the live
 * lookup fails we fall back to the static list only — failing closed, so a
 * Telegram hiccup can never make a stranger an admin.
 */
export class AdminResolver {
  private readonly env: Env;
  private readonly tg: Telegram;
  private readonly store: Store;
  private readonly now: () => number;

  // Explicit field assignments, not parameter properties: Node's `--experimental
  // -strip-types` (which the tests and the polling runner use) rejects the
  // shorthand outright.
  constructor(env: Env, tg: Telegram, store: Store, now: () => number) {
    this.env = env;
    this.tg = tg;
    this.store = store;
    this.now = now;
  }

  staticIds(): number[] {
    return String(this.env.ADMIN_IDS ?? "")
      .split(/[,\s]+/)
      .map((part) => part.trim())
      .filter((part) => /^\d+$/.test(part))
      .map(Number);
  }

  isStatic(userId: number): boolean {
    return this.staticIds().includes(userId);
  }

  async isAdmin(chatId: number, userId: number, opts: { refresh?: boolean } = {}): Promise<boolean> {
    if (this.isStatic(userId)) return true;
    if (!userId) return false;
    const ids = await this.liveIds(chatId, opts.refresh === true);
    return ids.includes(userId);
  }

  /** Cached `getChatAdministrators`. A negative result is cached briefly only. */
  async liveIds(chatId: number, refresh = false): Promise<number[]> {
    const key = `admins:${chatId}`;
    if (!refresh) {
      const raw = await this.store.get(key);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { ids: number[]; at: number; ok: boolean };
          const ttl = parsed.ok ? ADMIN_CACHE_TTL : ADMIN_CACHE_MISS_TTL;
          if (this.now() - parsed.at < ttl * 1000) return parsed.ids;
        } catch {
          // Corrupt cache is the same as no cache.
        }
      }
    }

    const res = await this.tg.call<{ user: TgUser; status: string }[]>("getChatAdministrators", {
      chat_id: chatId,
    });
    if (!res.ok) {
      await this.store.put(key, JSON.stringify({ ids: [], at: this.now(), ok: false }), ADMIN_CACHE_MISS_TTL * 2);
      return [];
    }
    const ids = res.result
      .filter((member) => member.status === "creator" || member.status === "administrator")
      .map((member) => member.user.id)
      .filter((id) => !isBotId(id));
    await this.store.put(key, JSON.stringify({ ids, at: this.now(), ok: true }), ADMIN_CACHE_TTL * 2);
    return ids;
  }
}

function isBotId(id: number): boolean {
  // Bot ids are negative in some legacy payloads; nothing to do with identity.
  return !Number.isFinite(id) || id <= 0;
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

/**
 * The slice of the Telegram Bot API this bot touches.
 *
 * Hand-written instead of pulling `@grammyjs/types` or `typegram`: the bot ships
 * with five runtime dependencies and every extra package is one more thing the
 * person deploying it has to trust. Only fields we read are typed, and the
 * media fields exist because the lock system switches on them.
 */

export type TgUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type TgChatType = "private" | "group" | "supergroup" | "channel";

export type TgChat = {
  id: number;
  type: TgChatType;
  title?: string;
  username?: string;
  is_forum?: boolean;
};

export type TgMessageEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TgUser;
};

export type TgMessage = {
  message_id: number;
  date?: number;
  chat: TgChat;
  from?: TgUser;
  /** Set when a message is posted on behalf of a channel. */
  sender_chat?: TgChat;
  text?: string;
  caption?: string;
  entities?: TgMessageEntity[];
  caption_entities?: TgMessageEntity[];
  new_chat_members?: TgUser[];
  left_chat_member?: TgUser;
  new_chat_title?: string;
  pinned_message?: TgMessage;
  reply_to_message?: TgMessage;
  message_thread_id?: number;
  is_topic_message?: boolean;
  edit_date?: number;
  via_bot?: TgUser;
  // Media, one field per lock kind.
  photo?: unknown[];
  video?: unknown;
  animation?: unknown;
  sticker?: unknown;
  document?: unknown;
  audio?: unknown;
  voice?: unknown;
  video_note?: unknown;
  poll?: { id?: string; question?: string };
  // Any of these present means "this arrived from somewhere else".
  forward_origin?: unknown;
  forward_from?: TgUser;
  forward_date?: number;
  forward_sender_name?: string;
};

export type TgCallbackQuery = {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
};

export type TgChatMember = {
  status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
  user: TgUser;
  is_anonymous?: boolean;
  until_date?: number;
};

export type TgChatMemberUpdated = {
  chat: TgChat;
  from: TgUser;
  date?: number;
  old_chat_member: TgChatMember;
  new_chat_member: TgChatMember;
};

export type TgUpdate = {
  update_id?: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  my_chat_member?: TgChatMemberUpdated;
  chat_member?: TgChatMemberUpdated;
  chat_join_request?: { chat: TgChat; from: TgUser; date: number; invite_link?: { invite_link: string } };
};

/** `ChatPermissions` is a bag of optional booleans; only the ones we set. */
export type TgChatPermissions = Record<string, boolean>;

export type TgChatFullInfo = TgChat & { linked_chat_id?: number };

// ---------------------------------------------------------------------------
// Runtime plumbing
// ---------------------------------------------------------------------------

/**
 * The storage surface the bot needs for hot state.
 *
 * Deliberately tiny so the same core runs on Cloudflare KV, in memory (tests),
 * and on disk (the local polling runner). Durable records live in SQL instead —
 * see `db/`.
 */
export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Every key with the given prefix. Needed for the captcha sweep. */
  keys(prefix: string): Promise<string[]>;
}

/** Structural type of a Workers KV namespace — no import required. */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete?: boolean;
    cursor?: string;
  }>;
}

/** Structural type of a D1 database, enough for drizzle and our own runner. */
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
    first<T = unknown>(): Promise<T | null>;
    all<T = unknown>(): Promise<{ results: T[] }>;
    run(): Promise<unknown>;
  };
  batch(statements: unknown[]): Promise<unknown[]>;
  exec(query: string): Promise<unknown>;
}

export type Env = {
  BOT_TOKEN: string;
  /** Comma/space separated numeric ids. Grants admin in every chat. */
  ADMIN_IDS?: string;
  /** Also used as the `secret_token` Telegram sends back on every webhook. */
  WEBHOOK_SECRET?: string;
  /** Default moderation log target; a per-chat config can override it. */
  LOG_CHAT_ID?: string;
  BOT_USERNAME?: string;
  STORE?: KVLike;
  DB?: D1Like;
  /** Shared secret for the federation list; unset disables federation. */
  FEDERATION_URL?: string;
  FEDERATION_TOKEN?: string;
  /** Combot API key for CAS; without it CAS refuses every request (401). */
  CAS_KEY?: string;
  /** Base URL of this deployment, used to build the webhook URL. */
  PUBLIC_URL?: string;
  ENVIRONMENT?: string;
  /** Minutes east of UTC for night mode; default +480. */
  TZ_OFFSET?: string;
};

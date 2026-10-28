/**
 * The slice of the Telegram Bot API this bot actually touches.
 *
 * Hand-written instead of pulling `@cloudflare/workers-types` or `typegram`:
 * the bot ships with zero dependencies, and every extra package is one more
 * thing the person deploying it has to trust. Only fields we read are typed.
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
};

export type TgMessageEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
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
  reply_to_message?: TgMessage;
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
  status: string;
  user: TgUser;
};

export type TgChatMemberUpdated = {
  chat: TgChat;
  from: TgUser;
  old_chat_member: TgChatMember;
  new_chat_member: TgChatMember;
};

export type TgUpdate = {
  update_id?: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  my_chat_member?: TgChatMemberUpdated;
};

/** `ChatPermissions` is a bag of optional booleans; only the ones we set. */
export type TgChatPermissions = Record<string, boolean>;

// ---------------------------------------------------------------------------
// Runtime plumbing
// ---------------------------------------------------------------------------

/**
 * The storage surface the bot needs. Deliberately tiny so the same core runs on
 * Cloudflare KV, in memory (tests), and on disk (the local polling runner).
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

export type Env = {
  BOT_TOKEN: string;
  /** Comma/space separated numeric ids. Grants admin in every chat. */
  ADMIN_IDS?: string;
  /** Also used as the `secret_token` Telegram sends back on every webhook. */
  WEBHOOK_SECRET?: string;
  /** Default moderation log target; a per-chat rule can override it. */
  LOG_CHAT_ID?: string;
  BOT_USERNAME?: string;
  STORE?: KVLike;
};

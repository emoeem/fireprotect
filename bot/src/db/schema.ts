/**
 * Durable records. Hot state (per-chat config, pending verifications, flood
 * windows) stays in KV; anything an admin will want to query later lives here,
 * because KV cannot answer "how many bans last week".
 */
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** One row per moderation/verification/join event. Append-only. */
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id").notNull(),
    userId: integer("user_id").notNull().default(0),
    /** delete | mute | ban | kick | warn | verify | join | leave | external */
    kind: text("kind").notNull(),
    /** Free-form detail: the matched keyword, the lock kind, the strike level. */
    reason: text("reason").notNull().default(""),
    minutes: integer("minutes").notNull().default(0),
    byId: integer("by_id").notNull().default(0),
    at: integer("at").notNull(),
  },
  (table) => [index("idx_events_chat_at").on(table.chatId, table.at), index("idx_events_kind").on(table.kind)],
);

/** Current warning count per member. Reset when the ladder bans them. */
export const warnings = sqliteTable(
  "warnings",
  {
    chatId: integer("chat_id").notNull(),
    userId: integer("user_id").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.userId] })],
);

/** `/save` snippets and `/rules` text. */
export const notes = sqliteTable(
  "notes",
  {
    chatId: integer("chat_id").notNull(),
    name: text("name").notNull(),
    content: text("content").notNull(),
    createdBy: integer("created_by").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.name] })],
);

/** Auto-replies (`/filter`). */
export const replyFilters = sqliteTable(
  "reply_filters",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id").notNull(),
    trigger: text("trigger").notNull(),
    /** exact | prefix | regex */
    match: text("match").notNull().default("exact"),
    response: text("response").notNull(),
    createdBy: integer("created_by").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_filters_chat").on(table.chatId)],
);

/** Shared ban list. Local rows plus anything pulled from the federation. */
export const bannedUsers = sqliteTable("banned_users", {
  userId: integer("user_id").primaryKey(),
  reason: text("reason").notNull().default(""),
  /** local | federation | cas */
  source: text("source").notNull().default("local"),
  at: integer("at").notNull(),
});

/** Members an admin unbanned by hand; exempt from the newbie window. */
export const trustedUsers = sqliteTable(
  "trusted_users",
  {
    chatId: integer("chat_id").notNull(),
    userId: integer("user_id").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.userId] })],
);

/**
 * Shadow bans. A blocked member's messages are deleted without a warning and
 * without a notice — the point is that a spammer cannot tell they are muted,
 * so they keep posting into the void instead of making a new account.
 */
export const blockedUsers = sqliteTable(
  "blocked_users",
  {
    chatId: integer("chat_id").notNull(),
    userId: integer("user_id").notNull(),
    reason: text("reason").notNull().default(""),
    byId: integer("by_id").notNull().default(0),
    at: integer("at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.userId] })],
);

/**
 * Channel → group mirrors. `intervalSeconds = 0` means "push on arrival": the
 * bot receives a `channel_post` update and copies it immediately, which needs
 * no polling and no scraping. Any other value is polled through the public
 * `t.me/s/` preview, because the Bot API has no "list channel posts" method.
 */
export const syncSources = sqliteTable(
  "sync_sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id").notNull(),
    /** Channel username without the leading @. */
    source: text("source").notNull(),
    intervalSeconds: integer("interval_seconds").notNull().default(300),
    /** Highest post id already copied. */
    lastId: integer("last_id").notNull().default(0),
    enabled: integer("enabled").notNull().default(1),
    failures: integer("failures").notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    sent: integer("sent").notNull().default(0),
    at: integer("at").notNull(),
  },
  (table) => [uniqueIndex("uq_sync_chat_source").on(table.chatId, table.source)],
);

/**
 * RSS subscriptions, one row per (chat, feed).
 *
 * The row is per chat rather than per URL on purpose: two groups may follow the
 * same feed and they must not share a watermark, or the first group's poll would
 * suppress the second group's delivery. `lastKey` is the watermark — the
 * identifier of the last item already delivered, the same idea as
 * `sync_sources.last_id` — and `failures` is the consecutive-failure counter
 * that eventually removes a feed that is simply dead.
 */
export const rssFeeds = sqliteTable(
  "rss_feeds",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id").notNull(),
    /** Normalised absolute feed URL; the dedupe key together with `chatId`. */
    url: text("url").notNull(),
    title: text("title").notNull().default(""),
    /** guid/link of the last delivered item. Empty means "nothing delivered yet". */
    lastKey: text("last_key").notNull().default(""),
    failures: integer("failures").notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    sent: integer("sent").notNull().default(0),
    /** Last poll attempt, and the last poll that actually found something. */
    at: integer("at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull().default(0),
  },
  (table) => [
    uniqueIndex("uq_rss_chat_url").on(table.chatId, table.url),
    // Polling picks the least recently polled rows first, so the index is what
    // keeps a deployment with many feeds from starving the tail of the list.
    index("idx_rss_poll").on(table.at),
  ],
);

/** Toolbox usage, so the console can answer "is anyone using /splitpdf". */
export const toolUsage = sqliteTable(
  "tool_usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id").notNull(),
    userId: integer("user_id").notNull().default(0),
    /** splitpdf | slice | expand | timestamp */
    tool: text("tool").notNull(),
    ok: integer("ok").notNull().default(1),
    bytes: integer("bytes").notNull().default(0),
    at: integer("at").notNull(),
  },
  (table) => [index("idx_tool_chat").on(table.chatId, table.tool)],
);

/** Health of each external dependency, so /stats can show "CAS is down". */
export const externalHealth = sqliteTable("external_health", {
  name: text("name").primaryKey(),
  failures: integer("failures").notNull().default(0),
  lastOkAt: integer("last_ok_at").notNull().default(0),
  lastError: text("last_error").notNull().default(""),
  lastErrorAt: integer("last_error_at").notNull().default(0),
});

export type EventRow = typeof events.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
export type FilterRow = typeof replyFilters.$inferSelect;

/** Chat registry, so the console can list groups by name without asking KV. */
export const chats = sqliteTable("chats", {
  chatId: integer("chat_id").primaryKey(),
  title: text("title").notNull().default(""),
  type: text("type").notNull().default("supergroup"),
  addedAt: integer("added_at").notNull().default(0),
  lastSeenAt: integer("last_seen_at").notNull().default(0),
});

/** Scheduled messages: one row per repeating or one-shot post. */
export const scheduledMessages = sqliteTable(
  "scheduled_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id").notNull(),
    text: text("text").notNull(),
    /** Seconds between runs; 0 means "send once, then disable". */
    every: integer("every").notNull().default(0),
    nextAt: integer("next_at").notNull(),
    enabled: integer("enabled").notNull().default(1),
    createdBy: integer("created_by").notNull().default(0),
    sent: integer("sent").notNull().default(0),
    lastError: text("last_error").notNull().default(""),
  },
  (table) => [index("idx_sched_next").on(table.enabled, table.nextAt)],
);

/**
 * Daily hot-word counts.
 *
 * `day` is `YYYY-MM-DD` in the deployment's timezone, not UTC: "today's words"
 * has to match the admin's today. `count` is a document frequency (one per
 * message), which is what makes "这个群在聊什么" readable — a single long
 * message should not outrank a topic twenty people mentioned.
 */
export const wordStats = sqliteTable(
  "word_stats",
  {
    chatId: integer("chat_id").notNull(),
    day: text("day").notNull(),
    word: text("word").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.day, table.word] }),
    index("idx_word_day").on(table.chatId, table.day),
  ],
);

/** Vision calls per chat per day: the budget, the hit rate and the cost signal. */
export const aiUsage = sqliteTable(
  "ai_usage",
  {
    chatId: integer("chat_id").notNull(),
    day: text("day").notNull(),
    calls: integer("calls").notNull().default(0),
    hits: integer("hits").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    ms: integer("ms").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.day] })],
);

/**
 * Media parse attempts.
 *
 * A row is created before the work starts (`pending`) and closed with `done` or
 * `failed`. A `pending` row older than two minutes means the request died
 * mid-flight — the self-hosted node reaps those, which is the only way a
 * Worker-only crash leaves a visible trace instead of silence.
 */
export const parseJobs = sqliteTable(
  "parse_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id").notNull(),
    userId: integer("user_id").notNull().default(0),
    messageId: integer("message_id").notNull().default(0),
    url: text("url").notNull(),
    /** douyin | xiaohongshu | twitter | bilibili | "" */
    site: text("site").notNull().default(""),
    /** pending | done | failed */
    status: text("status").notNull().default("pending"),
    /** full (yt-dlp) | preview (og: tags) */
    mode: text("mode").notNull().default("preview"),
    media: integer("media").notNull().default(0),
    error: text("error").notNull().default(""),
    at: integer("at").notNull(),
    updatedAt: integer("updated_at").notNull().default(0),
  },
  (table) => [
    index("idx_parse_status").on(table.status, table.at),
    index("idx_parse_chat").on(table.chatId, table.at),
  ],
);

export type WordRowDb = typeof wordStats.$inferSelect;
export type ParseJobRow = typeof parseJobs.$inferSelect;
export type AiUsageRow = typeof aiUsage.$inferSelect;

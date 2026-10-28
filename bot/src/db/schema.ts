/**
 * Durable records. Hot state (per-chat config, pending verifications, flood
 * windows) stays in KV; anything an admin will want to query later lives here,
 * because KV cannot answer "how many bans last week".
 */
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

/**
 * Schema migrations, in order.
 *
 * This is drizzle-kit's generated DDL, inlined as a string because a Workers
 * bundle cannot read `.sql` files at runtime and `wrangler d1 migrations
 * apply` would make the local runner and the Worker diverge. Regenerate with
 * `npm run db:generate` when `schema.ts` changes; never edit an applied entry —
 * append a new one.
 */
export type Migration = { name: string; sql: string };

export const MIGRATIONS: Migration[] = [
  {
    name: "0000_init",
    sql: `
create table if not exists "events" (
  "id" integer primary key autoincrement not null,
  "chat_id" integer not null,
  "user_id" integer not null default 0,
  "kind" text not null,
  "reason" text not null default '',
  "minutes" integer not null default 0,
  "by_id" integer not null default 0,
  "at" integer not null
);
create index if not exists "idx_events_chat_at" on "events" ("chat_id","at");
create index if not exists "idx_events_kind" on "events" ("kind");

create table if not exists "warnings" (
  "chat_id" integer not null,
  "user_id" integer not null,
  "count" integer not null default 0,
  "updated_at" integer not null,
  constraint "warnings_chat_id_user_id_pk" primary key("chat_id","user_id")
);

create table if not exists "notes" (
  "chat_id" integer not null,
  "name" text not null,
  "content" text not null,
  "created_by" integer not null default 0,
  "updated_at" integer not null,
  constraint "notes_chat_id_name_pk" primary key("chat_id","name")
);

create table if not exists "reply_filters" (
  "id" integer primary key autoincrement not null,
  "chat_id" integer not null,
  "trigger" text not null,
  "match" text not null default 'exact',
  "response" text not null,
  "created_by" integer not null default 0,
  "created_at" integer not null
);
create index if not exists "idx_filters_chat" on "reply_filters" ("chat_id");

create table if not exists "banned_users" (
  "user_id" integer primary key not null,
  "reason" text not null default '',
  "source" text not null default 'local',
  "at" integer not null
);

create table if not exists "trusted_users" (
  "chat_id" integer not null,
  "user_id" integer not null,
  "at" integer not null,
  constraint "trusted_users_chat_id_user_id_pk" primary key("chat_id","user_id")
);

create table if not exists "external_health" (
  "name" text primary key not null,
  "failures" integer not null default 0,
  "last_ok_at" integer not null default 0,
  "last_error" text not null default '',
  "last_error_at" integer not null default 0
);
`.trim(),
  },
  {
    name: "0001_console",
    sql: `
create table if not exists "chats" (
  "chat_id" integer primary key not null,
  "title" text not null default '',
  "type" text not null default 'supergroup',
  "added_at" integer not null default 0,
  "last_seen_at" integer not null default 0
);

create table if not exists "scheduled_messages" (
  "id" integer primary key autoincrement not null,
  "chat_id" integer not null,
  "text" text not null,
  "every" integer not null default 0,
  "next_at" integer not null,
  "enabled" integer not null default 1,
  "created_by" integer not null default 0,
  "sent" integer not null default 0,
  "last_error" text not null default ''
);
create index if not exists "idx_sched_next" on "scheduled_messages" ("enabled","next_at");
`.trim(),
  },
  {
    name: "0002_block_sync_tools",
    sql: `
create table if not exists "blocked_users" (
  "chat_id" integer not null,
  "user_id" integer not null,
  "reason" text not null default '',
  "by_id" integer not null default 0,
  "at" integer not null,
  constraint "blocked_users_chat_id_user_id_pk" primary key("chat_id","user_id")
);

create table if not exists "sync_sources" (
  "id" integer primary key autoincrement not null,
  "chat_id" integer not null,
  "source" text not null,
  "interval_seconds" integer not null default 300,
  "last_id" integer not null default 0,
  "enabled" integer not null default 1,
  "failures" integer not null default 0,
  "last_error" text not null default '',
  "sent" integer not null default 0,
  "at" integer not null
);
create unique index if not exists "uq_sync_chat_source" on "sync_sources" ("chat_id","source");

create table if not exists "tool_usage" (
  "id" integer primary key autoincrement not null,
  "chat_id" integer not null,
  "user_id" integer not null default 0,
  "tool" text not null,
  "ok" integer not null default 1,
  "bytes" integer not null default 0,
  "at" integer not null
);
create index if not exists "idx_tool_chat" on "tool_usage" ("chat_id","tool");
`.trim(),
  },
  {
    name: "0003_ai_words_parse",
    sql: `
create table if not exists "word_stats" (
  "chat_id" integer not null,
  "day" text not null,
  "word" text not null,
  "count" integer not null default 0,
  constraint "word_stats_chat_id_day_word_pk" primary key("chat_id","day","word")
);
create index if not exists "idx_word_day" on "word_stats" ("chat_id","day");

create table if not exists "ai_usage" (
  "chat_id" integer not null,
  "day" text not null,
  "calls" integer not null default 0,
  "hits" integer not null default 0,
  "failures" integer not null default 0,
  "ms" integer not null default 0,
  constraint "ai_usage_chat_id_day_pk" primary key("chat_id","day")
);

create table if not exists "parse_jobs" (
  "id" integer primary key autoincrement not null,
  "chat_id" integer not null,
  "user_id" integer not null default 0,
  "message_id" integer not null default 0,
  "url" text not null,
  "site" text not null default '',
  "status" text not null default 'pending',
  "mode" text not null default 'preview',
  "media" integer not null default 0,
  "error" text not null default '',
  "at" integer not null,
  "updated_at" integer not null default 0
);
create index if not exists "idx_parse_status" on "parse_jobs" ("status","at");
create index if not exists "idx_parse_chat" on "parse_jobs" ("chat_id","at");
`.trim(),
  },
  {
    name: "0004_rss",
    sql: `
create table if not exists "rss_feeds" (
  "id" integer primary key autoincrement not null,
  "chat_id" integer not null,
  "url" text not null,
  "title" text not null default '',
  "last_key" text not null default '',
  "failures" integer not null default 0,
  "last_error" text not null default '',
  "sent" integer not null default 0,
  "at" integer not null,
  "last_seen_at" integer not null default 0
);
create unique index if not exists "uq_rss_chat_url" on "rss_feeds" ("chat_id","url");
create index if not exists "idx_rss_poll" on "rss_feeds" ("at");
`.trim(),
  },
  {
    // Cross-group member audit and paged ban lists both read by user / recency,
    // which the PK-only tables would otherwise scan for.
    name: "0005_indexes",
    sql: `
create index if not exists "idx_events_user" on "events" ("user_id","at");
create index if not exists "idx_banned_at" on "banned_users" ("at");
`.trim(),
  },
];

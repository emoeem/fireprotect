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
];

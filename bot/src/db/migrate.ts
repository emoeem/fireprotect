/**
 * Migration runner.
 *
 * Runs at startup on both platforms, so a fresh deployment (or a fresh local
 * `bot.db`) is usable without a manual `wrangler d1 migrations apply`. Each
 * entry is applied once and recorded by name, which makes a first boot on two
 * concurrent Worker isolates harmless.
 */
import { MIGRATIONS } from "./migrations.ts";
import type { SqliteHandle } from "./connect.ts";

const BOOKKEEPING = `create table if not exists "_migrations" (
  "name" text primary key not null,
  "at" integer not null
)`;

/**
 * Split a script into statements.
 *
 * Only ever applied to our own DDL, which contains no string literals — so a
 * plain `;` split cannot cut a statement in half. D1's `exec` splits on
 * newlines instead, which turns a normal formatted `CREATE TABLE` into
 * `incomplete input`, so every statement is sent on its own.
 */
function statements(sql: string): string[] {
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function apply(handle: SqliteHandle, sql: string): Promise<void> {
  for (const statement of statements(sql)) await handle.run(statement);
}

export async function migrate(handle: SqliteHandle, now = Date.now()): Promise<{ applied: string[] }> {
  await apply(handle, BOOKKEEPING);
  const applied: string[] = [];

  for (const migration of MIGRATIONS) {
    const row = await handle.get<{ name: string }>(`select "name" from "_migrations" where "name" = ? limit 1`, [
      migration.name,
    ]);
    if (row) continue;
    await apply(handle, migration.sql);
    // `insert or ignore` instead of a plain insert: two concurrent isolates
    // booting at once both see "not applied" and both apply the (idempotent)
    // DDL, so the second bookkeeping row must not fail the whole startup.
    await handle.run(`insert or ignore into "_migrations" ("name", "at") values (?, ?)`, [migration.name, now]);
    applied.push(migration.name);
  }

  return { applied };
}

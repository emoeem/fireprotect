/**
 * Query layer over the SQLite schema.
 *
 * Every driver (D1 on Workers, `node:sqlite` locally) speaks the same dialect,
 * so this file is driver-agnostic; `d1.ts` and `node-sqlite.ts` only build the
 * connection.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  bannedUsers,
  events,
  externalHealth,
  notes,
  replyFilters,
  trustedUsers,
  warnings,
  type FilterRow,
  type NoteRow,
} from "./schema.ts";

/**
 * The subset of drizzle's database object these queries need.
 *
 * Deliberately loose: D1 and the sqlite-proxy driver return different generic
 * instantiations of the same builder, and pinning the exact type here would mean
 * two copies of every query. The shapes are checked at the call sites.
 */
export type Db = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  run: (query: any) => Promise<unknown>;
};

export type EventKind =
  | "delete"
  | "mute"
  | "ban"
  | "kick"
  | "warn"
  | "verify"
  | "join"
  | "leave"
  | "external"
  | "trust";

export async function logEvent(
  db: Db,
  event: { chatId: number; userId?: number; kind: EventKind; reason?: string; minutes?: number; byId?: number; at: number },
): Promise<void> {
  await db.insert(events).values({
    chatId: event.chatId,
    userId: event.userId ?? 0,
    kind: event.kind,
    reason: (event.reason ?? "").slice(0, 300),
    minutes: event.minutes ?? 0,
    byId: event.byId ?? 0,
    at: event.at,
  });
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/**
 * Increment and return the new count in one statement.
 *
 * A read-then-write would lose warnings when two admins warn at the same time,
 * and a lost warning is a member who never gets banned.
 */
export async function warnInc(db: Db, chatId: number, userId: number, at: number): Promise<number> {
  const rows = await db
    .insert(warnings)
    .values({ chatId, userId, count: 1, updatedAt: at })
    .onConflictDoUpdate({
      target: [warnings.chatId, warnings.userId],
      set: { count: sql`${warnings.count} + 1`, updatedAt: at },
    })
    .returning({ count: warnings.count });
  return Number((rows as { count: number }[])[0]?.count ?? 1);
}

export async function warnCount(db: Db, chatId: number, userId: number): Promise<number> {
  const rows = await db
    .select({ count: warnings.count })
    .from(warnings)
    .where(and(eq(warnings.chatId, chatId), eq(warnings.userId, userId)))
    .limit(1);
  return Number((rows as { count: number }[])[0]?.count ?? 0);
}

/** `count = max(count - 1, 0)`, deleting the row when it reaches zero. */
export async function warnDec(db: Db, chatId: number, userId: number, at: number): Promise<number> {
  const current = await warnCount(db, chatId, userId);
  if (current <= 0) return 0;
  const next = current - 1;
  if (next === 0) {
    await db.delete(warnings).where(and(eq(warnings.chatId, chatId), eq(warnings.userId, userId)));
    return 0;
  }
  await db
    .update(warnings)
    .set({ count: next, updatedAt: at })
    .where(and(eq(warnings.chatId, chatId), eq(warnings.userId, userId)));
  return next;
}

export async function warnReset(db: Db, chatId: number, userId: number): Promise<void> {
  await db.delete(warnings).where(and(eq(warnings.chatId, chatId), eq(warnings.userId, userId)));
}

// ---------------------------------------------------------------------------
// Notes and auto-replies
// ---------------------------------------------------------------------------

export async function noteSave(
  db: Db,
  note: { chatId: number; name: string; content: string; createdBy: number; at: number },
): Promise<void> {
  await db
    .insert(notes)
    .values({ chatId: note.chatId, name: note.name, content: note.content, createdBy: note.createdBy, updatedAt: note.at })
    .onConflictDoUpdate({
      target: [notes.chatId, notes.name],
      set: { content: note.content, updatedAt: note.at },
    });
}

export async function noteGet(db: Db, chatId: number, name: string): Promise<NoteRow | null> {
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.chatId, chatId), eq(notes.name, name)))
    .limit(1);
  return (rows as NoteRow[])[0] ?? null;
}

export async function noteList(db: Db, chatId: number): Promise<NoteRow[]> {
  return (await db.select().from(notes).where(eq(notes.chatId, chatId)).orderBy(notes.name)) as NoteRow[];
}

export async function noteDelete(db: Db, chatId: number, name: string): Promise<void> {
  await db.delete(notes).where(and(eq(notes.chatId, chatId), eq(notes.name, name)));
}

export async function filterAdd(
  db: Db,
  filter: { chatId: number; trigger: string; match: string; response: string; createdBy: number; at: number },
): Promise<void> {
  await db.insert(replyFilters).values({
    chatId: filter.chatId,
    trigger: filter.trigger,
    match: filter.match,
    response: filter.response,
    createdBy: filter.createdBy,
    createdAt: filter.at,
  });
}

export async function filterList(db: Db, chatId: number): Promise<FilterRow[]> {
  return (await db.select().from(replyFilters).where(eq(replyFilters.chatId, chatId)).orderBy(replyFilters.id)) as FilterRow[];
}

export async function filterDelete(db: Db, chatId: number, id: number): Promise<void> {
  await db.delete(replyFilters).where(and(eq(replyFilters.chatId, chatId), eq(replyFilters.id, id)));
}

// ---------------------------------------------------------------------------
// Shared ban list and trust
// ---------------------------------------------------------------------------

export async function banAdd(
  db: Db,
  ban: { userId: number; reason?: string; source?: string; at: number },
): Promise<void> {
  await db
    .insert(bannedUsers)
    .values({ userId: ban.userId, reason: (ban.reason ?? "").slice(0, 200), source: ban.source ?? "local", at: ban.at })
    .onConflictDoUpdate({
      target: bannedUsers.userId,
      set: { reason: (ban.reason ?? "").slice(0, 200), source: ban.source ?? "local", at: ban.at },
    });
}

export async function banGet(db: Db, userId: number): Promise<{ reason: string; source: string; at: number } | null> {
  const rows = await db
    .select({ reason: bannedUsers.reason, source: bannedUsers.source, at: bannedUsers.at })
    .from(bannedUsers)
    .where(eq(bannedUsers.userId, userId))
    .limit(1);
  return (rows as { reason: string; source: string; at: number }[])[0] ?? null;
}

export async function banCount(db: Db): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)` }).from(bannedUsers);
  return Number((rows as { n: number }[])[0]?.n ?? 0);
}

export async function trustAdd(db: Db, chatId: number, userId: number, at: number): Promise<void> {
  await db.insert(trustedUsers).values({ chatId, userId, at }).onConflictDoNothing();
}

export async function isTrusted(db: Db, chatId: number, userId: number): Promise<boolean> {
  const rows = await db
    .select({ userId: trustedUsers.userId })
    .from(trustedUsers)
    .where(and(eq(trustedUsers.chatId, chatId), eq(trustedUsers.userId, userId)))
    .limit(1);
  return (rows as { userId: number }[]).length > 0;
}

// ---------------------------------------------------------------------------
// Stats and dependency health
// ---------------------------------------------------------------------------

export type ChatStats = {
  totals: Record<string, number>;
  perDay: { day: string; kind: string; n: number }[];
};

export async function chatStats(db: Db, chatId: number, sinceMs: number): Promise<ChatStats> {
  const totals = (await db
    .select({ kind: events.kind, n: sql<number>`count(*)` })
    .from(events)
    .where(and(eq(events.chatId, chatId), gte(events.at, sinceMs)))
    .groupBy(events.kind)) as { kind: string; n: number }[];

  const day = sql<string>`date(${events.at} / 1000, 'unixepoch')`;
  const perDay = (await db
    .select({ day, kind: events.kind, n: sql<number>`count(*)` })
    .from(events)
    .where(and(eq(events.chatId, chatId), gte(events.at, sinceMs)))
    .groupBy(day, events.kind)) as { day: string; kind: string; n: number }[];

  return {
    totals: Object.fromEntries(totals.map((row) => [row.kind, Number(row.n)])),
    perDay: perDay.map((row) => ({ day: row.day, kind: row.kind, n: Number(row.n) })),
  };
}

export async function recentEvents(db: Db, chatId: number, limit = 10): Promise<{ kind: string; reason: string; userId: number; at: number }[]> {
  return (await db
    .select({ kind: events.kind, reason: events.reason, userId: events.userId, at: events.at })
    .from(events)
    .where(eq(events.chatId, chatId))
    .orderBy(desc(events.at))
    .limit(limit)) as { kind: string; reason: string; userId: number; at: number }[];
}

export async function healthMark(db: Db, name: string, ok: boolean, error: string, at: number): Promise<void> {
  const patch = ok
    ? { failures: 0, lastOkAt: at }
    : { failures: sql`${externalHealth.failures} + 1`, lastError: error.slice(0, 200), lastErrorAt: at };
  await db
    .insert(externalHealth)
    .values({ name, failures: ok ? 0 : 1, lastOkAt: ok ? at : 0, lastError: ok ? "" : error.slice(0, 200), lastErrorAt: ok ? 0 : at })
    .onConflictDoUpdate({ target: externalHealth.name, set: patch });
}

export async function healthAll(db: Db): Promise<{ name: string; failures: number; lastOkAt: number; lastError: string }[]> {
  return (await db
    .select({
      name: externalHealth.name,
      failures: externalHealth.failures,
      lastOkAt: externalHealth.lastOkAt,
      lastError: externalHealth.lastError,
    })
    .from(externalHealth)) as { name: string; failures: number; lastOkAt: number; lastError: string }[];
}

/** Column reference kept for callers that build their own filters. */
export type Column = SQLiteColumn;

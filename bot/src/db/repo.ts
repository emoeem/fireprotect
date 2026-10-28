/**
 * Query layer over the SQLite schema.
 *
 * Every driver (D1 on Workers, `node:sqlite` locally) speaks the same dialect,
 * so this file is driver-agnostic; `d1.ts` and `node-sqlite.ts` only build the
 * connection.
 */
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  aiUsage,
  bannedUsers,
  blockedUsers,
  chats,
  events,
  externalHealth,
  notes,
  replyFilters,
  rssFeeds,
  scheduledMessages,
  syncSources,
  toolUsage,
  trustedUsers,
  parseJobs,
  warnings,
  wordStats,
  type FilterRow,
  type NoteRow,
  type ParseJobRow,
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
  | "trust"
  | "block"
  /** Recorded but not acted on: keyword whitelist, watch-only rules. */
  | "watch";

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
/**
 * A warning older than this counts as served: the ladder judges recent
 * behavior, and a strike from two months ago should not ban someone today.
 * Decay is lazy — applied on read and increment, so no cron row is needed.
 */
export const WARN_DECAY_MS = 30 * 86_400_000;

/** Current warning count with decay applied; a decayed row is cleared so
 *  `/unwarn` cannot resurrect a stale number. */
async function effectiveWarnCount(db: Db, chatId: number, userId: number, at: number): Promise<number> {
  const rows = (await db
    .select({ count: warnings.count, updatedAt: warnings.updatedAt })
    .from(warnings)
    .where(and(eq(warnings.chatId, chatId), eq(warnings.userId, userId)))
    .limit(1)) as { count: number; updatedAt: number }[];
  const row = rows[0];
  if (!row) return 0;
  if (at - row.updatedAt > WARN_DECAY_MS) {
    await db.delete(warnings).where(and(eq(warnings.chatId, chatId), eq(warnings.userId, userId)));
    return 0;
  }
  return Number(row.count);
}

export async function warnInc(db: Db, chatId: number, userId: number, at: number): Promise<number> {
  // Read-then-write is safe here: every caller sits behind the per-chat lock,
  // which is the same serialization the whole punishment path relies on.
  const current = await effectiveWarnCount(db, chatId, userId, at);
  const next = current + 1;
  await db
    .insert(warnings)
    .values({ chatId, userId, count: next, updatedAt: at })
    .onConflictDoUpdate({
      target: [warnings.chatId, warnings.userId],
      set: { count: next, updatedAt: at },
    });
  return next;
}

export async function warnCount(db: Db, chatId: number, userId: number, at: number): Promise<number> {
  return effectiveWarnCount(db, chatId, userId, at);
}

/** `count = max(count - 1, 0)`, deleting the row when it reaches zero. */
export async function warnDec(db: Db, chatId: number, userId: number, at: number): Promise<number> {
  const current = await effectiveWarnCount(db, chatId, userId, at);
  if (current <= 0) {
    await db.delete(warnings).where(and(eq(warnings.chatId, chatId), eq(warnings.userId, userId)));
    return 0;
  }
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

export async function banList(
  db: Db,
  limit = 200,
  options: { offset?: number; q?: string } = {},
): Promise<{ userId: number; reason: string; source: string; at: number }[]> {
  const q = String(options.q ?? "").trim();
  const where = q
    ? sql`cast(${bannedUsers.userId} as text) like ${`%${q}%`} or ${bannedUsers.reason} like ${`%${q}%`}`
    : undefined;
  return (await db
    .select({ userId: bannedUsers.userId, reason: bannedUsers.reason, source: bannedUsers.source, at: bannedUsers.at })
    .from(bannedUsers)
    .where(where)
    .orderBy(desc(bannedUsers.at))
    .limit(limit)
    .offset(Math.max(0, options.offset ?? 0))) as { userId: number; reason: string; source: string; at: number }[];
}

export async function banDelete(db: Db, userId: number): Promise<void> {
  await db.delete(bannedUsers).where(eq(bannedUsers.userId, userId));
}

export async function banCount(db: Db): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)` }).from(bannedUsers);
  return Number((rows as { n: number }[])[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Cross-group member audit: everything the bot knows about one person.
// ---------------------------------------------------------------------------

export async function userEventsAll(
  db: Db,
  userId: number,
  limit = 100,
): Promise<{ chatId: number; kind: string; reason: string; byId: number; at: number }[]> {
  return (await db
    .select({ chatId: events.chatId, kind: events.kind, reason: events.reason, byId: events.byId, at: events.at })
    .from(events)
    .where(eq(events.userId, userId))
    .orderBy(desc(events.at))
    .limit(limit)) as { chatId: number; kind: string; reason: string; byId: number; at: number }[];
}

export async function userWarnings(db: Db, userId: number): Promise<{ chatId: number; count: number; updatedAt: number }[]> {
  return (await db
    .select({ chatId: warnings.chatId, count: warnings.count, updatedAt: warnings.updatedAt })
    .from(warnings)
    .where(eq(warnings.userId, userId))
    .orderBy(desc(warnings.updatedAt))) as { chatId: number; count: number; updatedAt: number }[];
}

export async function userBlocks(db: Db, userId: number): Promise<{ chatId: number; reason: string; byId: number; at: number }[]> {
  return (await db
    .select({ chatId: blockedUsers.chatId, reason: blockedUsers.reason, byId: blockedUsers.byId, at: blockedUsers.at })
    .from(blockedUsers)
    .where(eq(blockedUsers.userId, userId))
    .orderBy(desc(blockedUsers.at))) as { chatId: number; reason: string; byId: number; at: number }[];
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

export async function recentEvents(
  db: Db,
  chatId: number,
  limit = 10,
  options: { offset?: number; kind?: string } = {},
): Promise<{ kind: string; reason: string; userId: number; byId: number; at: number }[]> {
  const where = options.kind ? and(eq(events.chatId, chatId), eq(events.kind, options.kind)) : eq(events.chatId, chatId);
  return (await db
    .select({ kind: events.kind, reason: events.reason, userId: events.userId, byId: events.byId, at: events.at })
    .from(events)
    .where(where)
    .orderBy(desc(events.at))
    .limit(limit)
    .offset(Math.max(0, options.offset ?? 0))) as { kind: string; reason: string; userId: number; byId: number; at: number }[];
}

/** One member's timeline in one chat — the `/warns <id>` query. */
export async function userEvents(
  db: Db,
  chatId: number,
  userId: number,
  limit = 20,
): Promise<{ kind: string; reason: string; byId: number; at: number }[]> {
  return (await db
    .select({ kind: events.kind, reason: events.reason, byId: events.byId, at: events.at })
    .from(events)
    .where(and(eq(events.chatId, chatId), eq(events.userId, userId)))
    .orderBy(desc(events.at))
    .limit(limit)) as { kind: string; reason: string; byId: number; at: number }[];
}

/** Cross-chat event totals since a point in time — the overview's single query. */
export async function eventsKindTotals(db: Db, sinceMs: number): Promise<Record<string, number>> {
  return eventsKindTotalsBetween(db, sinceMs, Number.MAX_SAFE_INTEGER);
}

export async function eventsKindTotalsBetween(db: Db, fromMs: number, toMs: number): Promise<Record<string, number>> {
  const rows = (await db
    .select({ kind: events.kind, n: sql<number>`count(*)` })
    .from(events)
    .where(and(gte(events.at, fromMs), lt(events.at, toMs)))
    .groupBy(events.kind)) as { kind: string; n: number }[];
  return Object.fromEntries(rows.map((row) => [row.kind, Number(row.n)]));
}

/** Row count of scheduled messages without reading the full rows. */
export async function scheduleCount(db: Db): Promise<number> {
  const rows = (await db.select({ n: sql<number>`count(*)` }).from(scheduledMessages)) as { n: number }[];
  return Number(rows[0]?.n ?? 0);
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

// ---------------------------------------------------------------------------
// Chat registry and scheduled messages
// ---------------------------------------------------------------------------

export async function rememberChat(
  db: Db,
  chat: { chatId: number; title: string; type: string; at: number },
): Promise<void> {
  await db
    .insert(chats)
    .values({ chatId: chat.chatId, title: chat.title.slice(0, 120), type: chat.type, addedAt: chat.at, lastSeenAt: chat.at })
    .onConflictDoUpdate({
      target: chats.chatId,
      set: { title: chat.title.slice(0, 120), type: chat.type, lastSeenAt: chat.at },
    });
}

export async function listChats(db: Db): Promise<{ chatId: number; title: string; type: string; lastSeenAt: number }[]> {
  return (await db
    .select({ chatId: chats.chatId, title: chats.title, type: chats.type, lastSeenAt: chats.lastSeenAt })
    .from(chats)
    .orderBy(desc(chats.lastSeenAt))) as { chatId: number; title: string; type: string; lastSeenAt: number }[];
}

export type ScheduledRow = {
  id: number;
  chatId: number;
  text: string;
  every: number;
  nextAt: number;
  enabled: number;
  sent: number;
  lastError: string;
};

export async function scheduleAdd(
  db: Db,
  row: { chatId: number; text: string; every: number; nextAt: number; createdBy: number },
): Promise<void> {
  await db.insert(scheduledMessages).values({ ...row, enabled: 1, sent: 0, lastError: "" });
}

export async function scheduleList(db: Db, chatId?: number): Promise<ScheduledRow[]> {
  const query = db
    .select({
      id: scheduledMessages.id,
      chatId: scheduledMessages.chatId,
      text: scheduledMessages.text,
      every: scheduledMessages.every,
      nextAt: scheduledMessages.nextAt,
      enabled: scheduledMessages.enabled,
      sent: scheduledMessages.sent,
      lastError: scheduledMessages.lastError,
    })
    .from(scheduledMessages);
  const rows = chatId ? await query.where(eq(scheduledMessages.chatId, chatId)) : await query;
  return (rows as ScheduledRow[]).sort((a, b) => a.nextAt - b.nextAt);
}

export async function scheduleDue(db: Db, nowMs: number, limit = 10): Promise<ScheduledRow[]> {
  return (await db
    .select({
      id: scheduledMessages.id,
      chatId: scheduledMessages.chatId,
      text: scheduledMessages.text,
      every: scheduledMessages.every,
      nextAt: scheduledMessages.nextAt,
      enabled: scheduledMessages.enabled,
      sent: scheduledMessages.sent,
      lastError: scheduledMessages.lastError,
    })
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.enabled, 1), sql`${scheduledMessages.nextAt} <= ${nowMs}`))
    .limit(limit)) as ScheduledRow[];
}

export async function scheduleMarkSent(db: Db, id: number, nextAt: number | null, error = ""): Promise<void> {
  if (nextAt === null) {
    await db.update(scheduledMessages).set({ enabled: 0, lastError: error.slice(0, 200) }).where(eq(scheduledMessages.id, id));
    return;
  }
  await db
    .update(scheduledMessages)
    .set({ nextAt, sent: sql`${scheduledMessages.sent} + 1`, lastError: error.slice(0, 200) })
    .where(eq(scheduledMessages.id, id));
}

export async function scheduleDelete(db: Db, id: number, chatId?: number): Promise<void> {
  const where = chatId ? and(eq(scheduledMessages.id, id), eq(scheduledMessages.chatId, chatId)) : eq(scheduledMessages.id, id);
  await db.delete(scheduledMessages).where(where);
}

export async function scheduleToggle(db: Db, id: number, enabled: boolean, nextAt?: number): Promise<void> {
  await db
    .update(scheduledMessages)
    .set(nextAt === undefined ? { enabled: enabled ? 1 : 0 } : { enabled: enabled ? 1 : 0, nextAt })
    .where(eq(scheduledMessages.id, id));
}

// ---------------------------------------------------------------------------
// Shadow bans
// ---------------------------------------------------------------------------

export async function blockAdd(
  db: Db,
  row: { chatId: number; userId: number; reason?: string; byId?: number; at: number },
): Promise<void> {
  await db
    .insert(blockedUsers)
    .values({ chatId: row.chatId, userId: row.userId, reason: (row.reason ?? "").slice(0, 200), byId: row.byId ?? 0, at: row.at })
    .onConflictDoUpdate({
      target: [blockedUsers.chatId, blockedUsers.userId],
      set: { reason: (row.reason ?? "").slice(0, 200), byId: row.byId ?? 0, at: row.at },
    });
}

export async function blockRemove(db: Db, chatId: number, userId: number): Promise<void> {
  await db.delete(blockedUsers).where(and(eq(blockedUsers.chatId, chatId), eq(blockedUsers.userId, userId)));
}

export async function isBlocked(db: Db, chatId: number, userId: number): Promise<boolean> {
  const rows = await db
    .select({ userId: blockedUsers.userId })
    .from(blockedUsers)
    .where(and(eq(blockedUsers.chatId, chatId), eq(blockedUsers.userId, userId)))
    .limit(1);
  return (rows as { userId: number }[]).length > 0;
}

export async function blockList(
  db: Db,
  chatId: number,
  limit = 200,
): Promise<{ userId: number; reason: string; byId: number; at: number }[]> {
  return (await db
    .select({ userId: blockedUsers.userId, reason: blockedUsers.reason, byId: blockedUsers.byId, at: blockedUsers.at })
    .from(blockedUsers)
    .where(eq(blockedUsers.chatId, chatId))
    .orderBy(desc(blockedUsers.at))
    .limit(limit)) as { userId: number; reason: string; byId: number; at: number }[];
}

// ---------------------------------------------------------------------------
// Channel mirrors
// ---------------------------------------------------------------------------

export type SyncRow = {
  id: number;
  chatId: number;
  source: string;
  intervalSeconds: number;
  lastId: number;
  enabled: number;
  failures: number;
  lastError: string;
  sent: number;
  at: number;
};

export async function syncUpsert(
  db: Db,
  row: { chatId: number; source: string; intervalSeconds: number; at: number },
): Promise<void> {
  await db
    .insert(syncSources)
    .values({
      chatId: row.chatId,
      source: row.source,
      intervalSeconds: row.intervalSeconds,
      lastId: 0,
      enabled: 1,
      failures: 0,
      lastError: "",
      sent: 0,
      at: row.at,
    })
    .onConflictDoUpdate({
      target: [syncSources.chatId, syncSources.source],
      set: { intervalSeconds: row.intervalSeconds, enabled: 1, failures: 0, lastError: "", at: row.at },
    });
}

export async function syncList(db: Db, chatId?: number): Promise<SyncRow[]> {
  const query = db.select().from(syncSources);
  return (await (chatId === undefined ? query : query.where(eq(syncSources.chatId, chatId))).orderBy(
    syncSources.id,
  )) as SyncRow[];
}

export async function syncDelete(db: Db, chatId: number, source: string): Promise<void> {
  await db.delete(syncSources).where(and(eq(syncSources.chatId, chatId), eq(syncSources.source, source)));
}

export async function syncEnable(db: Db, chatId: number, source: string, enabled: boolean): Promise<void> {
  await db
    .update(syncSources)
    .set({ enabled: enabled ? 1 : 0, failures: 0, lastError: "" })
    .where(and(eq(syncSources.chatId, chatId), eq(syncSources.source, source)));
}

/** Instant mirrors are handled on update arrival; only polled rows appear here. */
export async function syncPollable(db: Db): Promise<SyncRow[]> {
  const rows = (await db
    .select()
    .from(syncSources)
    .where(and(eq(syncSources.enabled, 1), sql`${syncSources.intervalSeconds} > 0`))) as SyncRow[];
  return rows;
}

export async function syncMark(
  db: Db,
  id: number,
  patch: { lastId?: number; sent?: number; failures?: number; lastError?: string; enabled?: number; at: number },
): Promise<void> {
  const set: Record<string, unknown> = { at: patch.at };
  if (patch.lastId !== undefined) set.lastId = patch.lastId;
  if (patch.sent !== undefined) set.sent = sql`${syncSources.sent} + ${patch.sent}`;
  if (patch.failures !== undefined) set.failures = patch.failures;
  if (patch.lastError !== undefined) set.lastError = patch.lastError.slice(0, 200);
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  await db.update(syncSources).set(set).where(eq(syncSources.id, id));
}

// ---------------------------------------------------------------------------
// Toolbox usage
// ---------------------------------------------------------------------------

export async function toolLog(
  db: Db,
  row: { chatId: number; userId?: number; tool: string; ok?: boolean; bytes?: number; at: number },
): Promise<void> {
  await db.insert(toolUsage).values({
    chatId: row.chatId,
    userId: row.userId ?? 0,
    tool: row.tool,
    ok: row.ok === false ? 0 : 1,
    bytes: row.bytes ?? 0,
    at: row.at,
  });
}

export async function toolStats(
  db: Db,
  chatId: number,
  sinceMs: number,
): Promise<{ tool: string; runs: number; ok: number; bytes: number }[]> {
  return (await db
    .select({
      tool: toolUsage.tool,
      runs: sql<number>`count(*)`,
      ok: sql<number>`sum(${toolUsage.ok})`,
      bytes: sql<number>`sum(${toolUsage.bytes})`,
    })
    .from(toolUsage)
    .where(and(eq(toolUsage.chatId, chatId), gte(toolUsage.at, sinceMs)))
    .groupBy(toolUsage.tool)) as { tool: string; runs: number; ok: number; bytes: number }[];
}

// ---------------------------------------------------------------------------
// Hot words, AI usage, parse jobs
// ---------------------------------------------------------------------------

/**
 * Merge one bucket of counts into today's row.
 *
 * One statement for the whole bucket, not one per word: a busy group produces
 * thirty distinct tokens in ten minutes, and thirty round trips per flush is
 * how a free-tier D1 account runs out of writes.
 */
export async function wordBump(db: Db, chatId: number, day: string, entries: [string, number][]): Promise<void> {
  if (!entries.length) return;
  const rows = entries.slice(0, 200).map(([word, count]) => ({ chatId, day, word: word.slice(0, 40), count }));
  await db
    .insert(wordStats)
    .values(rows)
    .onConflictDoUpdate({
      target: [wordStats.chatId, wordStats.day, wordStats.word],
      set: { count: sql`${wordStats.count} + excluded."count"` },
    });
}

export async function wordTop(db: Db, chatId: number, day: string, limit = 15, minCount = 2): Promise<{ word: string; count: number }[]> {
  const rows = (await db
    .select({ word: wordStats.word, count: wordStats.count })
    .from(wordStats)
    .where(and(eq(wordStats.chatId, chatId), eq(wordStats.day, day), gte(wordStats.count, minCount)))
    .orderBy(desc(wordStats.count))
    .limit(limit)) as { word: string; count: number }[];
  return rows;
}

/** Per-day totals for the console chart: how much conversation, not which words. */
export async function wordDayTotals(db: Db, chatId: number, days: number): Promise<{ day: string; words: number; total: number }[]> {
  const rows = (await db
    .select({ day: wordStats.day, words: sql<number>`count(*)`, total: sql<number>`sum(${wordStats.count})` })
    .from(wordStats)
    .where(eq(wordStats.chatId, chatId))
    .groupBy(wordStats.day)
    .orderBy(desc(wordStats.day))
    .limit(Math.max(1, Math.min(days, 60)))) as { day: string; words: number; total: number }[];
  return rows.reverse();
}

export async function aiUsageBump(
  db: Db,
  chatId: number,
  day: string,
  patch: { calls?: number; hits?: number; failures?: number; ms?: number },
): Promise<void> {
  const calls = patch.calls ?? 0;
  const hits = patch.hits ?? 0;
  const failures = patch.failures ?? 0;
  const ms = patch.ms ?? 0;
  await db
    .insert(aiUsage)
    .values({ chatId, day, calls, hits, failures, ms })
    .onConflictDoUpdate({
      target: [aiUsage.chatId, aiUsage.day],
      set: {
        calls: sql`${aiUsage.calls} + ${calls}`,
        hits: sql`${aiUsage.hits} + ${hits}`,
        failures: sql`${aiUsage.failures} + ${failures}`,
        ms: sql`${aiUsage.ms} + ${ms}`,
      },
    });
}

export async function aiUsageGet(db: Db, chatId: number, day: string): Promise<{ calls: number; hits: number; failures: number; ms: number }> {
  const rows = (await db
    .select({ calls: aiUsage.calls, hits: aiUsage.hits, failures: aiUsage.failures, ms: aiUsage.ms })
    .from(aiUsage)
    .where(and(eq(aiUsage.chatId, chatId), eq(aiUsage.day, day)))
    .limit(1)) as { calls: number; hits: number; failures: number; ms: number }[];
  return rows[0] ?? { calls: 0, hits: 0, failures: 0, ms: 0 };
}

export async function aiUsageSeries(db: Db, chatId: number, days: number): Promise<{ day: string; calls: number; hits: number; failures: number }[]> {
  const rows = (await db
    .select({ day: aiUsage.day, calls: aiUsage.calls, hits: aiUsage.hits, failures: aiUsage.failures })
    .from(aiUsage)
    .where(eq(aiUsage.chatId, chatId))
    .orderBy(desc(aiUsage.day))
    .limit(Math.max(1, Math.min(days, 60)))) as { day: string; calls: number; hits: number; failures: number }[];
  return rows.reverse();
}

export async function parseJobAdd(
  db: Db,
  job: { chatId: number; userId: number; messageId: number; url: string; site: string; mode: string; at: number },
): Promise<number> {
  const rows = (await db
    .insert(parseJobs)
    .values({ ...job, status: "pending", updatedAt: job.at })
    .returning({ id: parseJobs.id })) as { id: number }[];
  return Number(rows[0]?.id ?? 0);
}

export async function parseJobFinish(
  db: Db,
  id: number,
  patch: { status: "done" | "failed"; media?: number; error?: string; mode?: string; at: number },
): Promise<void> {
  await db
    .update(parseJobs)
    .set({
      status: patch.status,
      media: patch.media ?? 0,
      error: String(patch.error ?? "").slice(0, 300),
      ...(patch.mode ? { mode: patch.mode } : {}),
      updatedAt: patch.at,
    })
    .where(eq(parseJobs.id, id));
}

export async function parseJobsRecent(db: Db, chatId: number, limit = 20): Promise<ParseJobRow[]> {
  return (await db
    .select()
    .from(parseJobs)
    .where(eq(parseJobs.chatId, chatId))
    .orderBy(desc(parseJobs.at))
    .limit(Math.max(1, Math.min(limit, 100)))) as ParseJobRow[];
}

/** Jobs left `pending` by a crash; the self-hosted node retries them. */
export async function parseJobsStale(db: Db, olderThanMs: number, limit = 5): Promise<ParseJobRow[]> {
  return (await db
    .select()
    .from(parseJobs)
    .where(and(eq(parseJobs.status, "pending"), sql`${parseJobs.at} <= ${olderThanMs}`))
    .orderBy(parseJobs.at)
    .limit(limit)) as ParseJobRow[];
}

export async function parseJobStats(
  db: Db,
  chatId: number,
  sinceMs: number,
): Promise<{ total: number; done: number; failed: number; pending: number; media: number }> {
  const rows = (await db
    .select({ status: parseJobs.status, n: sql<number>`count(*)`, media: sql<number>`sum(${parseJobs.media})` })
    .from(parseJobs)
    .where(and(eq(parseJobs.chatId, chatId), gte(parseJobs.at, sinceMs)))
    .groupBy(parseJobs.status)) as { status: string; n: number; media: number }[];
  const out = { total: 0, done: 0, failed: 0, pending: 0, media: 0 };
  for (const row of rows) {
    const n = Number(row.n ?? 0);
    out.total += n;
    out.media += Number(row.media ?? 0);
    if (row.status === "done") out.done = n;
    if (row.status === "failed") out.failed = n;
    if (row.status === "pending") out.pending = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// RSS subscriptions
// ---------------------------------------------------------------------------

export type RssFeedRow = {
  id: number;
  chatId: number;
  url: string;
  title: string;
  lastKey: string;
  failures: number;
  lastError: string;
  sent: number;
  at: number;
  lastSeenAt: number;
};

/**
 * Add a feed, or refresh the title of the one that is already there.
 *
 * The conflict branch deliberately does NOT reset `lastKey` or `failures`: a
 * duplicate `/sub` of a URL that is already being delivered must not replay the
 * whole feed into the group, and must not wipe the consecutive-failure count
 * that is about to retire a dead feed.
 */
export async function rssFeedAdd(
  db: Db,
  row: { chatId: number; url: string; title?: string; at: number },
): Promise<number> {
  const title = (row.title ?? "").slice(0, 120);
  const rows = (await db
    .insert(rssFeeds)
    .values({
      chatId: row.chatId,
      url: row.url,
      title,
      lastKey: "",
      failures: 0,
      lastError: "",
      sent: 0,
      at: row.at,
      lastSeenAt: 0,
    })
    .onConflictDoUpdate({
      target: [rssFeeds.chatId, rssFeeds.url],
      set: { title, at: row.at },
    })
    .returning({ id: rssFeeds.id })) as { id: number }[];
  return Number(rows[0]?.id ?? 0);
}

export async function rssFeedList(db: Db, chatId: number): Promise<RssFeedRow[]> {
  return (await db.select().from(rssFeeds).where(eq(rssFeeds.chatId, chatId)).orderBy(rssFeeds.id)) as RssFeedRow[];
}

export async function rssFeedGet(db: Db, chatId: number, id: number): Promise<RssFeedRow | null> {
  const rows = (await db
    .select()
    .from(rssFeeds)
    .where(and(eq(rssFeeds.chatId, chatId), eq(rssFeeds.id, id)))
    .limit(1)) as RssFeedRow[];
  return rows[0] ?? null;
}

export async function rssFeedByUrl(db: Db, chatId: number, url: string): Promise<RssFeedRow | null> {
  const rows = (await db
    .select()
    .from(rssFeeds)
    .where(and(eq(rssFeeds.chatId, chatId), eq(rssFeeds.url, url)))
    .limit(1)) as RssFeedRow[];
  return rows[0] ?? null;
}

export async function rssFeedCount(db: Db, chatId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(rssFeeds)
    .where(eq(rssFeeds.chatId, chatId));
  return Number((rows as { n: number }[])[0]?.n ?? 0);
}

/** Scoped by chat: an id from another group must never be removable here. */
export async function rssFeedDelete(db: Db, chatId: number, id: number): Promise<void> {
  await db.delete(rssFeeds).where(and(eq(rssFeeds.chatId, chatId), eq(rssFeeds.id, id)));
}

/**
 * Feeds to poll, least recently polled first.
 *
 * Ordering by `at` rather than id is what makes the `limit` a rotation instead
 * of a permanent starvation of every feed past the limit.
 */
export async function rssPollable(db: Db, limit = 20): Promise<RssFeedRow[]> {
  return (await db
    .select()
    .from(rssFeeds)
    .orderBy(rssFeeds.at, rssFeeds.id)
    .limit(Math.max(1, Math.min(limit, 200)))) as RssFeedRow[];
}

export async function rssFeedMark(
  db: Db,
  id: number,
  patch: {
    lastKey?: string;
    sent?: number;
    failures?: number;
    lastError?: string;
    title?: string;
    at?: number;
    lastSeenAt?: number;
  },
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.lastKey !== undefined) set.lastKey = patch.lastKey.slice(0, 300);
  if (patch.sent !== undefined) set.sent = sql`${rssFeeds.sent} + ${patch.sent}`;
  if (patch.failures !== undefined) set.failures = patch.failures;
  if (patch.lastError !== undefined) set.lastError = patch.lastError.slice(0, 200);
  if (patch.title !== undefined) set.title = patch.title.slice(0, 120);
  if (patch.at !== undefined) set.at = patch.at;
  if (patch.lastSeenAt !== undefined) set.lastSeenAt = patch.lastSeenAt;
  if (!Object.keys(set).length) return;
  await db.update(rssFeeds).set(set).where(eq(rssFeeds.id, id));
}

// ---------------------------------------------------------------------------
// Retention. Every table below was append-only until this point, which made
// D1 storage grow without bound and "delete my data" unanswerable. The cutoffs
// are intentionally generous: these tables exist so an admin can look back.
// ---------------------------------------------------------------------------

/** How long each append-only table keeps rows, in days. */
export const RETENTION_DAYS = {
  events: 90,
  wordStats: 365,
  aiUsage: 180,
  parseJobs: 30,
  toolUsage: 180,
} as const;

const cutoffAt = (now: number, days: number): number => now - days * 86_400_000;

/** `day` columns are `YYYY-MM-DD` in the deployment's timezone; the UTC-based
 *  cutoff can therefore be off by one day at the edges, which a 180–365 day
 *  retention window does not care about. */
const cutoffDay = (now: number, days: number): string => new Date(cutoffAt(now, days)).toISOString().slice(0, 10);

export function eventsPrune(db: Db, now: number, days = RETENTION_DAYS.events): Promise<unknown> {
  return db.delete(events).where(lt(events.at, cutoffAt(now, days)));
}

export function wordStatsPrune(db: Db, now: number, days = RETENTION_DAYS.wordStats): Promise<unknown> {
  return db.delete(wordStats).where(lt(wordStats.day, cutoffDay(now, days)));
}

export function aiUsagePrune(db: Db, now: number, days = RETENTION_DAYS.aiUsage): Promise<unknown> {
  return db.delete(aiUsage).where(lt(aiUsage.day, cutoffDay(now, days)));
}

export function parseJobsPrune(db: Db, now: number, days = RETENTION_DAYS.parseJobs): Promise<unknown> {
  return db.delete(parseJobs).where(lt(parseJobs.at, cutoffAt(now, days)));
}

export function toolUsagePrune(db: Db, now: number, days = RETENTION_DAYS.toolUsage): Promise<unknown> {
  return db.delete(toolUsage).where(lt(toolUsage.at, cutoffAt(now, days)));
}

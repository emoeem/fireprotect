import assert from "node:assert/strict";
import { test } from "node:test";
import { runRetention } from "../src/scheduler.ts";
import { RETENTION_DAYS } from "../src/db/repo.ts";
import { aiUsage, events, parseJobs, toolUsage, wordStats } from "../src/db/schema.ts";
import { GROUP, makeRuntime } from "./harness.ts";

const DAY = 86_400_000;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const count = async (h: Awaited<ReturnType<typeof makeRuntime>>, table: any): Promise<number> =>
  (await h.rt.db.select().from(table)).length;

test("retention prunes only the rows past each table's cutoff", async () => {
  const h = await makeRuntime();
  const now = h.now();
  // Each table gets its own "old" row: a row older than one table's window can
  // easily be younger than another's (events 90d vs tool_usage 180d).
  const oldAt = (days: number): number => now - (days + 5) * DAY;
  const newAt = now - DAY;
  const oldDay = (days: number): string => dayOf(now - (days + 5) * DAY);
  const newDay = dayOf(now - DAY);

  await h.rt.db.insert(events).values([
    { chatId: GROUP.id, userId: 500, kind: "delete", reason: "旧", at: oldAt(RETENTION_DAYS.events) },
    { chatId: GROUP.id, userId: 500, kind: "delete", reason: "新", at: newAt },
  ]);
  await h.rt.db.insert(wordStats).values([
    { chatId: GROUP.id, day: oldDay(RETENTION_DAYS.wordStats), word: "旧词", count: 1 },
    { chatId: GROUP.id, day: newDay, word: "新词", count: 1 },
  ]);
  await h.rt.db.insert(aiUsage).values([
    { chatId: GROUP.id, day: oldDay(RETENTION_DAYS.aiUsage), calls: 1 },
    { chatId: GROUP.id, day: newDay, calls: 1 },
  ]);
  await h.rt.db.insert(parseJobs).values([
    { chatId: GROUP.id, url: "https://a.example/old", status: "done", at: oldAt(RETENTION_DAYS.parseJobs), updatedAt: oldAt(RETENTION_DAYS.parseJobs) },
    { chatId: GROUP.id, url: "https://a.example/new", status: "done", at: newAt, updatedAt: newAt },
  ]);
  await h.rt.db.insert(toolUsage).values([
    { chatId: GROUP.id, userId: 500, tool: "timestamp", at: oldAt(RETENTION_DAYS.toolUsage) },
    { chatId: GROUP.id, userId: 500, tool: "timestamp", at: newAt },
  ]);

  const result = await runRetention(h.rt);
  assert.deepEqual(result, { pruned: true, failed: [] });
  assert.equal(await count(h, events), 1, "only the fresh event survives");
  assert.equal(await count(h, wordStats), 1);
  assert.equal(await count(h, aiUsage), 1);
  assert.equal(await count(h, parseJobs), 1);
  assert.equal(await count(h, toolUsage), 1);
});

test("the hourly gate skips a second run until the next hour bucket", async () => {
  const h = await makeRuntime();
  assert.deepEqual(await runRetention(h.rt), { pruned: true, failed: [] });

  const oldAt = h.now() - (RETENTION_DAYS.parseJobs + 5) * DAY;
  await h.rt.db.insert(parseJobs).values({ chatId: GROUP.id, url: "https://a.example/x", status: "done", at: oldAt, updatedAt: oldAt });
  assert.deepEqual(await runRetention(h.rt), { pruned: false, failed: [] }, "same hour bucket is skipped");
  assert.equal(await count(h, parseJobs), 1, "nothing was deleted on the skipped run");

  h.advance(2 * 3_600_000);
  assert.deepEqual(await runRetention(h.rt), { pruned: true, failed: [] });
  assert.equal(await count(h, parseJobs), 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { handleApi, mintSession } from "../src/admin/api.ts";
import { handleUpdate } from "../src/bot.ts";
import { memberList, memberTopDay, memberActivitySince } from "../src/db/repo.ts";
import { flushMemberStats, leaderboard, leaderboardText } from "../src/members.ts";
import { runScheduled } from "../src/scheduler.ts";
import { scheduleAdd, scheduleDue } from "../src/db/repo.ts";
import { dayKey } from "../src/ai/words.ts";
import { makeRuntime, message, nextUpdate, user } from "./harness.ts";

const env = () => ({ BOT_TOKEN: "123:abc", ADMIN_TOKEN: "adm1n" });
const authed = async (h: { rt: { now: () => number } }) => ({ cookie: `fw_admin=${await mintSession(env() as never, h.rt.now())}` });

async function speak(h: Awaited<ReturnType<typeof makeRuntime>>, id: number, name: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ from: user(id, name), text: "灌水 " + i }) });
  }
}

test("speaking messages build the roster and the daily leaderboard", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { keywords: [], locks: [], hotWords: false });
  await speak(h, 500, "小明", 3);
  await speak(h, 501, "小红", 1);

  await flushMemberStats(h.rt, -1001);

  const top = await memberTopDay(h.rt.db, -1001, leaderboardDay(h), 10);
  assert.deepEqual(top.map((r) => [r.userId, r.messages]), [
    [500, 3],
    [501, 1],
  ]);
  assert.equal((await memberList(h.rt.db, -1001, 10)).length, 2, "the roster learned both speakers");

  const rows = await leaderboard(h.rt, -1001, 10);
  assert.equal(rows[0]?.name, "小明");
  assert.match(leaderboardText(rows), /今日发言榜/);
  assert.match(leaderboardText(rows), /小明 · 3 条/);
  assert.equal(leaderboardText([]), "今天还没有发言记录。");
});

/** The harness clock is a fixed point in the past; reuse the bot's own day key. */
function leaderboardDay(h: Awaited<ReturnType<typeof makeRuntime>>): string {
  return dayKey(h.now(), h.rt.tzOffset);
}

test("the scheduled {{top}} placeholder is replaced with the real board", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { keywords: [], locks: [], hotWords: false });
  await speak(h, 500, "小明", 2);
  await flushMemberStats(h.rt, -1001);

  await scheduleAdd(h.rt.db, { chatId: -1001, text: "每日播报\n{{top}}", every: 0, nextAt: h.rt.now() - 1_000, createdBy: 9001 });
  const result = await runScheduled(h.rt);
  assert.equal(result.sent, 1);
  const sent = String(h.fake.find("sendMessage")?.body.text ?? "");
  assert.match(sent, /每日播报/);
  assert.match(sent, /小明 · 2 条/);
  assert.ok(!sent.includes("{{top}}"), "the placeholder must not survive into the message");
  assert.equal((await scheduleDue(h.rt.db, h.rt.now(), 5)).length, 0);
});

test("the members endpoint pages, searches and exposes warnings and blocks", async () => {
  const h = await makeRuntime();
  const headers = await authed(h);
  await h.rt.saveConfig(-1001, { keywords: [], locks: [] });
  await speak(h, 500, "小明", 2);
  await speak(h, 501, "小红", 1);
  await flushMemberStats(h.rt, -1001);
  // A blocked member stays on the roster with the flag set.
  const { blockAdd } = await import("../src/db/repo.ts");
  await blockAdd(h.rt.db, { chatId: -1001, userId: 501, reason: "广告", byId: 9001, at: h.rt.now() });

  const get = async (query: string) => {
    const res = await handleApi(
      new Request(`https://bot.test/api/chat/-1001/members${query}`, { headers }),
      env() as never,
      h.rt,
      new URL(`https://bot.test/api/chat/-1001/members${query}`),
    );
    return (await res.json()) as { members: { userId: number; week: number; warnings: number; blocked: boolean; firstName: string }[]; hasMore: boolean };
  };

  const page = await get("?limit=1");
  assert.equal(page.members.length, 1);
  assert.equal(page.hasMore, true);
  const all = await get("?limit=10");
  assert.equal(all.members.length, 2);
  const blocked = all.members.find((m) => m.userId === 501);
  assert.equal(blocked?.blocked, true);
  assert.equal(all.members.find((m) => m.userId === 500)?.week, 2);

  const searched = await get("?q=小红");
  assert.deepEqual(
    searched.members.map((m) => m.userId),
    [501],
  );
});

test("the inline mute action records an event attributed to the actor", async () => {
  const h = await makeRuntime();
  const headers = await authed(h);
  await speak(h, 500, "小明");
  await flushMemberStats(h.rt, -1001);

  const res = await handleApi(
    new Request("https://bot.test/api/chat/-1001/member/500/mute", { method: "POST", headers }),
    env() as never,
    h.rt,
    new URL("https://bot.test/api/chat/-1001/member/500/mute"),
  );
  assert.equal(res.status, 200);
  assert.equal(h.fake.count("restrictChatMember"), 1);
  const { recentEvents } = await import("../src/db/repo.ts");
  const events = await recentEvents(h.rt.db, -1001, 3);
  assert.equal(events[0]?.kind, "mute");
  assert.match(events[0]?.reason ?? "", /后台禁言/);
});

test("member activity rolls up per member over the window", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { keywords: [], locks: [], hotWords: false });
  await speak(h, 500, "小明", 4);
  await flushMemberStats(h.rt, -1001);
  const day = leaderboardDay(h);
  const activity = await memberActivitySince(h.rt.db, -1001, day);
  assert.equal(activity.get(500), 4);
});

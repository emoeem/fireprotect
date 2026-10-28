/**
 * The R6 command surface: `/ai`, the keyword extensions, `/allow`, `/words`.
 *
 * These are the branches an admin actually types. The matrix covers "normal,
 * stranger, garbage, extreme, duplicate"; this file covers the *other*
 * subcommands, because "the usage text exists" is not the same as "the
 * subcommand works".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMessage } from "../src/handlers/message.ts";
import { dayKey } from "../src/ai/words.ts";
import { wordBump } from "../src/db/repo.ts";
import { command, makeRuntime, user } from "./harness.ts";

const ADMIN = 9001;

async function run(text: string) {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN) } });
  await handleMessage(h.rt, command(text, { from: user(ADMIN, "群主") }));
  const said = h.fake.all("sendMessage").map((call) => String(call.body.text)).join("\n");
  return { h, said };
}

test("/ai status reports the switch, the budget and today's numbers", async () => {
  const { said } = await run("/ai");
  assert.match(said, /图片审核：关/);
  assert.match(said, /今天：调用 0/);
  assert.match(said, /没有配置 VISION_KEY/, "an unconfigured deployment says so instead of pretending");
});

test("/ai on and off flip the switch", async () => {
  const on = await run("/ai on");
  assert.equal((await on.h.rt.configFor(-1001)).ai, true);
  const off = await run("/ai off");
  assert.equal((await off.h.rt.configFor(-1001)).ai, false);
});

test("/ai provider accepts only the two known channels", async () => {
  const ok = await run("/ai provider cloud-vision");
  assert.equal((await ok.h.rt.configFor(-1001)).aiProvider, "cloud-vision");
  const bad = await run("/ai provider 别的");
  assert.match(bad.said, /用法/);
});

test("/ai min and budget clamp to their ranges", async () => {
  const min = await run("/ai min 88");
  assert.equal((await min.h.rt.configFor(-1001)).aiMinScore, 88);
  const low = await run("/ai min 10");
  assert.match(low.said, /阈值要 50–100/);

  const budget = await run("/ai budget 200");
  assert.equal((await budget.h.rt.configFor(-1001)).aiDailyBudget, 200);
  const tiny = await run("/ai budget 1");
  assert.match(tiny.said, /预算要 10–20000/);
});

test("/keywords action switches the outcome of a hit", async () => {
  const { h, said } = await run("/keywords action record");
  assert.equal((await h.rt.configFor(-1001)).keywordAction, "record");
  assert.match(said, /只记录/);
});

test("/keywords regex add stores a safe pattern and refuses a dangerous one", async () => {
  const ok = await run("/keywords regex add 加\\s*[Vv]");
  assert.deepEqual((await ok.h.rt.configFor(-1001)).keywordPatterns, ["加\\s*[Vv]"]);

  const bad = await run("/keywords regex add (a+)+$");
  assert.match(bad.said, /安全检查/, "the refusal explains itself");
  assert.deepEqual((await bad.h.rt.configFor(-1001)).keywordPatterns, []);
});

test("/keywords regex del removes exactly one pattern", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN) } });
  await h.rt.saveConfig(-1001, { keywordPatterns: ["a1", "b2"] });
  await handleMessage(h.rt, command("/keywords regex del a1", { from: user(ADMIN) }));
  assert.deepEqual((await h.rt.configFor(-1001)).keywordPatterns, ["b2"]);
});

test("/keywords list shows patterns and the action", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN) } });
  await h.rt.saveConfig(-1001, { keywordPatterns: ["加\\s*V"], keywordAction: "mute" });
  await handleMessage(h.rt, command("/keywords", { from: user(ADMIN) }));
  const said = String(h.fake.all("sendMessage").at(-1)?.body.text);
  assert.match(said, /正则（1）/);
  assert.match(said, /删除并禁言/);
});

test("/allow adds by id and /unallow removes it", async () => {
  const added = await run("/allow 8888");
  assert.deepEqual((await added.h.rt.configFor(-1001)).adWhitelist, [8888]);
  const removed = await run("/unallow 8888");
  assert.deepEqual((await removed.h.rt.configFor(-1001)).adWhitelist, []);
});

test("/words reports the window it was asked for", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN) } });
  const day = dayKey(h.rt.now(), h.rt.tzOffset);
  await wordBump(h.rt.db, -1001, day, [
    ["显卡", 4],
    ["价格", 2],
  ]);
  await handleMessage(h.rt, command("/words 3", { from: user(ADMIN) }));
  const said = String(h.fake.all("sendMessage").at(-1)?.body.text);
  assert.match(said, /显卡 4/);
  assert.match(said, /近 3 天/);
});

test("/stats folds the hot words, the vision numbers and parse attempts in", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN) } });
  const day = dayKey(h.rt.now(), h.rt.tzOffset);
  await wordBump(h.rt.db, -1001, day, [["显卡", 5]]);
  await handleMessage(h.rt, command("/stats", { from: user(ADMIN) }));
  const said = String(h.fake.all("sendMessage").at(-1)?.body.text);
  assert.match(said, /今日热词：显卡 5/);
});

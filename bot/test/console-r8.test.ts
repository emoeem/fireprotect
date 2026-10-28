/**
 * Console routes for R6–R8.
 *
 * The interesting case is not "the endpoint returns 200" — it is that a
 * feature patch cannot touch a field outside its own list. The preset editor
 * already shipped that bug once (a partial object with schema defaults writes
 * every field back); these tests exist so it cannot ship twice.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleApi, mintSession } from "../src/admin/api.ts";
import { dayKey } from "../src/ai/words.ts";
import { aiUsageBump, wordBump } from "../src/db/repo.ts";
import { makeRuntime } from "./harness.ts";

const ENV = { BOT_TOKEN: "123:abc", ADMIN_TOKEN: "adm1n" };

async function call(
  h: Awaited<ReturnType<typeof makeRuntime>>,
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<{ status: number; body: any }> {
  const cookie = init.cookie ?? `fw_admin=${await mintSession(ENV as never, h.rt.now())}`;
  const request = new Request(`https://bot.test${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const response = await handleApi(request, ENV as never, h.rt, new URL(`https://bot.test${path}`));
  return { status: response.status, body: await response.json() };
}

test("the chat payload carries the ai, words and parse blocks", async () => {
  const h = await makeRuntime();
  const day = dayKey(h.rt.now(), h.rt.tzOffset);
  await aiUsageBump(h.rt.db, -1001, day, { calls: 3, hits: 1, failures: 0, ms: 120 });
  await wordBump(h.rt.db, -1001, day, [
    ["显卡", 4],
    ["价格", 2],
  ]);

  const { status, body } = await call(h, "/api/chat/-1001");
  assert.equal(status, 200);
  assert.equal(body.ai.usage.calls, 3);
  assert.equal(body.words.top[0].word, "显卡");
  assert.equal(body.parse.stats.total, 0);
  assert.ok(Array.isArray(body.parse.jobs));
});

test("a feature patch only writes the fields it owns", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { captcha: true, keywords: ["广告"], aiMinScore: 80 });

  const { status, body } = await call(h, "/api/chat/-1001/ai", {
    method: "POST",
    // `captcha` and `keywords` are not AI fields; they must be dropped, not applied.
    body: { ai: true, aiMinScore: 92, captcha: false, keywords: [] },
  });
  assert.equal(status, 200);
  assert.deepEqual(body.changed.sort(), ["ai", "aiMinScore"]);

  const config = await h.rt.configFor(-1001);
  assert.equal(config.ai, true);
  assert.equal(config.aiMinScore, 92);
  assert.equal(config.captcha, true, "a foreign field must not be reset");
  assert.deepEqual(config.keywords, ["广告"]);
});

test("an out-of-range value is rejected by the shared zod schema", async () => {
  const h = await makeRuntime();
  const { status, body } = await call(h, "/api/chat/-1001/ai", { method: "POST", body: { aiMinScore: 999 } });
  assert.equal(status, 400);
  assert.match(String(body.error), /aiMinScore/);
  assert.equal((await h.rt.configFor(-1001)).aiMinScore, 80, "a rejected patch changes nothing");
});

test("an empty feature patch is a client error, not a silent no-op", async () => {
  const h = await makeRuntime();
  const { status } = await call(h, "/api/chat/-1001/parse", { method: "POST", body: { unrelated: 1 } });
  assert.equal(status, 400);
});

test("parse settings round-trip through their own endpoint", async () => {
  const h = await makeRuntime();
  const { status } = await call(h, "/api/chat/-1001/parse", { method: "POST", body: { parseAuto: true, parsePerHour: 5 } });
  assert.equal(status, 200);
  const config = await h.rt.configFor(-1001);
  assert.equal(config.parseAuto, true);
  assert.equal(config.parsePerHour, 5);
});

test("the keyword endpoint accepts numeric whitelist ids", async () => {
  const h = await makeRuntime();
  const { status } = await call(h, "/api/chat/-1001/keywords", {
    method: "POST",
    body: { adWhitelist: [42, 43], keywordAction: "record" },
  });
  assert.equal(status, 200);
  const config = await h.rt.configFor(-1001);
  assert.deepEqual(config.adWhitelist, [42, 43]);
  assert.equal(config.keywordAction, "record");
});

test("the words endpoint returns today's list and the day totals", async () => {
  const h = await makeRuntime();
  const day = dayKey(h.rt.now(), h.rt.tzOffset);
  await wordBump(h.rt.db, -1001, day, [["显卡", 3]]);
  const { status, body } = await call(h, "/api/chat/-1001/words?days=7");
  assert.equal(status, 200);
  assert.equal(body.day, day);
  assert.equal(body.top[0].count, 3);
  assert.ok(body.totals.length >= 1);
});

test("every new route refuses an unauthenticated caller", async () => {
  const h = await makeRuntime();
  for (const [path, method] of [
    ["/api/chat/-1001/ai", "POST"],
    ["/api/chat/-1001/parse", "POST"],
    ["/api/chat/-1001/keywords", "POST"],
    ["/api/chat/-1001/words", "GET"],
  ] as const) {
    const { status } = await call(h, path, { method, body: method === "GET" ? undefined : {}, cookie: "fw_admin=forged" });
    assert.equal(status, 401, `${method} ${path}`);
  }
});

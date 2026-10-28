import assert from "node:assert/strict";
import { test } from "node:test";
import { Screener } from "../src/external/screen.ts";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const none = { cas: false, federation: false };

test("the local list wins without any network call", async () => {
  let fetches = 0;
  const screener = new Screener({
    local: async () => ({ reason: "本地封禁", source: "local" }),
    fetchImpl: async () => {
      fetches += 1;
      return jsonResponse({ ok: true, result: { offenses: 5 } });
    },
  });
  const verdict = await screener.check(1, { cas: true, federation: true });
  assert.equal(verdict.banned, true);
  assert.equal(verdict.source, "local");
  assert.equal(fetches, 0);
});

test("with every source off the answer is instant and clean", async () => {
  const screener = new Screener({ local: async () => null });
  const verdict = await screener.check(2, none);
  assert.equal(verdict.banned, false);
});

test("CAS offences ban the user", async () => {
  const screener = new Screener({
    local: async () => null,
    fetchImpl: async () => jsonResponse({ ok: true, result: { offenses: 3 } }),
  });
  const verdict = await screener.check(3, { cas: true, federation: false });
  assert.equal(verdict.banned, true);
  assert.equal(verdict.source, "cas");
  assert.match(verdict.reason, /3/);
});

test("a CAS 401 is a failure, not a clean bill of health", async () => {
  let calls = 0;
  const health: string[] = [];
  const screener = new Screener({
    local: async () => null,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ ok: false, error_code: 401 }, 401);
    },
    onHealth: (name, ok) => void health.push(`${name}:${ok}`),
  });
  const verdict = await screener.check(4, { cas: true, federation: false });
  assert.equal(verdict.banned, false);
  assert.deepEqual(verdict.failures, ["cas"]);
  // 401 is not retried: three attempts would be three wasted seconds.
  assert.equal(calls, 1);
  assert.deepEqual(health, ["cas:false"]);
});

test("a dead service fails open", async () => {
  const screener = new Screener({
    local: async () => null,
    fetchImpl: async () => {
      const err = new Error("boom");
      err.name = "AbortError";
      throw err;
    },
  });
  const verdict = await screener.check(5, { cas: true, federation: false });
  assert.equal(verdict.banned, false);
  assert.deepEqual(verdict.failures, ["cas"]);
});

test("a successful check is cached for the next message", async () => {
  let calls = 0;
  const screener = new Screener({
    local: async () => null,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ ok: true, result: { offenses: 0 } });
    },
  });
  await screener.check(6, { cas: true, federation: false });
  await screener.check(6, { cas: true, federation: false });
  assert.equal(calls, 1);
});

test("the federation list is asked and can ban", async () => {
  const seen: string[] = [];
  const screener = new Screener({
    local: async () => null,
    federationUrl: "https://fed.example/",
    federationToken: "t",
    fetchImpl: async (url) => {
      seen.push(url);
      return jsonResponse({ banned: true, reason: "跨群广告" });
    },
  });
  const verdict = await screener.check(7, { cas: false, federation: true });
  assert.equal(verdict.banned, true);
  assert.equal(verdict.source, "federation");
  assert.equal(seen[0], "https://fed.example/check?user_id=7");
});

test("reporting posts to the federation and reports failure", async () => {
  const bodies: string[] = [];
  const screener = new Screener({
    local: async () => null,
    federationUrl: "https://fed.example",
    fetchImpl: async (_url, init) => {
      bodies.push(String(init?.body ?? ""));
      return jsonResponse({ ok: true });
    },
  });
  assert.equal(await screener.report(8, "广告"), true);
  assert.match(bodies[0] ?? "", /"user_id":8/);
});

test("report is a no-op without a federation URL", async () => {
  const screener = new Screener({ local: async () => null });
  assert.equal(await screener.report(9, "x"), false);
});

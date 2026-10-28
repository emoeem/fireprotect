/**
 * Keyword matching: the regex option, its safety rail, and the three actions.
 *
 * The ReDoS cases are the reason this file exists. A pattern like `(a+)+` is
 * one line of admin input and one hung isolate, so the guard is tested as a
 * behaviour ("a hostile pattern is refused"), not as an implementation detail.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePattern, inspectPattern, keywordPolicy, matchKeywords } from "../src/keywords.ts";
import { DEFAULT_CONFIG } from "../src/rules.ts";
import { handleMessage } from "../src/handlers/message.ts";
import { makeRuntime, message, user } from "./harness.ts";

test("a nested quantifier is refused before it can run", () => {
  for (const pattern of ["(a+)+$", "(a*)*b", "(.*)+", "(x+){2,}"]) {
    const check = inspectPattern(pattern);
    assert.equal(check.ok, false, `${pattern} should be refused`);
  }
});

test("a quantified alternation is refused as well", () => {
  // `(a|aa)+` has no nested quantifier but backtracks exponentially.
  assert.equal(inspectPattern("(a|aa)+$").ok, false);
  assert.equal(compilePattern("(a|aa)+$"), null);
});

test("ordinary patterns are accepted", () => {
  for (const pattern of ["加\\s*[Vv]", "\\d{2,4}", "(abc)+", "^出售.*账号$", "微信|weixin"]) {
    assert.equal(inspectPattern(pattern).ok, true, `${pattern} should be accepted`);
  }
});

test("unbalanced or unparsable patterns are refused, not thrown", () => {
  assert.equal(inspectPattern("(abc").ok, false);
  assert.equal(inspectPattern("abc)").ok, false);
  assert.equal(inspectPattern("[a-").ok, false);
  assert.equal(inspectPattern("a{2,").ok, true, "a trailing comma is not a crash; it is literal text");
  assert.equal(inspectPattern("(" + "a".repeat(300)).ok, false);
});

test("a refused pattern never reaches the engine", () => {
  const started = Date.now();
  const hit = matchKeywords("a".repeat(800) + "!", ["no"], ["(a+)+$"]);
  assert.equal(hit, null);
  assert.ok(Date.now() - started < 50, "matching must not backtrack");
});

test("words are cheaper and therefore win over patterns", () => {
  const hit = matchKeywords("请加微信联系", ["加微信"], ["微信"]);
  assert.deepEqual(hit, { label: "加微信", via: "word" });
});

test("a pattern hit reports the pattern it matched", () => {
  const hit = matchKeywords("加 V 领福利", [], ["加\\s*[Vv]"]);
  assert.equal(hit?.via, "pattern");
  assert.equal(hit?.label, "加\\s*[Vv]");
});

test("matching is case-insensitive for both kinds", () => {
  assert.equal(matchKeywords("PROMO CODE", ["promo"], [])?.label, "promo");
  assert.equal(matchKeywords("BUY NOW", [], ["buy\\s+now"])?.via, "pattern");
});

test("the subject is truncated, so a pathological input cannot grow the work", () => {
  // A pattern that only matches past 800 characters must not match.
  const long = "x".repeat(900) + "HIT";
  assert.equal(matchKeywords(long, [], ["HIT"]), null);
  assert.ok(matchKeywords("HIT " + "x".repeat(900), [], ["HIT"]));
});

test("the whitelist wins over the configured action", () => {
  const config = { ...DEFAULT_CONFIG, keywordAction: "delete" as const, adWhitelist: [42] };
  assert.equal(keywordPolicy(config, 42), "record");
  assert.equal(keywordPolicy(config, 43), "act");
  assert.equal(keywordPolicy({ ...config, keywordAction: "record" }, 43), "record");
});

// ---------------------------------------------------------------------------
// Pipeline behaviour
// ---------------------------------------------------------------------------

async function deliver(text: string, patch: Record<string, unknown> = {}) {
  const h = await makeRuntime({ env: { ADMIN_IDS: "9001" } });
  await h.rt.saveConfig(-1001, patch);
  await handleMessage(h.rt, message({ text, from: user(500, "路人") }));
  return h;
}

test("a keyword hit deletes by default", async () => {
  const h = await deliver("加微信 领福利");
  assert.equal(h.fake.count("deleteMessage"), 1);
});

test("keywordAction=record leaves the message alone but records it", async () => {
  const h = await deliver("加微信 领福利", { keywordAction: "record" });
  assert.equal(h.fake.count("deleteMessage"), 0);
  assert.equal(h.fake.count("deleteMessages"), 0);
  const stats = await h.rt.db.select().from((await import("../src/db/schema.ts")).events);
  assert.ok((stats as { kind: string }[]).some((row) => row.kind === "watch"));
});

test("a whitelisted sponsor keeps their message", async () => {
  const h = await deliver("加微信 谈合作", { adWhitelist: [500] });
  assert.equal(h.fake.count("deleteMessage"), 0);
  assert.equal(h.fake.count("restrictChatMember"), 0);
});

test("keywordAction=mute deletes and mutes in one step, with no warning counter", async () => {
  const h = await deliver("加微信 领福利", { keywordAction: "mute", muteMinutes: 20 });
  assert.equal(h.fake.count("deleteMessage"), 1);
  const restrict = h.fake.all("restrictChatMember").at(-1);
  assert.equal(restrict?.body.user_id, 500);
  assert.ok(Number(restrict?.body.until_date) > 0);
});

test("a regex rule catches a message no substring would", async () => {
  const h = await deliver("加   V   领钱", { keywordPatterns: ["加\\s*[Vv]"] });
  assert.equal(h.fake.count("deleteMessage"), 1);
});

/**
 * Hot words: tokenizer, batching, and the cost control that makes it viable.
 *
 * The property under test is "one message is one count, and thirty messages are
 * one write". Both halves matter: counting per occurrence would let one rant
 * define the day's top word, and writing per message would burn D1's free tier
 * before a busy group finishes its morning.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FLUSH_AT, bumpWords, dayKey, flushWords, pendingWords, tokenize } from "../src/ai/words.ts";
import { wordTop } from "../src/db/repo.ts";
import { handleMessage } from "../src/handlers/message.ts";
import { command, makeRuntime, message, user } from "./harness.ts";

test("the day boundary follows the deployment's timezone", () => {
  const utcMidnight = Date.UTC(2026, 9, 28, 0, 30, 0);
  assert.equal(dayKey(utcMidnight, 480), "2026-10-28");
  assert.equal(dayKey(utcMidnight, 0), "2026-10-28");
  // 23:30 UTC is already tomorrow in +08:00.
  const late = Date.UTC(2026, 9, 28, 23, 30, 0);
  assert.equal(dayKey(late, 480), "2026-10-29");
  assert.equal(dayKey(late, 0), "2026-10-28");
});

test("chinese is split into bigrams and function words are dropped", () => {
  const tokens = tokenize("今天显卡价格好贵");
  assert.ok(tokens.includes("显卡"));
  assert.ok(tokens.includes("价格"));
  assert.ok(!tokens.includes("今天"), "stop words must not reach the index");
  assert.ok(tokens.every((token) => token.length >= 2));
});

test("latin words are taken whole", () => {
  const tokens = tokenize("docker compose 起了 rtx4090 的容器");
  assert.ok(tokens.includes("docker"));
  assert.ok(tokens.includes("compose"));
  assert.ok(tokens.includes("rtx4090"));
});

test("one message counts once per word, however often it repeats", () => {
  const tokens = tokenize("显卡 显卡 显卡 显卡");
  assert.equal(tokens.filter((token) => token === "显卡").length, 1);
});

test("nothing is written until the bucket is worth a write", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { hotWords: true });
  const day = dayKey(h.rt.now(), h.rt.tzOffset);
  await bumpWords(h.rt, -1001, "显卡价格");
  assert.deepEqual(await wordTop(h.rt.db, -1001, day, 20, 1), [], "a single message must not cost a write");
  assert.equal(pendingWords(h.rt, -1001, day).length > 0, true);
});

test("explicit flush writes the bucket and clears it", async () => {
  const h = await makeRuntime();
  const day = dayKey(h.rt.now(), h.rt.tzOffset);
  await bumpWords(h.rt, -1001, "显卡价格");
  const written = await flushWords(h.rt, -1001);
  assert.ok(written >= 2);
  const rows = await wordTop(h.rt.db, -1001, day, 20, 1);
  assert.ok(rows.some((row) => row.word === "显卡"));

  const again = await flushWords(h.rt, -1001);
  assert.equal(again, 0, "a flush with an empty bucket is a no-op");
});

test("the same word across three messages counts three", async () => {
  const h = await makeRuntime();
  const day = dayKey(h.rt.now(), h.rt.tzOffset);
  for (let index = 0; index < 3; index++) await bumpWords(h.rt, -1001, "显卡又涨价了");
  await flushWords(h.rt, -1001);
  const rows = await wordTop(h.rt.db, -1001, day, 20, 1);
  assert.equal(rows.find((row) => row.word === "显卡")?.count, 3);
});

test("crossing the bucket size writes without being asked", async () => {
  const h = await makeRuntime();
  const day = dayKey(h.rt.now(), h.rt.tzOffset);
  const many = Array.from({ length: FLUSH_AT }, (_, index) => `词${String.fromCharCode(0x4e00 + index)}语`).join("");
  await bumpWords(h.rt, -1001, many);
  const rows = await wordTop(h.rt.db, -1001, day, 50, 1);
  assert.ok(rows.length >= FLUSH_AT - 5, `expected an automatic flush, got ${rows.length} rows`);
});

test("a word seen once is not a hot word", async () => {
  const h = await makeRuntime();
  const day = dayKey(h.rt.now(), h.rt.tzOffset);
  await bumpWords(h.rt, -1001, "显卡");
  await bumpWords(h.rt, -1001, "完全不同的话题内容");
  await flushWords(h.rt, -1001);
  const top = await wordTop(h.rt.db, -1001, day, 20, 2);
  assert.equal(top.some((row) => row.word === "显卡"), false);
});

test("the message pipeline feeds the counter without touching the message", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { hotWords: true, keywords: [] });
  await handleMessage(h.rt, message({ from: user(500), text: "显卡价格 显卡价格" }));
  assert.equal(h.fake.count("deleteMessage"), 0);
  const day = dayKey(h.rt.now(), h.rt.tzOffset);
  await flushWords(h.rt, -1001);
  const rows = await wordTop(h.rt.db, -1001, day, 20, 1);
  assert.ok(rows.some((row) => row.word === "显卡"));
});

test("turn it off and nothing is counted", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { hotWords: false, keywords: [] });
  await handleMessage(h.rt, message({ from: user(500), text: "显卡价格" }));
  const day = dayKey(h.rt.now(), h.rt.tzOffset);
  assert.deepEqual(pendingWords(h.rt, -1001, day), []);
});

test("/words names today's top words", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: "9001" } });
  await h.rt.saveConfig(-1001, { hotWords: true, keywords: [] });
  for (let index = 0; index < 2; index++) await handleMessage(h.rt, message({ from: user(500), text: "显卡价格太高" }));
  await handleMessage(h.rt, command("/words", { from: user(9001, "群主") }));
  const text = String(h.fake.all("sendMessage").at(-1)?.body.text);
  assert.match(text, /热词/);
  assert.match(text, /显卡/);
});

test("a second flush adds to the row instead of replacing it", async () => {
  const h = await makeRuntime();
  const day = dayKey(h.rt.now(), h.rt.tzOffset);
  await bumpWords(h.rt, -1001, "显卡价格");
  await flushWords(h.rt, -1001);
  await bumpWords(h.rt, -1001, "显卡价格");
  await flushWords(h.rt, -1001);
  const rows = await wordTop(h.rt.db, -1001, day, 20, 1);
  assert.equal(rows.find((row) => row.word === "显卡")?.count, 2, "ON CONFLICT must add, not overwrite");
});

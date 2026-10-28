import assert from "node:assert/strict";
import { test } from "node:test";
import { contentFingerprint, duplicateSignal, scoreMessage } from "../src/heuristics.ts";
import { GROUP, message, user } from "./harness.ts";

// One stand-in runtime per file: the fingerprint cache is keyed by it.
const RT = {};

test("a clean message scores zero", () => {
  const { score } = scoreMessage(message({ text: "今晚八点开会，别迟到" }));
  assert.equal(score, 0);
});

test("an invite link outweighs a plain URL", () => {
  const invite = scoreMessage(message({ text: "进群 https://t.me/+abcdef" })).score;
  const plain = scoreMessage(message({ text: "https://example.com/doc" })).score;
  assert.ok(invite > plain, `invite=${invite} plain=${plain}`);
  assert.ok(invite >= 25);
});

test("a risky TLD adds weight and says why", () => {
  const result = scoreMessage(message({ text: "领奖 http://promo.xyz" }));
  assert.ok(result.score >= 15);
  assert.ok(result.reasons.some((r) => r.includes("xyz")));
});

test("impersonating staff plus a link is the strongest single signal", () => {
  const result = scoreMessage(message({ text: "官方客服：点 https://help-desk.example 申诉解封" }));
  assert.ok(result.score >= 30);
  assert.ok(result.reasons.some((r) => r.includes("冒充")));
});

test("invisible and confusable characters are flagged", () => {
  assert.ok(scoreMessage(message({ text: "hello\u200bworld" })).score >= 20);
  assert.ok(scoreMessage(message({ text: "pаypal" })).score >= 20); // Cyrillic а
});

test("the score is capped at 100", () => {
  const nasty = scoreMessage(
    message({ text: "官方客服 admin 解封 https://t.me/+x http://a.top http://b.xyz http://c.icu\u200b pаypal" }),
  );
  assert.equal(nasty.score, 100);
});

test("identical text from four different members is flagged", () => {
  const chatId = -2001;
  const text = "扫码进群领福利 https://t.me/+x";
  for (let i = 0; i < 3; i++) {
    const result = duplicateSignal(RT, chatId, message({ chat: { ...GROUP, id: chatId }, from: user(600 + i), text }));
    assert.equal(result.score, 0, "first three are not a network yet");
  }
  const fourth = duplicateSignal(RT, chatId, message({ chat: { ...GROUP, id: chatId }, from: user(603), text }));
  assert.equal(fourth.count, 3);
  assert.equal(fourth.score, 25);
});

test("one member repeating themselves is not a spam network", () => {
  const chatId = -2002;
  const text = "同一句话重复很多遍也不算网络";
  for (let i = 0; i < 6; i++) {
    assert.equal(duplicateSignal(RT, chatId, message({ chat: { ...GROUP, id: chatId }, from: user(700), text })).score, 0);
  }
});

test("fingerprints fold case, punctuation and link differences", () => {
  assert.equal(contentFingerprint("Hello, World! https://a"), contentFingerprint("hello world https://b"));
});

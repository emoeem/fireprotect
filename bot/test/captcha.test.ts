import assert from "node:assert/strict";
import { test } from "node:test";
import { challengeFor, matchesAnswer, mathChallenge, normalizeAnswer, signCallback, verifyCallback } from "../src/captcha.ts";

const secret = "verify:test";
const chat = -1001;
const user = 500;

test("a button callback verifies only for its own chat and user", async () => {
  const data = await signCallback(secret, chat, user, "nonce1");
  const ok = await verifyCallback(secret, chat, user, data);
  assert.equal(ok.ok, true);

  const otherUser = await verifyCallback(secret, chat, 501, data);
  assert.equal(otherUser.ok, false);

  const otherChat = await verifyCallback(secret, -1002, user, data);
  assert.equal(otherChat.ok, false);
});

test("a tampered callback is refused", async () => {
  const data = await signCallback(secret, chat, user, "nonce1");
  const [version, nonce, mac] = data.split(".");
  const flipped = `${version}.${nonce}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
  assert.equal((await verifyCallback(secret, chat, user, flipped)).ok, false);
  assert.equal((await verifyCallback(secret, chat, user, "garbage")).ok, false);
});

test("a math choice is bound into the signature", async () => {
  const data = await signCallback(secret, chat, user, "nonce2", 12);
  const parsed = await verifyCallback(secret, chat, user, data);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.choice, 12);

  // Same nonce, different claimed answer: the MAC no longer matches.
  const forged = data.replace(".12.", ".13.");
  assert.equal((await verifyCallback(secret, chat, user, forged)).ok, false);
});

test("math offers four distinct options including the answer", () => {
  for (let i = 0; i < 50; i++) {
    const { answers, options } = mathChallenge();
    const answer = Number(answers[0]);
    assert.equal(options.length, 4);
    assert.equal(new Set(options).size, 4);
    assert.equal(options.includes(answer), true);
  }
});

test("answers are matched after normalising case, spaces and punctuation", () => {
  assert.equal(normalizeAnswer("  北 京！"), "北京");
  assert.equal(matchesAnswer({ answers: ["北京"] }, "北 京"), true);
  assert.equal(matchesAnswer({ answers: ["7"] }, "７"), true); // full-width digit
  assert.equal(matchesAnswer({ answers: ["北京"] }, "上海"), false);
});

test("question mode falls back to a usable default when no answers are configured", () => {
  const challenge = challengeFor("question", { answers: [], question: "主题？", timeoutSeconds: 60, nowMs: 1000 });
  assert.equal(challenge.mode, "question");
  assert.equal(challenge.question, "主题？");
  assert.deepEqual(challenge.answers, ["我同意群规"]);
});

test("button mode carries no question and a bounded lifetime", () => {
  const challenge = challengeFor("button", { answers: [], question: "q", timeoutSeconds: 60, nowMs: 1000 });
  assert.equal(challenge.question, undefined);
  assert.equal(challenge.expiresAt, 1000 + 60_000);
  assert.equal(challenge.nonce.length > 8, true);
});

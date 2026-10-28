import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, applyPatch } from "../src/rules.ts";
import { hasLink, inspect, isChannelPost, kindsOf } from "../src/filters.ts";
import { message } from "./harness.ts";

const base = (patch: Record<string, unknown> = {}) => applyPatch(DEFAULT_CONFIG, { keywords: [], locks: [], newbieHours: 0, ...patch });
const now = 1_700_000_000_000;

test("bare hostnames count as links", () => {
  assert.equal(hasLink(message({ text: "看 abc.com" })), true);
  assert.equal(hasLink(message({ text: "t.me/+abc" })), true);
  assert.equal(hasLink(message({ text: "hello there" })), false);
});

test("text_link entities are caught even when the visible text says nothing", () => {
  const msg = message({ text: "点这里", entities: [{ type: "text_link", offset: 0, length: 3, url: "https://x.example" }] });
  assert.equal(hasLink(msg), true);
});

test("a locked type is deleted with a readable reason", () => {
  const verdict = inspect({ msg: message({ photo: [{ file_id: "ph1" }] }), config: base({ locks: ["photos"] }), nowMs: now });
  assert.equal(verdict.hit, true);
  assert.equal(verdict.hit && verdict.kind, "lock");
  assert.match(verdict.hit ? verdict.reason : "", /图片/);
});

test("an unlocked type passes", () => {
  const verdict = inspect({ msg: message({ photo: [{ file_id: "ph1" }] }), config: base({ locks: ["videos"] }), nowMs: now });
  assert.equal(verdict.hit, false);
});

test("keywords outrank a lock and name the word", () => {
  const verdict = inspect({ msg: message({ text: "加微信 123" }), config: base({ keywords: ["加微信"], locks: ["links"] }), nowMs: now });
  assert.equal(verdict.hit && verdict.kind, "keyword");
  assert.match(verdict.hit ? verdict.reason : "", /加微信/);
});

test("newcomers are blocked from links inside the window and clear after it", () => {
  const config = base({ newbieHours: 24, newbieBlocks: ["links"] });
  const joinedAt = now - 60 * 60_000;
  const inside = inspect({ msg: message({ text: "http://spam.example" }), config, nowMs: now, joinedAt });
  assert.equal(inside.hit && inside.kind, "newbie");

  const after = inspect({ msg: message({ text: "http://spam.example" }), config, nowMs: now, joinedAt: now - 25 * 60 * 60_000 });
  assert.equal(after.hit, false);
});

test("a trusted member skips the newcomer window", () => {
  const config = base({ newbieHours: 24, newbieBlocks: ["links"] });
  const verdict = inspect({ msg: message({ text: "http://ok.example" }), config, nowMs: now, joinedAt: now - 1000, trusted: true });
  assert.equal(verdict.hit, false);
});

test("length uses characters, not code units", () => {
  const config = base({ maxLength: 3 });
  const verdict = inspect({ msg: message({ text: "😀😀😀😀" }), config, nowMs: now });
  assert.equal(verdict.hit && verdict.kind, "length");
});

test("a heuristic score at the threshold is a hit", () => {
  const config = base();
  assert.equal(inspect({ msg: message(), config, nowMs: now, heuristicScore: 59 }).hit, false);
  const hit = inspect({ msg: message(), config, nowMs: now, heuristicScore: 60 });
  assert.equal(hit.hit && hit.kind, "heuristic");
});

test("channel senders are recognised and lockable", () => {
  const msg = message({ sender_chat: { id: -1009, type: "channel", title: "频道" } });
  assert.equal(isChannelPost(msg), true);
  assert.deepEqual(kindsOf(msg).includes("channels"), true);
  const verdict = inspect({ msg, config: base({ locks: ["channels"] }), nowMs: now });
  assert.equal(verdict.hit && verdict.lock, "channels");
});

test("a normal message from a member trips nothing", () => {
  assert.equal(inspect({ msg: message({ text: "今天开会吗" }), config: base(), nowMs: now }).hit, false);
});

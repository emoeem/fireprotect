import assert from "node:assert/strict";
import test from "node:test";
import { charLength, floodExceeded, hasLink, hitKeyword, inspect, isChannelPost, isForward } from "../src/filters.ts";
import { DEFAULT_RULES } from "../src/rules.ts";
import { makeCtx, message, user } from "./harness.ts";

test("hasLink catches a bare domain the scheme-only check missed", () => {
  assert.equal(hasLink(message({ text: "去 abc.com 看看" })), true);
  assert.equal(hasLink(message({ text: "https://x" })), true);
  // A decimal number is not a host: 3.14 must not trip the domain pattern.
  assert.equal(hasLink(message({ text: "圆周率 3.14 够了" })), false);
  assert.equal(hasLink(message({ text: "没有链接" })), false);
});

test("hasLink trusts entities, where the visible text says nothing", () => {
  const msg = message({
    text: "点这里",
    entities: [{ type: "text_link", offset: 0, length: 3, url: "https://evil.example" }],
  });
  assert.equal(hasLink(msg), true);
});

test("hitKeyword is case-insensitive and returns the matched word", () => {
  assert.equal(hitKeyword("加我 WeChat 详聊", ["加微信", "wechat"]), "wechat");
  assert.equal(hitKeyword("干净的话", ["加微信"]), "");
});

test("charLength counts a reader's characters, not UTF-16 units", () => {
  assert.equal(charLength("😀😀"), 2);
});

test("isChannelPost needs a sender_chat different from the chat itself", () => {
  assert.equal(isChannelPost(message({ sender_chat: { id: -2002, type: "channel", title: "频道" } })), true);
  assert.equal(isChannelPost(message({ sender_chat: { id: -1001, type: "supergroup" } })), false);
  assert.equal(isChannelPost(message()), false);
});

test("isForward covers the modern forward_origin field", () => {
  assert.equal(isForward(message({ forward_origin: { type: "hidden_user" } })), true);
  assert.equal(isForward(message({ forward_from: user(7) })), true);
  assert.equal(isForward(message()), false);
});

test("inspect ranks filters in a stable order and names the reason", () => {
  const rules = { ...DEFAULT_RULES, keywords: ["博彩"], maxLength: 10 };
  assert.deepEqual(inspect(message({ text: "博彩 https://x" }), rules), {
    hit: true,
    reason: "命中关键词「博彩」",
    kind: "keyword",
  });
  assert.deepEqual(inspect(message({ text: "看 https://x" }), rules), {
    hit: true,
    reason: "含链接",
    kind: "link",
  });
  // maxLength 0 means "off", not "everything is too long".
  assert.deepEqual(inspect(message({ text: "一二三四五六七八九十十一" }), { ...rules, maxLength: 0 }), { hit: false });
  assert.deepEqual(inspect(message({ text: "一二三四五六七八九十十一" }), rules), {
    hit: true,
    reason: "超过 10 字",
    kind: "length",
  });
});

test("floodExceeded triggers only past the limit and trims its window", async () => {
  const { ctx, advance } = makeCtx();
  const rules = { floodLimit: 2, floodWindow: 10 } as never;
  const msg = message({ chat: { id: -1001, type: "supergroup" }, from: user(77) });

  assert.equal(await floodExceeded(ctx, msg, rules), false);
  assert.equal(await floodExceeded(ctx, msg, rules), false);
  assert.equal(await floodExceeded(ctx, msg, rules), true);

  // Ten seconds later the window has moved on entirely.
  advance(11_000);
  assert.equal(await floodExceeded(ctx, msg, rules), false);
});

test("floodExceeded is inert when the limit is zero", async () => {
  const { ctx } = makeCtx();
  const rules = { floodLimit: 0, floodWindow: 10 } as never;
  for (let i = 0; i < 50; i++) {
    assert.equal(await floodExceeded(ctx, message({ from: user(88) }), rules), false);
  }
});

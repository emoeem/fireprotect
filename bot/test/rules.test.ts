import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RULES, describeRules, fillTemplate, mergeRules, parseKeywords } from "../src/rules.ts";

test("mergeRules keeps 0 for maxLength, because 0 means off", () => {
  const rules = mergeRules(DEFAULT_RULES, { maxLength: 0 });
  assert.equal(rules.maxLength, 0);
});

test("mergeRules floors a small non-zero maxLength instead of silencing the group", () => {
  // 5 characters would make every normal sentence a violation; 40 is the floor
  // the generator used too.
  assert.equal(mergeRules(DEFAULT_RULES, { maxLength: 5 }).maxLength, 40);
});

test("mergeRules rejects an unknown action rather than degrading to delete", () => {
  assert.equal(mergeRules(DEFAULT_RULES, { spamAction: "nuke" }).spamAction, DEFAULT_RULES.spamAction);
  assert.equal(mergeRules(DEFAULT_RULES, { spamAction: "ban" }).spamAction, "ban");
});

test("mergeRules clamps durations and counts", () => {
  assert.equal(mergeRules(DEFAULT_RULES, { muteMinutes: 0 }).muteMinutes, 1);
  assert.equal(mergeRules(DEFAULT_RULES, { muteMinutes: 99_999 }).muteMinutes, 10_080);
  assert.equal(mergeRules(DEFAULT_RULES, { warnLimit: 99 }).warnLimit, 20);
  assert.equal(mergeRules(DEFAULT_RULES, { captchaTimeout: 1 }).captchaTimeout, 30);
  assert.equal(mergeRules(DEFAULT_RULES, { captchaTimeout: Number.NaN }).captchaTimeout, DEFAULT_RULES.captchaTimeout);
});

test("mergeRules accepts on/off strings from a chat command", () => {
  assert.equal(mergeRules(DEFAULT_RULES, { captcha: "off" }).captcha, false);
  assert.equal(mergeRules(DEFAULT_RULES, { filterLinks: "on" }).filterLinks, true);
});

test("mergeRules refuses a non-numeric log target", () => {
  assert.equal(mergeRules(DEFAULT_RULES, { logChatId: "@channel" }).logChatId, "");
  assert.equal(mergeRules(DEFAULT_RULES, { logChatId: "-100123" }).logChatId, "-100123");
});

test("mergeRules survives a null patch", () => {
  assert.deepEqual(mergeRules(DEFAULT_RULES, null as never), DEFAULT_RULES);
});

test("parseKeywords dedupes case-insensitively and drops paragraph-sized entries", () => {
  const words = parseKeywords("加微信, 加微信\nWECHAT，代理\n" + "长".repeat(200) + "\n\n");
  assert.deepEqual(words, ["加微信", "WECHAT", "代理"]);
});

test("parseKeywords accepts an array (used when merging existing + new)", () => {
  assert.deepEqual(parseKeywords(["a", "b", "a"]), ["a", "b"]);
});

test("fillTemplate substitutes without evaluating anything", () => {
  const text = fillTemplate("{name} 来到 {chat}，也叫 {username}。${7*7}", { first_name: "阿明" }, { title: "群" });
  assert.equal(text, "阿明 来到 群，也叫 阿明。${7*7}");
});

test("describeRules always states the punishment and the log target", () => {
  const lines = describeRules(DEFAULT_RULES).join("\n");
  assert.match(lines, /违规只删除/);
  assert.match(lines, /记录：未设置/);
  assert.match(lines, /关键词 5 个/);
});

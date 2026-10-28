import assert from "node:assert/strict";
import { test } from "node:test";
import { matchReplyFilter } from "../src/replies.ts";
import type { FilterRow } from "../src/db/schema.ts";

const row = (patch: Partial<FilterRow>): FilterRow => ({
  id: 1,
  chatId: -1001,
  trigger: "",
  match: "exact",
  response: "ok",
  createdBy: 0,
  createdAt: 0,
  ...patch,
});

test("exact matches ignore case and surrounding spaces", () => {
  const filters = [row({ trigger: "你好" })];
  assert.ok(matchReplyFilter(filters, "  你好 "));
  assert.equal(matchReplyFilter(filters, "你好啊"), null);
});

test("prefix matches the start only", () => {
  const filters = [row({ trigger: "规则", match: "prefix" })];
  assert.ok(matchReplyFilter(filters, "规则在哪"));
  assert.equal(matchReplyFilter(filters, "看看规则"), null);
});

test("regex matches and a broken pattern is inert", () => {
  const ok = [row({ trigger: "^开通.*会员$", match: "regex" })];
  assert.ok(matchReplyFilter(ok, "开通年度会员"));
  const broken = [row({ trigger: "([", match: "regex" })];
  assert.equal(matchReplyFilter(broken, "(["), null);
});

test("an over-long pattern is refused rather than compiled", () => {
  const long = [row({ trigger: "a".repeat(201), match: "regex" })];
  assert.equal(matchReplyFilter(long, "a".repeat(201)), null);
});

test("an empty message matches nothing", () => {
  assert.equal(matchReplyFilter([row({ trigger: "" })], "   "), null);
});

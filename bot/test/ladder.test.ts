import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, applyPatch } from "../src/rules.ts";
import { describeStrike, strikeAt } from "../src/ladder.ts";

test("the default ladder escalates mute → longer mute → ban", () => {
  assert.deepEqual(strikeAt(1, DEFAULT_CONFIG), { at: 1, action: "mute", minutes: 60 });
  assert.deepEqual(strikeAt(2, DEFAULT_CONFIG), { at: 2, action: "mute", minutes: 1440 });
  assert.deepEqual(strikeAt(3, DEFAULT_CONFIG), { at: 3, action: "ban", minutes: 0 });
  // Beyond the last rung the last rung keeps applying.
  assert.deepEqual(strikeAt(9, DEFAULT_CONFIG), { at: 3, action: "ban", minutes: 0 });
});

test("with the ladder off it falls back to warnLimit", () => {
  const config = applyPatch(DEFAULT_CONFIG, { strikes: [], warnLimit: 2 });
  assert.equal(strikeAt(1, config), null);
  assert.deepEqual(strikeAt(2, config), { at: 2, action: "ban", minutes: 0 });
});

test("both off means warnings are only recorded", () => {
  const config = applyPatch(DEFAULT_CONFIG, { strikes: [], warnLimit: 0 });
  assert.equal(strikeAt(3, config), null);
});

test("a custom ladder is honoured", () => {
  const config = applyPatch(DEFAULT_CONFIG, { strikes: [{ at: 2, action: "kick", minutes: 0 }] });
  assert.equal(strikeAt(1, config), null);
  assert.deepEqual(strikeAt(2, config), { at: 2, action: "kick", minutes: 0 });
});

test("describeStrike reads like a punishment", () => {
  assert.equal(describeStrike({ at: 1, action: "mute", minutes: 60 }), "禁言 60 分钟");
  assert.equal(describeStrike({ at: 3, action: "ban", minutes: 0 }), "封禁");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, applyPatch, coerceField, describeConfig, normalizeLegacy, parseKeywords, patchError } from "../src/rules.ts";

test("every field has a shipped default", () => {
  assert.equal(DEFAULT_CONFIG.captcha, true);
  assert.equal(DEFAULT_CONFIG.captchaMode, "button");
  assert.deepEqual(DEFAULT_CONFIG.locks, ["links"]);
  assert.equal(DEFAULT_CONFIG.strikes.length, 3);
});

test("a patch only touches the keys the admin sent", () => {
  const next = applyPatch(DEFAULT_CONFIG, { captcha: false });
  assert.equal(next.captcha, false);
  // Everything else survives — this is the bug that would silently reset rules.
  assert.equal(next.maxLength, DEFAULT_CONFIG.maxLength);
  assert.deepEqual(next.keywords, DEFAULT_CONFIG.keywords);
  assert.equal(next.strikes.length, 3);
});

test("out-of-range numbers are rejected, not clamped silently", () => {
  assert.notEqual(patchError({ captchaTimeout: 5 }), "");
  const next = applyPatch(DEFAULT_CONFIG, { captchaTimeout: 5 });
  assert.equal(next.captchaTimeout, DEFAULT_CONFIG.captchaTimeout);
});

test("unknown keys are ignored rather than stored", () => {
  const next = applyPatch(DEFAULT_CONFIG, { notAField: 1 } as Record<string, unknown>);
  assert.equal((next as unknown as Record<string, unknown>).notAField, undefined);
});

test("legacy filterLinks/filterForwards migrate into locks", () => {
  const legacy = { filterLinks: true, filterForwards: true, filterChannels: true, captcha: false };
  const normalized = normalizeLegacy(legacy);
  assert.deepEqual(normalized.locks, ["links", "forwards", "channels"]);
  assert.equal(normalized.filterLinks, undefined);
  const next = applyPatch(DEFAULT_CONFIG, normalized);
  assert.deepEqual(next.locks, ["links", "forwards", "channels"]);
  assert.equal(next.captcha, false);
});

test("a legacy config with filters off ends with no locks", () => {
  const next = applyPatch(DEFAULT_CONFIG, normalizeLegacy({ filterLinks: false, filterForwards: false, filterChannels: false }));
  assert.deepEqual(next.locks, []);
});

test("strikes off falls back to the flat action", () => {
  const next = applyPatch(DEFAULT_CONFIG, { strikes: [] });
  assert.deepEqual(next.strikes, []);
});

test("coerceField converts by field type", () => {
  assert.equal(coerceField("maxLength", "800"), 800);
  assert.equal(coerceField("captcha", "off"), false);
  assert.equal(coerceField("captcha", "1"), true);
  assert.equal(coerceField("captchaPrompt", "hi"), "hi");
  assert.equal(coerceField("logChatId", "off"), "");
});

test("parseKeywords dedupes, trims and drops paragraph-length entries", () => {
  assert.deepEqual(parseKeywords("A, b，A、c"), ["A", "b", "c"]);
  assert.deepEqual(parseKeywords(["x", "x", "y".repeat(81)]), ["x"]);
});

test("describeConfig mentions the active rules", () => {
  const lines = describeConfig(applyPatch(DEFAULT_CONFIG, { nightMode: true, cas: true })).join("\n");
  assert.match(lines, /新人验证：开/);
  assert.match(lines, /拦截：链接/);
  assert.match(lines, /夜间模式：23:00–07:00/);
  assert.match(lines, /CAS/);
});

/**
 * The field table is the only thing standing between an admin and forty-four
 * raw camelCase keys. These tests exist because the failure mode is silent: add
 * a key to `configSchema`, forget the row, and the console renders
 * `captchaKick` as a label with no hint — nobody files a bug about a label.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FIELDS, FIELD_GROUPS, fieldLabel, fieldPayload } from "../src/admin/fields.ts";
import { renderConsole } from "../src/admin/page.ts";
import { CAPTCHA_MODES, LOCK_KINDS, SPAM_ACTIONS, configSchema } from "../src/rules.ts";

const schemaKeys = Object.keys(configSchema.shape).sort();
const tableKeys = FIELDS.map((field) => field.key).sort();

test("every config key has exactly one row in the field table", () => {
  assert.deepEqual(tableKeys, schemaKeys, "field table and schema disagree");
  assert.equal(new Set(tableKeys).size, tableKeys.length, "a key is listed twice");
});

test("every row lands in a group that exists", () => {
  const ids = new Set(FIELD_GROUPS.map((group) => group.id));
  for (const field of FIELDS) {
    assert.ok(ids.has(field.group), `${field.key} points at unknown group ${field.group}`);
  }
});

test("no group is empty, because an empty heading is a broken page", () => {
  for (const group of FIELD_GROUPS) {
    assert.ok(
      FIELDS.some((field) => field.group === group.id),
      `group ${group.id} has no fields`,
    );
  }
});

test("labels are Chinese and never the raw identifier", () => {
  for (const field of FIELDS) {
    assert.ok(field.label.length > 0, `${field.key} has no label`);
    assert.notEqual(field.label, field.key, `${field.key} was left untranslated`);
    assert.match(field.label, /[\u4e00-\u9fa5]/, `${field.key} label is not Chinese: ${field.label}`);
  }
});

test("options for the enum fields track the schema instead of drifting", () => {
  const optionsOf = (key: string) => FIELDS.find((field) => field.key === key)?.options?.map((o) => o.value);
  assert.deepEqual(optionsOf("captchaMode"), [...CAPTCHA_MODES]);
  assert.deepEqual(optionsOf("spamAction"), [...SPAM_ACTIONS]);
  assert.deepEqual(optionsOf("locks"), [...LOCK_KINDS]);
  assert.deepEqual(optionsOf("aiCategories"), ["nsfw", "gambling", "ad", "qr"]);
  assert.deepEqual(optionsOf("newbieBlocks"), ["links", "mentions"]);
});

test("every enum-valued field carries options, and every option is labelled", () => {
  for (const field of FIELDS) {
    if (field.kind !== "select" && field.kind !== "locks") continue;
    assert.ok(field.options && field.options.length >= 2, `${field.key} is a ${field.kind} with no options`);
    for (const option of field.options ?? []) {
      assert.match(option.label, /[\u4e00-\u9fa5]/, `${field.key}.${option.value} has no Chinese label`);
    }
  }
});

test("numbers carry a unit, because '900' means nothing without one", () => {
  for (const field of FIELDS) {
    if (field.kind !== "number") continue;
    assert.ok(field.unit, `${field.key} is a number with no unit`);
  }
});

test("fieldLabel falls back to the key instead of rendering blank", () => {
  assert.equal(fieldLabel("captchaTimeout"), "验证时限");
  assert.equal(fieldLabel("somethingNew"), "somethingNew");
});

test("the payload survives JSON round-tripping", () => {
  const payload = fieldPayload();
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  assert.equal(payload.fields.length, schemaKeys.length);
});

test("the rendered page ships the labels, not the raw key list", () => {
  const html = renderConsole();
  for (const field of FIELDS) {
    assert.ok(html.includes(field.label), `${field.key} label missing from the page`);
  }
  assert.ok(html.includes("验证时限"), "the page should carry the Chinese table");
  assert.ok(html.includes('groups'), "the page should carry the group structure");
  // The old renderer printed the key as the visible label; the new one puts it in
  // a <code> chip. Both contain the string, so assert on the chip instead.
  assert.ok(html.includes('fkey'), "raw keys should be rendered as a small chip");
});

test("the page has no unresolved template placeholder left in it", () => {
  const html = renderConsole();
  assert.ok(!html.includes("${FIELD_DATA}"), "the field payload was not interpolated");
  assert.ok(!/\$\{[a-zA-Z]+\}/.test(html), "an interpolation was left unrendered");
});

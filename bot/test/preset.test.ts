import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUpdate } from "../src/bot.ts";
import { PRESET, readPreset, writePreset } from "../src/preset.ts";
import { GROUP, makeRuntime, message, nextUpdate } from "./harness.ts";

test("the first message in a new group writes the conservative preset", async () => {
  const h = await makeRuntime();
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ text: "你好" }) });

  const config = await h.rt.configFor(GROUP.id);
  assert.equal(config.captcha, true);
  assert.equal(config.floodLimit, PRESET.floodLimit);
  assert.equal(config.floodWindow, PRESET.floodWindow);
  assert.equal(config.warnLimit, 3);
  assert.equal(config.newbieHours, 24);
  assert.deepEqual(config.keywords, [], "no keyword filter by default");
  assert.equal(config.cas, false);
  assert.equal(config.logChatId, "");
  assert.equal(config.strikes.length, 3, "the ladder ships with the preset");
});

test("the preset is written once and then owned by the group", async () => {
  const h = await makeRuntime();
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ text: "你好" }) });
  await h.rt.saveConfig(GROUP.id, { floodLimit: 0 });

  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ text: "还在吗" }) });
  const config = await h.rt.configFor(GROUP.id);
  assert.equal(config.floodLimit, 0, "a later message must not re-apply the preset");
});

test("a group with an existing config is left alone", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(GROUP.id, { captcha: false, keywords: ["旧词"] });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ text: "你好" }) });
  const config = await h.rt.configFor(GROUP.id);
  assert.equal(config.captcha, false);
  assert.deepEqual(config.keywords, ["旧词"]);
});

test("the stored preset keeps only the keys that were set", async () => {
  const h = await makeRuntime();
  assert.equal(await writePreset(h.rt, { floodLimit: 7 }), "");
  assert.deepEqual((await readPreset(h.rt)).preset, { floodLimit: 7 });

  // A second edit must merge, not reset the first one.
  assert.equal(await writePreset(h.rt, { captcha: false }), "");
  assert.deepEqual((await readPreset(h.rt)).preset, { floodLimit: 7, captcha: false });

  assert.notEqual(await writePreset(h.rt, { floodLimit: 999 }), "", "out-of-range values are refused");
  assert.notEqual(await writePreset(h.rt, { nope: 1 }), "", "unknown keys are refused");
});

test("the console preset overrides the built-in one for new groups", async () => {
  const h = await makeRuntime();
  await h.rt.store.put("preset:global", JSON.stringify({ floodLimit: 2, captcha: false }));
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ text: "你好" }) });
  const config = await h.rt.configFor(GROUP.id);
  assert.equal(config.floodLimit, 2);
  assert.equal(config.captcha, false);
  assert.equal(config.warnLimit, 3, "untouched keys still come from the built-in preset");
});

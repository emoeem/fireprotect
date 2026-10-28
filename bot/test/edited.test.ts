import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUpdate } from "../src/bot.ts";
import { recentEvents, warnCount } from "../src/db/repo.ts";
import { GROUP, makeRuntime, message, nextUpdate, user } from "./harness.ts";

const edited = (patch: Record<string, unknown> = {}) => message({ text: "hello", ...patch });

test("a clean post edited into spam is deleted, but the warn ladder is not touched", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(GROUP.id, { keywords: ["加微信"], locks: [] });
  await handleUpdate(h.rt, { update_id: nextUpdate(), edited_message: edited({ text: "加微信 https://t.me/+abc" }) });

  assert.equal(h.fake.count("deleteMessage"), 1);
  assert.equal(await warnCount(h.rt.db, GROUP.id, 500, h.now()), 0, "an edit never advances the ladder");
  assert.equal(h.fake.count("restrictChatMember"), 0);
  assert.equal(h.fake.count("banChatMember"), 0);
});

test("a harmless edit costs no moderation API calls at all", async () => {
  const h = await makeRuntime();
  await handleUpdate(h.rt, { update_id: nextUpdate(), edited_message: edited({ text: "改个错别字" }) });
  assert.equal(h.fake.count("deleteMessage"), 0);
  assert.equal(h.fake.count("sendMessage"), 0);
});

test("a redelivered edit is processed once", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(GROUP.id, { keywords: ["加微信"], locks: [] });
  const update = { update_id: nextUpdate(), edited_message: edited({ text: "加微信" }) };
  await handleUpdate(h.rt, update);
  await handleUpdate(h.rt, update);
  assert.equal(h.fake.count("deleteMessage"), 1);
});

test("an admin's edit passes, and a whitelisted keyword is only recorded", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: "9001" } });
  await h.rt.saveConfig(GROUP.id, { keywords: ["加微信"], locks: [] });
  await handleUpdate(h.rt, { update_id: nextUpdate(), edited_message: edited({ text: "加微信", from: user(9001, "群主") }) });
  assert.equal(h.fake.count("deleteMessage"), 0, "admins are never filtered, even on edit");

  await h.rt.saveConfig(GROUP.id, { keywords: ["加微信"], keywordAction: "record", locks: [] });
  await handleUpdate(h.rt, { update_id: nextUpdate(), edited_message: edited({ text: "加微信", from: user(600) }) });
  assert.equal(h.fake.count("deleteMessage"), 0, "a record-only keyword survives an edit");
  const events = await recentEvents(h.rt.db, GROUP.id, 5);
  assert.equal(events[0]?.kind, "watch");
  assert.match(events[0]?.reason ?? "", /编辑只记录/);
});

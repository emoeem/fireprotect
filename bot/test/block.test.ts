import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUpdate } from "../src/bot.ts";
import { warnCount } from "../src/db/repo.ts";
import { blocked, listBlocked } from "../src/block.ts";
import { GROUP, command, makeRuntime, message, nextUpdate, user } from "./harness.ts";

const admin = () => makeRuntime({ env: { ADMIN_IDS: "9001" } });

test("/block records the member and says so to the admin", async () => {
  const h = await admin();
  const spam = message({ from: user(500), text: "广告" });
  await handleUpdate(h.rt, {
    update_id: nextUpdate(),
    message: command("/block", { from: user(9001, "群主"), reply_to_message: spam }),
  });

  const rows = await listBlocked(h.rt, GROUP.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.userId, 500);
  assert.match(String(h.fake.find("sendMessage")?.body.text ?? ""), /已屏蔽/);
});

test("a blocked member's message is deleted with no notice and no warning", async () => {
  const h = await admin();
  await h.rt.saveConfig(GROUP.id, { keywords: [], locks: [] });
  await handleUpdate(h.rt, {
    update_id: nextUpdate(),
    message: command("/block 500001 发广告", { from: user(9001, "群主") }),
  });
  h.fake.reset();

  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ from: user(500001), text: "你好" }) });

  assert.equal(h.fake.count("deleteMessage"), 1);
  assert.equal(h.fake.count("sendMessage"), 0, "shadow ban is silent");
  assert.equal(h.fake.count("restrictChatMember"), 0, "no mute, no ban");
  assert.equal(await warnCount(h.rt.db, GROUP.id, 500001, h.now()), 0, "no warning, so the ladder never escalates");
});

test("the ban is cached, so the second message costs no query but still deletes", async () => {
  const h = await admin();
  await h.rt.saveConfig(GROUP.id, { keywords: [], locks: [] });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/block 500002", { from: user(9001, "群主") }) });
  assert.equal(await blocked(h.rt, GROUP.id, 500002), true);

  h.fake.reset();
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ from: user(500002), text: "a" }) });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ from: user(500002), text: "b" }) });
  assert.equal(h.fake.count("deleteMessage"), 2);
});

test("/unblock lets the member speak again immediately", async () => {
  const h = await admin();
  await h.rt.saveConfig(GROUP.id, { keywords: [], locks: [] });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/block 500003", { from: user(9001, "群主") }) });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/unblock 500003", { from: user(9001, "群主") }) });

  assert.deepEqual(await listBlocked(h.rt, GROUP.id), []);
  h.fake.reset();
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ from: user(500003), text: "我回来了" }) });
  assert.equal(h.fake.count("deleteMessage"), 0);
});

test("/blocks lists the shadow bans for an admin", async () => {
  const h = await admin();
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/block 500004 刷屏", { from: user(9001, "群主") }) });
  h.fake.reset();
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/blocks", { from: user(9001, "群主") }) });
  const text = String(h.fake.find("sendMessage")?.body.text ?? "");
  assert.match(text, /本群屏蔽 1 人/);
  assert.match(text, /500004/);
});

test("a stranger cannot block anyone", async () => {
  const h = await admin();
  await handleUpdate(h.rt, {
    update_id: nextUpdate(),
    message: command("/block 500005", { from: user(6666), reply_to_message: message({ from: user(500) }) }),
  });
  assert.deepEqual(await listBlocked(h.rt, GROUP.id), []);
  assert.match(String(h.fake.find("sendMessage")?.body.text ?? ""), /没有这个权限/);
});

test("a blocked newcomer cannot verify their way back in", async () => {
  const h = await admin();
  await h.rt.saveConfig(GROUP.id, { captcha: true, captchaMode: "button" });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/block 500006", { from: user(9001, "群主") }) });
  await handleUpdate(h.rt, {
    update_id: nextUpdate(),
    message: message({ text: "", from: user(500006), new_chat_members: [user(500006)] }),
  });
  h.fake.reset();
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ from: user(500006), text: "放我进去" }) });
  assert.equal(h.fake.count("deleteMessage"), 1);
  assert.equal(h.fake.count("restrictChatMember"), 0);
});

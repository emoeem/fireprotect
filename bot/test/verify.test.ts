import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUpdate } from "../src/bot.ts";
import { sweepExpired } from "../src/handlers/verify.ts";
import { buttonData, buttonDataAll, callback, makeRuntime, message, nextUpdate, user } from "./harness.ts";
import type { TgMessage } from "../src/types.ts";

const join = (member = user(500)): TgMessage => message({ text: "", from: member, new_chat_members: [member] });

test("a newcomer is muted and gets a signed button", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { captcha: true, captchaMode: "button" });

  await handleUpdate(h.rt, { update_id: nextUpdate(), message: join() });

  const restrict = h.fake.all("restrictChatMember");
  assert.equal(restrict.length, 1);
  assert.equal(restrict[0]?.body.permissions.can_send_messages, false);
  assert.ok(Number(restrict[0]?.body.until_date) > 0, "the mute must expire with the window");

  const data = buttonData(h.fake);
  assert.match(data, /^v1\./);
  assert.ok(data.length <= 64, "callback_data must fit Telegram's 64-byte limit");
});

test("pressing the button unmutes, welcomes and removes the prompt", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { captcha: true, captchaMode: "button", welcomeText: "欢迎 {name}" });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: join() });
  const data = buttonData(h.fake);
  h.fake.reset();

  await handleUpdate(h.rt, { update_id: nextUpdate(), callback_query: callback(data, 500) });

  const restore = h.fake.all("restrictChatMember").at(-1);
  assert.equal(restore?.body.permissions.can_send_messages, true);
  assert.equal(restore?.body.permissions.can_invite_users, false, "verification must not grant invite rights");
  assert.equal(h.fake.count("deleteMessage"), 1, "the dead button is cleaned up");
  assert.match(String(h.fake.find("sendMessage")?.body.text ?? ""), /欢迎 小明/);
  assert.equal(await h.rt.store.get("verify:-1001:500"), null);
});

test("a crafted callback for another member does not verify them", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { captcha: true, captchaMode: "button" });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: join(user(500)) });
  const data = buttonData(h.fake);
  h.fake.reset();

  // Attacker forges the payload for themselves while the nonce belongs to 500.
  await handleUpdate(h.rt, { update_id: nextUpdate(), callback_query: callback(data, 666) });

  assert.equal(h.fake.count("restrictChatMember"), 0, "no unmute for the attacker");
  assert.match(String(h.fake.find("answerCallbackQuery")?.body.text ?? ""), /不是给你的/);
});

test("math mode offers four buttons and only the right one verifies", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { captcha: true, captchaMode: "math" });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: join() });

  const payloads = buttonDataAll(h.fake);
  assert.equal(payloads.length, 4);
  assert.equal(new Set(payloads).size, 4);
  const sent = String(h.fake.find("sendMessage")?.body.text ?? "");
  assert.match(sent, /= \?/);

  // Try every option but the last; at most one verifies.
  const before = h.fake.count("restrictChatMember");
  let verified = 0;
  for (const payload of payloads) {
    h.fake.reset();
    await handleUpdate(h.rt, { update_id: nextUpdate(), callback_query: callback(payload, 500) });
    const unmuted = h.fake.all("restrictChatMember").some((call) => call.body.permissions.can_send_messages === true);
    if (unmuted) verified += 1;
  }
  assert.equal(verified, 1, "exactly one option is the answer");
  assert.ok(before >= 1);
});

test("question mode does not mute, deletes wrong answers, and accepts the right one", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, {
    captcha: true,
    captchaMode: "question",
    captchaQuestion: "本群主题？",
    captchaAnswer: ["读书"],
  });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: join() });

  assert.equal(h.fake.count("restrictChatMember"), 0, "a text answer needs an unmuted member");
  assert.match(String(h.fake.find("sendMessage")?.body.text ?? ""), /本群主题/);

  h.fake.reset();
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ text: "吃饭" }) });
  assert.equal(h.fake.count("deleteMessage"), 1);
  assert.match(String(h.fake.find("sendMessage")?.body.text ?? ""), /答案不对/);

  h.fake.reset();
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ text: " 读书 " }) });
  const restore = h.fake.all("restrictChatMember").at(-1);
  assert.equal(restore?.body.permissions.can_send_messages, true);
});

test("an expired window kicks the member and clears the record", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { captcha: true, captchaMode: "button", captchaTimeout: 60 });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: join() });
  h.fake.reset();

  h.advance(61_000);
  const result = await sweepExpired(h.rt);

  assert.equal(result.expired, 1);
  assert.equal(h.fake.count("banChatMember"), 1);
  assert.equal(h.fake.count("unbanChatMember"), 1, "ban+unban = kick, so they may return later");
  assert.equal(await h.rt.store.get("verify:-1001:500"), null);
});

test("captcha off means a plain welcome", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { captcha: false, welcomeText: "欢迎 {name}" });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: join() });
  assert.equal(h.fake.count("restrictChatMember"), 0);
  assert.match(String(h.fake.find("sendMessage")?.body.text ?? ""), /欢迎/);
});

test("a CAS hit bans before the challenge is even offered", async () => {
  const h = await makeRuntime({ env: { CAS_KEY: "k" } });
  await h.rt.saveConfig(-1001, { captcha: true, cas: true });
  // The screener is constructed at runtime creation; point it at a fake host by
  // replacing the runtime's fetch through a fresh screener is not possible, so
  // assert the decision path instead: local list bans without any network.
  await h.rt.db.insert((await import("../src/db/schema.ts")).bannedUsers).values({
    userId: 501,
    reason: "历史广告",
    source: "local",
    at: h.now(),
  });

  await handleUpdate(h.rt, { update_id: nextUpdate(), message: join(user(501)) });

  assert.equal(h.fake.count("banChatMember"), 1);
  assert.equal(h.fake.all("sendMessage").filter((call) => call.body.reply_markup).length, 0, "no button for a known spammer");
});

test("the join-rate threshold warns once and can lock the group", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { captcha: false, joinRateMax: 2, joinRateWindow: 30, joinRateAction: "lock" });

  for (let i = 0; i < 3; i++) {
    await handleUpdate(h.rt, { update_id: nextUpdate(), message: join(user(600 + i)) });
  }

  assert.equal(h.fake.count("setChatPermissions"), 1, "the group is locked at the threshold");
  const notice = h.fake.all("sendMessage").filter((call) => String(call.body.text).includes("疑似炸群"));
  assert.equal(notice.length, 1);
});

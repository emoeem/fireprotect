import assert from "node:assert/strict";
import test from "node:test";
import { challenge, handleCaptchaCallback, pendingKey, pendingOf, sweep } from "../src/captcha.ts";
import { DEFAULT_RULES } from "../src/rules.ts";
import { callback, buttonData, GROUP, makeCtx, message, user } from "./harness.ts";

test("challenge mutes with an expiry so a dead bot cannot silence anyone forever", async () => {
  const { ctx, fake } = makeCtx();
  const member = user(500);
  await challenge(ctx, message({ from: member, chat: GROUP }), member, DEFAULT_RULES);

  const mute = fake.find("restrictChatMember");
  assert.equal(mute?.body.user_id, 500);
  assert.equal(mute?.body.permissions.can_send_messages, false);
  assert.equal(mute?.body.use_independent_chat_permissions, true);
  // until_date = now + captchaTimeout, so Telegram lifts it even if we never
  // sweep. The harness clock starts at 1_700_000_000_000 ms.
  assert.equal(mute?.body.until_date, 1_700_000_000 + DEFAULT_RULES.captchaTimeout);

  const prompt = fake.find("sendMessage");
  assert.ok(prompt?.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data);
  assert.match(String(prompt?.body.text), /先点下面的按钮/);
  assert.ok(await pendingOf(ctx, GROUP.id, 500));
});

test("a valid button press restores the right to talk and nothing more", async () => {
  const { ctx, fake } = makeCtx();
  const member = user(500);
  await challenge(ctx, message({ from: member }), member, DEFAULT_RULES);

  await handleCaptchaCallback(ctx, callback(buttonData(fake), 500), DEFAULT_RULES);

  const restore = fake.all("restrictChatMember").at(-1);
  assert.equal(restore?.body.permissions.can_send_messages, true);
  // Not a moderator: inviting and pinning stay off.
  assert.equal(restore?.body.permissions.can_invite_users, false);
  assert.equal(restore?.body.permissions.can_pin_messages, false);
  assert.equal(await pendingOf(ctx, GROUP.id, 500), null);
  assert.equal(fake.count("deleteMessage"), 1);
  assert.equal(fake.count("sendMessage"), 2); // prompt + welcome
});

test("someone else's button is refused", async () => {
  const { ctx, fake } = makeCtx();
  await challenge(ctx, message({ from: user(500) }), user(500), DEFAULT_RULES);

  await handleCaptchaCallback(ctx, callback(buttonData(fake), 501), DEFAULT_RULES);

  assert.equal(fake.count("restrictChatMember"), 1); // the initial mute only
  const answer = fake.all("answerCallbackQuery").at(-1);
  assert.match(String(answer?.body.text), /不是你的验证按钮/);
});

test("an expired button is refused", async () => {
  const { ctx, fake, advance } = makeCtx();
  await challenge(ctx, message({ from: user(500) }), user(500), { ...DEFAULT_RULES, captchaTimeout: 60 });
  advance(61_000);

  await handleCaptchaCallback(ctx, callback(buttonData(fake), 500), DEFAULT_RULES);

  const answer = fake.all("answerCallbackQuery").at(-1);
  assert.match(String(answer?.body.text), /已过期/);
  assert.equal(fake.count("restrictChatMember"), 1);
});

test("a tampered signature is refused", async () => {
  const { ctx, fake } = makeCtx();
  await challenge(ctx, message({ from: user(500) }), user(500), DEFAULT_RULES);
  const good = buttonData(fake);
  const bad = good.slice(0, good.lastIndexOf(":") + 1) + "0000000000000000";

  await handleCaptchaCallback(ctx, callback(bad, 500), DEFAULT_RULES);

  const answer = fake.all("answerCallbackQuery").at(-1);
  assert.match(String(answer?.body.text), /签名不符/);
});

test("a prompt that cannot be delivered gives the membership back", async () => {
  const { ctx, fake } = makeCtx();
  fake.on("sendMessage", { ok: false, description: "not enough rights", error_code: 400 });
  const member = user(500);

  await challenge(ctx, message({ from: member }), member, DEFAULT_RULES);

  const calls = fake.all("restrictChatMember");
  assert.equal(calls.length, 2);
  assert.equal(calls.at(-1)?.body.permissions.can_send_messages, true);
  assert.equal(await pendingOf(ctx, GROUP.id, 500), null);
});

test("sweep removes members whose window closed and leaves the rest alone", async () => {
  const { ctx, fake, advance } = makeCtx();
  await challenge(ctx, message({ from: user(500) }), user(500), { ...DEFAULT_RULES, captchaTimeout: 60 });
  await ctx.store.put(pendingKey(GROUP.id, 501), JSON.stringify({ exp: 1_600_000_000, promptId: 42 }), 600);
  // Still inside its window: must survive the sweep untouched.
  await ctx.store.put(pendingKey(GROUP.id, 502), JSON.stringify({ exp: 1_700_100_000, promptId: 43 }), 600);
  advance(61_000);

  const removed = await sweep(ctx, GROUP.id, DEFAULT_RULES);

  assert.equal(removed, 2);
  assert.equal(fake.count("banChatMember"), 2);
  assert.equal(fake.count("unbanChatMember"), 2);
  assert.equal(await ctx.store.get(pendingKey(GROUP.id, 501)), null);
  assert.equal(await ctx.store.get(pendingKey(GROUP.id, 500)), null);
  assert.ok(await ctx.store.get(pendingKey(GROUP.id, 502)));
});

test("sweep is throttled per chat so every message does not list the store", async () => {
  const { ctx } = makeCtx();
  assert.equal(await sweep(ctx, GROUP.id, DEFAULT_RULES), 0);
  await ctx.store.put(pendingKey(GROUP.id, 501), JSON.stringify({ exp: 2, promptId: 42 }), 600);
  // Second call inside the 30s marker returns without touching the store.
  assert.equal(await sweep(ctx, GROUP.id, DEFAULT_RULES), 0);
  assert.ok(await ctx.store.get(pendingKey(GROUP.id, 501)));
});

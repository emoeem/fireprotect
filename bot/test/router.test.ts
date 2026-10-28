import assert from "node:assert/strict";
import test from "node:test";
import { saveRules } from "../src/context.ts";
import { handleUpdate, moderate } from "../src/router.ts";
import { GROUP, makeCtx, message, update, user } from "./harness.ts";

test("a post made on behalf of a channel is caught even though it has no sender", async () => {
  const { ctx, fake } = makeCtx();
  const msg = message({ from: undefined, sender_chat: { id: -2002, type: "channel", title: "广告频道" } });

  await moderate(ctx, msg);

  // This is exactly the case the template's filter order made unreachable.
  assert.equal(fake.count("deleteMessage"), 1);
});

test("a link from a plain member is removed", async () => {
  const { ctx, fake } = makeCtx();
  await moderate(ctx, message({ text: "看这个 abc.com" }));
  assert.equal(fake.count("deleteMessage"), 1);
});

test("an admin can post a link", async () => {
  const { ctx, fake } = makeCtx();
  await moderate(ctx, message({ from: user(9001), text: "看这个 abc.com" }));
  assert.equal(fake.count("deleteMessage"), 0);
});

test("a forwarded message is only removed when the rule is on", async () => {
  const { ctx, fake } = makeCtx();
  const forwarded = message({ forward_origin: { type: "hidden_user" } });

  await moderate(ctx, forwarded);
  assert.equal(fake.count("deleteMessage"), 0);

  await saveRules(ctx, GROUP.id, { filterForwards: true });
  await moderate(ctx, forwarded);
  assert.equal(fake.count("deleteMessage"), 1);
});

test("flood control punishes the message that crosses the limit", async () => {
  const { ctx, fake } = makeCtx();
  await saveRules(ctx, GROUP.id, { floodLimit: 2, floodWindow: 10 });

  for (let i = 0; i < 3; i++) await moderate(ctx, message({ from: user(600), text: "hi" }));

  assert.equal(fake.count("deleteMessage"), 1);
  assert.equal(fake.count("banChatMember"), 0);
});

test("a new member is muted and challenged, and the service message is removed", async () => {
  const { ctx, fake } = makeCtx();
  const joiner = user(600, "新人");

  await handleUpdate(ctx, update({ message: message({ from: joiner, new_chat_members: [joiner] }) }));

  assert.equal(fake.find("restrictChatMember")?.body.user_id, 600);
  assert.equal(fake.find("restrictChatMember")?.body.permissions.can_send_messages, false);
  assert.ok(fake.find("sendMessage")?.body.reply_markup);
  assert.ok(fake.count("deleteMessage") >= 1);
});

test("with the captcha off the member is welcomed instead of muted", async () => {
  const { ctx, fake } = makeCtx();
  await saveRules(ctx, GROUP.id, { captcha: false });
  const joiner = user(601, "阿明");

  await handleUpdate(ctx, update({ message: message({ from: joiner, new_chat_members: [joiner] }) }));

  assert.equal(fake.count("restrictChatMember"), 0);
  assert.match(String(fake.find("sendMessage")?.body.text), /阿明/);
});

test("a leaving member's service message is removed", async () => {
  const { ctx, fake } = makeCtx();
  await handleUpdate(ctx, update({ message: message({ left_chat_member: user(601) }) }));
  assert.equal(fake.count("deleteMessage"), 1);
});

test("being added as admin produces the setup instructions", async () => {
  const { ctx, fake } = makeCtx();
  await handleUpdate(
    ctx,
    update({
      my_chat_member: {
        chat: GROUP,
        from: user(9001),
        old_chat_member: { status: "left", user: user(123456) },
        new_chat_member: { status: "member", user: user(123456) },
      },
    }),
  );
  assert.match(String(fake.find("sendMessage")?.body.text), /设为管理员/);
});

test("an edit is re-checked, because the first version may have been clean", async () => {
  const { ctx, fake } = makeCtx();
  await handleUpdate(ctx, update({ edited_message: message({ text: "加微信 详聊" }) }));
  assert.equal(fake.count("deleteMessage"), 1);
});

test("private chats are never moderated", async () => {
  const { ctx, fake } = makeCtx();
  await handleUpdate(ctx, update({ message: message({ chat: { id: 500, type: "private" }, text: "加微信" }) }));
  assert.equal(fake.count("deleteMessage"), 0);
});

test("a non-admin command that is not a moderation command falls through to the filter", async () => {
  const { ctx, fake } = makeCtx();
  // `/start` from a stranger in a group is ignored by handleCommand, then the
  // message is moderated like any other text (no match here, so nothing).
  await handleUpdate(ctx, update({ message: message({ from: user(500), text: "/start" }) }));
  assert.equal(fake.count("deleteMessage"), 0);
});

test("a bot joining is ignored", async () => {
  const { ctx, fake } = makeCtx();
  const bot = { id: 777, first_name: "other_bot", is_bot: true };
  await handleUpdate(ctx, update({ message: message({ from: bot, new_chat_members: [bot] }) }));
  assert.equal(fake.count("restrictChatMember"), 0);
});

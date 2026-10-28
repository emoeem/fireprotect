import assert from "node:assert/strict";
import test from "node:test";
import { handleCommand, parseTarget } from "../src/commands.ts";
import { rulesFor, saveRules } from "../src/context.ts";
import { DEFAULT_RULES } from "../src/rules.ts";
import { command, GROUP, makeCtx, message, user } from "./harness.ts";

const ADMIN = 9001;
const STRANGER = 500;

test("parseTarget reads a reply plus a duration", () => {
  const msg = command("/ban 30", { reply_to_message: message({ from: user(700) }) });
  assert.deepEqual(parseTarget(msg, "30"), { id: 700, minutes: 30, error: "" });
});

test("parseTarget accepts `id duration` without a reply", () => {
  assert.deepEqual(parseTarget(command("/ban 700 30"), "700 30"), { id: 700, minutes: 30, error: "" });
});

test("parseTarget refuses a bare small number instead of muting user 10", () => {
  const target = parseTarget(command("/mute 10"), "10");
  assert.equal(target.id, 0);
  assert.match(target.error, /只写了分钟数/);
});

test("parseTarget still accepts a bare id when it cannot be a duration", () => {
  assert.deepEqual(parseTarget(command("/ban 123456789"), "123456789"), {
    id: 123456789,
    minutes: 0,
    error: "",
  });
});

test("/ban on a reply bans the author and reports success", async () => {
  const { ctx, fake } = makeCtx();
  const rules = await rulesFor(ctx, GROUP.id);
  const msg = command("/ban", { from: user(ADMIN), reply_to_message: message({ from: user(700) }) });

  assert.equal(await handleCommand(ctx, msg, rules), true);
  assert.equal(fake.find("banChatMember")?.body.user_id, 700);
  assert.equal(fake.find("banChatMember")?.body.until_date, undefined);
  assert.match(String(fake.find("sendMessage")?.body.text), /已封禁/);
});

test("/ban 30 sets an expiry", async () => {
  const { ctx, fake } = makeCtx();
  const rules = await rulesFor(ctx, GROUP.id);
  const msg = command("/ban 30", { from: user(ADMIN), reply_to_message: message({ from: user(700) }) });

  await handleCommand(ctx, msg, rules);
  const until = fake.find("banChatMember")?.body.until_date as number;
  // Harness clock: 1_700_000_000_000 ms + 30 minutes.
  assert.equal(until, 1_700_000_000 + 1800);
});

test("/mute 10 is refused, and nothing is sent to Telegram", async () => {
  const { ctx, fake } = makeCtx();
  const rules = await rulesFor(ctx, GROUP.id);

  await handleCommand(ctx, command("/mute 10", { from: user(ADMIN) }), rules);

  assert.equal(fake.count("restrictChatMember"), 0);
  assert.match(String(fake.find("sendMessage")?.body.text), /只写了分钟数/);
});

test("a failed Telegram call is reported as failure, not as success", async () => {
  const { ctx, fake } = makeCtx();
  const rules = await rulesFor(ctx, GROUP.id);
  fake.on("banChatMember", { ok: false, description: "not enough rights to restrict", error_code: 400 });

  await handleCommand(ctx, command("/ban", { from: user(ADMIN), reply_to_message: message({ from: user(700) }) }), rules);

  assert.match(String(fake.find("sendMessage")?.body.text), /没成功：not enough rights/);
});

test("admin targets are protected, including /unban", async () => {
  const { ctx, fake } = makeCtx();
  const rules = await rulesFor(ctx, GROUP.id);

  await handleCommand(ctx, command("/unban", { from: user(ADMIN), reply_to_message: message({ from: user(ADMIN) }) }), rules);

  assert.equal(fake.count("unbanChatMember"), 0);
  assert.match(String(fake.find("sendMessage")?.body.text), /不能对管理员/);
});

test("the bot itself is protected", async () => {
  const { ctx, fake } = makeCtx();
  const rules = await rulesFor(ctx, GROUP.id);
  await handleCommand(ctx, command("/ban 123456", { from: user(ADMIN) }), rules);
  assert.equal(fake.count("banChatMember"), 0);
  assert.match(String(fake.find("sendMessage")?.body.text), /不能对我自己/);
});

test("warnings escalate to a ban at the limit and reset the counter", async () => {
  const { ctx, fake } = makeCtx();
  await saveRules(ctx, GROUP.id, { warnLimit: 3, spamAction: "delete" });
  const rules = await rulesFor(ctx, GROUP.id);
  const reply = message({ from: user(700) });

  for (let i = 0; i < 2; i++) {
    await handleCommand(ctx, command("/warn", { from: user(ADMIN), reply_to_message: reply }), rules);
  }
  assert.equal(fake.count("banChatMember"), 0);

  await handleCommand(ctx, command("/warn", { from: user(ADMIN), reply_to_message: reply }), rules);
  assert.equal(fake.find("banChatMember")?.body.user_id, 700);
  assert.match(String(fake.all("sendMessage").at(-1)?.body.text), /警告已满 3 次/);

  // Counter cleared, so one more warning starts again at 1.
  const left = await ctx.store.get(`warn:${GROUP.id}:700`);
  assert.equal(left, null);
});

test("/keywords add and del edit the stored rules", async () => {
  const { ctx } = makeCtx();
  const rules = await rulesFor(ctx, GROUP.id);

  await handleCommand(ctx, command("/keywords add 引流,代开", { from: user(ADMIN) }), rules);
  let saved = await rulesFor(ctx, GROUP.id);
  assert.ok(saved.keywords.includes("引流"));
  assert.ok(saved.keywords.includes("代开"));

  await handleCommand(ctx, command("/keywords del 引流", { from: user(ADMIN) }), saved);
  saved = await rulesFor(ctx, GROUP.id);
  assert.ok(!saved.keywords.includes("引流"));
});

test("/set persists a boolean and a number", async () => {
  const { ctx } = makeCtx();
  const rules = await rulesFor(ctx, GROUP.id);

  await handleCommand(ctx, command("/set captcha off", { from: user(ADMIN) }), rules);
  await handleCommand(ctx, command("/set maxLength 0", { from: user(ADMIN) }), rules);

  const saved = await rulesFor(ctx, GROUP.id);
  assert.equal(saved.captcha, false);
  assert.equal(saved.maxLength, 0);
});

test("/set rejects an unknown field without writing anything", async () => {
  const { ctx, fake } = makeCtx();
  const rules = await rulesFor(ctx, GROUP.id);
  await handleCommand(ctx, command("/set nuke true", { from: user(ADMIN) }), rules);
  assert.match(String(fake.find("sendMessage")?.body.text), /未知字段/);
  assert.equal(await ctx.store.get(`rules:${GROUP.id}`), null);
});

test("a non-admin gets silence, not an error message", async () => {
  const { ctx, fake } = makeCtx();
  const rules = await rulesFor(ctx, GROUP.id);

  const handled = await handleCommand(ctx, command("/ban 700", { from: user(STRANGER) }), rules);

  assert.equal(handled, false);
  assert.equal(fake.count("banChatMember"), 0);
  assert.equal(fake.count("sendMessage"), 0);
});

test("/id answers in private even when the group reply is blocked", async () => {
  const { ctx, fake } = makeCtx();
  const rules = await rulesFor(ctx, GROUP.id);
  fake.on("sendMessage", (body) =>
    body.chat_id === STRANGER
      ? { ok: false, description: "bot can't initiate conversation", error_code: 403 }
      : { ok: true, result: true },
  );

  await handleCommand(ctx, command("/id", { from: user(STRANGER) }), rules);

  assert.equal(fake.count("sendMessage"), 2);
  assert.match(String(fake.all("sendMessage").at(-1)?.body.text), /你的 ID 是 500/);
});

test("/rules is available to everyone", async () => {
  const { ctx, fake } = makeCtx();
  const rules = await rulesFor(ctx, GROUP.id);
  await handleCommand(ctx, command("/rules", { from: user(STRANGER) }), rules);
  assert.match(String(fake.find("sendMessage")?.body.text), /处置：/);
});

test("legacy defaults still parse: /help in a group is admin-only", async () => {
  const { ctx, fake } = makeCtx();
  const rules = await rulesFor(ctx, GROUP.id);
  assert.equal(await handleCommand(ctx, command("/help", { from: user(STRANGER) }), rules), false);
  await handleCommand(ctx, command("/help", { from: user(ADMIN) }), rules);
  assert.match(String(fake.find("sendMessage")?.body.text), /焰卫在岗/);
});

test("DEFAULT_RULES keeps the shipped keyword list", () => {
  assert.ok(DEFAULT_RULES.keywords.includes("加微信"));
});

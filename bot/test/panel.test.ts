/**
 * The in-Telegram control panel.
 *
 * Every screen is rendered, and every toggle is flipped through the callback
 * path a real button press takes. The two properties that matter: a button
 * press is re-authorized on every tap (the button is not the permission), and a
 * toggle re-renders the screen it belongs to instead of dumping you at the root.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { handlePanel, panelData, renderScreen } from "../src/panel.ts";
import { GROUP, makeRuntime } from "./harness.ts";
import type { TgCallbackQuery } from "../src/types.ts";

const OTHER_CHAT = { ...GROUP, id: -1002, title: "另一个群" };

const SCREENS = ["main", "chat", "captcha", "welcome", "locks", "punish", "night", "keywords", "sched", "stats", "bans", "invite", "export"];

function press(data: string, fromId = 9001, withMessage = true): TgCallbackQuery {
  return {
    id: "cb",
    from: { id: fromId, first_name: "群主", is_bot: false },
    data,
    ...(withMessage ? { message: { message_id: 77, chat: GROUP, from: { id: 1, first_name: "焰卫", is_bot: true } } } : {}),
  };
}

async function panel(options: Parameters<typeof makeRuntime>[0] = {}) {
  const h = await makeRuntime({ env: { ADMIN_IDS: "9001" }, ...options });
  await h.rt.saveConfig(GROUP.id, {});
  return h;
}

test("every screen renders text and a keyboard", async () => {
  const h = await panel();
  for (const screen of SCREENS) {
    const view = await renderScreen(h.rt, GROUP.id, screen);
    assert.ok(view.text.length > 0, `${screen} has no text`);
    const rows = (view.markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    assert.ok(rows.length > 0, `${screen} has no buttons`);
    assert.ok(rows.every((row) => row.every((button) => button.callback_data.length > 0)));
  }
});

test("the root screen lists registered chats, or explains that there are none", async () => {
  const h = await panel();
  const empty = await renderScreen(h.rt, GROUP.id, "main");
  assert.match(empty.text, /还没有任何群/);
  assert.deepEqual((empty.markup as { inline_keyboard: unknown[] }).inline_keyboard.flat(), []);

  await h.rt.db.insert((await import("../src/db/schema.ts")).chats).values({
    chatId: OTHER_CHAT.id,
    title: OTHER_CHAT.title,
    type: "supergroup",
    at: h.now(),
  });
  const view = await renderScreen(h.rt, GROUP.id, "main");
  assert.match(JSON.stringify(view.markup), new RegExp(String(OTHER_CHAT.id)), "each chat becomes a button");
  assert.match(view.text, /共 1 个群/);
});

test("a screen button edits the message in place", async () => {
  const h = await panel();
  for (const screen of ["chat", "captcha", "welcome", "locks", "punish", "night", "keywords", "sched", "stats", "bans", "invite", "export"]) {
    h.fake.reset();
    const handled = await handlePanel(h.rt, press(panelData(GROUP.id, screen)));
    assert.equal(handled, true);
    const edit = h.fake.find("editMessageText");
    assert.ok(edit, `${screen} did not re-render`);
    assert.equal(edit?.body.message_id, 77);
    assert.ok(String(edit?.body.text).length > 0);
    assert.equal(h.fake.count("answerCallbackQuery"), 1, "the spinner must always be resolved");
  }
});

test("toggling a switch saves it and stays on the same screen", async () => {
  const h = await panel();
  const before = await h.rt.configFor(GROUP.id);
  await handlePanel(h.rt, press(panelData(GROUP.id, "set", "enabled")));
  const after = await h.rt.configFor(GROUP.id);
  assert.notEqual(after.enabled, before.enabled, "the flip must be persisted");
  // The state lives in the button label, not the body text.
  const markup = JSON.stringify(h.fake.find("editMessageText")?.body.reply_markup ?? {});
  assert.match(markup, /运行中|已停用/);
});

test("the strike ladder toggles off and back on", async () => {
  const h = await panel();
  await handlePanel(h.rt, press(panelData(GROUP.id, "set", "strikes")));
  assert.deepEqual((await h.rt.configFor(GROUP.id)).strikes, [], "first tap turns the ladder off");
  await handlePanel(h.rt, press(panelData(GROUP.id, "set", "strikes")));
  assert.equal((await h.rt.configFor(GROUP.id)).strikes.length, 3, "second tap restores it");
});

test("the captcha mode buttons set the mode and switch it on", async () => {
  const h = await panel();
  await h.rt.saveConfig(GROUP.id, { captcha: false, captchaMode: "button" });
  await handlePanel(h.rt, press(panelData(GROUP.id, "mode", "math")));
  const config = await h.rt.configFor(GROUP.id);
  assert.equal(config.captchaMode, "math");
  assert.equal(config.captcha, true, "picking a mode implies verification is on");
  assert.match(String(h.fake.find("editMessageText")?.body.text), /算术/);
});

test("the punishment action buttons switch the flat action", async () => {
  const h = await panel();
  for (const action of ["ban", "mute", "delete"]) {
    await handlePanel(h.rt, press(panelData(GROUP.id, "action", action)));
    assert.equal((await h.rt.configFor(GROUP.id)).spamAction, action);
  }
});

test("lock buttons add and remove exactly one lock kind", async () => {
  const h = await panel();
  await h.rt.saveConfig(GROUP.id, { locks: ["links"] });
  await handlePanel(h.rt, press(panelData(GROUP.id, "lock", "photos")));
  assert.deepEqual((await h.rt.configFor(GROUP.id)).locks.sort(), ["links", "photos"]);
  await handlePanel(h.rt, press(panelData(GROUP.id, "lock", "photos")));
  assert.deepEqual((await h.rt.configFor(GROUP.id)).locks, ["links"]);
});

test("a member who is not an admin cannot press any button", async () => {
  const h = await panel();
  h.fake.on("getChatMember", () => ({ ok: true, result: { status: "member" } }));
  const before = await h.rt.configFor(GROUP.id);
  await handlePanel(h.rt, press(panelData(GROUP.id, "set", "enabled"), 500));
  const after = await h.rt.configFor(GROUP.id);
  assert.equal(after.enabled, before.enabled, "the button is not the permission");
  assert.equal(h.fake.count("editMessageText"), 0);
  assert.match(String(h.fake.find("answerCallbackQuery")?.body.text), /不是这个群的管理员/);
});

test("an administrator without can_change_info is refused too", async () => {
  const h = await panel();
  h.fake.on("getChatMember", () => ({ ok: true, result: { status: "administrator", can_change_info: false } }));
  await handlePanel(h.rt, press(panelData(GROUP.id, "set", "captcha"), 777));
  assert.equal(h.fake.count("editMessageText"), 0);
  assert.match(String(h.fake.find("answerCallbackQuery")?.body.text), /没有改信息权限/);
});

test("a stale or foreign button is rejected without touching config", async () => {
  const h = await panel();
  await handlePanel(h.rt, press("p.notanumber.chat"));
  assert.match(String(h.fake.find("answerCallbackQuery")?.body.text), /按钮已过期/);
  assert.equal(h.fake.count("editMessageText"), 0);
});

test("non-panel callbacks are left for the verifier", async () => {
  const h = await panel();
  assert.equal(await handlePanel(h.rt, press("v1.abc.def")), false);
  assert.equal(h.fake.count("answerCallbackQuery"), 0);
});

test("a press without a message falls back to a private message", async () => {
  const h = await panel();
  await handlePanel(h.rt, press(panelData(GROUP.id, "chat"), 9001, false));
  assert.equal(h.fake.count("editMessageText"), 0);
  assert.equal(h.fake.count("sendMessage"), 1);
});

test("the panel data format is stable and parses back", () => {
  assert.equal(panelData(-1001, "chat"), "p.-1001.chat");
  assert.equal(panelData(-1001, "set", "enabled"), "p.-1001.set.enabled");
  const [prefix, chatId, screen] = panelData(-1001, "lock", "links").split(".");
  assert.equal(prefix, "p");
  assert.equal(Number(chatId), -1001);
  assert.equal(screen, "lock");
});

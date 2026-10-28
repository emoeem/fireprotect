/**
 * `/help` — the card an admin actually reads, plus the buttons on it.
 *
 * The properties under test are the ones that make it usable rather than just
 * present: the console link is absolute and configurable, every button on the
 * card resolves to a screen that renders, a stranger cannot open the admin
 * screens, and the full command list still covers every command the dispatcher
 * knows (a curated text that silently loses `/parse` is worse than no text).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMessage } from "../src/handlers/message.ts";
import { COMMAND_SPEC } from "../src/handlers/commands.ts";
import { DEFAULT_PUBLIC_URL, FULL_HELP, adminUrl, handleHelpCallback, helpCard, miniAppLink } from "../src/help.ts";
import { GROUP, command, makeRuntime, user } from "./harness.ts";
import type { Env, TgCallbackQuery } from "../src/types.ts";

const ADMIN = 9001;
const STRANGER = 500;

type TestButton = { text: string; url?: string; callback_data?: string; web_app?: { url: string } };
type Keyboard = { inline_keyboard: TestButton[][] };

function keyboardOf(markup: unknown): Keyboard {
  return markup as Keyboard;
}

function buttons(call: { body: Record<string, unknown> }): TestButton[] {
  const markup = call.body.reply_markup as Keyboard | undefined;
  if (!markup) return [];
  return markup.inline_keyboard.flat();
}

async function sayHelp(text = "/help", from = ADMIN, env: Partial<Env> = {}) {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN), ...env } });
  await handleMessage(h.rt, command(text, { from: user(from, from === ADMIN ? "群主" : "路人") }));
  return h;
}

test("the group card links to the console and carries no wall of text", async () => {
  const h = await sayHelp();
  const sent = h.fake.find("sendMessage");
  assert.ok(sent, "no message was sent");
  const text = String(sent.body.text);
  assert.ok(text.length < 400, `the card is ${text.length} chars — that is a manual again`);
  assert.match(text, /焰卫/);
  assert.match(text, /运行中|已停用/, "the card shows state, not instructions");

  const all = buttons(sent);
  const link = all.find((button) => button.text.includes("管理后台"));
  assert.ok(link, "no console button");
  assert.equal(link.url, `${DEFAULT_PUBLIC_URL}/admin`);
  assert.equal(link.callback_data, undefined, "a url button must not carry callback_data");
});

test("PUBLIC_URL moves the console link without touching any handler", async () => {
  const h = await sayHelp("/help", ADMIN, { PUBLIC_URL: "https://bot.example.com/" });
  const link = buttons(h.fake.find("sendMessage")!).find((button) => button.url);
  assert.equal(link?.url, "https://bot.example.com/admin", "trailing slash is not doubled");
});

test("adminUrl falls back when PUBLIC_URL is empty, not to a relative link", () => {
  assert.equal(adminUrl({ BOT_TOKEN: "x", PUBLIC_URL: "" }), `${DEFAULT_PUBLIC_URL}/admin`);
  assert.equal(adminUrl({ BOT_TOKEN: "x", PUBLIC_URL: "https://a.b" }), "https://a.b/admin");
});

test("a stranger gets one line and no keyboard", async () => {
  const h = await sayHelp("/help", STRANGER);
  const sent = h.fake.find("sendMessage");
  assert.equal(sent?.body.reply_markup, undefined, "a stranger must not get admin buttons");
  assert.ok(String(sent?.body.text).length < 40);
});

test("the private card launches the console as a Mini App", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN) } });
  const dm = { id: ADMIN, type: "private" as const, title: undefined };
  await handleMessage(h.rt, command("/help", { chat: dm, from: user(ADMIN, "群主") }));
  const all = buttons(h.fake.find("sendMessage")!);
  assert.ok(all.some((button) => button.callback_data === "p.0.main"), "no panel button in the DM card");
  // A private chat is the one place `web_app` is legal, and it is what makes the
  // console open in place instead of in a browser tab.
  const consoleButton = all.find((button) => button.web_app);
  assert.equal(consoleButton?.web_app?.url, `${DEFAULT_PUBLIC_URL}/admin`);
  assert.equal(consoleButton?.url, undefined, "a button cannot be both web_app and url");
});

test("a group never gets a web_app button, because Telegram rejects it", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN) } });
  const view = helpCard(h.rt.env, { chatId: GROUP.id, title: GROUP.title!, config: await h.rt.configFor(GROUP.id) });
  for (const button of keyboardOf(view.markup).inline_keyboard.flat()) {
    assert.equal(button.web_app, undefined, "web_app in a group is 400 BUTTON_TYPE_INVALID");
  }
});

test("a group with a Main Mini App gets the in-place t.me link", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN), BOT_USERNAME: "@fireprotcectbot" } });
  h.fake.on("getMe", () => ({ ok: true, result: { id: 1, is_bot: true, username: "fireprotcectbot", has_main_web_app: true } }));
  const view = helpCard(h.rt.env, {
    chatId: GROUP.id,
    title: GROUP.title!,
    config: await h.rt.configFor(GROUP.id),
    miniApp: await miniAppLink(h.rt),
  });
  const link = keyboardOf(view.markup).inline_keyboard.flat().find((button) => button.url);
  assert.equal(link?.url, "https://t.me/fireprotcectbot?startapp=admin");
});

test("without a Main Mini App the group button stays a plain web link", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN), BOT_USERNAME: "fireprotcectbot" } });
  h.fake.on("getMe", () => ({ ok: true, result: { id: 1, is_bot: true, username: "fireprotcectbot", has_main_web_app: false } }));
  assert.equal(await miniAppLink(h.rt), null, "an unconfigured startapp link lands on the bot chat, not the app");

  const view = helpCard(h.rt.env, {
    chatId: GROUP.id,
    title: GROUP.title!,
    config: await h.rt.configFor(GROUP.id),
    miniApp: await miniAppLink(h.rt),
  });
  assert.equal(
    keyboardOf(view.markup).inline_keyboard.flat().find((button) => button.url)?.url,
    `${DEFAULT_PUBLIC_URL}/admin`,
  );
});

test("miniAppLink needs a username before it will build a t.me link", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN) } });
  h.fake.on("getMe", () => ({ ok: true, result: { id: 1, is_bot: true, has_main_web_app: true } }));
  assert.equal(await miniAppLink(h.rt), null);
});

test("every button on the card opens a screen that renders", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN) } });
  const view = helpCard(h.rt.env, { chatId: GROUP.id, title: GROUP.title!, config: await h.rt.configFor(GROUP.id) });
  const targets = keyboardOf(view.markup)
    .inline_keyboard.flat()
    .map((button) => button.callback_data)
    .filter((data): data is string => typeof data === "string");

  assert.ok(targets.length >= 3, "a button that goes nowhere is decoration");
  for (const data of targets) {
    h.fake.reset();
    const handled = await handleHelpCallback(h.rt, press(data));
    assert.ok(handled, `${data} was not handled`);
    const edit = h.fake.find("editMessageText");
    assert.ok(edit, `${data} opened nothing`);
    assert.ok(String(edit.body.text).length > 0);
  }
});

function press(data: string, fromId = ADMIN, chat = GROUP): TgCallbackQuery {
  return {
    id: "cb-help",
    from: user(fromId, "群主"),
    data,
    message: { message_id: 42, chat, from: user(1, "焰卫") },
  } as TgCallbackQuery;
}

test("the full list is one press away and covers every dispatched command", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN) } });
  const handled = await handleHelpCallback(h.rt, press("h.-1001.full"));
  assert.ok(handled);
  const edit = h.fake.find("editMessageText")!;
  assert.match(String(edit.body.text), /锁类型/);

  // Aliases of screens reachable another way: documenting `/start` beside
  // `/panel` teaches nothing, so they are exempt by name and by nothing else.
  const aliases = new Set(["start", "panel"]);
  const missing = COMMAND_SPEC.filter((spec) => !aliases.has(spec.name) && !FULL_HELP.includes(`/${spec.name}`)).map(
    (spec) => spec.name,
  );
  assert.deepEqual(missing, [], `commands missing from /help: ${missing.join(", ")}`);
});

test("the rules and stats screens read current state", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN) } });
  await handleMessage(h.rt, command("/set welcome off", { from: user(ADMIN, "群主") }));

  h.fake.reset();
  await handleHelpCallback(h.rt, press("h.-1001.rules"));
  assert.match(String(h.fake.find("editMessageText")!.body.text), /欢迎语：关/);

  h.fake.reset();
  await handleHelpCallback(h.rt, press("h.-1001.stats"));
  assert.match(String(h.fake.find("editMessageText")!.body.text), /最近 7 天/);
});

test("a stranger cannot open the admin screens", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN) } });
  const handled = await handleHelpCallback(h.rt, press("h.-1001.full", STRANGER));
  assert.ok(handled);
  assert.equal(h.fake.count("editMessageText"), 0, "the button must not be the permission");
  const answer = h.fake.find("answerCallbackQuery")!;
  assert.equal(answer.body.show_alert, true);
  assert.match(String(answer.body.text), /管理员/);
});

test("a malformed payload answers the callback instead of hanging the spinner", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN) } });
  assert.ok(await handleHelpCallback(h.rt, press("h.nope.full")));
  assert.equal(h.fake.count("editMessageText"), 0);
  assert.equal(h.fake.count("answerCallbackQuery"), 1);
});

test("callbacks outside the h. namespace are left to the verifier", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN) } });
  assert.equal(await handleHelpCallback(h.rt, press("p.-1001.main")), false);
  assert.equal(await handleHelpCallback(h.rt, press("verify:1:2")), false);
});

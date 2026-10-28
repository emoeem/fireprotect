import assert from "node:assert/strict";
import { test } from "node:test";
import { handleApi, mintSession } from "../src/admin/api.ts";
import { handlePanel, renderScreen } from "../src/panel.ts";
import { runScheduled } from "../src/scheduler.ts";
import { scheduleAdd, scheduleList } from "../src/db/repo.ts";
import { callback, makeRuntime, nextUpdate, user } from "./harness.ts";
import { handleUpdate } from "../src/bot.ts";

const env = (extra: Record<string, unknown> = {}) => ({ BOT_TOKEN: "123:abc", ADMIN_TOKEN: "adm1n", ...extra });

async function authed(h: { rt: { now: () => number } }, extra: Record<string, unknown> = {}) {
  const cookie = await mintSession(env(extra) as never, h.rt.now());
  return { cookie: `fw_admin=${cookie}` };
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

test("the panel refuses a stranger's tap", async () => {
  const h = await makeRuntime();
  h.fake.on("getChatMember", () => ({ ok: true, result: { status: "member" } }));
  const handled = await handlePanel(h.rt, callback("p.-1001.captcha", 500));
  assert.equal(handled, true);
  const answer = h.fake.find("answerCallbackQuery");
  assert.match(String(answer?.body.text ?? ""), /不是这个群的管理员/);
  assert.equal(h.fake.count("editMessageText"), 0);
});

test("an admin's toggle saves and re-renders in place", async () => {
  const h = await makeRuntime();
  h.fake.on("getChatMember", () => ({
    ok: true,
    result: { status: "administrator", can_change_info: true, can_delete_messages: true },
  }));
  await h.rt.saveConfig(-1001, { captcha: true });

  await handlePanel(h.rt, callback("p.-1001.set.captcha", 500));

  assert.equal((await h.rt.configFor(-1001)).captcha, false);
  const edit = h.fake.find("editMessageText");
  assert.ok(edit, "the message is edited, not re-sent");
  assert.match(String(edit?.body.text ?? ""), /状态：关/);
});

test("tapping a lock kind flips exactly that kind", async () => {
  const h = await makeRuntime();
  h.fake.on("getChatMember", () => ({ ok: true, result: { status: "administrator", can_change_info: true } }));
  await h.rt.saveConfig(-1001, { locks: ["links"] });

  await handlePanel(h.rt, callback("p.-1001.lock.stickers", 500));

  const config = await h.rt.configFor(-1001);
  assert.equal(config.locks.includes("stickers"), true);
  assert.equal(config.locks.includes("links"), true);

  await handlePanel(h.rt, callback("p.-1001.lock.links", 500));
  assert.equal((await h.rt.configFor(-1001)).locks.includes("links"), false);
});

test("a stale button still renders current state", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { nightMode: true, nightStart: "22:00", nightEnd: "06:00" });
  const view = await renderScreen(h.rt, -1001, "night");
  assert.match(view.text, /22:00 – 06:00/);
});

test("the main screen lists nothing until a chat is registered", async () => {
  const h = await makeRuntime();
  const view = await renderScreen(h.rt, 0, "main");
  assert.match(view.text, /还没有任何群/);
});

test("/panel in a group points at the DM", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: "9001", BOT_USERNAME: "flareward_bot" } });
  await handleUpdate(h.rt, {
    update_id: nextUpdate(),
    message: { ...callback("", 9001).message!, text: "/panel", from: user(9001), message_id: 5 },
  });
  const sent = h.fake.all("sendMessage").find((call) => call.body.reply_markup);
  const url = sent?.body?.reply_markup?.inline_keyboard?.[0]?.[0]?.url;
  assert.match(String(url), /t\.me\/flareward_bot\?start=panel/);
});

// ---------------------------------------------------------------------------
// Web console API
// ---------------------------------------------------------------------------

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://bot.example${path}`, init);
}

test("the console API is closed without a session", async () => {
  const h = await makeRuntime();
  const res = await handleApi(req("/api/overview"), env() as never, h.rt, new URL("https://bot.example/api/overview"));
  assert.equal(res.status, 401);
});

test("a wrong ADMIN_TOKEN mints nothing", async () => {
  const h = await makeRuntime();
  const res = await handleApi(
    req("/api/login", { method: "POST", body: JSON.stringify({ token: "nope" }) }),
    env() as never,
    h.rt,
    new URL("https://bot.example/api/login"),
  );
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("login with the right token returns a hardened cookie", async () => {
  const h = await makeRuntime();
  const res = await handleApi(
    req("/api/login", { method: "POST", body: JSON.stringify({ token: "adm1n" }) }),
    env() as never,
    h.rt,
    new URL("https://bot.example/api/login"),
  );
  assert.equal(res.status, 200);
  const cookie = String(res.headers.get("set-cookie"));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test("the API is disabled entirely when ADMIN_TOKEN is unset", async () => {
  const h = await makeRuntime();
  const res = await handleApi(
    req("/api/login", { method: "POST", body: JSON.stringify({ token: "" }) }),
    { BOT_TOKEN: "123:abc" } as never,
    h.rt,
    new URL("https://bot.example/api/login"),
  );
  assert.equal(res.status, 503);
});

test("an authenticated session can read and patch a chat", async () => {
  const h = await makeRuntime();
  const { cookie } = await authed(h);
  await h.rt.saveConfig(-1001, { maxLength: 1200 });

  const overview = await handleApi(req("/api/overview", { headers: { cookie } }), env() as never, h.rt, new URL("https://bot.example/api/overview"));
  assert.equal(overview.status, 200);

  const patch = await handleApi(
    req("/api/chat/-1001/config", { method: "PATCH", headers: { cookie }, body: JSON.stringify({ maxLength: 300 }) }),
    env() as never,
    h.rt,
    new URL("https://bot.example/api/chat/-1001/config"),
  );
  assert.equal(patch.status, 200);
  assert.equal((await h.rt.configFor(-1001)).maxLength, 300);

  const bad = await handleApi(
    req("/api/chat/-1001/config", { method: "PATCH", headers: { cookie }, body: JSON.stringify({ maxLength: 99999 }) }),
    env() as never,
    h.rt,
    new URL("https://bot.example/api/chat/-1001/config"),
  );
  assert.equal(bad.status, 400, "an out-of-range value is refused, not clamped");
});

test("a forged cookie is rejected", async () => {
  const h = await makeRuntime();
  const future = String(h.rt.now() + 3600_000);
  const res = await handleApi(
    req("/api/overview", { headers: { cookie: `fw_admin=${future}.deadbeefdeadbeefdeadbeefdeadbeef` } }),
    env() as never,
    h.rt,
    new URL("https://bot.example/api/overview"),
  );
  assert.equal(res.status, 401);
});

test("an expired cookie is rejected", async () => {
  const h = await makeRuntime();
  const cookie = await mintSession(env() as never, h.rt.now() - 13 * 3600_000);
  const res = await handleApi(
    req("/api/overview", { headers: { cookie: `fw_admin=${cookie}` } }),
    env() as never,
    h.rt,
    new URL("https://bot.example/api/overview"),
  );
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

test("a due message is sent and the next slot is booked", async () => {
  const h = await makeRuntime();
  await scheduleAdd(h.rt.db, { chatId: -1001, text: "午间提醒", every: 3600, nextAt: h.now() - 1, createdBy: 9001 });

  const result = await runScheduled(h.rt);
  assert.equal(result.sent, 1);
  assert.equal(h.fake.count("sendMessage"), 1);

  const rows = await scheduleList(h.rt.db, -1001);
  assert.equal(rows[0]?.sent, 1);
  assert.equal(rows[0]?.nextAt, h.now() + 3600_000);
});

test("a one-shot message disables itself after sending", async () => {
  const h = await makeRuntime();
  await scheduleAdd(h.rt.db, { chatId: -1001, text: "只发一次", every: 0, nextAt: h.now() - 1, createdBy: 9001 });
  await runScheduled(h.rt);
  const rows = await scheduleList(h.rt.db, -1001);
  assert.equal(rows[0]?.enabled, 0);
});

test("a kicked chat disables the row instead of retrying forever", async () => {
  const h = await makeRuntime();
  h.fake.on("sendMessage", () => ({ ok: false, error_code: 403, description: "Forbidden: bot was kicked from the group chat" }));
  await scheduleAdd(h.rt.db, { chatId: -1001, text: "x", every: 600, nextAt: h.now() - 1, createdBy: 9001 });

  const result = await runScheduled(h.rt);
  assert.equal(result.failed, 1);
  assert.equal(result.disabled, 1);
  const rows = await scheduleList(h.rt.db, -1001);
  assert.equal(rows[0]?.enabled, 0);
  assert.match(rows[0]?.lastError ?? "", /kicked/);
});

test("a transient failure retries in five minutes and keeps the cadence", async () => {
  const h = await makeRuntime();
  h.fake.on("sendMessage", () => ({ ok: false, error_code: 500, description: "Internal Server Error" }));
  await scheduleAdd(h.rt.db, { chatId: -1001, text: "x", every: 600, nextAt: h.now() - 1, createdBy: 9001 });

  await runScheduled(h.rt);
  const rows = await scheduleList(h.rt.db, -1001);
  assert.equal(rows[0]?.enabled, 1);
  assert.equal(rows[0]?.nextAt, h.now() + 5 * 60_000);
});

test("the master switch stops automatic action but keeps commands alive", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { enabled: false, keywords: ["加微信"], locks: [] });
  const { handleUpdate } = await import("../src/bot.ts");
  const { message, user } = await import("./harness.ts");

  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ text: "加微信 123" }) });
  assert.equal(h.fake.count("deleteMessage"), 0, "disabled means disabled");

  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ text: "/rules", from: user(500) }) });
  assert.equal(h.fake.count("sendMessage"), 1, "commands still answer");
});

// ---------------------------------------------------------------------------
// Event log paging (A4)
// ---------------------------------------------------------------------------

test("the event log endpoint requires a session", async () => {
  const h = await makeRuntime();
  const res = await handleApi(req("/api/chat/-1001/events"), env() as never, h.rt, new URL("https://bot.example/api/chat/-1001/events"));
  assert.equal(res.status, 401);
});

test("the event log endpoint pages, filters and clamps its query params", async () => {
  const h = await makeRuntime();
  const { events } = await import("../src/db/schema.ts");
  const at = h.now();
  await h.rt.db.insert(events).values(
    Array.from({ length: 25 }, (_, i) => ({
      chatId: -1001,
      userId: 500,
      kind: i % 5 === 0 ? "ban" : "delete",
      reason: `r${i}`,
      at: at - i * 60_000,
    })),
  );
  const headers = await authed(h);
  const get = async (query: string) => {
    const res = await handleApi(req(`/api/chat/-1001/events${query}`, { headers }), env() as never, h.rt, new URL(`https://bot.example/api/chat/-1001/events${query}`));
    return (await res.json()) as { events: { kind: string }[]; hasMore: boolean; offset: number };
  };

  const page1 = await get("");
  assert.equal(page1.events.length, 20);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.offset, 0);

  const page2 = await get("?offset=20");
  assert.equal(page2.events.length, 5);
  assert.equal(page2.hasMore, false);

  const bans = await get("?kind=ban");
  assert.equal(bans.events.length, 5);
  assert.ok(bans.events.every((e) => e.kind === "ban"));

  const clamped = await get("?limit=1000&offset=-5");
  assert.equal(clamped.events.length, 25, "limit is clamped to 100 and a negative offset floors at 0");
  assert.equal(clamped.hasMore, false);
});

// ---------------------------------------------------------------------------
// Export / import, member audit, ban paging
// ---------------------------------------------------------------------------

test("export mirrors the bot payload and import applies it to another chat", async () => {
  const h = await makeRuntime();
  const headers = await authed(h);
  await h.rt.saveConfig(-1001, { maxLength: 800 });
  await handleApi(req("/api/chat/-1001/note/规则", { method: "PUT", headers, body: JSON.stringify({ content: "不发广告" }) }), env() as never, h.rt, new URL("https://bot.example/api/chat/-1001/note/规则"));
  await handleApi(req("/api/chat/-1001/filter", { method: "POST", headers, body: JSON.stringify({ trigger: "你好", match: "exact", response: "你也好" }) }), env() as never, h.rt, new URL("https://bot.example/api/chat/-1001/filter"));

  const exported = await (
    await handleApi(req("/api/chat/-1001/export", { headers }), env() as never, h.rt, new URL("https://bot.example/api/chat/-1001/export"))
  ).json();
  assert.equal(exported.v, 1);
  assert.equal(exported.config.maxLength, 800);
  assert.equal(exported.notes[0]?.name, "规则");
  assert.equal(exported.filters[0]?.trigger, "你好");

  // The log target must never travel: an import would hijack another group's
  // audit trail.
  exported.config.logChatId = -100999;
  const imported = await (
    await handleApi(req("/api/chat/-1002/import", { method: "POST", headers, body: JSON.stringify(exported) }), env() as never, h.rt, new URL("https://bot.example/api/chat/-1002/import"))
  ).json();
  assert.equal(imported.applied, 3);
  const detail = await (
    await handleApi(req("/api/chat/-1002", { headers }), env() as never, h.rt, new URL("https://bot.example/api/chat/-1002"))
  ).json();
  assert.equal(detail.config.maxLength, 800);
  assert.equal(detail.config.logChatId ?? "", "");
  assert.equal(detail.filters.length, 1);
  assert.equal(detail.notes[0]?.name, "规则");
});

test("the member audit endpoint aggregates one person across chats", async () => {
  const h = await makeRuntime();
  const headers = await authed(h);
  const { events } = await import("../src/db/schema.ts");
  const now = h.rt.now();
  await h.rt.db.insert(events).values([
    { chatId: -1001, userId: 777, kind: "delete", reason: "a", at: now - 1000 },
    { chatId: -1002, userId: 777, kind: "warn", reason: "b", at: now - 500 },
  ]);

  const res = await (
    await handleApi(req("/api/user/777", { headers }), env() as never, h.rt, new URL("https://bot.example/api/user/777"))
  ).json();
  assert.equal(res.userId, 777);
  assert.deepEqual(
    res.events.map((e: { chatId: number }) => e.chatId).sort((a: number, b: number) => a - b),
    [-1002, -1001],
  );
  assert.equal(res.ban, null);
  assert.deepEqual(res.warnings, []);
});

test("the ban list supports search and paging", async () => {
  const h = await makeRuntime();
  const headers = await authed(h);
  const { bannedUsers } = await import("../src/db/schema.ts");
  const now = h.rt.now();
  await h.rt.db.insert(bannedUsers).values([
    { userId: 111, reason: "广告", source: "local", at: now - 3000 },
    { userId: 222, reason: "刷屏", source: "federation", at: now - 2000 },
    { userId: 333, reason: "广告", source: "cas", at: now - 1000 },
  ]);

  const page1 = await (await handleApi(req("/api/bans?limit=2", { headers }), env() as never, h.rt, new URL("https://bot.example/api/bans?limit=2"))).json();
  assert.equal(page1.bans.length, 2);
  assert.equal(page1.hasMore, true);
  const page2 = await (await handleApi(req("/api/bans?limit=2&offset=2", { headers }), env() as never, h.rt, new URL("https://bot.example/api/bans?limit=2&offset=2"))).json();
  assert.equal(page2.bans.length, 1);
  assert.equal(page2.hasMore, false);

  const byId = await (await handleApi(req("/api/bans?q=222", { headers }), env() as never, h.rt, new URL("https://bot.example/api/bans?q=222"))).json();
  assert.equal(byId.bans.length, 1);
  assert.equal(byId.bans[0].userId, 222);
  const reasonQuery = encodeURIComponent("广告");
  const byReason = await (await handleApi(req(`/api/bans?q=${reasonQuery}`, { headers }), env() as never, h.rt, new URL(`https://bot.example/api/bans?q=${reasonQuery}`))).json();
  assert.equal(byReason.bans.length, 2);
});

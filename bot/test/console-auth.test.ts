/**
 * Console auth: password login and Telegram Mini App identity.
 *
 * The signature checks are compared against an *independent* implementation
 * (node:crypto `createHmac`) rather than against the module under test. If both
 * sides shared one helper, a bug in the data-check-string would cancel out and
 * the test would stay green while every real launch failed.
 *
 * The other half of this file is the abuse path: `emoemoemo`-class passwords are
 * short and shared in chat, so guessing has to cost something.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { handleApi, mintSession, INIT_DATA_HEADER } from "../src/admin/api.ts";
import { handleUpdate } from "../src/bot.ts";
import { rememberChat } from "../src/db/repo.ts";
import { menuButton } from "../src/menu.ts";
import { parseInitData, verifyInitData, resetAdminCache } from "../src/admin/tginit.ts";
import { makeRuntime, user } from "./harness.ts";

const TOKEN = "123456:TEST-TOKEN";
const PASSWORD = "emoemoemo";
const ENV = { BOT_TOKEN: TOKEN, ADMIN_TOKEN: "", ADMIN_PASSWORD: PASSWORD, ADMIN_IDS: "9001" };

/** Build initData the way Telegram does: percent-encoded fields, hash over decoded ones. */
function buildInitData(fields: Record<string, string>, token = TOKEN): string {
  const encoded = Object.entries(fields).map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
  const checkString = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return [...encoded, `hash=${hash}`].join("&");
}

function initDataFor(userId: number, overrides: Record<string, string> = {}): string {
  return buildInitData({
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify({ id: userId, first_name: "测", username: "ops" }),
    auth_date: String(Math.floor(1_700_000_000_000 / 1000)),
    ...overrides,
  });
}

async function post(
  h: Awaited<ReturnType<typeof makeRuntime>>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; cookie: string | null }> {
  const request = new Request(`https://bot.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const response = await handleApi(request, ENV as never, h.rt, new URL(`https://bot.test${path}`));
  return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") };
}

async function get(
  h: Awaited<ReturnType<typeof makeRuntime>>,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const request = new Request(`https://bot.test${path}`, { headers });
  const response = await handleApi(request, ENV as never, h.rt, new URL(`https://bot.test${path}`));
  return { status: response.status, body: await response.json() };
}

// ---------------------------------------------------------------------------
// initData signature
// ---------------------------------------------------------------------------

test("a correctly signed initData verifies and yields the user", async () => {
  const h = await makeRuntime();
  const initData = initDataFor(9001);
  const check = await verifyInitData(initData, TOKEN, h.rt.now());
  assert.equal(check.ok, true);
  if (!check.ok) return;
  assert.equal(check.user.id, 9001);
  assert.equal(check.user.username, "ops");
});

test("a tampered field breaks the signature", async () => {
  const h = await makeRuntime();
  const initData = initDataFor(9001).replace("auth_date=1700000000", "auth_date=1700000001");
  const check = await verifyInitData(initData, TOKEN, h.rt.now());
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.match(check.error, /签名/);
});

test("the same initData signed with another bot's token is refused", async () => {
  const h = await makeRuntime();
  const otherBot = buildInitData({ user: JSON.stringify({ id: 9001 }), auth_date: "1700000000" }, "999:OTHER");
  const check = await verifyInitData(otherBot, TOKEN, h.rt.now());
  assert.equal(check.ok, false);
});

test("an old auth_date is refused", async () => {
  const h = await makeRuntime();
  const stale = initDataFor(9001, { auth_date: "1600000000" });
  const check = await verifyInitData(stale, TOKEN, h.rt.now());
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.match(check.error, /过期/);
});

test("parseInitData decodes values, including the user JSON", () => {
  const fields = parseInitData(initDataFor(9001));
  assert.equal(fields.get("query_id"), "AAHdF6IQAAAAAN0XohDhrOrc");
  assert.equal(JSON.parse(fields.get("user") ?? "{}").id, 9001);
});

// ---------------------------------------------------------------------------
// Password login
// ---------------------------------------------------------------------------

test("the password logs in and the cookie it mints opens the console", async () => {
  const h = await makeRuntime();
  const login = await post(h, "/api/login", { secret: PASSWORD });
  assert.equal(login.status, 200);
  assert.equal(login.body.via, "password");
  assert.ok(login.cookie && login.cookie.includes("fw_admin="));
  // SameSite=Strict is what keeps the cookie from being sent on a cross-site
  // POST; dropping it would make every console write CSRF-able.
  assert.match(login.cookie!, /SameSite=Strict/);
  assert.match(login.cookie!, /HttpOnly/);

  const cookie = login.cookie!.split(";")[0];
  const overview = await get(h, "/api/overview", { cookie });
  assert.equal(overview.status, 200);
  assert.ok(Array.isArray(overview.body.chats));
});

test("a wrong password is refused and the counter climbs", async () => {
  const h = await makeRuntime();
  const first = await post(h, "/api/login", { secret: "nope" });
  assert.equal(first.status, 401);
  assert.match(first.body.error, /还可以试 7 次/);
});

test("guessing is cut off after eight failures from one address", async () => {
  const h = await makeRuntime();
  for (let i = 0; i < 8; i++) {
    const attempt = await post(h, "/api/login", { secret: `guess-${i}` }, { "cf-connecting-ip": "203.0.113.9" });
    assert.equal(attempt.status, 401);
  }
  const blocked = await post(h, "/api/login", { secret: PASSWORD }, { "cf-connecting-ip": "203.0.113.9" });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.includes("尝试次数过多"), true);

  // A different address is unaffected: the budget is per client, not global.
  const other = await post(h, "/api/login", { secret: PASSWORD }, { "cf-connecting-ip": "198.51.100.4" });
  assert.equal(other.status, 200);
});

test("a successful login clears the failure budget", async () => {
  const h = await makeRuntime();
  for (let i = 0; i < 3; i++) await post(h, "/api/login", { secret: "x" }, { "cf-connecting-ip": "203.0.113.5" });
  await post(h, "/api/login", { secret: PASSWORD }, { "cf-connecting-ip": "203.0.113.5" });
  const again = await post(h, "/api/login", { secret: "x" }, { "cf-connecting-ip": "203.0.113.5" });
  assert.match(again.body.error, /还可以试 7 次/);
});

test("a broken KV store cannot turn the login form into a 500", async () => {
  const h = await makeRuntime();
  const broken = {
    async get() { throw new Error("kv write rate limited"); },
    async put() { throw new Error("kv write rate limited"); },
    async del() { throw new Error("kv write rate limited"); },
    async keys() { return []; },
  };
  const request = new Request("https://bot.test/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.77" },
    body: JSON.stringify({ secret: "guess" }),
  });
  const response = await handleApi(request, ENV as never, { ...h.rt, store: broken } as never, new URL("https://bot.test/api/login"));
  assert.equal(response.status, 401);

  // And the in-memory counter still reaches the limit instead of failing open.
  for (let i = 0; i < 8; i++) {
    const attempt = new Request("https://bot.test/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.77" },
      body: JSON.stringify({ secret: `g${i}` }),
    });
    await handleApi(attempt, ENV as never, { ...h.rt, store: broken } as never, new URL("https://bot.test/api/login"));
  }
  const blocked = new Request("https://bot.test/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.77" },
    body: JSON.stringify({ secret: PASSWORD }),
  });
  const last = await handleApi(blocked, ENV as never, { ...h.rt, store: broken } as never, new URL("https://bot.test/api/login"));
  assert.equal(last.status, 429);
});

test("with no secret at all the console refuses to log anyone in", async () => {
  const h = await makeRuntime();
  const bare = { BOT_TOKEN: "" } as never;
  const request = new Request("https://bot.test/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: PASSWORD }),
  });
  const response = await handleApi(request, bare, h.rt, new URL("https://bot.test/api/login"));
  assert.equal(response.status, 503);
});

test("logout clears the cookie instead of leaving a live session behind", async () => {
  const h = await makeRuntime();
  const request = new Request("https://bot.test/api/logout");
  const response = await handleApi(request, ENV as never, h.rt, new URL("https://bot.test/api/logout"));
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /fw_admin=;/);
  assert.match(cookie, /Max-Age=0/);
});

// ---------------------------------------------------------------------------
// Mini App header auth
// ---------------------------------------------------------------------------

test("a signed Mini App request for a listed admin needs no cookie", async () => {
  resetAdminCache();
  const h = await makeRuntime();
  const initData = initDataFor(9001);
  const overview = await get(h, "/api/overview", { [INIT_DATA_HEADER]: initData });
  assert.equal(overview.status, 200);
  // No Bot API lookup: ADMIN_IDS short-circuits before getChatMember.
  assert.equal(h.fake.calls.filter((call) => call.method === "getChatMember").length, 0);

  const who = await get(h, "/api/whoami", { [INIT_DATA_HEADER]: initData });
  assert.equal(who.body.via, "telegram");
  assert.equal(who.body.userId, 9001);
});

test("a group administrator passes the permission check", async () => {
  resetAdminCache();
  const h = await makeRuntime();
  await rememberChat(h.rt.db, { chatId: -1001, title: "测试群", type: "supergroup", at: h.rt.now() });
  h.fake.on("getChatMember", () => ({ ok: true, result: { status: "administrator" } }));
  const overview = await get(h, "/api/overview", { [INIT_DATA_HEADER]: initDataFor(5002) });
  assert.equal(overview.status, 200);
});

test("an ordinary member is refused with 403, not 401", async () => {
  resetAdminCache();
  const h = await makeRuntime();
  await rememberChat(h.rt.db, { chatId: -1001, title: "测试群", type: "supergroup", at: h.rt.now() });
  h.fake.on("getChatMember", () => ({ ok: true, result: { status: "member" } }));
  const overview = await get(h, "/api/overview", { [INIT_DATA_HEADER]: initDataFor(5003) });
  assert.equal(overview.status, 403);
  assert.match(overview.body.error, /不是本机器人的管理员/);
});

test("a forged header is refused even before the permission check", async () => {
  resetAdminCache();
  const h = await makeRuntime();
  const forged = initDataFor(9001).replace(/hash=[0-9a-f]+/, "hash=" + "0".repeat(64));
  const overview = await get(h, "/api/overview", { [INIT_DATA_HEADER]: forged });
  assert.equal(overview.status, 403);
  assert.match(overview.body.error, /签名/);
});

test("a cookie session and a Mini App session are reported apart", async () => {
  resetAdminCache();
  const h = await makeRuntime();
  const cookie = `fw_admin=${await mintSession(ENV as never, h.rt.now())}`;
  const who = await get(h, "/api/whoami", { cookie });
  assert.equal(who.body.via, "cookie");
  assert.equal(who.body.userId, null);
});

// ---------------------------------------------------------------------------
// Per-chat authorization: one group's admin must not open another group's drawer
// ---------------------------------------------------------------------------

test("a group admin reaches only the groups they administer", async () => {
  resetAdminCache();
  const h = await makeRuntime();
  await rememberChat(h.rt.db, { chatId: -1001, title: "A 群", type: "supergroup", at: h.rt.now() });
  await rememberChat(h.rt.db, { chatId: -1002, title: "B 群", type: "supergroup", at: h.rt.now() });
  h.fake.on("getChatMember", (body) => ({
    ok: true,
    result: { status: body.chat_id === -1001 ? "administrator" : "member" },
  }));
  const headers = { [INIT_DATA_HEADER]: initDataFor(5002) };

  const own = await get(h, "/api/chat/-1001", headers);
  assert.equal(own.status, 200);

  const other = await get(h, "/api/chat/-1002", headers);
  assert.equal(other.status, 403);
  assert.match(other.body.error, /不是这个群的管理员/);

  const overview = await get(h, "/api/overview", headers);
  assert.equal(overview.status, 200);
  assert.deepEqual(
    overview.body.chats.map((c: { chatId: number }) => c.chatId),
    [-1001],
  );
  assert.equal(overview.body.bans, undefined, "operator-only fields are dropped for group admins");
});

test("the shared-password cookie keeps full access to every chat", async () => {
  resetAdminCache();
  const h = await makeRuntime();
  await rememberChat(h.rt.db, { chatId: -1002, title: "B 群", type: "supergroup", at: h.rt.now() });
  const cookie = `fw_admin=${await mintSession(ENV as never, h.rt.now())}`;
  assert.equal((await get(h, "/api/chat/-1002", { cookie })).status, 200);
  assert.equal((await get(h, "/api/bans", { cookie })).status, 200);
});

test("an ADMIN_IDS Mini App user keeps operator rights", async () => {
  resetAdminCache();
  const h = await makeRuntime();
  const headers = { [INIT_DATA_HEADER]: initDataFor(9001) };
  assert.equal((await get(h, "/api/bans", headers)).status, 200);
  assert.equal((await get(h, "/api/chat/-1002", headers)).status, 200);
});

test("global routes stay operator-only", async () => {
  resetAdminCache();
  const h = await makeRuntime();
  await rememberChat(h.rt.db, { chatId: -1001, title: "A 群", type: "supergroup", at: h.rt.now() });
  h.fake.on("getChatMember", () => ({ ok: true, result: { status: "administrator" } }));
  const headers = { [INIT_DATA_HEADER]: initDataFor(5002) };
  assert.equal((await get(h, "/api/bans", headers)).status, 403);
  assert.equal((await get(h, "/api/preset", headers)).status, 403);
  assert.equal((await get(h, "/api/health", headers)).status, 403);
});

// ---------------------------------------------------------------------------
// Login codes: request in the browser, approve from Telegram, consume once
// ---------------------------------------------------------------------------

async function requestCode(h: Awaited<ReturnType<typeof makeRuntime>>, ip = "203.0.113.10"): Promise<string> {
  const res = await post(h, "/api/login/request", {}, { "cf-connecting-ip": ip });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.code, /^\d{6}$/);
  return res.body.code as string;
}

test("a login code needs the Telegram side before the browser gets in", async () => {
  const h = await makeRuntime();
  const code = await requestCode(h);

  const unapproved = await get(h, `/api/login/status?code=${code}`);
  assert.equal(unapproved.body.approved, false);

  // The browser cannot claim it before an admin approves.
  const early = await post(h, "/api/login", { code });
  assert.equal(early.status, 401);

  // A non-admin cannot approve either (readOnly command → isAdmin gate).
  await handleUpdate(h.rt, {
    update_id: 900_001,
    message: { message_id: 41, date: 1, chat: { id: -1001, type: "supergroup", title: "群" }, from: user(600), text: `/login ${code}` },
  });
  const still = await post(h, "/api/login", { code });
  assert.equal(still.status, 401);

  // The admin approves; the browser signs in and carries the user id.
  await handleUpdate(h.rt, {
    update_id: 900_002,
    message: { message_id: 42, date: 1, chat: { id: -1001, type: "supergroup", title: "群" }, from: user(9001), text: `/login ${code}` },
  });
  const approved = await get(h, `/api/login/status?code=${code}`);
  assert.equal(approved.body.approved, true);

  const login = await post(h, "/api/login", { code });
  assert.equal(login.status, 200);
  assert.ok(login.cookie?.includes("fw_admin="));

  // One-shot: the second consume fails.
  const again = await post(h, "/api/login", { code });
  assert.equal(again.status, 401);
});

test("a personal session from a code is per-chat authorized and attributed", async () => {
  const h = await makeRuntime();
  await rememberChat(h.rt.db, { chatId: -1001, title: "A 群", type: "supergroup", at: h.rt.now() });
  await rememberChat(h.rt.db, { chatId: -1002, title: "B 群", type: "supergroup", at: h.rt.now() });
  const code = await requestCode(h, "203.0.113.11");
  // /login is an admin command: 5002 is not in ADMIN_IDS but administers
  // -1001, so they can approve — and the personal session then covers exactly
  // the chats they actually administer, never the whole deployment.
  h.fake.on("getChatMember", (body) => ({
    ok: true,
    result: { status: body.chat_id === -1001 ? "administrator" : "member" },
  }));
  await handleUpdate(h.rt, {
    update_id: 900_003,
    message: { message_id: 43, date: 1, chat: { id: -1001, type: "supergroup", title: "群" }, from: user(5002), text: `/login ${code}` },
  });
  const login = await post(h, "/api/login", { code });
  assert.equal(login.status, 200);
  const cookie = login.cookie!.split(";")[0];

  const who = await get(h, "/api/whoami", { cookie });
  assert.equal(who.body.via, "cookie");
  assert.equal(who.body.userId, 5002);

  assert.equal((await get(h, "/api/chat/-1001", { cookie })).status, 200);
  assert.equal((await get(h, "/api/chat/-1002", { cookie })).status, 403);
  assert.equal((await get(h, "/api/bans", { cookie })).status, 403, "a personal session is not an operator");

  // …and their writes are attributed to them.
  await handleApi(
    new Request("https://bot.test/api/chat/-1001/note/规则", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) }),
    ENV as never,
    h.rt,
    new URL("https://bot.test/api/chat/-1001/note/规则"),
  );
  const { noteList } = await import("../src/db/repo.ts");
  const notes = await noteList(h.rt.db, -1001);
  assert.equal(notes[0]?.createdBy, 5002);
});

test("the legacy two-segment cookie keeps operator status", async () => {
  const h = await makeRuntime();
  const cookie = `fw_admin=${await mintSession(ENV as never, h.rt.now())}`;
  assert.equal((await get(h, "/api/bans", { cookie })).status, 200);
  const who = await get(h, "/api/whoami", { cookie });
  assert.equal(who.body.userId, null);
});

// ---------------------------------------------------------------------------
// Menu button
// ---------------------------------------------------------------------------

test("the menu button points the Mini App at the console", () => {
  assert.deepEqual(menuButton("https://flareward-bot.pd2335346.workers.dev"), {
    type: "web_app",
    text: "管理后台",
    web_app: { url: "https://flareward-bot.pd2335346.workers.dev/admin" },
  });
  // A trailing slash must not produce `//admin`.
  assert.equal(
    menuButton("https://example.test/")!.web_app.url,
    "https://example.test/admin",
  );
});

test("no absolute origin means no menu button instead of an invalid one", () => {
  assert.equal(menuButton(undefined), null);
  assert.equal(menuButton(""), null);
  assert.equal(menuButton("/admin"), null);
  assert.equal(menuButton("flareward-bot.pd2335346.workers.dev"), null);
});

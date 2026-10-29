/**
 * Web console API.
 *
 * Two ways in, both derived from one secret and neither needing a session table:
 *
 *  1. Browser — a signed cookie:
 *     value = `<expiry>.<hmac(sha256, "console:" + secret, expiry)>`
 *     The secret is `ADMIN_TOKEN` (or `ADMIN_PASSWORD` when only that is set),
 *     so rotating it logs every browser out.
 *  2. Telegram Mini App — `X-Telegram-Init-Data` on each request, verified in
 *     `tginit.ts`. No cookie: inside `web.telegram.org` a `SameSite=Strict`
 *     cookie is third-party and would be dropped, and relaxing it to `None`
 *     would make every write route CSRF-able. The header is CSRF-immune
 *     (a cross-site form cannot set it).
 *
 * Every route is behind `identity()`. The exceptions are `/api/login` (mints the
 * cookie) and `/api/logout`. Login is rate-limited per client address: the
 * password may be short, so guessing must be expensive.
 */
import type { Runtime } from "../context.ts";
import { PERMS_MEMBER, PERMS_MUTED } from "../context.ts";
import { record } from "../moderation.ts";
import type { Env } from "../types.ts";
import {
  banCount,
  banDelete,
  banGet,
  banList,
  aiUsageGet,
  aiUsageSeries,
  blockAdd,
  blockList,
  blockRemove,
  parseJobStats,
  parseJobsRecent,
  wordDayTotals,
  wordTop,
  syncDelete,
  syncEnable,
  syncList,
  syncUpsert,
  toolStats,
  chatStats,
  eventsKindTotals,
  eventsKindTotalsBetween,
  scheduleCount,
  filterAdd,
  filterDelete,
  filterList,
  healthAll,
  listChats,
  noteDelete,
  noteList,
  noteSave,
  recentEvents,
  scheduleAdd,
  scheduleDelete,
  scheduleList,
  scheduleToggle,
  warnList,
  memberActivitySince,
  memberList,
  userBlocks,
  userEventsAll,
  userWarnings,
} from "../db/repo.ts";
import { DEFAULT_CONFIG, LOCK_KINDS, SETTABLE, patchError } from "../rules.ts";
import { PRESET, readPreset, writePreset } from "../preset.ts";
import { normalizeChannel } from "../sync.ts";
import { dayKey } from "../ai/words.ts";
import { cachesFor } from "../caches.ts";
import { safeEqual } from "../telegram.ts";
import { authorizeConsoleUser, verifyInitData } from "./tginit.ts";
import {
  LOGIN_CODE_TTL_S,
  consumeLoginCode,
  issueLoginCode,
  loginCodeStatus,
  newLoginCode,
} from "./login-codes.ts";

const COOKIE = "fw_admin";
const SESSION_MS = 12 * 3600_000;
export const INIT_DATA_HEADER = "x-telegram-init-data";

/** Failed-login budget per client address. */
const LOGIN_FAIL_MAX = 8;
const LOGIN_FAIL_WINDOW_S = 600;

/** Login-code request and polling budgets per client address. */
const LOGIN_REQUEST_WINDOW_MS = 10 * 60_000;
const LOGIN_POLL_WINDOW_MS = 10 * 60_000;
const LOGIN_POLL_MAX = 240;
const loginRequests = new Map<string, number>();
const loginPolls = new Map<string, { n: number; at: number }>();

const enc = new TextEncoder();

/**
 * Key material for the session cookie. `ADMIN_TOKEN` wins so existing sessions
 * survive this change; `ADMIN_PASSWORD` alone is enough for a password-only
 * deployment; with neither, the BOT_TOKEN derives one so the login-code flow
 * (which needs no shared password at all) still has something to sign with.
 */
function sessionSecret(env: Env): string {
  // `??` is not enough: wrangler `[vars]` and `.dev.vars` routinely define a key
  // as an empty string, and an empty ADMIN_TOKEN would shadow a real password
  // and disable the console. Treat blank as absent.
  const token = String(env.ADMIN_TOKEN ?? "").trim();
  if (token) return token;
  const password = String(env.ADMIN_PASSWORD ?? "").trim();
  if (password) return password;
  return `bot:${String(env.BOT_TOKEN ?? "")}`;
}

function hasPasswordSecret(env: Env): boolean {
  return Boolean(String(env.ADMIN_TOKEN ?? "").trim() || String(env.ADMIN_PASSWORD ?? "").trim());
}

function envSecret(value: string | undefined): string {
  return String(value ?? "").trim();
}

async function sign(env: Env, expiry: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(`console:${sessionSecret(env)}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(expiry)));
  return [...sig]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export async function mintSession(env: Env, nowMs: number, userId?: number): Promise<string> {
  const expiry = String(nowMs + SESSION_MS);
  const uid = userId && userId > 0 ? String(userId) : "";
  // v2 carries the user id so personal sessions can be authorized per chat and
  // attributed per person; the bare-password cookie (v1, two segments) stays
  // valid and keeps its operator status.
  const payload = uid ? `${expiry}.${uid}` : expiry;
  return `${payload}.${await sign(env, payload)}`;
}

export async function validSession(
  env: Env,
  cookie: string | null | undefined,
  nowMs: number,
): Promise<{ ok: boolean; userId?: number }> {
  if (!sessionSecret(env)) return { ok: false };
  if (!cookie) return { ok: false };
  const parts = String(cookie).split(".");
  if (parts.length === 2) {
    const [expiry, mac] = parts as [string, string];
    if (!expiry || !mac) return { ok: false };
    if (Number(expiry) < nowMs) return { ok: false };
    return { ok: safeEqual(mac, await sign(env, expiry)) };
  }
  if (parts.length === 3) {
    const [expiry, uid, mac] = parts as [string, string, string];
    if (!expiry || !mac) return { ok: false };
    if (Number(expiry) < nowMs) return { ok: false };
    if (!/^-?\d+$/.test(uid)) return { ok: false };
    return { ok: safeEqual(mac, await sign(env, `${expiry}.${uid}`)), userId: Number(uid) };
  }
  return { ok: false };
}

/** The address the login budget is charged to. Cloudflare sets the first one. */
export function clientIp(request: Request): string {
  const direct = request.headers.get("cf-connecting-ip");
  if (direct) return direct.trim();
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim();
  return first || "local";
}

/**
 * Belt and braces on the failure counter.
 *
 * KV allows roughly one write per second per key; a real guessing loop writes
 * far faster, and a thrown KV error inside the login handler would surface as a
 * 500 to everyone behind that address. So the budget is kept twice: in KV for
 * cross-isolate persistence, and in this isolate's memory as the counter that
 * cannot fail. Whichever is higher wins.
 */
const recentFails = new Map<string, { n: number; at: number }>();

function memoryFailures(ip: string, nowMs: number): number {
  const hit = recentFails.get(ip);
  if (!hit) return 0;
  if (nowMs - hit.at > LOGIN_FAIL_WINDOW_S * 1000) {
    recentFails.delete(ip);
    return 0;
  }
  return hit.n;
}

async function loginFailures(rt: Runtime, ip: string): Promise<number> {
  let stored = 0;
  try {
    const raw = await rt.store.get(`admin:fail:${ip}`);
    const n = Number(raw ?? 0);
    stored = Number.isFinite(n) ? n : 0;
  } catch {
    stored = 0;
  }
  return Math.max(stored, memoryFailures(ip, rt.now()));
}

async function chargeFailure(rt: Runtime, ip: string): Promise<void> {
  const nowMs = rt.now();
  const next = memoryFailures(ip, nowMs) + 1;
  // Bound the map: a botnet rotating addresses must not grow this without end.
  if (recentFails.size > 2_000) recentFails.clear();
  recentFails.set(ip, { n: next, at: nowMs });
  try {
    await rt.store.put(
      `admin:fail:${ip}`,
      String(await loginFailures(rt, ip)),
      LOGIN_FAIL_WINDOW_S,
    );
  } catch {
    // The memory counter already recorded it; persistence is a bonus.
  }
}

async function clearFailures(rt: Runtime, ip: string): Promise<void> {
  recentFails.delete(ip);
  try {
    await rt.store.del(`admin:fail:${ip}`);
  } catch {
    /* nothing to do: the memory counter is authoritative within this isolate */
  }
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

/**
 * Apply only the listed keys, through the same zod-validated path as `/config`.
 *
 * This is the fix for the bug that bit the preset editor: spreading a partial
 * object that has schema defaults writes every field back, so "change one
 * number" silently resets the rest. Whitelisting keys is the cheap guard.
 */
async function patchKeys(
  rt: Runtime,
  chatId: number,
  body: Record<string, unknown>,
  keys: string[],
): Promise<Response> {
  const patch: Record<string, unknown> = {};
  for (const key of keys) if (body[key] !== undefined) patch[key] = body[key];
  if (!Object.keys(patch).length) return json({ error: "没有可保存的字段" }, 400);
  const error = patchError(patch);
  if (error) return json({ error }, 400);
  const saved = await rt.saveConfig(chatId, patch);
  if (saved.error) return json({ error: saved.error }, 400);
  return json({ ok: true, changed: Object.keys(patch), config: saved.config });
}

export type Identity =
  { ok: true; via: "cookie" | "telegram"; userId?: number } | { ok: false; error: string };

/**
 * Who is calling? Mini App header first, cookie second.
 *
 * The Mini App path re-verifies on every request rather than trusting a cookie,
 * so a revoked admin loses the console at the next click instead of at the next
 * session expiry. A cookie carrying a user id is a personal (login-code)
 * session: per-chat authorized, never an operator.
 */
async function identity(request: Request, env: Env, rt: Runtime): Promise<Identity> {
  const initData = request.headers.get(INIT_DATA_HEADER);
  if (initData) {
    const check = await verifyInitData(initData, env.BOT_TOKEN ?? "", rt.now());
    if (!check.ok) return { ok: false, error: check.error };
    const allowed = await authorizeConsoleUser(
      { env, api: rt.api, db: rt.db, now: rt.now },
      check.user.id,
    );
    if (!allowed) return { ok: false, error: "这个 Telegram 账号不是本机器人的管理员" };
    return { ok: true, via: "telegram", userId: check.user.id };
  }
  const session = await validSession(env, readCookie(request, COOKIE), rt.now());
  if (session.ok) return { ok: true, via: "cookie", userId: session.userId };
  return { ok: false, error: "未登录" };
}

/**
 * Operators see everything: whoever holds the bare password cookie and
 * everyone in `ADMIN_IDS`. A personal session (login code or Mini App) gets
 * exactly the groups its user administers — one group's console must not open
 * another group's config, blocks or schedules.
 */
function isOperator(rt: Runtime, who: Identity): boolean {
  if (!who.ok) return false;
  if (who.via === "cookie") return !who.userId || rt.admin.isStatic(who.userId);
  return Boolean(who.userId && rt.admin.isStatic(who.userId));
}

async function authorizeChat(rt: Runtime, who: Identity, chatId: number): Promise<boolean> {
  if (!who.ok) return false;
  if (isOperator(rt, who)) return true;
  return Boolean(who.userId && (await rt.admin.isAdmin(chatId, who.userId)));
}

/** The bot's own numeric id, fetched once per isolate. */
async function botIdentifier(rt: Runtime): Promise<number> {
  const caches = cachesFor(rt);
  if (caches.botId) return caches.botId;
  const me = await rt.api.call<{ id?: number }>("getMe", {}).catch(() => null);
  caches.botId = me && me.ok ? Number(me.result?.id ?? 0) : 0;
  return caches.botId;
}

type BotRights = { admin: boolean; delete: boolean; restrict: boolean; pin: boolean };

/** Rights the bot itself holds in a chat, cached ten minutes per runtime. */
async function botRightsFor(rt: Runtime, botId: number, chatId: number): Promise<BotRights> {
  const caches = cachesFor(rt);
  const hit = caches.botRights.get(chatId);
  if (hit) return hit;
  let rights: BotRights = { admin: false, delete: false, restrict: false, pin: false };
  if (botId) {
    const res = await rt.api
      .call<{
        status?: string;
        can_delete_messages?: boolean;
        can_restrict_members?: boolean;
        can_pin_messages?: boolean;
      }>("getChatMember", { chat_id: chatId, user_id: botId })
      .catch(() => null);
    const member = res && res.ok ? res.result : null;
    if (member) {
      rights =
        member.status === "creator"
          ? { admin: true, delete: true, restrict: true, pin: true }
          : {
              admin: member.status === "administrator",
              delete: Boolean(member.can_delete_messages),
              restrict: Boolean(member.can_restrict_members),
              pin: Boolean(member.can_pin_messages),
            };
    }
  }
  caches.botRights.set(chatId, rights);
  return rights;
}

export async function handleApi(
  request: Request,
  env: Env,
  rt: Runtime,
  url: URL,
): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/login/request" && request.method === "POST") {
    // Per-IP throttle: three codes per ten minutes is plenty for one operator
    // and keeps the code space from being pre-seeded by a stranger.
    const ip = clientIp(request);
    const last = loginRequests.get(ip);
    if (last && rt.now() - last < LOGIN_REQUEST_WINDOW_MS) {
      return json({ error: "请求太频繁，请几分钟后重试" }, 429, { "retry-after": "600" });
    }
    loginRequests.set(ip, rt.now());
    if (loginRequests.size > 4_000) loginRequests.clear();
    const code = newLoginCode();
    await issueLoginCode(rt, code);
    return json({
      ok: true,
      code,
      bot: String(env.BOT_USERNAME ?? "").replace(/^@/, ""),
      ttl: LOGIN_CODE_TTL_S,
    });
  }

  if (path === "/api/login/status" && request.method === "GET") {
    const ip = clientIp(request);
    const polled = loginPolls.get(ip) ?? { n: 0, at: rt.now() };
    const window = rt.now() - polled.at > LOGIN_POLL_WINDOW_MS ? { n: 0, at: rt.now() } : polled;
    window.n += 1;
    loginPolls.set(ip, window);
    if (loginPolls.size > 4_000) loginPolls.clear();
    if (window.n > LOGIN_POLL_MAX) return json({ error: "轮询太频繁" }, 429);
    const code = String(url.searchParams.get("code") ?? "");
    if (!/^\d{6}$/.test(code)) return json({ error: "码格式不对" }, 400);
    return json(await loginCodeStatus(rt, code));
  }

  if (path === "/api/login" && request.method === "POST") {
    // The code path works with no password secret at all (BOT_TOKEN signs the
    // session); the 503 only applies when there is genuinely nothing to sign with.
    if (!sessionSecret(env) || (!hasPasswordSecret(env) && !env.BOT_TOKEN)) {
      return json({ error: "部署没有设置 ADMIN_TOKEN 或 ADMIN_PASSWORD，后台已禁用" }, 503);
    }

    const body = (await request.json().catch(() => ({}))) as {
      token?: string;
      password?: string;
      secret?: string;
      initData?: string;
      code?: string;
    };

    // Mini App first: it is the only path that works inside an iframe, and it
    // needs no password at all — Telegram already vouched for the user.
    if (body.initData) {
      const check = await verifyInitData(body.initData, env.BOT_TOKEN ?? "", rt.now());
      if (!check.ok) return json({ error: check.error }, 401);
      if (
        !(await authorizeConsoleUser({ env, api: rt.api, db: rt.db, now: rt.now }, check.user.id))
      ) {
        return json({ error: "这个 Telegram 账号不是本机器人的管理员" }, 403);
      }
      // 会话必须携带身份：不带 userId 的裸 cookie 等于给任何普通群管理员
      // 铸造全局 operator 会话（跨浏览器 12 小时有效）。
      return json({ ok: true, via: "telegram", user: check.user }, 200, {
        "set-cookie": cookieHeader(await mintSession(env, rt.now(), check.user.id)),
      });
    }

    // Login code: the secret is the code itself, and it only works after an
    // admin approved it from Telegram — so no rate budget is charged here.
    const code = String(body.code ?? "").trim();
    const codeIp = clientIp(request);
    if (/^\d{6}$/.test(code)) {
      // 登录码空间只有 10^6 且未批准码不消耗：不做每 IP 尝试上限，
      // 10 分钟 TTL 内可以被无成本爆破。命中上限后锁该 IP 到窗口重置。
      if ((await loginFailures(rt, codeIp)) >= LOGIN_FAIL_MAX) {
        return json({ error: "尝试太多次，请稍后再试" }, 429);
      }
      const identity = await consumeLoginCode(rt, code);
      if (!identity) {
        await chargeFailure(rt, codeIp);
        return json({ error: "码不对、还没批准或已过期" }, 401);
      }
      return json(
        { ok: true, via: "code", user: { id: identity.userId, first_name: identity.name } },
        200,
        { "set-cookie": cookieHeader(await mintSession(env, rt.now(), identity.userId)) },
      );
    }

    const ip = clientIp(request);
    if ((await loginFailures(rt, ip)) >= LOGIN_FAIL_MAX) {
      return json({ error: "尝试次数过多，请 10 分钟后再试" }, 429, {
        "retry-after": String(LOGIN_FAIL_WINDOW_S),
      });
    }

    // One field for both: the console asks for "访问密码" and the operator may
    // paste either the password or the older ADMIN_TOKEN.
    const supplied = String(body.secret ?? body.password ?? body.token ?? "");
    const token = envSecret(env.ADMIN_TOKEN);
    const password = envSecret(env.ADMIN_PASSWORD);
    const tokenOk = Boolean(token) && safeEqual(supplied, token);
    const passwordOk = Boolean(password) && safeEqual(supplied, password);
    if (!tokenOk && !passwordOk) {
      await chargeFailure(rt, ip);
      const left = Math.max(0, LOGIN_FAIL_MAX - (await loginFailures(rt, ip)));
      return json({ error: `密码不对（还可以试 ${left} 次）` }, 401);
    }

    await clearFailures(rt, ip);
    return json({ ok: true, via: "password" }, 200, {
      "set-cookie": cookieHeader(await mintSession(env, rt.now())),
    });
  }

  if (path === "/api/logout") {
    return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
  }

  const who = await identity(request, env, rt);
  if (!who.ok) return json({ error: who.error }, who.error === "未登录" ? 401 : 403);

  if (path === "/api/whoami") return json({ via: who.via, userId: who.userId ?? null });

  try {
    return await route(request, env, rt, url, path, who);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

function cookieHeader(value: string, maxAgeSeconds = SESSION_MS / 1000): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

async function route(
  request: Request,
  env: Env,
  rt: Runtime,
  url: URL,
  path: string,
  who: Identity,
): Promise<Response> {
  const operator = isOperator(rt, who);

  if (path === "/api/overview") {
    let chats = await listChats(rt.db);
    let totals: Record<string, number> = {};
    if (operator) {
      totals = await eventsKindTotals(rt.db, rt.now() - 7 * 86_400_000);
    } else {
      // A group admin sees only the groups they administer, and the totals
      // aggregate only those — another group's numbers are none of their
      // business. Bounded by the chats they actually run, so the per-chat loop
      // that used to run here stays cheap.
      const mine: typeof chats = [];
      for (const chat of chats) {
        if (who.ok && who.userId && (await rt.admin.isAdmin(chat.chatId, who.userId)))
          mine.push(chat);
      }
      chats = mine;
      const since = rt.now() - 7 * 86_400_000;
      for (const chat of mine) {
        const stats = await chatStats(rt.db, chat.chatId, since, rt.tzOffset);
        for (const [kind, n] of Object.entries(stats.totals))
          totals[kind] = (totals[kind] ?? 0) + n;
      }
    }

    // The bot's own rights per chat, cached ten minutes — the console badges
    // the groups where moderation rights (delete/restrict/pin) are missing.
    const botId = await botIdentifier(rt);
    for (const chat of chats) {
      (chat as { rights?: unknown }).rights = await botRightsFor(rt, botId, chat.chatId);
    }

    // Today/yesterday join-leave board, in the deployment's timezone.
    let board: { today: Record<string, number>; yesterday: Record<string, number> } | undefined;
    if (operator) {
      const localMs = rt.now() + rt.tzOffset * 60_000;
      const dayStart = rt.now() - (localMs % 86_400_000);
      board = {
        today: await eventsKindTotalsBetween(rt.db, dayStart, rt.now() + 1),
        yesterday: await eventsKindTotalsBetween(rt.db, dayStart - 86_400_000, dayStart),
      };
    }

    return json({
      chats,
      totals,
      board,
      // Operator-only fields are dropped rather than zeroed, so the front end
      // can hide what a group admin has no business clicking.
      bans: operator ? await banCount(rt.db) : undefined,
      health: operator ? await healthAll(rt.db) : [],
      scheduled: operator ? await scheduleCount(rt.db) : undefined,
      now: rt.now(),
      fields: SETTABLE,
      lockKinds: LOCK_KINDS,
      defaults: DEFAULT_CONFIG,
    });
  }

  const chatMatch = path.match(/^\/api\/chat\/(-?\d+)(?:\/(.+))?$/);
  if (chatMatch) {
    const chatId = Number(chatMatch[1]);
    const rest = chatMatch[2] ?? "";
    if (!(await authorizeChat(rt, who, chatId)))
      return json({ error: "你不是这个群的管理员" }, 403);
    // Personal sessions (login code / Mini App) attribute every write to the
    // person; the shared-password cookie stays anonymous (0).
    const actorId = who.ok && who.userId ? who.userId : 0;

    if (!rest) {
      const config = await rt.configFor(chatId);
      const day = dayKey(rt.now(), rt.tzOffset);
      return json({
        chatId,
        day,
        config,
        stats: await chatStats(rt.db, chatId, rt.now() - 30 * 86_400_000, rt.tzOffset),
        events: await recentEvents(rt.db, chatId, 20),
        notes: await noteList(rt.db, chatId),
        filters: await filterList(rt.db, chatId),
        schedules: await scheduleList(rt.db, chatId),
        blocks: await blockList(rt.db, chatId),
        sync: await syncList(rt.db, chatId),
        tools: await toolStats(rt.db, chatId, rt.now() - 30 * 86_400_000),
        ai: {
          usage: await aiUsageGet(rt.db, chatId, day),
          series: await aiUsageSeries(rt.db, chatId, 7),
        },
        words: {
          top: await wordTop(rt.db, chatId, day, 20),
          totals: await wordDayTotals(rt.db, chatId, 7),
        },
        parse: {
          stats: await parseJobStats(rt.db, chatId, rt.now() - 30 * 86_400_000),
          jobs: await parseJobsRecent(rt.db, chatId, 20),
        },
      });
    }

    // The event log with paging and a kind filter. `hasMore` comes from asking
    // for one row past the limit, so the console knows whether to offer "更早"
    // without a separate count query per page.
    if (rest === "events" && request.method === "GET") {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100));
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
      const kindParam = String(url.searchParams.get("kind") ?? "").trim();
      const rows = await recentEvents(rt.db, chatId, limit + 1, {
        offset,
        kind: kindParam || undefined,
      });
      return json({ events: rows.slice(0, limit), hasMore: rows.length > limit, offset });
    }

    // Same payload as the bot's /export command, so a JSON can move between
    // chat and console without translation.
    if (rest === "export" && request.method === "GET") {
      const config = await rt.configFor(chatId);
      const notes = await noteList(rt.db, chatId);
      const filters = await filterList(rt.db, chatId);
      return json({
        v: 1,
        config,
        notes: notes.map((n) => ({ name: n.name, content: n.content })),
        filters: filters.map((f) => ({ trigger: f.trigger, match: f.match, response: f.response })),
      });
    }
    if (rest === "import" && request.method === "POST") {
      // Mirrors the bot's /import: config is patched, logChatId never travels,
      // notes and filters are added on top.
      const body = (await request.json().catch(() => ({}))) as {
        config?: Record<string, unknown>;
        notes?: { name?: string; content?: string }[];
        filters?: { trigger?: string; match?: string; response?: string }[];
      };
      let applied = 0;
      const byId = who.ok && who.userId ? who.userId : 0;
      if (body.config && typeof body.config === "object") {
        const safe = { ...body.config };
        delete safe.logChatId;
        const saved = await rt.saveConfig(chatId, safe);
        if (saved.error) return json({ error: saved.error }, 400);
        applied += 1;
      }
      for (const row of Array.isArray(body.notes) ? body.notes : []) {
        const name = String(row?.name ?? "")
          .toLowerCase()
          .slice(0, 40);
        const content = String(row?.content ?? "").slice(0, 3500);
        if (!name || !content) continue;
        await noteSave(rt.db, { chatId, name, content, createdBy: byId, at: rt.now() });
        applied += 1;
      }
      for (const row of Array.isArray(body.filters) ? body.filters : []) {
        const trigger = String(row?.trigger ?? "").slice(0, 200);
        const response = String(row?.response ?? "").slice(0, 1000);
        if (!trigger || !response) continue;
        const match = String(row?.match ?? "exact");
        if (!["exact", "prefix", "regex"].includes(match)) continue;
        await filterAdd(rt.db, { chatId, trigger, match, response, createdBy: byId, at: rt.now() });
        applied += 1;
      }
      return json({ ok: true, applied });
    }

    if (rest === "members" && request.method === "GET") {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200));
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
      const q = String(url.searchParams.get("q") ?? "").trim();
      const day = dayKey(rt.now() - 7 * 86_400_000, rt.tzOffset);
      const [rows, activity, warnRows, blocks] = await Promise.all([
        memberList(rt.db, chatId, limit + 1, { offset, q }),
        memberActivitySince(rt.db, chatId, day),
        warnList(rt.db, chatId),
        blockList(rt.db, chatId, 1_000),
      ]);
      const warnMap = new Map(warnRows.map((w) => [w.userId, w.count]));
      const blockedSet = new Set(blocks.map((b) => b.userId));
      return json({
        members: rows.slice(0, limit).map((row) => ({
          ...row,
          week: activity.get(row.userId) ?? 0,
          warnings: warnMap.get(row.userId) ?? 0,
          blocked: blockedSet.has(row.userId),
        })),
        hasMore: rows.length > limit,
        offset,
      });
    }

    // Inline member actions from the console. They go through the same Bot API
    // calls the group commands use, and fail loudly when the bot lacks rights.
    const memberAction = rest.match(/^member\/(-?\d+)\/(mute|unmute|kick)$/);
    if (memberAction && request.method === "POST") {
      const userId = Number(memberAction[1]);
      const action = memberAction[2];
      // 与群内命令的 guardTarget 同一条规则：机器人自己、管理员都不可作为
      // 处置对象——此前控制台这条路完全没有守卫。
      if (!userId || String(userId) === rt.api.botId) {
        return json({ error: "不能对机器人自己这么做" }, 400);
      }
      if (await rt.admin.isAdmin(chatId, userId)) {
        return json({ error: "不能对管理员这么做" }, 400);
      }
      let res;
      if (action === "mute") {
        res = await rt.api.call("restrictChatMember", {
          chat_id: chatId,
          user_id: userId,
          permissions: PERMS_MUTED,
          use_independent_chat_permissions: true,
          until_date: Math.floor(rt.now() / 1000) + 3_600,
        });
      } else if (action === "unmute") {
        res = await rt.api.call("restrictChatMember", {
          chat_id: chatId,
          user_id: userId,
          permissions: PERMS_MEMBER,
          use_independent_chat_permissions: true,
        });
      } else {
        const banned = await rt.api.call("banChatMember", { chat_id: chatId, user_id: userId });
        res = banned.ok
          ? await rt.api.call("unbanChatMember", {
              chat_id: chatId,
              user_id: userId,
              only_if_banned: true,
            })
          : banned;
      }
      if (!res.ok) return json({ error: res.error }, 502);
      await record(rt, {
        chatId,
        userId,
        kind: action === "kick" ? "kick" : "mute",
        reason: `后台${action === "kick" ? "移出" : action === "mute" ? "禁言" : "解除禁言"}`,
        byId: actorId,
      });
      return json({ ok: true });
    }

    // Dedicated config endpoints, keyed by feature. They exist so the console
    // cannot accidentally send a field it did not mean to touch: `patchKeys`
    // drops everything outside the list, and the shared zod schema still
    // validates what survives.
    if (rest === "ai" && (request.method === "POST" || request.method === "PATCH")) {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return patchKeys(rt, chatId, body, [
        "ai",
        "aiProvider",
        "aiMinScore",
        "aiDailyBudget",
        "aiCategories",
      ]);
    }
    if (rest === "parse" && (request.method === "POST" || request.method === "PATCH")) {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return patchKeys(rt, chatId, body, ["parseAuto", "parsePerHour"]);
    }
    if (rest === "keywords" && (request.method === "POST" || request.method === "PATCH")) {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return patchKeys(rt, chatId, body, [
        "keywordAction",
        "keywordPatterns",
        "keywords",
        "adWhitelist",
      ]);
    }
    if (rest === "words" && request.method === "GET") {
      const day = dayKey(rt.now(), rt.tzOffset);
      const days = Math.max(1, Math.min(Number(url.searchParams.get("days") ?? 7) || 7, 30));
      return json({
        day,
        top: await wordTop(rt.db, chatId, day, 30),
        totals: await wordDayTotals(rt.db, chatId, days),
      });
    }

    if (rest === "config" && (request.method === "PATCH" || request.method === "POST")) {
      const patch = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const error = patchError(patch);
      if (error) return json({ error }, 400);
      const current = await rt.configFor(chatId);
      const saved = await rt.saveConfig(chatId, patch);
      if (saved.error) return json({ error: saved.error }, 400);
      return json({
        config: saved.config,
        changed: Object.keys(patch).filter(
          (key) => (current as never)[key] !== (saved.config as never)[key],
        ),
      });
    }

    if (rest.startsWith("note/") && request.method === "PUT") {
      const name = decodeURIComponent(rest.slice(5)).toLowerCase().slice(0, 40);
      const body = (await request.json().catch(() => ({}))) as { content?: string };
      if (!name || !body.content) return json({ error: "名字和内容都不能为空" }, 400);
      await noteSave(rt.db, {
        chatId,
        name,
        content: String(body.content).slice(0, 3500),
        createdBy: actorId,
        at: rt.now(),
      });
      return json({ ok: true });
    }
    if (rest.startsWith("note/") && request.method === "DELETE") {
      await noteDelete(rt.db, chatId, decodeURIComponent(rest.slice(5)).toLowerCase());
      return json({ ok: true });
    }

    if (rest === "filter" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        trigger?: string;
        match?: string;
        response?: string;
      };
      if (!body.trigger || !body.response) return json({ error: "触发词和回复都要填" }, 400);
      const mode = ["exact", "prefix", "regex"].includes(String(body.match))
        ? String(body.match)
        : "exact";
      await filterAdd(rt.db, {
        chatId,
        trigger: String(body.trigger).slice(0, 200),
        match: mode,
        response: String(body.response).slice(0, 1000),
        createdBy: actorId,
        at: rt.now(),
      });
      return json({ ok: true });
    }
    if (rest.startsWith("filter/") && request.method === "DELETE") {
      await filterDelete(rt.db, chatId, Number(rest.slice(7)));
      return json({ ok: true });
    }

    if (rest === "block" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { userId?: number; reason?: string };
      const userId = Number(body.userId);
      if (!Number.isFinite(userId) || userId === 0) return json({ error: "userId 不合法" }, 400);
      await blockAdd(rt.db, {
        chatId,
        userId,
        reason: String(body.reason ?? "后台屏蔽"),
        byId: actorId,
        at: rt.now(),
      });
      return json({ ok: true });
    }
    if (rest.startsWith("block/") && request.method === "DELETE") {
      await blockRemove(rt.db, chatId, Number(rest.slice(6)));
      return json({ ok: true });
    }

    if (rest === "sync" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        source?: string;
        interval?: number;
      };
      const source = normalizeChannel(String(body.source ?? ""));
      if (!source) return json({ error: "频道用户名不合法" }, 400);
      const interval = Math.max(0, Math.min(Number(body.interval ?? 300) || 0, 86_400));
      await syncUpsert(rt.db, { chatId, source, intervalSeconds: interval, at: rt.now() });
      return json({ ok: true, source, interval });
    }
    if (rest.startsWith("sync/")) {
      const source = decodeURIComponent(rest.slice(5));
      if (request.method === "DELETE") {
        await syncDelete(rt.db, chatId, source);
        return json({ ok: true });
      }
      if (request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { enabled?: boolean };
        await syncEnable(rt.db, chatId, source, body.enabled !== false);
        return json({ ok: true });
      }
    }

    if (rest === "schedule" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { text?: string; every?: number };
      if (!body.text) return json({ error: "内容不能为空" }, 400);
      const every = Math.max(0, Math.min(Number(body.every ?? 0) || 0, 30 * 86_400));
      await scheduleAdd(rt.db, {
        chatId,
        text: String(body.text).slice(0, 3000),
        every,
        nextAt: rt.now() + 60_000,
        createdBy: actorId,
      });
      return json({ ok: true });
    }
  }

  const schedMatch = path.match(/^\/api\/schedule\/(\d+)$/);
  if (schedMatch) {
    if (!operator) return json({ error: "只有部署操作员能访问全局任务" }, 403);
    const id = Number(schedMatch[1]);
    if (request.method === "DELETE") {
      await scheduleDelete(rt.db, id);
      return json({ ok: true });
    }
    if (request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { enabled?: boolean };
      await scheduleToggle(
        rt.db,
        id,
        body.enabled !== false,
        body.enabled === false ? undefined : rt.now() + 60_000,
      );
      return json({ ok: true });
    }
  }

  if (path === "/api/bans" && request.method === "GET") {
    if (!operator) return json({ error: "只有部署操作员能访问全局黑名单" }, 403);
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200));
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    const q = String(url.searchParams.get("q") ?? "").trim();
    const rows = await banList(rt.db, limit + 1, { offset, q });
    return json({ bans: rows.slice(0, limit), hasMore: rows.length > limit, offset });
  }
  const banMatch = path.match(/^\/api\/bans\/(-?\d+)$/);
  if (banMatch && request.method === "DELETE") {
    if (!operator) return json({ error: "只有部署操作员能访问全局黑名单" }, 403);
    await banDelete(rt.db, Number(banMatch[1]));
    return json({ ok: true });
  }

  // Cross-group member audit: one person's events, warnings, blocks and ban
  // row in every chat the bot knows. Operator-only — it spans all groups.
  const userMatch = path.match(/^\/api\/user\/(-?\d+)$/);
  if (userMatch && request.method === "GET") {
    if (!operator) return json({ error: "只有部署操作员能查询成员" }, 403);
    const userId = Number(userMatch[1]);
    return json({
      userId,
      events: await userEventsAll(rt.db, userId, 100),
      warnings: await userWarnings(rt.db, userId),
      blocks: await userBlocks(rt.db, userId),
      ban: await banGet(rt.db, userId),
    });
  }

  if (path === "/api/preset") {
    if (!operator) return json({ error: "只有部署操作员能修改新群预设" }, 403);
    if (request.method === "GET") return json({ ...(await readPreset(rt)), base: PRESET });
    if (request.method === "PUT" || request.method === "POST") {
      const patch = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const error = await writePreset(rt, patch);
      if (error) return json({ error }, 400);
      return json({ ...(await readPreset(rt)), base: PRESET });
    }
  }

  if (path === "/api/health") {
    if (!operator) return json({ error: "只有部署操作员能访问健康面板" }, 403);
    return json({
      health: await healthAll(rt.db),
      env: { bot: Boolean(env.BOT_TOKEN), db: Boolean(env.DB), admin: Boolean(env.ADMIN_TOKEN) },
    });
  }

  return json({ error: "not found" }, 404);
}

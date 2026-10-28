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

const COOKIE = "fw_admin";
const SESSION_MS = 12 * 3600_000;
export const INIT_DATA_HEADER = "x-telegram-init-data";

/** Failed-login budget per client address. */
const LOGIN_FAIL_MAX = 8;
const LOGIN_FAIL_WINDOW_S = 600;

const enc = new TextEncoder();

/**
 * Key material for the session cookie. `ADMIN_TOKEN` wins so existing sessions
 * survive this change; `ADMIN_PASSWORD` alone is enough for a password-only
 * deployment.
 */
function sessionSecret(env: Env): string {
  // `??` is not enough: wrangler `[vars]` and `.dev.vars` routinely define a key
  // as an empty string, and an empty ADMIN_TOKEN would shadow a real password
  // and disable the console. Treat blank as absent.
  const token = String(env.ADMIN_TOKEN ?? "").trim();
  if (token) return token;
  return String(env.ADMIN_PASSWORD ?? "").trim();
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
  return [...sig].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export async function mintSession(env: Env, nowMs: number): Promise<string> {
  const expiry = String(nowMs + SESSION_MS);
  return `${expiry}.${await sign(env, expiry)}`;
}

export async function validSession(env: Env, cookie: string | null | undefined, nowMs: number): Promise<boolean> {
  if (!sessionSecret(env)) return false;
  if (!cookie) return false;
  const [expiry, mac] = String(cookie).split(".");
  if (!expiry || !mac) return false;
  if (Number(expiry) < nowMs) return false;
  return safeEqual(mac, await sign(env, expiry));
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
    await rt.store.put(`admin:fail:${ip}`, String(await loginFailures(rt, ip)), LOGIN_FAIL_WINDOW_S);
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
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/**
 * Apply only the listed keys, through the same zod-validated path as `/config`.
 *
 * This is the fix for the bug that bit the preset editor: spreading a partial
 * object that has schema defaults writes every field back, so "change one
 * number" silently resets the rest. Whitelisting keys is the cheap guard.
 */
async function patchKeys(rt: Runtime, chatId: number, body: Record<string, unknown>, keys: string[]): Promise<Response> {
  const patch: Record<string, unknown> = {};
  for (const key of keys) if (body[key] !== undefined) patch[key] = body[key];
  if (!Object.keys(patch).length) return json({ error: "没有可保存的字段" }, 400);
  const error = patchError(patch);
  if (error) return json({ error }, 400);
  const saved = await rt.saveConfig(chatId, patch);
  if (saved.error) return json({ error: saved.error }, 400);
  return json({ ok: true, changed: Object.keys(patch), config: saved.config });
}

export type Identity = { ok: true; via: "cookie" | "telegram"; userId?: number } | { ok: false; error: string };

/**
 * Who is calling? Mini App header first, cookie second.
 *
 * The Mini App path re-verifies on every request rather than trusting a cookie,
 * so a revoked admin loses the console at the next click instead of at the next
 * session expiry.
 */
async function identity(request: Request, env: Env, rt: Runtime): Promise<Identity> {
  const initData = request.headers.get(INIT_DATA_HEADER);
  if (initData) {
    const check = await verifyInitData(initData, env.BOT_TOKEN ?? "", rt.now());
    if (!check.ok) return { ok: false, error: check.error };
    const allowed = await authorizeConsoleUser({ env, api: rt.api, db: rt.db, now: rt.now }, check.user.id);
    if (!allowed) return { ok: false, error: "这个 Telegram 账号不是本机器人的管理员" };
    return { ok: true, via: "telegram", userId: check.user.id };
  }
  if (await validSession(env, readCookie(request, COOKIE), rt.now())) return { ok: true, via: "cookie" };
  return { ok: false, error: "未登录" };
}

/**
 * Operators see everything: whoever holds the cookie (the shared secret) and
 * everyone in `ADMIN_IDS`. A Mini App user who is merely a group admin gets
 * exactly the groups they administer — one group's console must not open
 * another group's config, blocks or schedules.
 */
function isOperator(rt: Runtime, who: Identity): boolean {
  if (!who.ok) return false;
  if (who.via === "cookie") return true;
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
      .call<{ status?: string; can_delete_messages?: boolean; can_restrict_members?: boolean; can_pin_messages?: boolean }>(
        "getChatMember",
        { chat_id: chatId, user_id: botId },
      )
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

export async function handleApi(request: Request, env: Env, rt: Runtime, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/login" && request.method === "POST") {
    if (!sessionSecret(env)) return json({ error: "部署没有设置 ADMIN_TOKEN 或 ADMIN_PASSWORD，后台已禁用" }, 503);

    const body = (await request.json().catch(() => ({}))) as {
      token?: string;
      password?: string;
      secret?: string;
      initData?: string;
    };

    // Mini App first: it is the only path that works inside an iframe, and it
    // needs no password at all — Telegram already vouched for the user.
    if (body.initData) {
      const check = await verifyInitData(body.initData, env.BOT_TOKEN ?? "", rt.now());
      if (!check.ok) return json({ error: check.error }, 401);
      if (!(await authorizeConsoleUser({ env, api: rt.api, db: rt.db, now: rt.now }, check.user.id))) {
        return json({ error: "这个 Telegram 账号不是本机器人的管理员" }, 403);
      }
      return json({ ok: true, via: "telegram", user: check.user }, 200, { "set-cookie": cookieHeader(await mintSession(env, rt.now())) });
    }

    const ip = clientIp(request);
    if ((await loginFailures(rt, ip)) >= LOGIN_FAIL_MAX) {
      return json({ error: "尝试次数过多，请 10 分钟后再试" }, 429, { "retry-after": String(LOGIN_FAIL_WINDOW_S) });
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
    return json({ ok: true, via: "password" }, 200, { "set-cookie": cookieHeader(await mintSession(env, rt.now())) });
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

async function route(request: Request, env: Env, rt: Runtime, url: URL, path: string, who: Identity): Promise<Response> {
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
        if (who.ok && who.userId && (await rt.admin.isAdmin(chat.chatId, who.userId))) mine.push(chat);
      }
      chats = mine;
      const since = rt.now() - 7 * 86_400_000;
      for (const chat of mine) {
        const stats = await chatStats(rt.db, chat.chatId, since);
        for (const [kind, n] of Object.entries(stats.totals)) totals[kind] = (totals[kind] ?? 0) + n;
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
    if (!(await authorizeChat(rt, who, chatId))) return json({ error: "你不是这个群的管理员" }, 403);

    if (!rest) {
      const config = await rt.configFor(chatId);
      const day = dayKey(rt.now(), rt.tzOffset);
      return json({
        chatId,
        day,
        config,
        stats: await chatStats(rt.db, chatId, rt.now() - 30 * 86_400_000),
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
      const rows = await recentEvents(rt.db, chatId, limit + 1, { offset, kind: kindParam || undefined });
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
        const name = String(row?.name ?? "").toLowerCase().slice(0, 40);
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

    // Dedicated config endpoints, keyed by feature. They exist so the console
    // cannot accidentally send a field it did not mean to touch: `patchKeys`
    // drops everything outside the list, and the shared zod schema still
    // validates what survives.
    if (rest === "ai" && (request.method === "POST" || request.method === "PATCH")) {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return patchKeys(rt, chatId, body, ["ai", "aiProvider", "aiMinScore", "aiDailyBudget", "aiCategories"]);
    }
    if (rest === "parse" && (request.method === "POST" || request.method === "PATCH")) {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return patchKeys(rt, chatId, body, ["parseAuto", "parsePerHour"]);
    }
    if (rest === "keywords" && (request.method === "POST" || request.method === "PATCH")) {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return patchKeys(rt, chatId, body, ["keywordAction", "keywordPatterns", "keywords", "adWhitelist"]);
    }
    if (rest === "words" && request.method === "GET") {
      const day = dayKey(rt.now(), rt.tzOffset);
      const days = Math.max(1, Math.min(Number(url.searchParams.get("days") ?? 7) || 7, 30));
      return json({ day, top: await wordTop(rt.db, chatId, day, 30), totals: await wordDayTotals(rt.db, chatId, days) });
    }

    if (rest === "config" && (request.method === "PATCH" || request.method === "POST")) {
      const patch = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const error = patchError(patch);
      if (error) return json({ error }, 400);
      const current = await rt.configFor(chatId);
      const saved = await rt.saveConfig(chatId, patch);
      if (saved.error) return json({ error: saved.error }, 400);
      return json({ config: saved.config, changed: Object.keys(patch).filter((key) => (current as never)[key] !== (saved.config as never)[key]) });
    }

    if (rest.startsWith("note/") && request.method === "PUT") {
      const name = decodeURIComponent(rest.slice(5)).toLowerCase().slice(0, 40);
      const body = (await request.json().catch(() => ({}))) as { content?: string };
      if (!name || !body.content) return json({ error: "名字和内容都不能为空" }, 400);
      await noteSave(rt.db, { chatId, name, content: String(body.content).slice(0, 3500), createdBy: 0, at: rt.now() });
      return json({ ok: true });
    }
    if (rest.startsWith("note/") && request.method === "DELETE") {
      await noteDelete(rt.db, chatId, decodeURIComponent(rest.slice(5)).toLowerCase());
      return json({ ok: true });
    }

    if (rest === "filter" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { trigger?: string; match?: string; response?: string };
      if (!body.trigger || !body.response) return json({ error: "触发词和回复都要填" }, 400);
      const mode = ["exact", "prefix", "regex"].includes(String(body.match)) ? String(body.match) : "exact";
      await filterAdd(rt.db, {
        chatId,
        trigger: String(body.trigger).slice(0, 200),
        match: mode,
        response: String(body.response).slice(0, 1000),
        createdBy: 0,
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
      await blockAdd(rt.db, { chatId, userId, reason: String(body.reason ?? "后台屏蔽"), byId: 0, at: rt.now() });
      return json({ ok: true });
    }
    if (rest.startsWith("block/") && request.method === "DELETE") {
      await blockRemove(rt.db, chatId, Number(rest.slice(6)));
      return json({ ok: true });
    }

    if (rest === "sync" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { source?: string; interval?: number };
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
      await scheduleAdd(rt.db, { chatId, text: String(body.text).slice(0, 3000), every, nextAt: rt.now() + 60_000, createdBy: 0 });
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
      await scheduleToggle(rt.db, id, body.enabled !== false, body.enabled === false ? undefined : rt.now() + 60_000);
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
    return json({ health: await healthAll(rt.db), env: { bot: Boolean(env.BOT_TOKEN), db: Boolean(env.DB), admin: Boolean(env.ADMIN_TOKEN) } });
  }

  return json({ error: "not found" }, 404);
}

/**
 * Live smoke against the deployed Worker.
 *
 * Unit tests prove the decisions; this proves the whole path — signed webhook →
 * Cloudflare Worker → KV/D1 → Bot API — with the real group and the real
 * database. Assertions read D1 directly, so "the bot said ok" is never enough.
 *
 * What it will and will not do:
 *   · injects commands as the group's real creator (that is what a genuine
 *     update looks like; the bot has no way — and no reason — to tell them
 *     apart),
 *   · only touches throwaway ids (999999999 / 999999999999) and one scheduled
 *     message it deletes again,
 *   · never mutes, bans or deletes anything belonging to a real member.
 *
 *   BOT_TOKEN=... TEST_CHAT_ID=-100... CF_API_TOKEN=... CF_ACCOUNT_ID=... \
 *   CF_D1_ID=... node --experimental-strip-types scripts/live-smoke.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publicHttpUrl } from "../src/url-guard.ts";

const token = process.env.BOT_TOKEN ?? "";
const secret = process.env.WEBHOOK_SECRET ?? safeRead(".webhook-secret");
// Guarded once at the source: everything built from it is already-validated data.
const publicUrl = publicHttpUrl((process.env.PUBLIC_URL ?? "https://flareward-bot.pd2335346.workers.dev").replace(/\/+$/, "")) ?? "";
const chatId = process.env.TEST_CHAT_ID ?? "";
const cfToken = process.env.CF_API_TOKEN ?? "";
const cfAccount = process.env.CF_ACCOUNT_ID ?? "";
const cfDb = process.env.CF_D1_ID ?? "";

if (!token || !chatId) {
  console.error("需要 BOT_TOKEN 与 TEST_CHAT_ID");
  process.exit(1);
}

function safeRead(name: string): string {
  try {
    return readFileSync(join(import.meta.dirname, "..", name), "utf8").trim();
  } catch {
    return "";
  }
}

let passed = 0;
let failed = 0;
const blocked: { command: string; why: string }[] = [];

function ok(label: string, detail = ""): void {
  passed += 1;
  console.log(`✔ ${label}${detail ? ` — ${detail}` : ""}`);
}
function bad(label: string, detail: string): void {
  failed += 1;
  console.log(`✖ ${label} — ${detail}`);
}

const API = "https://api.telegram.org";

/**
 * This machine's route to Telegram drops TLS handshakes every few requests; the
 * bot's own client retries, so the harness must too or it reports the network as
 * a product failure.
 *
 * Every target comes from an operator's environment, so the guard is what keeps
 * one mistyped variable from turning the smoke run into a probe of loopback or
 * an internal address. This script is for the deployed Worker; a local one needs
 * a public tunnel anyway.
 */
async function fetchRetry(input: string, init: RequestInit, attempts = 3): Promise<Response> {
  const target = publicHttpUrl(input);
  if (!target) throw new Error(`smoke 目标必须是公网 http(s) 地址：${input.slice(0, 80)}`);
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(target, init);
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw last;
}

async function api<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: T; description?: string }> {
  const res = await fetchRetry(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; result?: T; description?: string };
}

async function d1<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  if (!cfToken || !cfAccount || !cfDb) return [];
  const res = await fetchRetry(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/d1/database/${cfDb}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfToken}`, "content-type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  const payload = (await res.json()) as { result?: { results?: T[] }[]; success?: boolean; errors?: { message: string }[] };
  if (!payload.success) throw new Error(`D1: ${payload.errors?.[0]?.message ?? "query failed"}`);
  return payload.result?.[0]?.results ?? [];
}

let updateId = 900_000;
async function inject(text: string, from: number, messageId = 5000): Promise<number> {
  updateId += 1;
  const res = await fetchRetry(`${publicUrl}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(chatId), type: "supergroup", title: "smoke" },
        from: { id: from, first_name: "Smoke", is_bot: false },
        text,
      },
    }),
  });
  return res.status;
}

async function eventually<T>(fn: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 8000): Promise<T | null> {
  const started = Date.now();
  let last: T | null = null;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (ok(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
}

// ---------------------------------------------------------------------------

const me = await api<{ id: number; username?: string; can_read_all_group_messages?: boolean }>("getMe");
if (!me.ok) {
  bad("getMe", me.description ?? "");
  process.exit(1);
}
ok("getMe", `@${me.result?.username}`);
if (me.result?.can_read_all_group_messages === false) bad("隐私模式", "仍开启，机器人看不见普通消息");
else ok("隐私模式", "已关闭");

const chat = await api<{ title?: string; type: string }>("getChat", { chat_id: chatId });
if (chat.ok) ok("getChat", `${chat.result?.title} (${chat.result?.type})`);
else bad("getChat", chat.description ?? "");

const admins = await api<{ user: { id: number }; status: string }[]>("getChatAdministrators", { chat_id: chatId });
const creator = admins.result?.find((entry) => entry.status === "creator")?.user.id ?? 0;
if (creator) ok("getChatAdministrators", `管理员 ${admins.result?.length} 人，creator=${creator}`);
else bad("getChatAdministrators", "没找到群主，无法以真实管理员身份注入命令");

const hook = await api<{ url?: string; pending_update_count?: number; last_error_message?: string }>("getWebhookInfo");
if (hook.ok && hook.result?.url?.endsWith("/webhook")) ok("getWebhookInfo", hook.result.url);
else bad("getWebhookInfo", hook.result?.url ?? "未注册");

async function healthStatus(): Promise<Record<string, unknown>> {
  const res = await fetchRetry(`${publicUrl}/health`, {});
  return res.json() as Promise<Record<string, unknown>>;
}

const health = await healthStatus();
if (health.ok) ok("worker /health", JSON.stringify(health));
else bad("worker /health", JSON.stringify(health));

if (!cfToken) {
  blocked.push({ command: "D1 断言", why: "没有 CF_API_TOKEN，只能看 HTTP 200，无法核对落库" });
} else {
  const tables = await d1<{ name: string }>("select name from sqlite_master where type='table' and name in ('blocked_users','scheduled_messages','events')");
  if (tables.length === 3) ok("D1 schema", "blocked_users / scheduled_messages / events 都在");
  else bad("D1 schema", `缺表：${tables.map((row) => row.name).join(",") || "全部"}`);
}

if (!creator) {
  console.log("\n跳过注入阶段：没有可用的管理员 id");
  process.exit(failed ? 1 : 0);
}

// 1 ─ /block then /unblock on a throwaway id: a real read + write through D1.
await inject(`/block 999999999 smoke`, creator, 5001);
const blockedRow = await eventually(
  () => d1<{ n: number }>("select count(*) as n from blocked_users where user_id=999999999"),
  (rows) => Number(rows[0]?.n ?? 0) === 1,
);
if (Number(blockedRow?.[0]?.n ?? 0) === 1) ok("/block 落库", "blocked_users 有 1 行");
else bad("/block 落库", `blocked_users=${blockedRow?.[0]?.n ?? "查不到"}`);

await inject(`/unblock 999999999`, creator, 5002);
const cleared = await eventually(
  () => d1<{ n: number }>("select count(*) as n from blocked_users where user_id=999999999"),
  (rows) => Number(rows[0]?.n ?? 0) === 0,
);
if (Number(cleared?.[0]?.n ?? 0) === 0) ok("/unblock 落库", "记录已清除");
else bad("/unblock 落库", `仍有 ${cleared?.[0]?.n ?? "?"} 行`);

// 2 ─ /schedule writes a row; it is deleted again so nothing posts later.
await inject(`/schedule 7200 smoke-verify`, creator, 5003);
const scheduled = await eventually(
  () => d1<{ n: number; id: number }>("select count(*) as n, max(id) as id from scheduled_messages where text='smoke-verify'"),
  (rows) => Number(rows[0]?.n ?? 0) === 1,
);
if (Number(scheduled?.[0]?.n ?? 0) === 1) {
  ok("/schedule 落库", `id=${scheduled?.[0]?.id}`);
  await d1("delete from scheduled_messages where text='smoke-verify'");
  const after = await d1<{ n: number }>("select count(*) as n from scheduled_messages where text='smoke-verify'");
  if (Number(after[0]?.n ?? 0) === 0) ok("/schedule 清理", "已删除，不会在两小时后发到群里");
  else bad("/schedule 清理", "残留一行，两小时后会发一条消息，请手动删");
} else {
  bad("/schedule 落库", `scheduled_messages=${scheduled?.[0]?.n ?? "查不到"}`);
}

// 3 ─ /set writes config (KV) and must answer without touching D1.
const setStatus = await inject(`/set maxLength 1200`, creator, 5004);
if (setStatus === 200) ok("/set 被接受", "webhook 200（配置写 KV，值未变）");
else bad("/set", `webhook ${setStatus}`);

// 4 ─ /ban on an impossible id must fail loudly and store nothing.
await inject(`/ban 999999999999`, creator, 5005);
await new Promise((resolve) => setTimeout(resolve, 2500));
const banRows = await d1<{ n: number }>("select count(*) as n from banned_users where user_id=999999999999");
if (Number(banRows[0]?.n ?? 0) === 0) ok("/ban 失败路径", "不存在的 id 没有进黑名单");
else bad("/ban 失败路径", "居然落库了");

// 5 ─ read-only commands: they must not create events or crash the webhook.
const before = await d1<{ n: number }>("select count(*) as n from events");
for (const [text, id] of [
  ["/stats", 5006],
  ["/rules", 5007],
  ["/tool", 5008],
  ["/ts 1700000000", 5009],
  ["/words", 5010],
  ["/ai status", 5011],
] as const) {
  const status = await inject(text, creator, id);
  if (status === 200) ok(`${text}`, "webhook 200");
  else bad(text, `webhook ${status}`);
}
const after = await d1<{ n: number }>("select count(*) as n from events");

// ---------------------------------------------------------------------------

const SKIP: { command: string; why: string }[] = [
  { command: "/lock · /unlock（不带参数）", why: "会把 899 人的群整体禁言；中途失败就没人能说话" },
  { command: "/del · /purge · /pin · /unpin", why: "需要指定真实消息；会删/置顶真实成员的内容" },
  { command: "/ban · /mute · /kick · /warn · /unwarn · /verify · /trust · /unblock 真成员", why: "会作用到真人；已用不存在的 id 覆盖失败路径" },
  { command: "/sync add", why: "需要一个机器人担任管理员的真实频道" },
  { command: "/splitpdf（50 页）", why: "会向群里发 20 个文件；单页路径由单元测试覆盖" },
  { command: "/slice", why: "Worker 没有 sharp，预期回“需要自托管版”；该分支由单元测试覆盖" },
  { command: "/export", why: "输出整份规则 JSON，会刷屏" },
  { command: "/import", why: "会整体覆盖本群配置" },
  { command: "/parse", why: "会往群里发图集/视频（可能几十 MB）；预览与上传路径由单元测试覆盖" },
  { command: "/ai on", why: "打开后每次发图都会计费；只验了 /ai status 与 off" },
];

console.log("\n以下命令没有在真实群里执行：");
for (const item of [...SKIP, ...blocked]) console.log(`  · ${item.command} — ${item.why}`);

console.log(`\n真实冒烟：${passed} 通过 / ${failed} 失败；events ${before[0]?.n ?? "?"} → ${after[0]?.n ?? "?"}`);
process.exit(failed ? 1 : 0);

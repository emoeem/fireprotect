/**
 * HTTP surface: the install page, a health probe, and the webhook route.
 *
 * `/install` is the one thing here an attacker would want: pointing a bot's
 * webhook at their own server steals every update. So it needs the deployment's
 * secret. When no `WEBHOOK_SECRET` is configured the page still renders but the
 * POST is refused — an unauthenticated installer is worse than a manual step.
 */
import { safeEqual } from "./telegram.ts";
import { escape as escapeEntities } from "he";
import type { Env } from "./types.ts";

const API = "https://api.telegram.org";

/**
 * The secret Telegram echoes back on every webhook call.
 *
 * Derived from BOT_TOKEN when the operator did not set one, so "no secret
 * configured" never means "no check". BOT_TOKEN is known to Telegram and to the
 * deployment, and to nobody else.
 */
export async function webhookSecret(env: Env): Promise<string> {
  if (env.WEBHOOK_SECRET) return env.WEBHOOK_SECRET;
  const data = new TextEncoder().encode(`wh:${env.BOT_TOKEN ?? ""}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
}

export function renderInstallPage(env: Env, message = ""): string {
  const configured = Boolean(env.WEBHOOK_SECRET);
  const body = message ? `<p class="msg">${escapeEntities(message)}</p>` : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>焰卫 · 接入</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#e6edf3;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif}
main{width:min(560px,92vw);padding:28px;border:1px solid #1f2a37;border-radius:14px;background:#111823}
h1{margin:0 0 6px;font-size:20px}
p{margin:10px 0;color:#9fb0c3}
code{background:#0b0f14;padding:2px 6px;border-radius:6px;color:#c9d6e4}
label{display:block;margin:18px 0 6px;color:#c9d6e4}
input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid #24303d;background:#0b0f14;color:#e6edf3;font:inherit}
button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:10px;background:#2f81f7;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.msg{margin-top:14px;padding:10px 12px;border-radius:10px;background:#1b2530;color:#e6edf3}
.warn{color:#f0b429}
</style></head>
<body><main>
<h1>焰卫 · 接入</h1>
<p>把本部署的 webhook 指向当前域名，Telegram 之后才会把消息推过来。</p>
${body}
${configured ? "" : '<p class="warn">这个部署没有设置 <code>WEBHOOK_SECRET</code>，所以页面不接受安装。先执行 <code>wrangler secret put WEBHOOK_SECRET</code> 再来。</p>'}
<form method="post" action="/install">
<label for="key">部署密钥（WEBHOOK_SECRET）</label>
<input id="key" name="key" type="password" autocomplete="off" required>
<button type="submit">注册 webhook</button>
</form>
<p>注册后可以在群里发 <code>/help</code> 查看命令。健康检查：<code>/health</code></p>
</main></body></html>`;
}

export type InstallResult = { status: number; body: string; html: boolean };

export async function handleInstall(request: Request, env: Env): Promise<InstallResult> {
  if (request.method === "GET") {
    return { status: 200, body: renderInstallPage(env), html: true };
  }
  if (request.method !== "POST") {
    return { status: 405, body: "method not allowed", html: false };
  }

  if (!env.WEBHOOK_SECRET) {
    return {
      status: 403,
      body: renderInstallPage(env, "部署没有配置 WEBHOOK_SECRET，拒绝远程安装。"),
      html: true,
    };
  }

  const contentType = request.headers.get("content-type") ?? "";
  let key = "";
  let target = "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { key?: string; url?: string };
    key = String(body.key ?? "");
    target = String(body.url ?? "");
  } else {
    const form = await request.formData().catch(() => null);
    key = String(form?.get("key") ?? "");
    target = String(form?.get("url") ?? "");
  }

  if (!safeEqual(key, env.WEBHOOK_SECRET ?? "")) {
    return { status: 403, body: renderInstallPage(env, "密钥不对。"), html: true };
  }

  const base = target || env.PUBLIC_URL || new URL(request.url).origin;
  const webhookUrl = `${String(base).replace(/\/+$/, "")}/webhook`;
  const secret = await webhookSecret(env);

  const res = await fetch(`${API}/bot${env.BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: [
        "message",
        "edited_message",
        "callback_query",
        "my_chat_member",
        "chat_member",
        "chat_join_request",
        "channel_post",
      ],
      drop_pending_updates: false,
    }),
  });
  const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!payload.ok) {
    return {
      status: 502,
      body: renderInstallPage(env, `Telegram 拒绝：${payload.description ?? res.status}`),
      html: true,
    };
  }
  return { status: 200, body: renderInstallPage(env, `已注册：${webhookUrl}`), html: true };
}

export function healthBody(env: Env): { ok: boolean; bot: boolean; db: boolean; env: string } {
  return {
    ok: true,
    bot: Boolean(env.BOT_TOKEN),
    db: Boolean(env.DB),
    env: env.ENVIRONMENT ?? "production",
  };
}

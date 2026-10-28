import type { Ctx } from "./context.ts";
import { escapeHtml, safeEqual } from "./telegram.ts";
import { commandList } from "./router.ts";
import type { Env } from "./types.ts";

/**
 * Webhook installation.
 *
 * The template performed setWebhook on a GET with the secret in the query
 * string, so a link preview or a bot crawling the URL silently re-pointed the
 * webhook. GET now only renders a form; the mutation is a POST whose body
 * carries the key.
 */
export function installPage(env: Env, message?: string): string {
  const hasSecret = Boolean(env.WEBHOOK_SECRET);
  const hint = hasSecret
    ? "输入你在 Cloudflare 里设置的 WEBHOOK_SECRET。"
    : "没有设置 WEBHOOK_SECRET：将用 BOT_TOKEN 派生 webhook 密钥，只点下面的按钮即可。";
  const banner = message ? `<p class="ok">${escapeHtml(message)}</p>` : "";
  return html(
    "接入 Telegram",
    `<h1>接入 Telegram</h1>
<p class="muted">这一步把 Telegram 的消息指到本服务。</p>
${banner}
<form method="post" action="/install">
  ${hasSecret ? `<label>WEBHOOK_SECRET<input name="key" type="password" autocomplete="off" required></label>` : ""}
  <button type="submit">接上 Telegram</button>
</form>
<p class="muted">${escapeHtml(hint)}</p>
<p class="muted">接好之后：把我拉进群 → 设为管理员 → 打开「删除消息」「封禁用户」「置顶消息」→ 到 @BotFather 发送 /setprivacy 选 Disable。</p>`,
  );
}

export function installResultPage(ok: boolean, detail: string): string {
  return html(
    ok ? "已经接上" : "没接上",
    `<h1>${ok ? "已经接上 Telegram" : "没接上"}</h1><p class="${ok ? "ok" : "bad"}">${escapeHtml(detail)}</p>
${ok ? '<p class="muted">现在把我拉进群，并设为管理员。</p>' : '<p class="muted">检查 BOT_TOKEN 是否正确，然后刷新本页重试。</p>'}`,
  );
}

export function statusPage(env: Env): string {
  return html(
    "焰卫在线",
    `<h1>焰卫在线</h1>
<p class="muted">服务已经起来了。${env.BOT_TOKEN ? "BOT_TOKEN 已配置。" : "还缺 BOT_TOKEN。"}</p>
<p><a href="/install">去接入 Telegram →</a></p>`,
  );
}

/** Render the page the browser sees when the webhook is (re)pointed. */
export async function performInstall(ctx: Ctx, key: string, origin: string): Promise<{ ok: boolean; detail: string }> {
  const env = ctx.env;
  if (!env.BOT_TOKEN) return { ok: false, detail: "还没有 BOT_TOKEN：先到环境变量里添加，再回来。" };

  const expected = env.WEBHOOK_SECRET || env.BOT_TOKEN;
  if (env.WEBHOOK_SECRET && !safeEqual(key, env.WEBHOOK_SECRET)) {
    return { ok: false, detail: "钥匙不对。" };
  }
  if (!expected) return { ok: false, detail: "缺少密钥，无法安全地接收更新。" };

  const me = await ctx.tg.call<{ username?: string }>("getMe", {});
  if (!me.ok) return { ok: false, detail: `BOT_TOKEN 无效：${me.error}` };

  const hook = await ctx.tg.call("setWebhook", {
    url: `${origin.replace(/\/$/, "")}/`,
    secret_token: expected,
    allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member"],
    // Never drop queued updates: re-running /install used to silently discard
    // everything sent while the deployment was being fixed.
    drop_pending_updates: false,
    max_connections: 40,
  });
  if (!hook.ok) return { ok: false, detail: `setWebhook 失败：${hook.error}` };

  const commands = await ctx.tg.call("setMyCommands", { commands: commandList() });
  const who = me.result.username ? `@${me.result.username}` : "你的机器人";
  const tail = commands.ok ? "命令菜单也写好了。" : `命令菜单没写成（${commands.ok ? "" : commands.error}），不影响收消息。`;
  return { ok: true, detail: `${who} 会把消息送到这个地址。${tail}` };
}

function html(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#14110e;color:#f3ece3;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.6}
  main{max-width:34rem;margin:0 auto;padding:3rem 1.25rem}
  h1{font-size:1.6rem;font-weight:560;margin:0 0 1rem}
  .muted{color:#b3a496;font-size:.92rem}
  .ok{color:#8fd6a3}.bad{color:#f0917f}
  form{margin:1.5rem 0}
  label{display:block;font-size:.85rem;color:#b3a496;margin-bottom:1rem}
  input{display:block;width:100%;margin-top:.4rem;padding:.6rem .7rem;border-radius:.5rem;border:1px solid #3a322a;background:#1d1814;color:inherit;font:inherit}
  button{padding:.65rem 1.1rem;border-radius:.5rem;border:0;background:#e8c9a0;color:#231a12;font-weight:600;cursor:pointer}
  a{color:#e8c9a0}
</style>
<main>${body}</main>
`;
}

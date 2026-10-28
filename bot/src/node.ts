/**
 * Local polling runner.
 *
 * Same core as the Worker, no domain and no webhook: `getUpdates` with a long
 * timeout, plus a one-minute sweep that stands in for the cron trigger.
 */
import { handleUpdate } from "./bot.ts";
import { BOT_COMMANDS, menuButton } from "./menu.ts";
import { createRuntime, ensureSchema } from "./context.ts";
import { openSqlite } from "./db/node-sqlite.ts";
import { fileStore } from "./store-file.ts";
import { sweepExpired } from "./handlers/verify.ts";
import { runSync } from "./sync.ts";
import { sliceImage } from "./tools/slice.node.ts";
import { fetchWithYtdlp } from "./parse/ytdlp.node.ts";
import { ocrImage } from "./tools/ocr.node.ts";
import { nodeRssDeps } from "./rss.node.ts";
import { pollFeeds } from "./rss.ts";
import { runParseQueue } from "./parse/service.ts";
import { notifyOperators } from "./notify.ts";
import { runRetention, runScheduled } from "./scheduler.ts";
import { Telegram } from "./telegram.ts";
import type { Env, TgUpdate } from "./types.ts";

const token = process.env.BOT_TOKEN ?? "";
if (!token) {
  console.error("BOT_TOKEN 未设置。用法：BOT_TOKEN=123:abc node --experimental-strip-types src/node.ts");
  process.exit(1);
}

const env: Env = {
  BOT_TOKEN: token,
  ADMIN_IDS: process.env.ADMIN_IDS,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
  LOG_CHAT_ID: process.env.LOG_CHAT_ID,
  FEDERATION_URL: process.env.FEDERATION_URL,
  FEDERATION_TOKEN: process.env.FEDERATION_TOKEN,
  CAS_KEY: process.env.CAS_KEY,
  PUBLIC_URL: process.env.PUBLIC_URL,
  ENVIRONMENT: process.env.ENVIRONMENT ?? "local",
};

const sqlite = openSqlite(process.env.BOT_DB ?? "bot.db");
await ensureSchema(sqlite);

const runtime = createRuntime(env, {
  sqlite,
  store: fileStore(process.env.BOT_STORE ?? ".bot-store"),
  api: new Telegram(token),
  // The only native dependency in the project; the Worker never sees it.
  sliceImage: (bytes, height) => sliceImage(bytes, height),
  // yt-dlp + sharp: the reason a self-hosted deployment can answer `/parse`
  // with the actual video while the Worker can only send the cover.
  parseDownloader: (url) => fetchWithYtdlp(url),
  // tesseract is a subprocess, so `/ocr` only exists on a self-hosted node.
  ocr: (bytes) => ocrImage(bytes),
  // rss-parser assumes Node globals; the Worker has neither it nor a scheduler.
  rssParse: nodeRssDeps().parse,
});

// Commands are registered once per start; it is idempotent and makes the
// Telegram UI show the right command list.
await runtime.api.call("setMyCommands", { commands: BOT_COMMANDS });

// The console also hangs off the menu button; without a public origin there is
// no absolute URL to point at, and Telegram rejects relative ones.
const button = menuButton(process.env.PUBLIC_URL);
if (button) {
  const set = await runtime.api.call("setChatMenuButton", { menu_button: button });
  if (!set.ok) console.error(`setChatMenuButton 失败：${set.error}`);
}

const me = await runtime.api.call<{ username?: string; id: number }>("getMe");
if (me.ok) console.log(`焰卫已上线：@${me.result.username} (${me.result.id}) · db=${process.env.BOT_DB ?? "bot.db"}`);
else console.error(`getMe 失败：${me.error}`);

/**
 * Telegram refuses `getUpdates` while a webhook is registered, so long polling
 * needs it removed first. Doing that automatically would silently take a
 * deployed Worker offline — a local `npm run dev` must not break production, so
 * the removal is explicit.
 */
const hook = await runtime.api.call<{ url?: string }>("getWebhookInfo");
if (hook.ok && hook.result.url) {
  if (process.env.DROP_WEBHOOK === "1") {
    await runtime.api.call("deleteWebhook", { drop_pending_updates: false });
    console.log(`已移除 webhook（原 ${hook.result.url}）`);
  } else {
    console.error(
      `已存在 webhook：${hook.result.url}\n` +
        "  · 本机会收到 409 Conflict，收不到任何更新；\n" +
        "  · 确认要改用长轮询，加 DROP_WEBHOOK=1 再启动（会摘掉线上 webhook）。",
    );
    process.exit(1);
  }
}

let running = true;
const stop = () => {
  running = false;
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const sweeper = setInterval(() => {
  runScheduled(runtime).catch((err) => {
    console.log(`scheduler: ${err instanceof Error ? err.message : String(err)}`);
    void notifyOperators(runtime, "cron-scheduled", `定时消息任务失败：${err instanceof Error ? err.message : String(err)}`);
  });
  sweepExpired(runtime)
    .then((result) => {
      if (result.expired) console.log(`sweep: expired ${result.expired}/${result.checked}`);
    })
    .catch((err) => {
      console.log(`sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      void notifyOperators(runtime, "cron-sweep", `验证过期清理失败：${err instanceof Error ? err.message : String(err)}`);
    });
  runSync(runtime)
    .then((result) => {
      if (result.copied) console.log(`sync: copied ${result.copied}`);
    })
    .catch((err) => {
      console.log(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
      void notifyOperators(runtime, "cron-sync", `频道同步失败：${err instanceof Error ? err.message : String(err)}`);
    });
  // Feeds are polled on the same one-minute tick, in a small batch. There is no
  // per-feed interval column: `rssPollable` orders by last attempt and takes
  // `limit`, and every attempt (success or failure) rewrites that timestamp. So
  // a feed is polled roughly every ceil(feeds/limit) minutes, and a chat with
  // one feed is polled every minute while a chat with twenty is polled every
  // seven. Cheaper and fairer than a fixed interval, and one fewer column.
  pollFeeds(runtime, { parse: runtime.rssParse! }, 3)
    .then((result) => {
      if (result.delivered || result.removed) {
        console.log(`rss: ${result.delivered} new / ${result.checked} checked / ${result.removed} unsubscribed`);
      }
    })
    .catch((err) => console.log(`rss poll failed: ${err instanceof Error ? err.message : String(err)}`));
  // Jobs a crashed Worker request left pending are retried here: a Worker
  // cannot do better on a second attempt, a node with yt-dlp can.
  runParseQueue(runtime)
    .then((result) => {
      if (result.checked) console.log(`parse queue: ${result.done}/${result.checked} done`);
    })
    .catch((err) => console.log(`parse queue failed: ${err instanceof Error ? err.message : String(err)}`));
  runRetention(runtime).catch((err) => {
    console.log(`retention failed: ${err instanceof Error ? err.message : String(err)}`);
    void notifyOperators(runtime, "cron-retention", `数据保留清理失败：${err instanceof Error ? err.message : String(err)}`);
  });
}, 60_000);

let offset = 0;
while (running) {
  const res = await runtime.api.call<TgUpdate[]>("getUpdates", {
    offset,
    timeout: 30,
    allowed_updates: [
      "message",
      "edited_message",
      "callback_query",
      "my_chat_member",
      "chat_member",
      "chat_join_request",
      "channel_post",
    ],
  });
  if (!res.ok) {
    console.log(`getUpdates: ${res.error}（2 秒后重试）`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    continue;
  }
  for (const update of res.result) {
    if (typeof update.update_id === "number") offset = update.update_id + 1;
    await handleUpdate(runtime, update);
  }
}

clearInterval(sweeper);
sqlite.close?.();
console.log("已停止。");

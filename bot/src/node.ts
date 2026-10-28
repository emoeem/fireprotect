/**
 * Local polling runner.
 *
 * Same core as the Worker, no domain and no webhook: `getUpdates` with a long
 * timeout, plus a one-minute sweep that stands in for the cron trigger.
 */
import { handleUpdate } from "./bot.ts";
import { createRuntime, ensureSchema } from "./context.ts";
import { openSqlite } from "./db/node-sqlite.ts";
import { fileStore } from "./store-file.ts";
import { sweepExpired } from "./handlers/verify.ts";
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
});

// Commands are registered once per start; it is idempotent and makes the
// Telegram UI show the right command list.
await runtime.api.call("setMyCommands", {
  commands: [
    { command: "help", description: "命令列表" },
    { command: "rules", description: "本群规则" },
    { command: "id", description: "看自己的数字 ID" },
    { command: "notes", description: "本群保存的说明" },
    { command: "stats", description: "近 7 天处置统计" },
    { command: "lock", description: "全群禁言 / 锁类型" },
    { command: "unlock", description: "解除禁言 / 解锁类型" },
    { command: "nightmode", description: "夜间模式" },
    { command: "config", description: "当前配置（管理员）" },
  ],
});

const me = await runtime.api.call<{ username?: string; id: number }>("getMe");
if (me.ok) console.log(`焰卫已上线：@${me.result.username} (${me.result.id}) · db=${process.env.BOT_DB ?? "bot.db"}`);
else console.error(`getMe 失败：${me.error}`);

// Drop any webhook: Telegram refuses `getUpdates` while one is registered.
await runtime.api.call("deleteWebhook", { drop_pending_updates: false });

let running = true;
const stop = () => {
  running = false;
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const sweeper = setInterval(() => {
  sweepExpired(runtime)
    .then((result) => {
      if (result.expired) console.log(`sweep: expired ${result.expired}/${result.checked}`);
    })
    .catch((err) => console.log(`sweep failed: ${err instanceof Error ? err.message : String(err)}`));
}, 60_000);

let offset = 0;
while (running) {
  const res = await runtime.api.call<TgUpdate[]>("getUpdates", {
    offset,
    timeout: 30,
    allowed_updates: ["message", "callback_query", "my_chat_member", "chat_member", "chat_join_request"],
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

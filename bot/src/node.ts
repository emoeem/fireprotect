/**
 * Local runner: same core, long polling instead of a webhook.
 *
 * Useful before a domain exists, behind a firewall, or on a laptop. It shares
 * every handler with the Worker — only the transport differs.
 *
 *   BOT_TOKEN=123:abc node --experimental-strip-types src/node.ts
 *
 * Env: BOT_TOKEN (required), ADMIN_IDS, LOG_CHAT_ID, BOT_DATA_DIR.
 */
import { createContext } from "./context.ts";
import { handleUpdate } from "./router.ts";
import { fileStore } from "./store-file.ts";
import { Telegram } from "./telegram.ts";
import type { Env, TgUpdate } from "./types.ts";

type GetUpdates = { ok: true; result: TgUpdate[] } | { ok: false; error: string; code: number };

async function main(): Promise<void> {
  const env: Env = {
    BOT_TOKEN: (process.env.BOT_TOKEN ?? "").trim(),
    ADMIN_IDS: process.env.ADMIN_IDS,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    LOG_CHAT_ID: process.env.LOG_CHAT_ID,
  };

  if (!env.BOT_TOKEN) {
    console.error("缺少 BOT_TOKEN。用法：BOT_TOKEN=123:abc node --experimental-strip-types bot/src/node.ts");
    process.exitCode = 1;
    return;
  }

  const dataDir = process.env.BOT_DATA_DIR ?? ".bot-data";
  // Generous per-call timeout: getUpdates is supposed to block for up to 25s.
  const tg = new Telegram(env.BOT_TOKEN, undefined, 40_000);
  const ctx = createContext(env, { tg, store: fileStore(dataDir) });

  const me = await tg.call<{ username?: string; id: number }>("getMe", {});
  if (!me.ok) {
    console.error(`BOT_TOKEN 无效：${me.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`焰卫已上线：@${me.result.username ?? me.result.id}（长轮询，数据目录 ${dataDir}）`);

  // A webhook left over from a previous setup makes getUpdates fail with 409.
  const cleared = await tg.call("deleteWebhook", { drop_pending_updates: false });
  if (!cleared.ok) console.log(`提示：deleteWebhook 失败（${cleared.error}），如果 getUpdates 报 409 请先手动清除 webhook。`);

  let offset = 0;
  let stopping = false;
  const stop = () => {
    stopping = true;
    console.log("\n收到停止信号，处理完当前更新后退出。");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    const res = (await tg.call<TgUpdate[]>("getUpdates", {
      offset,
      timeout: 25,
      allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member"],
    })) as GetUpdates;

    if (!res.ok) {
      // 409 means another consumer (webhook or a second poller) owns the bot.
      console.error(`getUpdates 失败：${res.error}（${res.code}）`);
      await sleep(res.code === 409 ? 10_000 : 3_000);
      continue;
    }

    for (const update of res.result) {
      if (typeof update.update_id === "number") offset = update.update_id + 1;
      try {
        await handleUpdate(ctx, update);
      } catch (err) {
        // One bad update must not kill the loop.
        console.error("处理更新失败：", err instanceof Error ? err.message : err);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();

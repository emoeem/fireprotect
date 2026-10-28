/**
 * Live Bot API check.
 *
 * Everything the mocked tests cannot prove: that Telegram accepts our payloads,
 * that the token works, and — when `TEST_CHAT_ID` points at a group the bot is
 * in — that it really has the permissions the product assumes.
 *
 * Usage:
 *   BOT_TOKEN=... npm run live
 *   BOT_TOKEN=... TEST_CHAT_ID=-1001234567890 npm run live
 *
 * It writes three things to a real group at most: one command list, one probe
 * message, and the deletion of that message. Nothing else is touched.
 */
import { Telegram } from "../src/telegram.ts";

const token = process.env.BOT_TOKEN ?? "";
if (!token) {
  console.error("BOT_TOKEN 未设置");
  process.exit(1);
}

const api = new Telegram(token, undefined, { timeoutMs: 15_000, maxAttempts: 2 });
const ok = (label: string, detail = "") => console.log(`✔ ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label: string, detail: string) => console.log(`✖ ${label} — ${detail}`);

const me = await api.call<{ id: number; username?: string; can_join_groups?: boolean; can_read_all_group_messages?: boolean }>(
  "getMe",
);
if (!me.ok) {
  bad("getMe", me.error);
  process.exit(1);
}
ok("getMe", `@${me.result.username} (${me.result.id})`);

// `can_read_all_group_messages` false means privacy mode is ON and the bot will
// not see ordinary group messages — the single most common setup mistake.
if (me.result.can_read_all_group_messages === false) {
  bad("privacy mode", "仍是开启状态，去 @BotFather /setprivacy → Disable，否则看不见广告");
} else {
  ok("privacy mode", "已关闭（能看到群里的普通消息）");
}
if (me.result.can_join_groups === false) bad("can_join_groups", "这个机器人被禁止加入群组");

const commands = [
  { command: "help", description: "命令列表" },
  { command: "rules", description: "本群规则" },
  { command: "id", description: "看自己的数字 ID" },
  { command: "stats", description: "近 7 天处置统计" },
  { command: "lock", description: "全群禁言 / 锁类型" },
  { command: "unlock", description: "解除禁言 / 解锁类型" },
  { command: "nightmode", description: "夜间模式" },
  { command: "config", description: "当前配置（管理员）" },
];
const set = await api.call("setMyCommands", { commands });
if (set.ok) ok("setMyCommands", `${commands.length} 条`);
else bad("setMyCommands", set.error);

const got = await api.call<{ command: string }[]>("getMyCommands");
if (got.ok) ok("getMyCommands", got.result.map((entry) => "/" + entry.command).join(" "));
else bad("getMyCommands", got.error);

const webhook = await api.call<{ url?: string; pending_update_count?: number; last_error_message?: string }>(
  "getWebhookInfo",
);
if (webhook.ok) {
  const info = webhook.result;
  ok("getWebhookInfo", info.url ? `${info.url}（待处理 ${info.pending_update_count ?? 0}）` : "未设置 webhook（长轮询模式）");
  if (info.last_error_message) bad("webhook 上次错误", info.last_error_message);
}

const chatId = process.env.TEST_CHAT_ID ?? "";
if (!chatId) {
  console.log("\n· 未提供 TEST_CHAT_ID，群内权限检查跳过（把机器人拉进一个测试群后重跑）");
  process.exit(0);
}

const chat = await api.call<{ id: number; title?: string; type: string }>("getChat", { chat_id: chatId });
if (!chat.ok) {
  bad("getChat", chat.error);
  process.exit(1);
}
ok("getChat", `${chat.result.title ?? chat.result.id} (${chat.result.type})`);

const member = await api.call<Record<string, unknown>>("getChatMember", { chat_id: chatId, user_id: me.result.id });
if (!member.ok) {
  bad("getChatMember", member.error);
} else {
  const status = String(member.result.status);
  const rights = [
    ["can_delete_messages", "删除消息"],
    ["can_restrict_members", "封禁用户"],
    ["can_pin_messages", "置顶消息"],
    ["can_change_info", "修改群信息"],
  ] as const;
  if (status !== "administrator" && status !== "creator") {
    bad("机器人身份", `当前是 ${status}，不是管理员 —— 删除和封禁都会失败`);
  } else {
    ok("机器人身份", status);
    for (const [key, label] of rights) {
      const value = member.result[key] === true;
      (value ? ok : bad)(`权限 ${label}`, value ? "已授予" : "缺失");
    }
  }
}

// Prove the write path end to end: send, then delete. A bot with only read
// rights fails here, which is exactly what we want to see before shipping.
const probe = await api.call<{ message_id: number }>("sendMessage", {
  chat_id: chatId,
  text: "焰卫自检：这条消息马上会被删除。",
  disable_notification: true,
});
if (!probe.ok) {
  bad("sendMessage", probe.error);
} else {
  ok("sendMessage", `message_id=${probe.result.message_id}`);
  const removed = await api.call("deleteMessage", { chat_id: chatId, message_id: probe.result.message_id });
  if (removed.ok) ok("deleteMessage", "探针消息已删除");
  else bad("deleteMessage", removed.error);
}

console.log("\n完成。webhook 注册见 /install，长轮询见 npm run dev。");

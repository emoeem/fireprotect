/**
 * In-Telegram control panel.
 *
 * A group admin should be able to run the whole product from a private chat
 * with the bot — that is how the mature bots in this space work, and it is the
 * only UI that needs no hosting, no password and no browser.
 *
 * Every screen is a pure function of (chat config, chat stats) → (text, buttons),
 * and every button is `p.<chatId>.<screen>[.<arg>]`, so a stale button from an
 * hour ago still lands on a screen that renders current state instead of
 * erroring. Toggles re-render immediately; anything that needs free text
 * delegates to the command that already exists.
 */
import type { Runtime } from "./context.ts";
import { LOCK_KINDS, describeConfig, lockLabel } from "./rules.ts";
import { banCount, chatStats, healthAll, listChats, recentEvents, scheduleList } from "./db/repo.ts";
import { say } from "./moderation.ts";
import { escapeHtml } from "./telegram.ts";
import { localClock } from "./nightmode.ts";
import type { TgCallbackQuery } from "./types.ts";

const PREFIX = "p";

export function panelData(chatId: number, screen: string, arg = ""): string {
  return [PREFIX, String(chatId), screen, arg].filter((part) => part !== "").join(".");
}

export type Screen = { text: string; markup: unknown };

const btn = (text: string, data: string) => ({ text, callback_data: data });
const grid = (...rows: ReturnType<typeof btn>[][]) => ({ inline_keyboard: rows });

export async function renderScreen(rt: Runtime, chatId: number, screen: string): Promise<Screen> {
  const config = await rt.configFor(chatId);
  const back = btn("« 返回", panelData(chatId, "chat"));

  switch (screen) {
    case "main":
      return renderMain(rt);
    case "chat":
      return {
        text: [`<b>${escapeHtml(chatId)}</b>`, ...describeConfig(config)].join("\n"),
        markup: grid(
          [btn(`${config.enabled ? "🟢" : "⚪️"} 本群：${config.enabled ? "运行中" : "已停用"}`, panelData(chatId, "set", "enabled")), btn("🎉 欢迎语", panelData(chatId, "welcome"))],
          [btn(`🤖 进群验证：${config.captcha ? "开" : "关"}`, panelData(chatId, "captcha")), btn("⚖️ 惩罚阶梯", panelData(chatId, "punish"))],
          [btn(`🚫 内容拦截（${config.locks.length}）`, panelData(chatId, "locks")), btn("📅 定时消息", panelData(chatId, "sched"))],
          [btn(`🌙 夜间：${config.nightMode ? `${config.nightStart}-${config.nightEnd}` : "关"}`, panelData(chatId, "night")), btn("🔤 关键词", panelData(chatId, "keywords"))],
          [btn("📊 统计", panelData(chatId, "stats")), btn("🖤 黑名单", panelData(chatId, "bans"))],
          [btn("🔗 邀请链接", panelData(chatId, "invite")), btn("📤 导出规则", panelData(chatId, "export"))],
          [btn("🔄 切换群", panelData(chatId, "main"))],
        ),
      };
    case "captcha":
      return {
        text: [
          "<b>🤖 进群验证</b>",
          `状态：${config.captcha ? "开" : "关"}`,
          `方式：${{ button: "按钮", math: "算术（4 个选项）", question: "问答题" }[config.captchaMode]}`,
          `时限：${Math.round(config.captchaTimeout / 60)} 分钟，超时${config.captchaKick ? "移出群" : "保持禁言"}`,
          "",
          "问答题的答案用 /set captchaAnswer 设置，题目用 /set captchaQuestion。",
        ].join("\n"),
        markup: grid(
          [btn(config.captcha ? "关闭验证" : "打开验证", panelData(chatId, "set", "captcha"))],
          [
            btn(`按钮${config.captchaMode === "button" ? " ✓" : ""}`, panelData(chatId, "mode", "button")),
            btn(`算术${config.captchaMode === "math" ? " ✓" : ""}`, panelData(chatId, "mode", "math")),
            btn(`问答${config.captchaMode === "question" ? " ✓" : ""}`, panelData(chatId, "mode", "question")),
          ],
          [btn(`超时${config.captchaKick ? "移出" : "只禁言"}（点击切换）`, panelData(chatId, "set", "captchaKick"))],
          [back],
        ),
      };
    case "welcome":
      return {
        text: [
          "<b>🎉 欢迎与告别</b>",
          `欢迎：${config.welcome ? "开" : "关"}`,
          `告别：${config.farewell ? "开" : "关"}`,
          `删除「X 加入」系统消息：${config.deleteJoinMessages ? "是" : "否"}`,
          "",
          "正文用 /set welcomeText 改，可用 {name} {chat} {username} {id}。",
        ].join("\n"),
        markup: grid(
          [btn(config.welcome ? "关闭欢迎" : "打开欢迎", panelData(chatId, "set", "welcome")), btn(config.farewell ? "关闭告别" : "打开告别", panelData(chatId, "set", "farewell"))],
          [btn(config.deleteJoinMessages ? "保留系统消息" : "删除系统消息", panelData(chatId, "set", "deleteJoinMessages"))],
          [back],
        ),
      };
    case "locks": {
      const rows = LOCK_KINDS.map((kind) => btn(`${config.locks.includes(kind) ? "✅" : "⬜"} ${lockLabel(kind)}`, panelData(chatId, "lock", kind)));
      const paired: ReturnType<typeof btn>[][] = [];
      for (let i = 0; i < rows.length; i += 3) paired.push(rows.slice(i, i + 3));
      return {
        text: [
          "<b>🚫 内容拦截</b>",
          `已拦截：${config.locks.length ? config.locks.map(lockLabel).join("、") : "无"}`,
          `超长：${config.maxLength > 0 ? `${config.maxLength} 字` : "关"}｜刷屏：${config.floodLimit > 0 ? `${config.floodWindow}s/${config.floodLimit}条` : "关"}`,
          "",
          "点一下切换。改字数用 /set maxLength，改刷屏用 /set floodLimit。",
        ].join("\n"),
        markup: grid(...paired, [back]),
      };
    }
    case "punish": {
      const ladder = config.strikes.length
        ? config.strikes.map((strike) => `${strike.at} 次→${strike.action === "mute" ? `禁言${strike.minutes}分` : strike.action === "ban" ? "封禁" : strike.action === "kick" ? "移出" : "记录"}`).join("\n")
        : "已关闭（按单次处置）";
      return {
        text: [
          "<b>⚖️ 惩罚阶梯</b>",
          ladder,
          "",
          `单次处置：${config.spamAction}（mute 时长 ${config.muteMinutes} 分）`,
          `新人限制：${config.newbieHours > 0 ? `入群 ${config.newbieHours} 小时内禁链接/提及` : "关"}`,
          `进群限速：${config.joinRateMax > 0 ? `${config.joinRateWindow}s 内 ${config.joinRateMax} 人` : "关"}`,
        ].join("\n"),
        markup: grid(
          [btn(config.strikes.length ? "关闭阶梯" : "开启阶梯（1→1h / 2→24h / 3→封禁）", panelData(chatId, "set", "strikes"))],
          [
            btn(`单次:${config.spamAction === "delete" ? "删✓" : "删"}`, panelData(chatId, "action", "delete")),
            btn(`单次:${config.spamAction === "mute" ? "禁言✓" : "禁言"}`, panelData(chatId, "action", "mute")),
            btn(`单次:${config.spamAction === "ban" ? "封禁✓" : "封禁"}`, panelData(chatId, "action", "ban")),
          ],
          [back],
        ),
      };
    }
    case "night":
      return {
        text: [
          "<b>🌙 夜间模式</b>",
          `状态：${config.nightMode ? "开" : "关"}`,
          `时段：${config.nightStart} – ${config.nightEnd}（时区偏移 ${rt.tzOffset} 分钟）`,
          "",
          "改时段：/nightmode 23:00-07:00",
        ].join("\n"),
        markup: grid([btn(config.nightMode ? "关闭" : "打开", panelData(chatId, "set", "nightMode"))], [back]),
      };
    case "keywords": {
      const list = config.keywords.slice(0, 20).map((word) => `· ${escapeHtml(word)}`).join("\n") || "（空）";
      return {
        text: [`<b>🔤 关键词（${config.keywords.length}）</b>`, list, "", "增删：/keywords add 词1,词2 ｜ /keywords del 词"].join("\n"),
        markup: grid([back]),
      };
    }
    case "sched": {
      const rows = (await scheduleList(rt.db, chatId)).slice(0, 6);
      const lines = rows.length
        ? rows.map((row) => `#${row.id} ${row.every > 0 ? `每 ${row.every}s` : "一次"} · ${row.enabled ? "启用" : "停用"} · 下次 ${localClock(row.nextAt, rt.tzOffset)} · ${escapeHtml(row.text.slice(0, 24))}`)
        : ["（没有定时消息）"];
      return {
        text: ["<b>📅 定时消息</b>", ...lines, "", "新增：/schedule 3600 文本（秒；0=只发一次）", "删除：/schedule del ID"].join("\n"),
        markup: grid([back]),
      };
    }
    case "stats": {
      const since = rt.now() - 7 * 86_400_000;
      const stats = await chatStats(rt.db, chatId, since);
      const recent = await recentEvents(rt.db, chatId, 5);
      const label: Record<string, string> = { delete: "删除", mute: "禁言", ban: "封禁", kick: "移出", warn: "警告", verify: "验证", join: "进群", leave: "退群", external: "外部" };
      const totals = Object.entries(stats.totals).filter(([, n]) => n > 0).map(([kind, n]) => `${label[kind] ?? kind} ${n}`).join("｜") || "无记录";
      const lines = ["<b>📊 最近 7 天</b>", totals];
      if (recent.length) lines.push("", ...recent.map((row) => `· ${label[row.kind] ?? row.kind} ${row.userId || "-"} ${escapeHtml(row.reason)}`));
      return { text: lines.join("\n"), markup: grid([back]) };
    }
    case "bans": {
      const total = await banCount(rt.db);
      const health = await healthAll(rt.db);
      const sick = health.filter((row) => row.failures > 0).map((row) => `${row.name}×${row.failures}`).join("、") || "全部正常";
      return {
        text: [
          "<b>🖤 共享黑名单</b>",
          `累计 ${total} 人。封禁会自动写入，所有接入的群共享。`,
          `外部依赖：${sick}`,
          "",
          "开关：/set cas on|off ｜ /set federation on|off",
        ].join("\n"),
        markup: grid([back]),
      };
    }
    case "invite": {
      const res = await rt.api.call<{ invite_link?: string }>("createChatInviteLink", {
        chat_id: chatId,
        name: `panel-${Math.floor(rt.now() / 1000)}`,
        member_limit: 1,
      });
      const text = res.ok
        ? `<b>🔗 一次性邀请链接</b>\n${escapeHtml(res.result.invite_link ?? "")}\n仅 1 人可用。`
        : `<b>🔗 邀请链接</b>\n没成功：${escapeHtml(res.error)}`;
      return { text, markup: grid([back]) };
    }
    case "export": {
      const payload = JSON.stringify({ v: 1, chatId, config }, null, 0);
      return {
        text: `<b>📤 导出</b>\n<code>${escapeHtml(payload.slice(0, 3000))}</code>`,
        markup: grid([back]),
      };
    }
    default:
      return renderScreen(rt, chatId, "chat");
  }
}

async function renderMain(rt: Runtime): Promise<Screen> {
  const chats = await listChats(rt.db);
  if (!chats.length) {
    return {
      text: ["<b>焰卫控制台</b>", "还没有任何群。把我拉进群并设为管理员，然后回来。", "", "命令速查：/help"].join("\n"),
      markup: grid([]),
    };
  }
  const rows = chats.slice(0, 8).map((chat) => [btn(`${chat.title || chat.chatId}`, panelData(chat.chatId, "chat"))]);
  return {
    text: ["<b>焰卫控制台</b>", "选一个群开始配置。", `共 ${chats.length} 个群。`].join("\n"),
    markup: grid(...rows),
  };
}

/**
 * Handle one panel callback.
 *
 * Returns true when the payload was ours. Authorisation is checked per press
 * against the *live* admin rights of the chat in the payload — a button is not
 * a capability.
 */
export async function handlePanel(rt: Runtime, query: TgCallbackQuery): Promise<boolean> {
  const data = query.data ?? "";
  if (!data.startsWith(PREFIX + ".")) return false;

  const [, rawChat, screen = "main", arg = ""] = data.split(".");
  const chatId = Number(rawChat);
  if (!Number.isFinite(chatId)) {
    await rt.api.call("answerCallbackQuery", { callback_query_id: query.id, text: "按钮已过期" });
    return true;
  }

  const allowed = await rt.admin.can(chatId, query.from.id, "can_change_info");
  if (!allowed) {
    await rt.api.call("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "你不是这个群的管理员（或没有改信息权限）",
      show_alert: true,
    });
    return true;
  }

  let patch: Record<string, unknown> | null = null;
  switch (screen) {
    case "set": {
      const config = await rt.configFor(chatId);
      if (arg === "strikes") {
        patch = {
          strikes: config.strikes.length
            ? []
            : [
                { at: 1, action: "mute", minutes: 60 },
                { at: 2, action: "mute", minutes: 1440 },
                { at: 3, action: "ban", minutes: 0 },
              ],
        };
      } else if (arg in config) {
        patch = { [arg]: !(config as unknown as Record<string, unknown>)[arg] };
      }
      break;
    }
    case "mode":
      patch = { captcha: true, captchaMode: arg };
      break;
    case "action":
      patch = { spamAction: arg };
      break;
    case "lock": {
      const config = await rt.configFor(chatId);
      const next = new Set(config.locks);
      if (next.has(arg as never)) next.delete(arg as never);
      else next.add(arg as never);
      patch = { locks: [...next] };
      break;
    }
    default:
      break;
  }

  if (patch) {
    const saved = await rt.saveConfig(chatId, patch);
    if (saved.error) {
      await rt.api.call("answerCallbackQuery", { callback_query_id: query.id, text: `没保存：${saved.error}`, show_alert: true });
      return true;
    }
  }

  const view = await renderScreen(rt, chatId, screen === "set" ? screenFor(arg) : sibling(screen));
  await rt.api.call("answerCallbackQuery", { callback_query_id: query.id });
  if (query.message) {
    await rt.api.call("editMessageText", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text: view.text,
      parse_mode: "HTML",
      reply_markup: view.markup,
      disable_web_page_preview: true,
    });
  } else {
    await say(rt, query.from.id, view.text, { html: true, markup: view.markup });
  }
  return true;
}

/** Which screen owns a toggleable field, so a flip re-renders where you were. */
function screenFor(field: string): string {
  if (field.startsWith("captcha")) return "captcha";
  if (field === "welcome" || field === "farewell" || field === "deleteJoinMessages") return "welcome";
  if (field === "nightMode") return "night";
  if (field === "strikes") return "punish";
  if (field === "enabled") return "chat";
  return "chat";
}

/** Which screen a mutating toggle should re-render. */
function sibling(screen: string): string {
  switch (screen) {
    case "mode":
      return "captcha";
    case "lock":
      return "locks";
    case "action":
      return "punish";
    default:
      // `set` has no single home; re-render the most specific one it touched.
      return "chat";
  }
}

export async function sendPanel(rt: Runtime, userId: number, chatId?: number): Promise<void> {
  const view = chatId ? await renderScreen(rt, chatId, "chat") : await renderScreen(rt, 0, "main");
  const sent = await say(rt, userId, view.text, { html: true, markup: view.markup });
  if (!sent.ok) console.log(`panel send failed: ${sent.error}`);
}

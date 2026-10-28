/**
 * `/help` — one card, one button into the console.
 *
 * The first version dumped every command as a wall of text: twenty-odd lines
 * that fill a phone screen, of which an admin reads the first two and gives up.
 * That is a reference manual, not a UI. So the default screen carries only the
 * state an admin actually needs (is it running, what happens on a first
 * violation) plus a button to the console; the full list is still one press
 * away for whoever wants it.
 *
 * Every screen is a pure function of (config, title) → (text, buttons), and
 * every callback is `h.<chatId>.<screen>`, the same discipline panel.ts uses: a
 * stale button from an hour ago still lands on a screen that renders current
 * state instead of erroring.
 */
import type { Runtime } from "./context.ts";
import { panelData } from "./panel.ts";
import { LOCK_KINDS, describeConfig, type ChatConfig } from "./rules.ts";
import { statsText } from "./stats.ts";
import { escapeHtml } from "./telegram.ts";
import type { Env, TgCallbackQuery } from "./types.ts";

/**
 * Deployment origin used to build the console link.
 *
 * A constant is wrong in principle and right here: the Worker has no way to
 * learn its own public origin from inside `sendMessage`, and asking Telegram
 * for it would be a lie (Telegram only knows the webhook URL). `PUBLIC_URL`
 * overrides it; this is the fallback for the deployment that exists today.
 */
export const DEFAULT_PUBLIC_URL = "https://flareward-bot.pd2335346.workers.dev";

export function adminUrl(env: Env): string {
  const base = (env.PUBLIC_URL || DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
  return `${base}/admin`;
}

/** Deep-link parameter the Mini App is launched with. */
export const MINI_APP_PARAM = "admin";

/**
 * `t.me/<bot>?startapp=…` — a direct link that opens the Mini App in place.
 *
 * This is the only way to get an in-place console out of a *group* message:
 * a `web_app` inline button is rejected there (`400 BUTTON_TYPE_INVALID`,
 * verified against the live API), while a `t.me` direct link is a plain URL and
 * is accepted anywhere. On mobile Telegram opens the Mini App inside its own
 * webview, so there is no jump to Safari/Chrome.
 *
 * Returns null until the deployment has a Main Mini App configured in BotFather
 * (`getMe.has_main_web_app`). Returning the link when it is *not* configured
 * would land the admin on the plain bot chat — a worse outcome than the web
 * page, so the caller falls back to `adminUrl` instead.
 */
export async function miniAppLink(rt: Runtime): Promise<string | null> {
  const username = (rt.env.BOT_USERNAME || "").replace(/^@/, "").trim();
  if (!username) return null;
  const me = await rt.api.call("getMe", {});
  const hasMain = me.ok && (me.result as { has_main_web_app?: boolean })?.has_main_web_app === true;
  return hasMain ? `https://t.me/${username}?startapp=${MINI_APP_PARAM}` : null;
}

const PREFIX = "h";

export function helpData(chatId: number, screen: string): string {
  return [PREFIX, String(chatId), screen].join(".");
}

/** The curated list. `/help` shows it only when asked for. */
export const FULL_HELP = [
  "焰卫在岗。把我设为管理员，权限勾上：删除消息、封禁用户、置顶消息。",
  "再到 @BotFather 发 /setprivacy，对本机器人选 Disable —— 不关的话我看不见群里的广告。",
  "",
  "所有人可用：/id /rules /notes /get <名字> /help",
  "",
  "管理员（回复对方后发）：",
  "/ban [分钟] /mute [分钟] /kick /unban /warn /unwarn /verify",
  "/del /purge [数量] /pin /unpin",
  "/lock [类型|all] /unlock [类型|all] —— 不带参数时是全群禁言/解除",
  "/set 字段 值 —— 例：/set captchaMode math、/set strikes off",
  "/captcha on|off｜/keywords add 词1,词2｜/logs 频道ID|off",
  "/nightmode on|off [23:00-07:00]｜/stats [天数]",
  "/actions [条数]｜/warns 用户ID（或回复）—— 审计：最近动作 / 某人的全部记录",
  "/save 名字 内容｜/delnote 名字｜/filter add exact|prefix|regex 触发词 => 回复",
  "/filters｜/delfilter ID｜/export｜/import <JSON>｜/trust（信任此人，免验证）",
  "/block /unblock /blocks —— 屏蔽后静默删除其所有消息（对方不知道）",
  "/keywords action delete|mute|record｜/keywords regex add 加\\s*V｜/allow /unallow（广告白名单）",
  "/ai on|off|status|provider|min|budget —— 图片视觉审核（需部署配 VISION_KEY）",
  "/words [天数] —— 今日热词",
  "/sync add <频道> [间隔秒|instant]｜/sync list｜/sync off|on <频道>｜/sync del <频道>",
  "/sub <feed 地址>｜/sub list｜/sub export（OPML）｜/unsub #ID｜/unsubthis（回复消息）—— RSS 订阅，需自托管",
  "/tool —— 小工具箱（PDF 拆分、长图切分、t.me 展开、时间戳），也能直接发 /splitpdf /slice /ts /expand",
  "/parse 链接 —— 取抖音/小红书/X/B站的原图集或视频（回复带链接的消息也行）",
  "/ocr —— 回复一张图片，读出上面的文字；命中广告词按群规处置（需自托管部署）",
  "/schedule 3600 文本｜/schedule list｜/schedule del ID —— 定时消息（间隔秒，0 = 只发一次）",
  "",
  "锁类型：" + LOCK_KINDS.join(" "),
].join("\n");

/** One line of state, which is all an admin needs from `/help`. */
export function statusLine(config: ChatConfig): string {
  const running = config.enabled ? "🟢 运行中" : "⚪️ 已停用";
  const captcha = `验证${config.captcha ? "开" : "关"}`;
  const flood = config.floodLimit > 0 ? `防刷 ${config.floodLimit}/${config.floodWindow}s` : "防刷关";
  const ladder = config.strikes.length
    ? `阶梯 ${config.strikes.length} 级`
    : config.warnLimit > 0
      ? `警告 ${config.warnLimit} 次`
      : "阶梯关";
  return [running, captcha, flood, ladder].join(" · ");
}

export type HelpView = { text: string; markup: unknown };

type Button = { text: string; url?: string; callback_data?: string; web_app?: { url: string } };
const grid = (...rows: Button[][]) => ({ inline_keyboard: rows });

type CardInput = {
  chatId: number;
  /** Group title, already user-supplied text: escaped here. */
  title: string;
  config?: ChatConfig;
  /** `t.me/<bot>?startapp=…` when the deployment has a Main Mini App. */
  miniApp?: string | null;
};

/**
 * The console button.
 *
 * Three transports, chosen by what Telegram actually allows:
 *  - private chat → `web_app` button. The console runs as a Mini App with no
 *    cookie at all (the Mini App authenticates with a signed `initData`), so the
 *    `SameSite=Strict` objection that made this a plain URL last round is gone.
 *  - group + Main Mini App configured → a `t.me` direct link, which opens the
 *    Mini App in place from a group message.
 *  - group without one → the plain web page. A `web_app` button here is not an
 *    option: the Bot API rejects it outright in groups.
 */
export function consoleButton(env: Env, group: boolean, miniApp?: string | null): Button {
  if (!group) return { text: "🌐 打开管理后台", web_app: { url: adminUrl(env) } };
  if (miniApp) return { text: "🌐 管理后台", url: miniApp };
  return { text: "🌐 管理后台（网页）", url: adminUrl(env) };
}

/**
 * The invite deep link: one tap opens the "add to group" sheet with admin
 * preselection. Only built when the deployment knows its own username — a
 * fallback username would produce a dead link, which is worse than no button.
 */
export function startGroupButton(env: Env): Button | null {
  const username = (env.BOT_USERNAME || "").replace(/^@/, "").trim();
  return username ? { text: "➕ 拉我进群", url: `https://t.me/${username}?startgroup=true` } : null;
}

/**
 * The default screen.
 *
 * The console button is `consoleButton(env, group, miniApp)`; see its docstring
 * for why the transport differs between a group and a private chat.
 */
export function helpCard(env: Env, input: CardInput): HelpView {
  const group = input.chatId < 0;
  const consoleSpec = consoleButton(env, group, input.miniApp);

  if (!group) {
    return {
      text: [
        "🛡 <b>焰卫</b> · 群管理",
        "",
        "三步上线：① 把我拉进群设为管理员；② @BotFather 里把 Privacy Mode 关掉（否则看不见普通消息）；③ 点下面按钮配置。",
        "网页后台能看全部群、日志和统计，进去要密码（部署时设的 ADMIN_TOKEN）。",
      ].join("\n"),
      markup: grid([consoleSpec], [
        { text: "⚙️ 设置面板", callback_data: panelData(0, "main") },
        { text: "📖 全部命令", callback_data: helpData(input.chatId, "full") },
      ]),
    };
  }

  const config = input.config;
  const invite = startGroupButton(env);
  const inviteRow: Button[][] = invite ? [[{ text: "📋 本群规则", callback_data: helpData(input.chatId, "rules") }, { text: "📊 统计", callback_data: helpData(input.chatId, "stats") }], [invite]] : [
    [
      { text: "📋 本群规则", callback_data: helpData(input.chatId, "rules") },
      { text: "📊 统计", callback_data: helpData(input.chatId, "stats") },
    ],
  ];
  return {
    text: [
      "🛡 <b>焰卫</b> · 群管理",
      `<b>${escapeHtml(input.title)}</b>`,
      "",
      config ? statusLine(config) : "尚未初始化，发一条消息后自动写入默认配置。",
      "",
      "设置、统计、日志都在网页后台，不用记命令。",
    ].join("\n"),
    markup: grid([consoleSpec], ...inviteRow, [{ text: "📖 全部命令", callback_data: helpData(input.chatId, "full") }]),
  };
}

const backButton = (chatId: number): Button[] => [{ text: "« 返回", callback_data: helpData(chatId, "card") }];

export function fullHelpView(chatId: number): HelpView {
  return { text: `<pre>${escapeHtml(FULL_HELP)}</pre>`, markup: grid(backButton(chatId)) };
}

export function rulesView(chatId: number, config: ChatConfig): HelpView {
  return {
    text: [`<b>本群规则</b>`, ...describeConfig(config).map((line) => escapeHtml(line))].join("\n"),
    markup: grid(backButton(chatId)),
  };
}

export async function renderHelpScreen(rt: Runtime, input: CardInput & { screen: string }): Promise<HelpView> {
  switch (input.screen) {
    case "full":
      return fullHelpView(input.chatId);
    case "rules":
      return rulesView(input.chatId, input.config ?? (await rt.configFor(input.chatId)));
    case "stats":
      return {
        text: escapeHtml(await statsText(rt, input.chatId, 7)),
        markup: grid(backButton(input.chatId)),
      };
    default:
      return helpCard(rt.env, input);
  }
}

/**
 * `h.<chatId>.<screen>` buttons.
 *
 * Read-only screens, so "is an admin" is the whole gate. The console link is a
 * URL button and never comes through here.
 */
export async function handleHelpCallback(rt: Runtime, query: TgCallbackQuery): Promise<boolean> {
  const data = query.data ?? "";
  if (!data.startsWith(PREFIX + ".")) return false;

  const [, rawChat, screen = "card"] = data.split(".");
  const chatId = Number(rawChat);
  const editChat = query.message?.chat.id;
  const messageId = query.message?.message_id;
  if (!Number.isFinite(chatId) || editChat === undefined || messageId === undefined) {
    await rt.api.call("answerCallbackQuery", { callback_query_id: query.id, text: "按钮已过期" });
    return true;
  }

  const group = chatId < 0;
  const allowed = group ? await rt.admin.isAdmin(chatId, query.from.id) : query.from.id === chatId;
  if (!allowed) {
    await rt.api.call("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "只有本群管理员能看",
      show_alert: true,
    });
    return true;
  }

  const view = await renderHelpScreen(rt, {
    chatId,
    screen,
    title: query.message?.chat.title ?? "本群",
    config: group ? await rt.configFor(chatId) : undefined,
    // Resolved on every render so a card edited before BotFather was configured
    // still upgrades on the next tap of 返回.
    miniApp: await miniAppLink(rt),
  });

  const edited = await rt.api.call("editMessageText", {
    chat_id: editChat,
    message_id: messageId,
    text: view.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: view.markup,
  });
  // A rejected edit leaves the admin looking at the old screen with no clue why;
  // "message is not modified" is the one refusal that is not a fault.
  if (!edited.ok && !/not modified/i.test(edited.error)) {
    console.log(`help edit failed (${screen}): ${edited.error}`);
  }
  await rt.api.call("answerCallbackQuery", { callback_query_id: query.id });
  return true;
}

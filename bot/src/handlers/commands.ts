/**
 * Commands.
 *
 * Two gates before anything runs: is the sender an admin, and does that admin
 * hold the specific right this command needs. A group can promote someone to
 * "delete messages only"; without the second gate, `/ban` turns the bot into a
 * privilege-escalation path inside the group.
 */
import { PERMS_MEMBER, PERMS_MUTED, type Right, type Runtime } from "../context.ts";
import {
  LOCK_KINDS,
  SETTABLE,
  coerceField,
  describeConfig,
  lockLabel,
  parseKeywords,
  type ChatConfig,
  type LockKind,
} from "../rules.ts";
import {
  ban,
  deleteMessages,
  kick,
  logAction,
  record,
  recordBan,
  restrict,
  say,
  unban,
  unmute,
} from "../moderation.ts";
import { MATCH_MODES, type FilterMatchMode } from "../replies.ts";
import { inNightWindow } from "../nightmode.ts";
import { sendPanel } from "../panel.ts";
import {
  filterAdd,
  filterDelete,
  filterList,
  noteDelete,
  noteGet,
  noteList,
  noteSave,
  recentEvents,
  rememberChat,
  scheduleAdd,
  scheduleDelete,
  scheduleList,
  trustAdd,
  userEvents,
  warnDec,
  warnInc,
  warnReset,
} from "../db/repo.ts";
import { describeStrike, strikeAt } from "../ladder.ts";
import { KIND_LABELS } from "../stats.ts";
import { leaderboard, leaderboardText } from "../members.ts";
import { block, listBlocked, unblock } from "../block.ts";
import { helpCard, miniAppLink } from "../help.ts";
import { statsText } from "../stats.ts";
import { describeSync, normalizeChannel } from "../sync.ts";
import { syncDelete, syncEnable, syncList, syncUpsert, toolStats } from "../db/repo.ts";
import { MAX_PDF_BYTES, describePdfError, looksEncrypted, splitPdf } from "../tools/pdf.ts";
import { approveLoginCode } from "../admin/login-codes.ts";
import { resolveTelegramLink } from "../tools/expand.ts";
import { convertTimestamp } from "../tools/timestamp.ts";
import { TOOLS, TOOL_USAGE_LINE, allowTool } from "../tools/index.ts";
import { escapeHtml } from "../telegram.ts";
import { cmdSub, cmdSubList, cmdUnsub, cmdUnsubThis, rssAvailable, sendRssExport } from "../rss.ts";
import { WORKER_OCR_REASON, ocrAvailable, recognizeAndScreen } from "../ocr.ts";
import { visionSubject } from "../ai/vision.ts";
import { inspectPattern } from "../keywords.ts";
import { aiUsageGet, wordDayTotals, wordTop } from "../db/repo.ts";
import { dayKey, flushWords } from "../ai/words.ts";
import {
  allowParse,
  enqueueParse,
  parseBlockedNotice,
  parseBreakerFor,
  parseHostOf,
  runParseJob,
} from "../parse/service.ts";
import { detectSite, extractUrls, parseUrl } from "../parse/sites.ts";
import type { TgMessage, TgUser } from "../types.ts";

export type CommandInput = {
  rt: Runtime;
  msg: TgMessage;
  config: ChatConfig;
  args: string;
};

/**
 * The command table.
 *
 * One source of truth for three consumers that used to drift apart: the
 * dispatch gate (`COMMAND_RIGHTS` below), the help text, and the acceptance
 * matrix (`test/matrix.test.ts`). Adding a command to the switch without adding
 * it here is caught by "every dispatched name appears in COMMAND_SPEC".
 *
 * `sample` / `invalid` / `boundary` are real invocations, not descriptions —
 * the matrix runs them verbatim.
 */
export type CommandSpec = {
  name: string;
  /** Telegram admin right required; absent = anyone (or admin-only, see `readOnly`). */
  right?: Right;
  /** Public: anyone in the group. */
  public?: boolean;
  /** Admin-only but non-mutating (no right needed beyond being an admin). */
  readOnly?: boolean;
  /** Acts on the replied-to message. */
  needsReply?: boolean;
  /** Changes group state, so the permission gate must actually block strangers. */
  mutates?: boolean;
  usage: string;
  sample: string;
  invalid: string;
  boundary: string;
  /** What a rejected `invalid` invocation must say. */
  invalidExpect: RegExp;
};

export const COMMAND_SPEC: CommandSpec[] = [
  {
    name: "id",
    public: true,
    usage: "看自己的数字 ID",
    sample: "/id",
    invalid: "/id 乱写",
    boundary: "/id 999999999999",
    invalidExpect: /你的 ID|你的 Telegram ID/,
  },
  {
    name: "start",
    public: true,
    usage: "命令列表",
    sample: "/start",
    invalid: "/start x",
    boundary: "/start " + "x".repeat(200),
    invalidExpect: /焰卫|命令/,
  },
  {
    name: "help",
    public: true,
    usage: "命令列表",
    sample: "/help",
    invalid: "/help 乱写",
    boundary: "/help " + "x".repeat(200),
    invalidExpect: /焰卫|命令/,
  },
  {
    name: "rules",
    public: true,
    usage: "本群规则",
    sample: "/rules",
    invalid: "/rules x",
    boundary: "/rules " + "x".repeat(200),
    invalidExpect: /新人验证|拦截/,
  },
  {
    name: "get",
    public: true,
    usage: "名字",
    sample: "/get 不存在",
    invalid: "/get",
    boundary: "/get " + "名".repeat(200),
    invalidExpect: /用法|没有叫/,
  },
  {
    name: "notes",
    public: true,
    usage: "本群保存的说明",
    sample: "/notes",
    invalid: "/notes x",
    boundary: "/notes " + "x".repeat(200),
    invalidExpect: /还没有|条/,
  },
  {
    name: "stats",
    readOnly: true,
    usage: "[天数]",
    sample: "/stats",
    invalid: "/stats abc",
    boundary: "/stats 99999",
    invalidExpect: /最近 \d+ 天|没有记录/,
  },
  {
    name: "login",
    readOnly: true,
    usage: "<6 位登录码>",
    sample: "/login 000000",
    invalid: "/login abc",
    boundary: "/login 999999999999",
    invalidExpect: /用法|码不对|已批准/,
  },
  {
    name: "actions",
    readOnly: true,
    usage: "[条数]",
    sample: "/actions",
    invalid: "/actions abc",
    boundary: "/actions 999",
    invalidExpect: /用法|最近/,
  },
  {
    name: "top",
    readOnly: true,
    usage: "[人数]",
    sample: "/top",
    invalid: "/top abc",
    boundary: "/top 999",
    invalidExpect: /今日发言榜|还没有/,
  },
  {
    name: "warns",
    readOnly: true,
    usage: "<用户ID 或 回复消息>",
    sample: "/warns 500",
    invalid: "/warns abc",
    boundary: "/warns 999999999999",
    invalidExpect: /用法|没有找到/,
  },

  {
    name: "ban",
    right: "can_restrict_members",
    needsReply: true,
    mutates: true,
    usage: "[分钟]",
    sample: "/ban 10",
    invalid: "/ban abc",
    boundary: "/ban 999999",
    invalidExpect: /请回复|没指定对象|分钟数/,
  },
  {
    name: "mute",
    right: "can_restrict_members",
    needsReply: true,
    mutates: true,
    usage: "[分钟]",
    sample: "/mute 5",
    invalid: "/mute abc",
    boundary: "/mute 999999",
    invalidExpect: /请回复|没指定对象|分钟数/,
  },
  {
    name: "kick",
    right: "can_restrict_members",
    needsReply: true,
    mutates: true,
    usage: "",
    sample: "/kick",
    invalid: "/kick abc",
    boundary: "/kick 999999999",
    invalidExpect: /请回复|没指定对象/,
  },
  {
    name: "unban",
    right: "can_restrict_members",
    needsReply: true,
    mutates: true,
    usage: "",
    sample: "/unban",
    invalid: "/unban abc",
    boundary: "/unban 999999999",
    invalidExpect: /请回复|没指定对象/,
  },
  {
    name: "warn",
    right: "can_restrict_members",
    needsReply: true,
    mutates: true,
    usage: "",
    sample: "/warn",
    invalid: "/warn abc",
    boundary: "/warn 999999",
    invalidExpect: /请回复|要警告/,
  },
  {
    name: "unwarn",
    right: "can_restrict_members",
    needsReply: true,
    mutates: true,
    usage: "",
    sample: "/unwarn",
    invalid: "/unwarn abc",
    boundary: "/unwarn 999999",
    invalidExpect: /请回复|剩/,
  },
  {
    name: "verify",
    right: "can_restrict_members",
    needsReply: true,
    mutates: true,
    usage: "",
    sample: "/verify",
    invalid: "/verify abc",
    boundary: "/verify 999999999",
    invalidExpect: /请回复|放行/,
  },
  {
    name: "del",
    right: "can_delete_messages",
    needsReply: true,
    mutates: true,
    usage: "",
    sample: "/del",
    invalid: "/del abc",
    boundary: "/del 999999",
    invalidExpect: /请回复|删除/,
  },
  {
    name: "purge",
    right: "can_delete_messages",
    needsReply: true,
    mutates: true,
    usage: "[数量]",
    sample: "/purge 5",
    invalid: "/purge abc",
    boundary: "/purge 99999",
    invalidExpect: /请回复|删除|批量/,
  },
  {
    name: "pin",
    right: "can_pin_messages",
    needsReply: true,
    mutates: true,
    usage: "",
    sample: "/pin",
    invalid: "/pin abc",
    boundary: "/pin 999999",
    invalidExpect: /请回复|已置顶/,
  },
  {
    name: "unpin",
    right: "can_pin_messages",
    mutates: true,
    usage: "",
    sample: "/unpin",
    invalid: "/unpin abc",
    boundary: "/unpin 999999",
    invalidExpect: /已取消置顶|没成功|请回复/,
  },
  {
    name: "lock",
    right: "can_restrict_members",
    mutates: true,
    usage: "[类型|all]",
    sample: "/lock",
    invalid: "/lock 不存在的类型",
    boundary: "/lock all",
    invalidExpect: /不认识的类型|全群/,
  },
  {
    name: "unlock",
    right: "can_restrict_members",
    mutates: true,
    usage: "[类型|all]",
    sample: "/unlock",
    invalid: "/unlock 不存在的类型",
    boundary: "/unlock all",
    invalidExpect: /不认识的类型|解除/,
  },
  {
    name: "set",
    right: "can_change_info",
    mutates: true,
    usage: "字段 值",
    sample: "/set maxLength 800",
    invalid: "/set 不存在的字段 1",
    boundary: "/set warnLimit 99999",
    invalidExpect: /未知字段|没成功/,
  },
  {
    name: "captcha",
    right: "can_change_info",
    mutates: true,
    usage: "on|off|button|math|question|image|subscribe",
    sample: "/captcha on",
    invalid: "/captcha 乱写",
    boundary: "/captcha subscribe",
    invalidExpect: /用法|已|频道/,
  },
  {
    name: "keywords",
    right: "can_change_info",
    mutates: true,
    usage: "add 词1,词2 | del 词 | list",
    sample: "/keywords add 测试词",
    invalid: "/keywords 乱写",
    boundary: "/keywords add " + "词".repeat(120),
    invalidExpect: /用法|已加入|关键词/,
  },
  {
    name: "logs",
    right: "can_change_info",
    mutates: true,
    usage: "频道ID|off",
    sample: "/logs off",
    invalid: "/logs 不是数字",
    boundary: "/logs -100" + "9".repeat(20),
    invalidExpect: /请给频道|已关闭|记录/,
  },
  {
    name: "nightmode",
    right: "can_change_info",
    mutates: true,
    usage: "on|off [HH:MM-HH:MM]",
    sample: "/nightmode on",
    invalid: "/nightmode 25:99-99:99",
    boundary: "/nightmode 23:59-00:01",
    invalidExpect: /用法|夜间模式/,
  },
  {
    name: "save",
    right: "can_change_info",
    mutates: true,
    usage: "名字 内容",
    sample: "/save 规则 不许发广告",
    invalid: "/save",
    boundary: "/save 长名" + "字".repeat(60) + " 内容",
    invalidExpect: /用法|已保存/,
  },
  {
    name: "delnote",
    right: "can_change_info",
    mutates: true,
    usage: "名字",
    sample: "/delnote 规则",
    invalid: "/delnote",
    boundary: "/delnote " + "名".repeat(200),
    invalidExpect: /用法|已删除/,
  },
  {
    name: "filter",
    right: "can_change_info",
    mutates: true,
    usage: "add exact|prefix|regex 触发词 => 回复",
    sample: "/filter add exact 你好 => 你也好",
    invalid: "/filter add",
    boundary: "/filter add regex ^" + "a".repeat(190) + "$ => 太长",
    invalidExpect: /格式|用法|匹配方式|触发词|回复内容|已添加/,
  },
  {
    name: "filters",
    readOnly: true,
    usage: "",
    sample: "/filters",
    invalid: "/filters x",
    boundary: "/filters " + "x".repeat(200),
    invalidExpect: /还没有|#\d/,
  },
  {
    name: "delfilter",
    right: "can_change_info",
    mutates: true,
    usage: "ID",
    sample: "/delfilter 1",
    invalid: "/delfilter abc",
    boundary: "/delfilter 999999999",
    invalidExpect: /用法|已删除/,
  },
  {
    name: "schedule",
    right: "can_change_info",
    mutates: true,
    usage: "秒数 文本 | list | off ID",
    sample: "/schedule 3600 提醒喝水",
    invalid: "/schedule",
    boundary: "/schedule 99999999 文本",
    invalidExpect: /用法|已添加|定时/,
  },
  // `/ocr` is gated on can_delete_messages, not on "is an admin": reading text
  // off somebody's image and disposing of it are the same power. A stranger
  // could otherwise reply to a member's screenshot and trigger a punishment.
  {
    name: "ocr",
    right: "can_delete_messages",
    needsReply: true,
    usage: "",
    sample: "/ocr",
    invalid: "/ocr abc",
    boundary: "/ocr 999999",
    invalidExpect: /用法|没有图片/,
  },
  // RSS: subscribing makes the bot fetch a caller-chosen URL from our egress IP,
  // so it sits behind can_change_info like every other group-state change.
  {
    name: "sub",
    right: "can_change_info",
    mutates: true,
    usage: "<地址> | list | export",
    sample: "/sub list",
    invalid: "/sub 乱写",
    boundary: "/sub " + "https://e.com/".padEnd(600, "a"),
    invalidExpect: /地址|用法|订阅|链接/,
  },
  {
    name: "unsub",
    right: "can_change_info",
    mutates: true,
    usage: "#ID 或地址",
    sample: "/unsub 1",
    invalid: "/unsub abc",
    boundary: "/unsub 999999999",
    invalidExpect: /订阅|用法|没有/,
  },
  {
    name: "unsubthis",
    right: "can_change_info",
    needsReply: true,
    mutates: true,
    usage: "",
    sample: "/unsubthis",
    invalid: "/unsubthis abc",
    boundary: "/unsubthis 999999",
    invalidExpect: /回复|订阅|地址/,
  },
  {
    name: "sync",
    right: "can_change_info",
    mutates: true,
    usage: "add @频道 [间隔|instant] | list | on/off @频道 | del @频道",
    sample: "/sync list",
    invalid: "/sync add",
    boundary: "/sync add @ab 1",
    invalidExpect: /频道|用法|还没有|同步/,
  },
  {
    name: "trust",
    right: "can_restrict_members",
    needsReply: true,
    mutates: true,
    usage: "",
    sample: "/trust",
    invalid: "/trust abc",
    boundary: "/trust 999999999",
    invalidExpect: /请回复|已信任/,
  },
  {
    name: "block",
    right: "can_restrict_members",
    needsReply: true,
    mutates: true,
    usage: "",
    sample: "/block 广告",
    invalid: "/block",
    boundary: "/block " + "x".repeat(200),
    invalidExpect: /请回复|用法|已屏蔽/,
  },
  {
    name: "unblock",
    right: "can_restrict_members",
    needsReply: true,
    mutates: true,
    usage: "",
    sample: "/unblock",
    invalid: "/unblock abc",
    boundary: "/unblock 999999999",
    invalidExpect: /请回复|用法|已解除|不在/,
  },
  {
    name: "blocks",
    right: "can_restrict_members",
    readOnly: true,
    usage: "",
    sample: "/blocks",
    invalid: "/blocks x",
    boundary: "/blocks " + "x".repeat(200),
    invalidExpect: /没有|屏蔽/,
  },
  {
    name: "export",
    readOnly: true,
    usage: "",
    sample: "/export",
    invalid: "/export x",
    boundary: "/export " + "x".repeat(200),
    invalidExpect: /\{"v":1/,
  },
  {
    name: "import",
    right: "can_change_info",
    mutates: true,
    usage: "<JSON>",
    sample: '/import {"config":{"maxLength":900}}',
    invalid: "/import 不是json",
    boundary: '/import {"config":{"maxLength":99999999}}',
    invalidExpect: /用法|不是合法 JSON|已导入|没导入/,
  },
  {
    name: "panel",
    public: true,
    usage: "控制面板（群里只回私聊入口；面板本身按群逐个鉴权）",
    sample: "/panel",
    invalid: "/panel x",
    boundary: "/panel " + "x".repeat(200),
    invalidExpect: /焰卫|面板|配置/,
  },
  {
    name: "tool",
    public: true,
    usage: "工具箱",
    sample: "/tool",
    invalid: "/tool x",
    boundary: "/tool " + "x".repeat(200),
    invalidExpect: /工具箱/,
  },
  {
    name: "ts",
    public: true,
    usage: "1700000000 或 2026-10-28 18:00",
    sample: "/ts 1700000000",
    invalid: "/ts 认不出",
    boundary: "/ts 9999999999999",
    invalidExpect: /认不出|用法/,
  },
  {
    name: "expand",
    public: true,
    usage: "t.me 链接",
    sample: "/expand https://t.me/telegram",
    invalid: "/expand 不是链接",
    boundary: "/expand https://t.me/" + "a".repeat(120),
    invalidExpect: /展开失败|用法|只认/,
  },
  {
    name: "splitpdf",
    public: true,
    needsReply: true,
    usage: "（回复一个 PDF）",
    sample: "/splitpdf",
    invalid: "/splitpdf x",
    boundary: "/splitpdf " + "x".repeat(200),
    invalidExpect: /回复一个 PDF|不是 PDF|解析失败|下载失败|只有一页/,
  },
  {
    name: "slice",
    public: true,
    needsReply: true,
    usage: "（回复一张长截图）",
    sample: "/slice",
    invalid: "/slice x",
    boundary: "/slice " + "x".repeat(200),
    invalidExpect: /自托管|回复一张图片|下载失败|不需要切分|切分/,
  },
  {
    name: "ai",
    right: "can_change_info",
    mutates: true,
    usage: "on|off|status|provider generic|cloud-vision|min 50-100|budget 次/天",
    sample: "/ai status",
    invalid: "/ai 乱写",
    boundary: "/ai min 999",
    invalidExpect: /用法|图片审核|阈值|视觉/,
  },
  {
    name: "allow",
    right: "can_change_info",
    needsReply: true,
    mutates: true,
    usage: "（回复广告合作方）",
    sample: "/allow",
    invalid: "/allow abc",
    boundary: "/allow 999999999",
    invalidExpect: /请回复|白名单|用法/,
  },
  {
    name: "unallow",
    right: "can_change_info",
    needsReply: true,
    mutates: true,
    usage: "（回复广告合作方）",
    sample: "/unallow",
    invalid: "/unallow abc",
    boundary: "/unallow 999999999",
    invalidExpect: /请回复|白名单|不在|用法/,
  },
  {
    name: "words",
    readOnly: true,
    usage: "[天数]",
    sample: "/words",
    invalid: "/words abc",
    boundary: "/words 999",
    invalidExpect: /热词|还没有|天/,
  },
  {
    name: "parse",
    public: true,
    usage: "链接（或回复一条带链接的消息）",
    sample: "/parse https://www.bilibili.com/video/BV1GJ411x7h7",
    invalid: "/parse 乱写",
    boundary: "/parse https://example.com/" + "a".repeat(200),
    invalidExpect: /用法|不支持|链接/,
  },
];

const COMMAND_RIGHTS: Record<string, Right> = Object.fromEntries(
  COMMAND_SPEC.filter((spec) => spec.right).map((spec) => [spec.name, spec.right as Right]),
);

/** Commands that are harmless to *read* but must not mutate anything. */
const READ_ONLY = new Set(COMMAND_SPEC.filter((spec) => spec.readOnly).map((spec) => spec.name));

/** Commands anyone may use; they cost CPU, not permissions. */
const TOOL_COMMANDS = new Set(["tool", "splitpdf", "slice", "expand", "ts"]);

export type Target = { id: number; minutes: number; error: string; user?: TgUser };

/**
 * Work out who a command is aimed at.
 *
 * A replied-to message always wins and any number is a duration. Without a
 * reply, two numbers mean `id duration`; a single small number is a duration
 * with nobody to act on — reading it as a user id, as the original template
 * did, mutes a stranger whose id happens to be `10`.
 */
export function parseTarget(msg: TgMessage, args: string): Target {
  const numbers = String(args || "")
    .trim()
    .split(/\s+/)
    .filter((part) => /^\d+$/.test(part))
    .map(Number);

  const replied = msg.reply_to_message?.from;
  const out: Target = { id: replied?.id ?? 0, minutes: 0, error: "", user: replied };

  if (replied) {
    if (numbers.length >= 1) out.minutes = numbers[0];
  } else if (numbers.length >= 2) {
    out.id = numbers[0];
    out.minutes = numbers[1];
  } else if (numbers.length === 1) {
    if (numbers[0] >= 10_000) out.id = numbers[0];
    else out.error = `只写了分钟数，没指定对象。先回复对方再发，或写成 /命令 用户ID ${numbers[0]}`;
  }

  out.minutes = Math.max(0, Math.min(out.minutes, 525_600));
  return out;
}

async function guardTarget(rt: Runtime, msg: TgMessage, id: number): Promise<boolean> {
  if (!id) {
    await say(rt, msg.chat.id, "请回复对方的消息，或写成 /命令 用户ID。", {
      replyTo: msg.message_id,
    });
    return false;
  }
  if (String(id) === rt.api.botId) {
    await say(rt, msg.chat.id, "不能对我自己这么做。", { replyTo: msg.message_id });
    return false;
  }
  if (await rt.admin.isAdmin(msg.chat.id, id)) {
    await say(rt, msg.chat.id, "不能对管理员这么做。", { replyTo: msg.message_id });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------

export async function handleCommand(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const text = msg.text ?? "";
  if (!text.startsWith("/")) return false;
  if (!msg.from) return false;

  const bits = text.trim().split(/\s+/);
  const name = bits[0].slice(1).split("@")[0].toLowerCase();
  const chat = msg.chat;
  const from = msg.from;

  if (name === "id") {
    const dm = await say(rt, from.id, `你的 Telegram ID 是 ${from.id}。`, { html: false });
    if (!dm.ok && chat.type !== "private") {
      await say(
        rt,
        chat.id,
        `你的 ID 是 <code>${from.id}</code>。先私聊我发一次 /start，以后只发到私聊。`,
        {
          replyTo: msg.message_id,
          html: true,
        },
      );
    }
    return true;
  }

  if (chat.type === "private") {
    if (name === "start" || name === "panel") {
      await sendPanel(rt, from.id);
      return true;
    }
    if (name === "help") {
      const view = helpCard(rt.env, {
        chatId: from.id,
        title: from.first_name ?? "运营者",
        miniApp: await miniAppLink(rt),
      });
      await say(rt, from.id, view.text, { markup: view.markup, html: true });
      return true;
    }
    return true;
  }

  // Remember the group so the console and the panel can list it by name.
  if (name !== "id") {
    await rememberChat(rt.db, {
      chatId: chat.id,
      title: chat.title ?? String(chat.id),
      type: chat.type,
      at: rt.now(),
    }).catch(() => undefined);
  }

  if (name === "panel") {
    await say(rt, chat.id, "配置面板在私聊里：点下面的链接打开，然后发 /panel。", {
      markup: {
        inline_keyboard: [
          [
            {
              text: "打开私聊",
              url: `https://t.me/${rt.env.BOT_USERNAME ?? "your_bot"}?start=panel`,
            },
          ],
        ],
      },
      replyTo: msg.message_id,
    });
    return true;
  }

  if (name === "start" || name === "help") {
    if (await rt.admin.isAdmin(chat.id, from.id)) {
      // `miniApp` is what turns the console button into an in-place Mini App
      // launch. It is resolved from getMe, so a deployment without a Main Mini
      // App configured simply keeps the plain web link.
      const view = helpCard(rt.env, {
        chatId: chat.id,
        title: chat.title ?? "本群",
        config: input.config,
        miniApp: await miniAppLink(rt),
      });
      await say(rt, chat.id, view.text, {
        markup: view.markup,
        html: true,
        replyTo: msg.message_id,
      });
    } else {
      await say(rt, chat.id, "我在。管理员发 /help 打开面板。", { replyTo: msg.message_id });
    }
    return true;
  }

  if (name === "rules") {
    await say(rt, chat.id, describeConfig(input.config).join("\n"), { replyTo: msg.message_id });
    return true;
  }

  // Notes and note-reading are open to everyone: that is their point.
  if (name === "get" || name === "notes") {
    return handleNoteRead(input, name);
  }
  if (name === "stats") {
    // Non-admins get silence, not a moderation pass: a command must never fall
    // through to the content filters and be deleted as if it were spam.
    if (!(await rt.admin.isAdmin(chat.id, from.id))) return true;
    return handleStats(input);
  }

  if (TOOL_COMMANDS.has(name)) return handleToolCommand(input, name);
  // `/parse` is public: any member can ask what a link points at, and the
  // per-chat hourly budget is what keeps that from becoming an outbound proxy.
  if (name === "parse") return cmdParse(input);

  // --- admin gate -----------------------------------------------------------
  // A read-only command (filters/export/blocks) needs "is an admin", not a
  // specific right; everything else names the right it needs.
  const required = COMMAND_RIGHTS[name];
  if (!required && !READ_ONLY.has(name)) return false;
  const allowed = required
    ? await rt.admin.can(chat.id, from.id, required)
    : await rt.admin.isAdmin(chat.id, from.id);
  if (!allowed) {
    if (!READ_ONLY.has(name)) {
      await say(rt, chat.id, "你没有这个权限（或该命令需要对应群管理权限）。", {
        replyTo: msg.message_id,
      });
    }
    return true;
  }

  // Commands from the anonymous-admin bot cannot be attributed to a person, so
  // anything that mutates is refused rather than logged as "unknown admin".
  const GROUP_ANON = 1087968824;
  if (from.id === GROUP_ANON && !READ_ONLY.has(name)) {
    await say(rt, chat.id, "匿名管理员请用具体账号操作。", { replyTo: msg.message_id });
    return true;
  }

  switch (name) {
    case "ban":
      return cmdBan(input);
    case "mute":
      return cmdMute(input);
    case "kick":
      return cmdKick(input);
    case "unban":
      return cmdUnban(input);
    case "warn":
      return cmdWarn(input);
    case "unwarn":
      return cmdUnwarn(input);
    case "verify":
      return cmdVerify(input);
    case "del":
      return cmdDel(input);
    case "purge":
      return cmdPurge(input);
    case "pin":
      return cmdPin(input, true);
    case "unpin":
      return cmdPin(input, false);
    case "lock":
      return cmdLock(input, true);
    case "unlock":
      return cmdLock(input, false);
    case "set":
      return cmdSet(input);
    case "captcha":
      return cmdCaptcha(input);
    case "keywords":
      return cmdKeywords(input);
    case "logs":
      return cmdLogs(input);
    case "nightmode":
      return cmdNight(input);
    case "save":
    case "delnote":
      return handleNoteWrite(input, name);
    case "filter":
    case "filters":
    case "delfilter":
      return handleFilters(input, name);
    case "schedule":
      return cmdSchedule(input);
    case "trust":
      return cmdTrust(input);
    case "block":
      return cmdBlock(input, true);
    case "unblock":
      return cmdBlock(input, false);
    case "blocks":
      return cmdBlocks(input);
    case "sync":
      return cmdSync(input);
    case "ai":
      return cmdAi(input);
    case "allow":
      return cmdAllow(input, true);
    case "unallow":
      return cmdAllow(input, false);
    case "words":
      return cmdWords(input);
    case "ocr":
      return cmdOcr(input);
    case "sub":
    case "unsub":
    case "unsubthis":
      return cmdRss(input, name);
    case "export":
      return cmdExport(input);
    case "import":
      return cmdImport(input);
    case "actions":
      return cmdActions(input);
    case "warns":
      return cmdWarns(input);
    case "top":
      return cmdTop(input);
    case "login":
      return cmdLogin(input);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

async function cmdBan(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const target = parseTarget(msg, input.args);
  if (target.error) {
    await reply(input, target.error);
    return true;
  }
  if (!(await guardTarget(rt, msg, target.id))) return true;
  const res = await ban(rt, msg.chat.id, target.id, target.minutes);
  if (res.ok)
    await report(input, true, target.minutes ? `已封禁 ${target.minutes} 分钟。` : "已封禁。");
  else await report(input, false, res.error);
  if (res.ok) await recordBan(rt, config, target.id, "管理员手动封禁");
  if (res.ok) {
    await logAction(rt, config, {
      chat: msg.chat,
      user: target.user ?? { id: target.id, first_name: `ID ${target.id}` },
      action: target.minutes ? `封禁 ${target.minutes} 分钟` : "封禁",
      reason: "管理员手动操作",
      by: msg.from,
      kind: "ban",
      minutes: target.minutes || undefined,
    });
  }
  return true;
}

async function cmdMute(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const target = parseTarget(msg, input.args);
  if (target.error) {
    await reply(input, target.error);
    return true;
  }
  if (!(await guardTarget(rt, msg, target.id))) return true;
  const minutes = target.minutes || config.muteMinutes;
  const res = await restrict(rt, msg.chat.id, target.id, minutes);
  if (res.ok) await report(input, true, `已禁言 ${minutes} 分钟。`);
  else await report(input, false, res.error);
  if (res.ok) {
    await logAction(rt, config, {
      chat: msg.chat,
      user: target.user ?? { id: target.id },
      action: `禁言 ${minutes} 分钟`,
      reason: "管理员手动操作",
      by: msg.from,
      kind: "mute",
      minutes,
    });
  }
  return true;
}

async function cmdKick(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const target = parseTarget(msg, input.args);
  if (!(await guardTarget(rt, msg, target.id))) return true;
  const res = await kick(rt, msg.chat.id, target.id);
  await report(input, res.ok, res.ok ? "已移出，对方可以再进来。" : res.error);
  if (res.ok)
    await record(rt, {
      chatId: msg.chat.id,
      userId: target.id,
      kind: "kick",
      reason: "管理员手动",
      byId: msg.from?.id,
    });
  return true;
}

async function cmdUnban(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const target = parseTarget(msg, input.args);
  if (!(await guardTarget(rt, msg, target.id))) return true;
  const res = await unban(rt, msg.chat.id, target.id);
  // Unbanning by hand means "this person is fine": exempt them from the newbie
  // window so the next link they post is not auto-deleted.
  await trustAdd(rt.db, msg.chat.id, target.id, rt.now()).catch(() => undefined);
  await report(input, res.ok, res.ok ? "已解除限制，并记为可信成员（免新人限制）。" : res.error);
  return true;
}

async function cmdWarn(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const target = parseTarget(msg, input.args);
  if (!target.id) {
    await say(rt, msg.chat.id, "请回复要警告的消息。", { replyTo: msg.message_id });
    return true;
  }
  if (!(await guardTarget(rt, msg, target.id))) return true;
  if (msg.reply_to_message)
    await deleteMessages(rt, msg.chat.id, [msg.reply_to_message.message_id]);
  const count = await warnInc(rt.db, msg.chat.id, target.id, rt.now());
  const strike = strikeAt(count, input.config);
  if (strike && strike.action !== "warn") {
    if (strike.action === "ban") {
      await ban(rt, msg.chat.id, target.id, strike.minutes);
      // 与 applyStrike 对齐：封禁要进共享黑名单、警告计数清零——否则
      // 联邦封禁漏登记、下次违规直接重复最高档。
      await recordBan(rt, input.config, target.id, `手动警告第 ${count} 次触发`);
      await warnReset(rt.db, msg.chat.id, target.id).catch(() => undefined);
    } else if (strike.action === "kick") await kick(rt, msg.chat.id, target.id);
    else await restrict(rt, msg.chat.id, target.id, strike.minutes);
    await say(rt, msg.chat.id, `警告 ${count} 次：${describeStrike(strike)}。`, {
      replyTo: msg.message_id,
    });
  } else {
    await say(
      rt,
      msg.chat.id,
      `已警告 <code>${target.id}</code>（第 ${count} 次），并删掉那条消息。`,
      {
        replyTo: msg.message_id,
        html: true,
      },
    );
  }
  await record(rt, {
    chatId: msg.chat.id,
    userId: target.id,
    kind: "warn",
    reason: `手动警告第 ${count} 次`,
    byId: msg.from?.id,
  });
  return true;
}

async function cmdUnwarn(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const target = parseTarget(msg, input.args);
  if (!target.id) {
    await say(rt, msg.chat.id, "请回复对方的消息，或写成 /unwarn 用户ID。", {
      replyTo: msg.message_id,
    });
    return true;
  }
  const left = await warnDec(rt.db, msg.chat.id, target.id, rt.now());
  await say(rt, msg.chat.id, `已撤销一次警告，剩 ${left} 次。`, { replyTo: msg.message_id });
  return true;
}

async function cmdVerify(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const target = parseTarget(msg, input.args);
  if (!target.id) {
    await say(rt, msg.chat.id, "请回复要放行的人。", { replyTo: msg.message_id });
    return true;
  }
  await unmute(rt, msg.chat.id, target.id);
  await rt.store.del(`verify:${msg.chat.id}:${target.id}`);
  await trustAdd(rt.db, msg.chat.id, target.id, rt.now()).catch(() => undefined);
  await record(rt, {
    chatId: msg.chat.id,
    userId: target.id,
    kind: "verify",
    reason: "管理员手动放行",
    byId: msg.from?.id,
  });
  const answer = await say(rt, msg.chat.id, "已放行。", { replyTo: msg.message_id });
  if (answer.ok && !config.deleteJoinMessages) return true;
  return true;
}

async function cmdDel(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  if (!msg.reply_to_message) {
    await say(rt, msg.chat.id, "请回复要删除的消息。", { replyTo: msg.message_id });
    return true;
  }
  await deleteMessages(rt, msg.chat.id, [msg.reply_to_message.message_id]);
  await record(rt, {
    chatId: msg.chat.id,
    kind: "delete",
    reason: "管理员删除",
    byId: msg.from?.id,
  });
  return true;
}

async function cmdPurge(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  if (!msg.reply_to_message) {
    await say(rt, msg.chat.id, "请回复要开始删除的那条消息。", { replyTo: msg.message_id });
    return true;
  }
  const asked = Number(input.args.trim().split(/\s+/)[0]) || 50;
  const count = Math.max(1, Math.min(asked, 100));
  const start = msg.reply_to_message.message_id;
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const id = start + i;
    if (id > msg.message_id) break;
    ids.push(id);
  }
  // `deleteMessages` caps at 100 per call; the loop above already respects it.
  const res = await deleteMessages(rt, msg.chat.id, ids);
  if (!res.ok) await say(rt, msg.chat.id, `没成功：${res.error}`, { replyTo: msg.message_id });
  await record(rt, {
    chatId: msg.chat.id,
    kind: "delete",
    reason: `批量删除 ${ids.length} 条`,
    byId: msg.from?.id,
  });
  return true;
}

async function cmdPin(input: CommandInput, pin: boolean): Promise<boolean> {
  const { rt, msg } = input;
  if (pin) {
    if (!msg.reply_to_message) {
      await say(rt, msg.chat.id, "请回复要置顶的消息。", { replyTo: msg.message_id });
      return true;
    }
    const res = await rt.api.call("pinChatMessage", {
      chat_id: msg.chat.id,
      message_id: msg.reply_to_message.message_id,
      disable_notification: true,
    });
    await report(input, res.ok, res.ok ? "已置顶。" : res.error);
    return true;
  }
  const res = await rt.api.call("unpinChatMessage", { chat_id: msg.chat.id });
  await report(input, res.ok, res.ok ? "已取消置顶。" : res.error);
  return true;
}

/**
 * `/lock` does two different jobs, and the argument decides which:
 *   /lock            → mute the whole group (the behaviour people know)
 *   /lock links ...  → stop that message type
 */
async function cmdLock(input: CommandInput, locking: boolean): Promise<boolean> {
  const { rt, msg, config } = input;
  const arg = input.args.trim().toLowerCase();
  if (!arg) {
    const res = await rt.api.call("setChatPermissions", {
      chat_id: msg.chat.id,
      permissions: locking ? PERMS_MUTED : PERMS_MEMBER,
      use_independent_chat_permissions: true,
    });
    await report(
      input,
      res.ok,
      res.ok ? (locking ? "全群已禁言，管理员不受影响。" : "已解除全群禁言。") : res.error,
    );
    return true;
  }

  const requested = arg === "all" ? [...LOCK_KINDS] : arg.split(/[\s,]+/).filter(Boolean);
  const unknown = requested.filter((kind) => !(LOCK_KINDS as readonly string[]).includes(kind));
  if (unknown.length) {
    await say(
      rt,
      msg.chat.id,
      `不认识的类型：${unknown.join("、")}。可用：${LOCK_KINDS.join(" ")}`,
      {
        replyTo: msg.message_id,
      },
    );
    return true;
  }

  const next = new Set(config.locks);
  for (const kind of requested) {
    if (locking) next.add(kind as LockKind);
    else next.delete(kind as LockKind);
  }
  const saved = await rt.saveConfig(msg.chat.id, { locks: [...next] });
  const list = [...next].map(lockLabel);
  await say(
    rt,
    msg.chat.id,
    list.length ? `已拦截：${list.join("、")}` : "内容拦截已全部关闭，只剩关键词。",
    {
      replyTo: msg.message_id,
    },
  );
  if (saved.error)
    await say(rt, msg.chat.id, `但保存失败：${saved.error}`, { replyTo: msg.message_id });
  return true;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

async function cmdSet(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const [field, ...rest] = input.args.trim().split(/\s+/);
  if (!field) {
    await say(rt, msg.chat.id, "用法：/set 字段 值。字段：" + Object.keys(SETTABLE).join(" "), {
      replyTo: msg.message_id,
    });
    return true;
  }
  if (field === "keywords") {
    await say(rt, msg.chat.id, "关键词请用 /keywords add 词1,词2", { replyTo: msg.message_id });
    return true;
  }
  if (field === "strikes") {
    const value = (rest[0] ?? "").toLowerCase();
    if (!["on", "off"].includes(value)) {
      await say(
        rt,
        msg.chat.id,
        "用法：/set strikes on|off（on = 1次禁言1h，2次禁言24h，3次封禁）",
        { replyTo: msg.message_id },
      );
      return true;
    }
    const strikes =
      value === "off"
        ? []
        : [
            { at: 1, action: "mute" as const, minutes: 60 },
            { at: 2, action: "mute" as const, minutes: 1440 },
            { at: 3, action: "ban" as const, minutes: 0 },
          ];
    const saved = await rt.saveConfig(msg.chat.id, { strikes });
    await say(
      rt,
      msg.chat.id,
      saved.error
        ? `没成功：${saved.error}`
        : `阶梯制裁已${value === "on" ? "打开" : "关闭（回退到单次处置）"}。`,
      {
        replyTo: msg.message_id,
      },
    );
    return true;
  }
  if (!(field in SETTABLE)) {
    await say(rt, msg.chat.id, `未知字段。可用：${Object.keys(SETTABLE).join(" ")}`, {
      replyTo: msg.message_id,
    });
    return true;
  }
  if (!rest.length) {
    await say(rt, msg.chat.id, `用法：/set ${field} <${SETTABLE[field]}>`, {
      replyTo: msg.message_id,
    });
    return true;
  }

  const raw = rest.join(" ");
  const value = coerceField(field, raw);
  if (field === "nightStart" || field === "nightEnd") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) {
      await say(rt, msg.chat.id, "时间要写成 HH:MM，例如 23:00。", { replyTo: msg.message_id });
      return true;
    }
  }
  const saved = await rt.saveConfig(msg.chat.id, { [field]: value });
  if (saved.error) {
    await say(rt, msg.chat.id, `没成功：${saved.error}`, { replyTo: msg.message_id });
    return true;
  }
  const shown = (saved.config as unknown as Record<string, unknown>)[field];
  await say(
    rt,
    msg.chat.id,
    `已设置 ${field} = ${Array.isArray(shown) ? shown.join(",") : String(shown)}`,
    {
      replyTo: msg.message_id,
    },
  );
  return true;
}

async function cmdCaptcha(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const value = input.args.trim().toLowerCase();
  if (!value) {
    await say(
      rt,
      msg.chat.id,
      `新人验证现在是 ${config.captcha ? "开" : "关"}（${config.captchaMode}）。用法：/captcha on|off|button|math|question|image|subscribe`,
      {
        replyTo: msg.message_id,
      },
    );
    return true;
  }
  if (["on", "off"].includes(value)) {
    const saved = await rt.saveConfig(msg.chat.id, { captcha: value === "on" });
    await say(rt, msg.chat.id, `新人验证已${saved.config.captcha ? "打开" : "关闭"}。`, {
      replyTo: msg.message_id,
    });
    return true;
  }
  if (["button", "math", "question", "image", "subscribe"].includes(value)) {
    if (value === "subscribe" && !config.captchaChannel.trim()) {
      await say(
        rt,
        msg.chat.id,
        "先用 /set captchaChannel @频道 设置要订阅的公开频道（机器人需已加入该频道）。",
        { replyTo: msg.message_id },
      );
      return true;
    }
    const saved = await rt.saveConfig(msg.chat.id, { captcha: true, captchaMode: value });
    await say(rt, msg.chat.id, `验证方式已切换为 ${saved.config.captchaMode}。`, {
      replyTo: msg.message_id,
    });
    return true;
  }
  await say(rt, msg.chat.id, "用法：/captcha on|off|button|math|question|image|subscribe", {
    replyTo: msg.message_id,
  });
  return true;
}

async function cmdKeywords(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const [sub, ...rest] = input.args.trim().split(/\s+/);
  const action = (sub ?? "list").toLowerCase();
  if (action === "list" || !sub) {
    const lines: string[] = [];
    lines.push(
      config.keywords.length
        ? `关键词（${config.keywords.length}）：\n${config.keywords.join("\n")}`
        : "还没有关键词。用法：/keywords add 词1,词2",
    );
    if (config.keywordPatterns.length)
      lines.push(
        `正则（${config.keywordPatterns.length}）：\n${config.keywordPatterns.join("\n")}`,
      );
    lines.push(
      `命中动作：${config.keywordAction === "mute" ? "删除并禁言" : config.keywordAction === "record" ? "只记录" : "删除（走阶梯）"}`,
    );
    if (config.adWhitelist.length) lines.push(`广告白名单：${config.adWhitelist.length} 人`);
    await say(rt, msg.chat.id, lines.join("\n\n"), { replyTo: msg.message_id });
    return true;
  }

  if (action === "action") {
    const value = (rest[0] ?? "").toLowerCase();
    if (!["delete", "mute", "record"].includes(value)) {
      await say(rt, msg.chat.id, "用法：/keywords action delete|mute|record", {
        replyTo: msg.message_id,
      });
      return true;
    }
    const saved = await rt.saveConfig(msg.chat.id, { keywordAction: value });
    await say(
      rt,
      msg.chat.id,
      saved.error
        ? `没成功：${saved.error}`
        : `关键词命中后：${{ delete: "删除并走阶梯", mute: "删除并禁言", record: "只记录" }[value as "delete"] ?? value}。`,
      {
        replyTo: msg.message_id,
      },
    );
    return true;
  }

  if (action === "regex") {
    const mode = (rest[0] ?? "list").toLowerCase();
    const pattern = rest.slice(1).join(" ").trim();
    if (mode === "list") {
      await say(
        rt,
        msg.chat.id,
        config.keywordPatterns.length
          ? `正则（${config.keywordPatterns.length}）：\n${config.keywordPatterns.join("\n")}`
          : "还没有正则。用法：/keywords regex add 加\\s*V",
        {
          replyTo: msg.message_id,
        },
      );
      return true;
    }
    if (mode === "add") {
      if (!pattern) {
        await say(rt, msg.chat.id, "用法：/keywords regex add 正则（例如 加\\s*[Vv]）", {
          replyTo: msg.message_id,
        });
        return true;
      }
      const check = inspectPattern(pattern);
      if (!check.ok) {
        await say(rt, msg.chat.id, `这个正则没通过安全检查：${check.reason}`, {
          replyTo: msg.message_id,
        });
        return true;
      }
      if (config.keywordPatterns.includes(pattern)) {
        await say(rt, msg.chat.id, "这条正则已经在列表里了。", { replyTo: msg.message_id });
        return true;
      }
      const next = [...config.keywordPatterns, pattern].slice(0, 20);
      const saved = await rt.saveConfig(msg.chat.id, { keywordPatterns: next });
      await say(
        rt,
        msg.chat.id,
        saved.error ? `没成功：${saved.error}` : `已加入，现在 ${next.length} 条正则。`,
        { replyTo: msg.message_id },
      );
      return true;
    }
    if (mode === "del" || mode === "remove") {
      const next = config.keywordPatterns.filter((item) => item !== pattern);
      await rt.saveConfig(msg.chat.id, { keywordPatterns: next });
      await say(
        rt,
        msg.chat.id,
        `已删除 ${config.keywordPatterns.length - next.length} 条，剩 ${next.length} 条。`,
        { replyTo: msg.message_id },
      );
      return true;
    }
    await say(rt, msg.chat.id, "用法：/keywords regex add|del|list 正则", {
      replyTo: msg.message_id,
    });
    return true;
  }
  if (action === "add") {
    const merged = parseKeywords([...config.keywords, ...parseKeywords(rest.join(" "))]);
    const saved = await rt.saveConfig(msg.chat.id, { keywords: merged });
    await say(
      rt,
      msg.chat.id,
      saved.error ? `没成功：${saved.error}` : `已加入，现在共 ${merged.length} 个关键词。`,
      {
        replyTo: msg.message_id,
      },
    );
    return true;
  }
  if (action === "del" || action === "remove") {
    const words = parseKeywords(rest.join(" ")).map((word) => word.toLowerCase());
    const kept = config.keywords.filter((word) => !words.includes(word.toLowerCase()));
    await rt.saveConfig(msg.chat.id, { keywords: kept });
    await say(
      rt,
      msg.chat.id,
      `已删除 ${config.keywords.length - kept.length} 个，剩 ${kept.length} 个。`,
      {
        replyTo: msg.message_id,
      },
    );
    return true;
  }
  await say(rt, msg.chat.id, "用法：/keywords add 词1,词2 / del 词 / list", {
    replyTo: msg.message_id,
  });
  return true;
}

/**
 * `/ai` — image moderation, its budget, and today's numbers.
 *
 * `status` is the default subcommand on purpose: an admin who types `/ai` wants
 * to know whether it is on before he wants to change it, and the usage number
 * is the only place the cost is visible without opening the console.
 */
async function cmdAi(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const [sub, ...rest] = input.args.trim().split(/\s+/).filter(Boolean);
  const action = (sub ?? "status").toLowerCase();
  const usage = `用法：/ai on|off|status｜/ai provider generic|cloud-vision｜/ai min 50-100｜/ai budget 次数/天`;

  if (action === "status") {
    const day = dayKey(rt.now(), rt.tzOffset);
    const row = await aiUsageGet(rt.db, msg.chat.id, day).catch(() => ({
      calls: 0,
      hits: 0,
      failures: 0,
      ms: 0,
    }));
    const lines = [
      `图片审核：${config.ai ? "开" : "关"}（${config.aiProvider}，阈值 ${config.aiMinScore}，预算 ${config.aiDailyBudget}/天）`,
      `今天：调用 ${row.calls}，命中 ${row.hits}，失败 ${row.failures}`,
      config.aiCategories.length
        ? `类别：${config.aiCategories.join(" / ")}`
        : "类别：未选，等于不审",
    ];
    if (!rt.vision.configured(config.aiProvider))
      lines.push("部署没有配置 VISION_KEY，打开也不会真的调用。");
    await say(rt, msg.chat.id, lines.join("\n"), { replyTo: msg.message_id });
    return true;
  }

  if (action === "on" || action === "off") {
    const saved = await rt.saveConfig(msg.chat.id, { ai: action === "on" });
    const hint =
      action === "on" && !rt.vision.configured(config.aiProvider)
        ? "（注意：部署未配置视觉服务）"
        : "";
    await say(
      rt,
      msg.chat.id,
      saved.error
        ? `没成功：${saved.error}`
        : `图片审核已${action === "on" ? "开启" : "关闭"}${hint}。`,
      {
        replyTo: msg.message_id,
      },
    );
    return true;
  }

  if (action === "provider") {
    const value = (rest[0] ?? "").toLowerCase();
    if (value !== "generic" && value !== "cloud-vision") {
      await say(rt, msg.chat.id, usage, { replyTo: msg.message_id });
      return true;
    }
    const saved = await rt.saveConfig(msg.chat.id, { aiProvider: value });
    await say(rt, msg.chat.id, saved.error ? `没成功：${saved.error}` : `视觉通道：${value}`, {
      replyTo: msg.message_id,
    });
    return true;
  }

  if (action === "min") {
    const value = Number(rest[0]);
    if (!Number.isInteger(value) || value < 50 || value > 100) {
      await say(rt, msg.chat.id, `阈值要 50–100 的整数。${usage}`, { replyTo: msg.message_id });
      return true;
    }
    const saved = await rt.saveConfig(msg.chat.id, { aiMinScore: value });
    await say(
      rt,
      msg.chat.id,
      saved.error ? `没成功：${saved.error}` : `阈值已设为 ${value}（越高越保守）。`,
      { replyTo: msg.message_id },
    );
    return true;
  }

  if (action === "budget") {
    const value = Number(rest[0]);
    if (!Number.isInteger(value) || value < 10 || value > 20_000) {
      await say(rt, msg.chat.id, `预算要 10–20000 的整数。${usage}`, { replyTo: msg.message_id });
      return true;
    }
    const saved = await rt.saveConfig(msg.chat.id, { aiDailyBudget: value });
    await say(
      rt,
      msg.chat.id,
      saved.error ? `没成功：${saved.error}` : `每日预算：${value} 次，超了会告警一次并停到明天。`,
      { replyTo: msg.message_id },
    );
    return true;
  }

  await say(rt, msg.chat.id, usage, { replyTo: msg.message_id });
  return true;
}

/**
 * `/allow` and `/unallow` — the ad-partnership whitelist.
 *
 * A whitelisted member's keyword hits are recorded and left alone. Locks still
 * apply: the whitelist is about "this person is allowed to advertise", not
 * about "this person may post anything at all".
 */
async function cmdAllow(input: CommandInput, adding: boolean): Promise<boolean> {
  const { rt, msg, config } = input;
  // Not `parseTarget`: its one-number rule reads a bare value as minutes (that
  // is right for /ban, wrong for a whitelist where the number is the subject).
  const replied = msg.reply_to_message?.from;
  const typed = /^\d{4,}$/.test(input.args.trim()) ? Number(input.args.trim()) : 0;
  const target = { id: replied?.id ?? typed };
  if (!target.id) {
    await say(
      rt,
      msg.chat.id,
      `用法：回复对方发 /${adding ? "allow" : "unallow"}，或 /${adding ? "allow" : "unallow"} 用户ID。白名单里的人关键词命中只记录。`,
      {
        replyTo: msg.message_id,
      },
    );
    return true;
  }
  const current = config.adWhitelist ?? [];
  const next = adding
    ? [...new Set([...current, target.id])]
    : current.filter((id) => id !== target.id);
  if (adding && next.length > 200) {
    await say(rt, msg.chat.id, "白名单最多 200 人。", { replyTo: msg.message_id });
    return true;
  }
  const saved = await rt.saveConfig(msg.chat.id, { adWhitelist: next });
  if (saved.error) {
    await say(rt, msg.chat.id, `没成功：${saved.error}`, { replyTo: msg.message_id });
    return true;
  }
  if (adding) {
    await say(
      rt,
      msg.chat.id,
      `已加入广告白名单（${next.length} 人）：此人的关键词命中只记录、不删除。`,
      { replyTo: msg.message_id },
    );
  } else {
    const removed = current.includes(target.id);
    await say(rt, msg.chat.id, removed ? "已移出广告白名单。" : "这个人不在白名单里。", {
      replyTo: msg.message_id,
    });
  }
  return true;
}

/** `/words [天数]` — today's hot words plus how much the group talked. */
async function cmdWords(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const days = Math.max(1, Math.min(Number(input.args.trim().split(/\s+/)[0]) || 1, 30));
  const day = dayKey(rt.now(), rt.tzOffset);
  await flushWords(rt, msg.chat.id).catch(() => 0);
  const top = await wordTop(rt.db, msg.chat.id, day, 15).catch(() => []);
  const totals = await wordDayTotals(rt.db, msg.chat.id, days).catch(() => []);
  const lines: string[] = [];
  if (top.length) {
    lines.push(`今天的热词（${day}）：`);
    lines.push(top.map((row, index) => `${index + 1}. ${row.word} ${row.count}`).join("　"));
  } else {
    lines.push("今天还没有足够的热词（同一个词至少出现在 2 条消息里才算）。");
  }
  if (days > 1 && totals.length) {
    lines.push(
      `近 ${days} 天：${totals.map((row) => `${row.day.slice(5)} ${row.words} 词`).join("｜")}`,
    );
  }
  await say(rt, msg.chat.id, lines.join("\n"), { replyTo: msg.message_id });
  return true;
}

/**
 * `/parse` — the media behind a share link.
 *
 * The URL comes from the argument or from the message being replied to, which
 * is the natural gesture: someone drops a 抖音 link, an admin replies "这是啥"
 * with `/parse`. Both the Worker and the self-hosted build answer; only the
 * quality of the answer differs, and the reply says which one you got.
 */
async function cmdParse(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const usage = "用法：/parse 链接，或回复一条带链接的消息。支持抖音 / 小红书 / X / B 站。";

  const argument = input.args.trim();
  const fromArgs = argument ? extractUrls(argument) : [];
  const replied = msg.reply_to_message;
  const candidates = fromArgs.length
    ? fromArgs
    : extractUrls(replied?.text ?? replied?.caption ?? "", [
        ...(replied?.entities ?? []),
        ...(replied?.caption_entities ?? []),
      ]);

  if (!candidates.length) {
    await say(rt, msg.chat.id, usage, { replyTo: msg.message_id });
    return true;
  }

  const url = candidates[0];
  const site = detectSite(url);
  if (!site) {
    const hosts = candidates
      .map((item) => parseUrl(item)?.hostname)
      .filter(Boolean)
      .join("、");
    await say(
      rt,
      msg.chat.id,
      `不支持这个站点${hosts ? `（${hosts}）` : ""}。只认抖音 / 小红书 / X / B 站。`,
      {
        replyTo: msg.message_id,
      },
    );
    return true;
  }

  // Breaker check FIRST, and with `retryAfterMs` rather than `allow()`: `allow()`
  // consumes the half-open probe token, so calling it here and again inside
  // `runParseJob` would refuse the very first attempt at recovery. Order matters
  // for a second reason — a chat hammering a blocked host must not burn its
  // hourly budget to learn that the host is still down.
  const host = parseHostOf(url);
  const wait = host ? parseBreakerFor(rt).retryAfterMs(host) : 0;
  if (wait > 0) {
    await say(rt, msg.chat.id, `${parseBlockedNotice(host, wait)}\n原消息保留。`, {
      replyTo: msg.message_id,
    });
    return true;
  }

  if (!allowParse(rt, msg.chat.id, config.parsePerHour)) {
    await say(
      rt,
      msg.chat.id,
      `本小时解析次数已用完（上限 ${config.parsePerHour} 次），稍后再试。`,
      { replyTo: msg.message_id },
    );
    return true;
  }

  const jobId = await enqueueParse(rt, {
    chatId: msg.chat.id,
    userId: msg.from?.id ?? 0,
    messageId: msg.message_id,
    url,
    site,
  });
  const outcome = await runParseJob(rt, {
    id: jobId,
    chatId: msg.chat.id,
    messageId: msg.message_id,
    url,
    site,
  });
  if (!outcome.ok) {
    const how = outcome.mode === "full" ? "解析失败" : "只拿到预览，且失败了";
    await say(rt, msg.chat.id, `${how}：${outcome.error || "未知原因"}。原消息保留。`, {
      replyTo: msg.message_id,
    });
    return true;
  }
  // Preview mode says what it is inside the card instead of firing a second
  // message after the media: one reply per command is the whole contract.
  return true;
}

async function cmdLogs(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const value = input.args.trim();
  if (!value) {
    await say(rt, msg.chat.id, `记录目标：${config.logChatId || rt.env.LOG_CHAT_ID || "未设置"}`, {
      replyTo: msg.message_id,
    });
    return true;
  }
  if (value.toLowerCase() === "off") {
    await rt.saveConfig(msg.chat.id, { logChatId: "" });
    await say(rt, msg.chat.id, "已关闭记录（若部署里配了 LOG_CHAT_ID，会继续发到那里）。", {
      replyTo: msg.message_id,
    });
    return true;
  }
  if (!/^-?\d+$/.test(value)) {
    await say(rt, msg.chat.id, "请给频道或群的数字 ID，或 /logs off", { replyTo: msg.message_id });
    return true;
  }
  await rt.saveConfig(msg.chat.id, { logChatId: value });
  await say(rt, msg.chat.id, `记录会发到 ${value}（记得把我加进去并给发消息权限）。`, {
    replyTo: msg.message_id,
  });
  return true;
}

async function cmdNight(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const parts = input.args.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    const state = config.nightMode ? `${config.nightStart}–${config.nightEnd}` : "关";
    const nowIn =
      config.nightMode && inNightWindow(rt.now(), config.nightStart, config.nightEnd, rt.tzOffset);
    await say(
      rt,
      msg.chat.id,
      `夜间模式：${state}${config.nightMode ? `（当前${nowIn ? "在" : "不在"}夜间）` : ""}`,
      {
        replyTo: msg.message_id,
      },
    );
    return true;
  }
  const head = parts[0].toLowerCase();
  if (["on", "off"].includes(head)) {
    await rt.saveConfig(msg.chat.id, { nightMode: head === "on" });
    await say(rt, msg.chat.id, `夜间模式已${head === "on" ? "打开" : "关闭"}。`, {
      replyTo: msg.message_id,
    });
    return true;
  }
  const range = parts[0].match(/^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/);
  if (!range) {
    await say(rt, msg.chat.id, "用法：/nightmode on|off，或 /nightmode 23:00-07:00", {
      replyTo: msg.message_id,
    });
    return true;
  }
  await rt.saveConfig(msg.chat.id, {
    nightMode: true,
    nightStart: `${range[1]}:${range[2]}`,
    nightEnd: `${range[3]}:${range[4]}`,
  });
  await say(
    rt,
    msg.chat.id,
    `夜间模式：${range[1]}:${range[2]}–${range[3]}:${range[4]}，期间只有管理员能发言。`,
    {
      replyTo: msg.message_id,
    },
  );
  return true;
}

async function cmdTrust(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const target = parseTarget(msg, input.args);
  if (!target.id) {
    await say(rt, msg.chat.id, "请回复要信任的人。", { replyTo: msg.message_id });
    return true;
  }
  await unmute(rt, msg.chat.id, target.id);
  await trustAdd(rt.db, msg.chat.id, target.id, rt.now()).catch(() => undefined);
  await record(rt, {
    chatId: msg.chat.id,
    userId: target.id,
    kind: "trust",
    reason: "管理员信任",
    byId: msg.from?.id,
  });
  await say(rt, msg.chat.id, "已信任：不再走新人限制。", { replyTo: msg.message_id });
  return true;
}

/**
 * `/schedule 3600 文本` or `/schedule del ID`.
 *
 * The 60-second floor is deliberate: the cron fires once a minute, so anything
 * shorter promises a precision the platform cannot deliver.
 */
async function cmdSchedule(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const args = input.args.trim();
  if (!args || args.toLowerCase() === "list") {
    const rows = await scheduleList(rt.db, msg.chat.id);
    if (!rows.length) {
      await reply(input, "还没有定时消息。用法：/schedule 3600 文本（间隔秒，0=只发一次）");
      return true;
    }
    const lines = rows.map(
      (row: { id: number; every: number; nextAt: number; enabled: number; text: string }) => {
        const when = new Date(row.nextAt + rt.tzOffset * 60_000)
          .toISOString()
          .slice(0, 16)
          .replace("T", " ");
        return `#${row.id} ${row.every > 0 ? `每 ${row.every}s` : "一次"} · ${row.enabled ? `下次 ${when}` : "已停用"} · ${row.text.slice(0, 30)}`;
      },
    );
    await say(rt, msg.chat.id, ["定时消息：", ...lines, "", "删除：/schedule del ID"].join("\n"), {
      replyTo: msg.message_id,
    });
    return true;
  }

  if (args.toLowerCase().startsWith("del")) {
    const id = Number(args.split(/\s+/)[1]);
    if (!Number.isFinite(id)) {
      await reply(input, "用法：/schedule del ID");
      return true;
    }
    await scheduleDelete(rt.db, id, msg.chat.id);
    await reply(input, `已删除 #${id}。`);
    return true;
  }

  const match = args.match(/^(\d+)\s+([\s\S]+)$/);
  if (!match) {
    await reply(input, "用法：/schedule 3600 文本（间隔秒，0=只发一次）");
    return true;
  }
  const every = Math.max(0, Math.min(Number(match[1]), 30 * 86_400));
  const text = (match[2] ?? "").trim().slice(0, 3000);
  if (!text) {
    await reply(input, "内容不能为空。");
    return true;
  }
  await scheduleAdd(rt.db, {
    chatId: msg.chat.id,
    text,
    every,
    nextAt: rt.now() + 60_000,
    createdBy: msg.from?.id ?? 0,
  });
  await reply(input, `已排期：${every > 0 ? `每 ${every} 秒` : "只发一次"}，1 分钟后开始。`);
  return true;
}

// ---------------------------------------------------------------------------
// Notes, filters, stats, export/import
// ---------------------------------------------------------------------------

async function handleNoteRead(input: CommandInput, name: string): Promise<boolean> {
  const { rt, msg } = input;
  if (name === "notes") {
    const list = await noteList(rt.db, msg.chat.id);
    await say(
      rt,
      msg.chat.id,
      list.length
        ? `本群有 ${list.length} 条：${list.map((n) => n.name).join("、")}`
        : "本群还没有保存的说明。",
      {
        replyTo: msg.message_id,
      },
    );
    return true;
  }
  const key = input.args.trim().split(/\s+/)[0];
  if (!key) {
    await say(rt, msg.chat.id, "用法：/get 名字", { replyTo: msg.message_id });
    return true;
  }
  const note = await noteGet(rt.db, msg.chat.id, key.toLowerCase());
  await say(rt, msg.chat.id, note ? note.content : `没有叫「${key}」的说明。`, {
    replyTo: msg.message_id,
  });
  return true;
}

async function handleNoteWrite(input: CommandInput, name: string): Promise<boolean> {
  const { rt, msg } = input;
  if (name === "delnote") {
    const key = input.args.trim().toLowerCase();
    if (!key) {
      await reply(input, "用法：/delnote 名字");
      return true;
    }
    await noteDelete(rt.db, msg.chat.id, key);
    await say(rt, msg.chat.id, `已删除「${key}」。`, { replyTo: msg.message_id });
    return true;
  }
  const [rawName, ...rest] = input.args.trim().split(/\s+/);
  if (!rawName) {
    await reply(input, "用法：/save 名字 内容（或回复一条消息 /save 名字）");
    return true;
  }
  const key = rawName.toLowerCase().slice(0, 40);
  const content = rest.join(" ").trim() || (msg.reply_to_message?.text ?? "").trim();
  if (!content) {
    await reply(input, "内容不能是空的。");
    return true;
  }
  await noteSave(rt.db, {
    chatId: msg.chat.id,
    name: key,
    content: content.slice(0, 3500),
    createdBy: msg.from?.id ?? 0,
    at: rt.now(),
  });
  await say(rt, msg.chat.id, `已保存「${key}」。任何人都可以用 /get ${key} 看。`, {
    replyTo: msg.message_id,
  });
  return true;
}

async function handleFilters(input: CommandInput, name: string): Promise<boolean> {
  const { rt, msg } = input;
  if (name === "filters") {
    const list = await filterList(rt.db, msg.chat.id);
    if (!list.length) {
      await reply(input, "还没有自动回复。用法：/filter add exact 你好 => 你也好");
      return true;
    }
    await say(
      rt,
      msg.chat.id,
      list.map((f) => `#${f.id} [${f.match}] ${f.trigger} → ${f.response.slice(0, 40)}`).join("\n"),
      {
        replyTo: msg.message_id,
      },
    );
    return true;
  }
  if (name === "delfilter") {
    const id = Number(input.args.trim().split(/\s+/)[0]);
    if (!Number.isFinite(id)) {
      await reply(input, "用法：/delfilter ID（用 /filters 看 ID）");
      return true;
    }
    await filterDelete(rt.db, msg.chat.id, id);
    await say(rt, msg.chat.id, "已删除。", { replyTo: msg.message_id });
    return true;
  }

  const args = input.args.trim();
  if (!args.toLowerCase().startsWith("add")) {
    await reply(input, "用法：/filter add exact|prefix|regex 触发词 => 回复");
    return true;
  }
  const body = args.slice(3).trim();
  const [head, ...tail] = body.split("=>");
  if (!head || !tail.length) {
    await reply(input, "格式：/filter add exact 触发词 => 回复内容");
    return true;
  }
  const headParts = head.trim().split(/\s+/);
  const mode = (headParts[0] ?? "exact").toLowerCase() as FilterMatchMode;
  if (!MATCH_MODES.includes(mode)) {
    await reply(input, `匹配方式只能是 ${MATCH_MODES.join("/")}`);
    return true;
  }
  const trigger = headParts.slice(1).join(" ").trim();
  if (!trigger) {
    await reply(input, "触发词不能为空。");
    return true;
  }
  const response = tail.join("=>").trim();
  if (!response) {
    await reply(input, "回复内容不能为空。");
    return true;
  }

  await filterAdd(rt.db, {
    chatId: msg.chat.id,
    trigger: trigger.slice(0, 200),
    match: mode,
    response: response.slice(0, 1000),
    createdBy: msg.from?.id ?? 0,
    at: rt.now(),
  });
  await say(rt, msg.chat.id, `已添加自动回复：[${mode}] ${trigger}`, { replyTo: msg.message_id });
  return true;
}

async function handleStats(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const days = Math.max(1, Math.min(Number(input.args.trim().split(/\s+/)[0]) || 7, 90));
  await say(rt, msg.chat.id, await statsText(rt, msg.chat.id, days), { replyTo: msg.message_id });
  return true;
}

// ---------------------------------------------------------------------------
// Audit: /actions and /warns read the events table the console already shows,
// so an admin can answer "上周谁踢了谁" without opening a web page.
// ---------------------------------------------------------------------------

const stamp = (rt: Runtime, at: number): string =>
  new Date(at + rt.tzOffset * 60_000).toISOString().slice(5, 16).replace("T", " ");

function eventLine(row: { kind: string; reason: string; byId: number }): string {
  const kind = KIND_LABELS[row.kind] ?? row.kind;
  const reason = row.reason && row.reason !== kind ? ` ${row.reason}` : "";
  const by = row.byId ? `（操作人 ${row.byId}）` : "";
  return `${kind}${reason}${by}`;
}

async function cmdActions(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const limit = Math.max(1, Math.min(Number(input.args) || 10, 50));
  const rows = await recentEvents(rt.db, msg.chat.id, limit);
  if (!rows.length) return reply(input, "最近还没有记录。");
  const lines = rows.map((row) => `· ${stamp(rt, row.at)} ${eventLine(row)}`);
  return reply(input, [`最近 ${rows.length} 条动作：`, ...lines].join("\n"));
}

async function cmdWarns(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const replied = msg.reply_to_message?.from;
  const argId = Number((input.args || "").trim());
  const userId = replied?.id ?? (Number.isFinite(argId) && argId > 0 ? argId : 0);
  if (!userId) return reply(input, "用法：/warns 用户ID，或回复一条消息。");
  const rows = await userEvents(rt.db, msg.chat.id, userId, 20);
  if (!rows.length) return reply(input, `没有找到 ${userId} 的记录。`);
  const lines = rows.map((row) => `· ${stamp(rt, row.at)} ${eventLine(row)}`);
  return reply(input, [`用户 ${userId} 的最近 ${rows.length} 条记录：`, ...lines].join("\n"));
}

/**
 * `/login <code>` — approve the web console's login code.
 *
 * The command is admin-gated (readOnly in the spec = isAdmin check), so an
 * approved code means "a known admin vouched for that browser". The code itself
 * stays one-shot: the browser consumes it on first login.
 */
async function cmdLogin(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const code = input.args.trim();
  if (!/^\d{6}$/.test(code)) return reply(input, "用法：/login 6 位数字码（网页后台登录页生成）。");
  const approved = await approveLoginCode(rt, code, msg.from?.id ?? 0, msg.from?.first_name ?? "");
  if (!approved) return reply(input, "码不对、已过期或已被批准过。请在网页上重新生成。");
  return reply(input, "已批准。回到网页登录页，几秒内会自动进入后台。");
}

/** `/top [人数]` — today's speaking leaderboard; the same text `{{top}}` posts. */
async function cmdTop(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const limit = Math.max(3, Math.min(Number(input.args) || 10, 30));
  return reply(input, leaderboardText(await leaderboard(rt, msg.chat.id, limit)));
}

/**
 * `/ocr` — reply to an image and read the text off it.
 *
 * Two decisions worth keeping:
 *
 *  - an image sent *as a file* is read from the document itself, not from its
 *    thumbnail. `visionSubject` prefers thumbnails because moderation only needs
 *    to find a QR code; transcription needs pixels, and a 90x90 thumbnail of a
 *    screenshot is unreadable.
 *  - the recognised text is screened by `recognizeAndScreen`, which applies the
 *    same keyword policy as a text message (whitelist, admin exemption, ladder).
 *    So `/ocr` cannot be used as a way to *see* what other people's ads say while
 *    leaving the ad in place — the disposal happens first, the transcript after.
 */
/**
 * Download ceiling for OCR.
 *
 * Deliberately a local constant instead of importing `OCR_MAX_BYTES` from
 * `src/tools/ocr.node.ts`: that module imports `node:child_process`, and this
 * file is reachable from `src/worker.ts`. Importing the constant would drag the
 * whole adapter — and the Worker build — into a Node-only dependency. The two
 * numbers are asserted equal in `test/worker-compat.test.ts` instead.
 */
const OCR_COMMAND_MAX_BYTES = 10 * 1024 * 1024;

async function cmdOcr(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const target = msg.reply_to_message;
  if (!target) return reply(input, "用法：/ocr —— 回复一张图片，我把上面的文字读出来。");

  if (!ocrAvailable(rt)) return reply(input, WORKER_OCR_REASON);

  // Every call spawns a tesseract process. `allowTool` is the same per-member
  // budget the PDF/slice toolbox uses, so one member cannot pin the CPU.
  if (!allowTool(rt, msg.from?.id ?? 0)) return reply(input, "用得太频繁了，过几分钟再试。");

  const subject = ocrSubject(target);
  if (!subject) return reply(input, "这条消息里没有图片。回复一张图片或图片文件再试。");

  const file = await rt.api.download(subject.fileId, OCR_COMMAND_MAX_BYTES);
  if (!file.ok) return reply(input, `取图片失败：${file.error}`);

  const run = await recognizeAndScreen(rt, msg.chat.id, file.bytes, target);
  if (!run.ok) return reply(input, `没认出文字：${run.error}`);

  const text = run.text.trim();
  if (!text) return reply(input, "这张图上没有能认出来的文字。");

  if (run.screen.hit) {
    const errors = run.screen.errors.length
      ? `（部分操作没成功：${run.screen.errors.join("；")}）`
      : "";
    return reply(input, `${run.screen.reason}，已按群规处置${errors}`);
  }

  // Echoing the text is the point of the command, but it is attacker-supplied
  // content rendered into a message: escape it and cap it, and never `reply`
  // (which would quote the original image back into the chat).
  const shown = text.length > 600 ? `${text.slice(0, 600)}…` : text;
  await say(rt, msg.chat.id, `<b>图上的文字</b>\n<pre>${escapeHtml(shown)}</pre>`, {
    replyTo: msg.message_id,
    html: true,
  });
  return true;
}

/**
 * Which file to transcribe.
 *
 * A photo has several sizes and the largest is correct. A document is taken
 * as-is when it is an image — that is how screenshots get sent "without
 * compression", and it is the case where OCR quality matters most.
 */
function ocrSubject(msg: TgMessage): { fileId: string; mime: string } | null {
  const doc = msg.document;
  if (doc && typeof doc.mime_type === "string" && doc.mime_type.startsWith("image/")) {
    return { fileId: doc.file_id, mime: doc.mime_type };
  }
  const subject = visionSubject(msg);
  if (!subject) return null;
  // Stickers and video thumbnails are not worth transcribing: they are tiny and
  // the text on them is usually a watermark, not content.
  if (subject.kind !== "photo") return null;
  return { fileId: subject.fileId, mime: subject.mime };
}

/**
 * `/sub` `/unsub` `/unsubthis` — feed subscriptions.
 *
 * Admin-only (`can_change_info`), because subscribing makes the deployment fetch
 * a URL the caller chose, from the deployment's own egress IP. The SSRF guard in
 * `rss.ts` refuses private hosts, but "who may point the bot at a public host"
 * is still a permission question, not a parsing one.
 *
 * `/sub export` is where OPML lives rather than a bare `/export`: that name is
 * already the config JSON export, shipped and covered by tests. Reusing it would
 * have silently changed what existing admins get.
 */
async function cmdRss(input: CommandInput, name: string): Promise<boolean> {
  const { rt, msg } = input;

  if (name === "unsubthis") {
    return reply(input, await cmdUnsubThis(rt, msg.chat.id, msg.reply_to_message));
  }

  if (name === "unsub") {
    return reply(input, await cmdUnsub(rt, msg.chat.id, input.args));
  }

  const [action, ...rest] = input.args.trim().split(/\s+/).filter(Boolean);
  if ((action ?? "").toLowerCase() === "export") {
    if (!rssAvailable(rt)) return reply(input, "RSS 轮询需要自托管部署，当前 Worker 形态不支持");
    // Chunked sending: twenty feeds with long titles exceed Telegram's 4096-char
    // message limit, and OPML is meant to be imported, not truncated.
    const sent = await sendRssExport(rt, msg.chat.id, msg.chat.title ?? "");
    if (!sent.ok) return reply(input, `导出没发出去：${sent.error}`);
    return true;
  }
  if ((action ?? "").toLowerCase() === "list" || !action) {
    return reply(input, await cmdSubList(rt, msg.chat.id));
  }

  return reply(input, await cmdSub(rt, msg.chat.id, [action, ...rest].join(" ")));
}

async function cmdExport(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const notes = await noteList(rt.db, msg.chat.id);
  const filters = await filterList(rt.db, msg.chat.id);
  const payload = JSON.stringify(
    {
      v: 1,
      config,
      notes: notes.map((n) => ({ name: n.name, content: n.content })),
      filters: filters.map((f) => ({ trigger: f.trigger, match: f.match, response: f.response })),
    },
    null,
    0,
  );
  // 4096 is Telegram's message limit; a rule set that big is chunked rather
  // than truncated so nothing silently disappears from an export.
  const chunks: string[] = [];
  for (let i = 0; i < payload.length; i += 3500) chunks.push(payload.slice(i, i + 3500));
  for (const chunk of chunks.slice(0, 4)) await say(rt, msg.chat.id, chunk);
  if (chunks.length > 4)
    await say(rt, msg.chat.id, "规则太大，导出被截断，请先删掉一些说明或自动回复。");
  return true;
}

async function cmdImport(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const raw = (input.args.trim() || msg.reply_to_message?.text || "").trim();
  if (!raw) {
    await reply(input, "用法：/import <JSON>（先 /export 拿到 JSON）");
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await reply(input, "不是合法 JSON。");
    return true;
  }
  const data = parsed as {
    config?: Record<string, unknown>;
    notes?: { name?: string; content?: string }[];
    filters?: { trigger?: string; match?: string; response?: string }[];
  };
  let applied = 0;
  if (data.config && typeof data.config === "object") {
    const safe = { ...data.config };
    // Never import a log target: it would send another group's audit trail here.
    delete safe.logChatId;
    const saved = await rt.saveConfig(msg.chat.id, safe);
    if (saved.error) {
      await reply(input, `配置没导入：${saved.error}`);
      return true;
    }
    applied += 1;
  }
  const noteRows = (Array.isArray(data.notes) ? data.notes : []) as {
    name?: string;
    content?: string;
  }[];
  for (const row of noteRows) {
    const name = String(row?.name ?? "")
      .toLowerCase()
      .slice(0, 40);
    const content = String(row?.content ?? "").slice(0, 3500);
    if (!name || !content) continue;
    await noteSave(rt.db, {
      chatId: msg.chat.id,
      name,
      content,
      createdBy: msg.from?.id ?? 0,
      at: rt.now(),
    });
    applied += 1;
  }

  const filterRows = (Array.isArray(data.filters) ? data.filters : []) as {
    trigger?: string;
    match?: string;
    response?: string;
  }[];
  for (const row of filterRows) {
    const trigger = String(row?.trigger ?? "").slice(0, 200);
    const response = String(row?.response ?? "").slice(0, 1000);
    if (!trigger || !response) continue;
    const mode = String(row?.match ?? "exact") as FilterMatchMode;
    if (!MATCH_MODES.includes(mode)) continue;
    await filterAdd(rt.db, {
      chatId: msg.chat.id,
      trigger,
      match: mode,
      response,
      createdBy: msg.from?.id ?? 0,
      at: rt.now(),
    });
    applied += 1;
  }

  await say(rt, msg.chat.id, `已导入 ${applied} 项。`, { replyTo: msg.message_id });
  return true;
}

// ---------------------------------------------------------------------------

async function reply(input: CommandInput, text: string): Promise<boolean> {
  await say(input.rt, input.msg.chat.id, text, { replyTo: input.msg.message_id });
  return true;
}

async function report(input: CommandInput, ok: boolean, text: string): Promise<void> {
  await say(input.rt, input.msg.chat.id, ok ? text : `没成功：${text}`, {
    replyTo: input.msg.message_id,
  });
}

export { guardTarget, unmute };

// ---------------------------------------------------------------------------
// R1: shadow bans
// ---------------------------------------------------------------------------

async function cmdBlock(input: CommandInput, blocking: boolean): Promise<boolean> {
  const { rt, msg } = input;
  const target = parseTarget(msg, input.args);
  if (!target.id) {
    await say(
      rt,
      msg.chat.id,
      `用法：回复一条消息发 /${blocking ? "block" : "unblock"}，或 /${blocking ? "block" : "unblock"} 用户ID`,
      {
        replyTo: msg.message_id,
      },
    );
    return true;
  }
  if (blocking && !(await guardTarget(rt, msg, target.id))) return true;

  if (blocking) {
    const reason = input.args.replace(String(target.id), "").trim().slice(0, 200) || "管理员屏蔽";
    await block(rt, msg.chat.id, target.id, reason, msg.from?.id ?? 0);
    await record(rt, {
      chatId: msg.chat.id,
      userId: target.id,
      kind: "block",
      reason,
      byId: msg.from?.id,
    });
    await say(
      rt,
      msg.chat.id,
      `已屏蔽 <code>${target.id}</code>：之后它的消息会被静默删除，不会收到任何提示。`,
      {
        replyTo: msg.message_id,
        html: true,
      },
    );
    return true;
  }

  await unblock(rt, msg.chat.id, target.id);
  await record(rt, {
    chatId: msg.chat.id,
    userId: target.id,
    kind: "trust",
    reason: "解除屏蔽",
    byId: msg.from?.id,
  });
  await say(rt, msg.chat.id, `已解除屏蔽 <code>${target.id}</code>。`, {
    replyTo: msg.message_id,
    html: true,
  });
  return true;
}

async function cmdBlocks(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const rows = await listBlocked(rt, msg.chat.id);
  if (!rows.length) {
    await say(rt, msg.chat.id, "本群没有屏蔽成员。用法：回复消息发 /block", {
      replyTo: msg.message_id,
    });
    return true;
  }
  const lines = [`本群屏蔽 ${rows.length} 人：`];
  for (const row of rows.slice(0, 30)) {
    const when = new Date(row.at + rt.tzOffset * 60_000)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");
    lines.push(`· <code>${row.userId}</code> ${when} ${row.reason || ""}`.trim());
  }
  if (rows.length > 30) lines.push(`…还有 ${rows.length - 30} 人，见后台`);
  lines.push("解除：/unblock 用户ID");
  await say(rt, msg.chat.id, lines.join("\n"), { replyTo: msg.message_id, html: true });
  return true;
}

// ---------------------------------------------------------------------------
// R2: channel mirrors
// ---------------------------------------------------------------------------

export function parseSyncInterval(raw: string | undefined): number | null {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!value || value === "instant" || value === "即时") return 0;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return Math.max(60, Math.min(Math.round(seconds), 86_400));
}

async function cmdSync(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const [sub, ...rest] = input.args.trim().split(/\s+/).filter(Boolean);
  const action = (sub ?? "list").toLowerCase();

  if (action === "list" || !sub) {
    const rows = await syncList(rt.db, msg.chat.id);
    if (!rows.length) {
      return (
        say(
          rt,
          msg.chat.id,
          "还没有同步。用法：/sync add @频道 300（秒），或 /sync add @频道 instant",
          {
            replyTo: msg.message_id,
          },
        ),
        true
      );
    }
    const lines = ["本群同步任务："];
    for (const row of rows) lines.push(`· @${row.source} — ${describeSync(row)}`);
    lines.push("改间隔：/sync add @频道 600｜停用：/sync off @频道｜删除：/sync del @频道");
    await say(rt, msg.chat.id, lines.join("\n"), { replyTo: msg.message_id });
    return true;
  }

  if (action === "del" || action === "remove") {
    const source = normalizeChannel(rest[0] ?? "");
    if (!source) return reply(input, "给一个频道用户名，例如 /sync del @my_channel");
    await syncDelete(rt.db, msg.chat.id, source);
    await say(rt, msg.chat.id, `已删除 @${source} 的同步。`, { replyTo: msg.message_id });
    return true;
  }

  if (action === "off" || action === "on") {
    const source = normalizeChannel(rest[0] ?? "");
    if (!source) return reply(input, `给一个频道用户名，例如 /sync ${action} @my_channel`);
    await syncEnable(rt.db, msg.chat.id, source, action === "on");
    await say(rt, msg.chat.id, `@${source} 的同步已${action === "on" ? "启用" : "停用"}。`, {
      replyTo: msg.message_id,
    });
    return true;
  }

  if (action !== "add")
    return reply(
      input,
      "用法：/sync add @频道 [间隔秒|instant]｜/sync list｜/sync on|off @频道｜/sync del @频道",
    );

  const source = normalizeChannel(rest[0] ?? "");
  if (!source)
    return reply(input, "频道用户名不合法。给 @name 或 https://t.me/name（私有邀请链接不行）。");
  const interval = parseSyncInterval(rest[1]);
  if (interval === null) return reply(input, "间隔要写秒数（≥60）或 instant。");

  const chat = await rt.api.call<{ type: string; title?: string }>("getChat", {
    chat_id: `@${source}`,
  });
  if (!chat.ok) return reply(input, `读不到 @${source}：${chat.error}`);
  if (chat.result.type !== "channel")
    return reply(input, `@${source} 不是频道（类型 ${chat.result.type}）。`);

  if (interval === 0) {
    const me = await rt.api.call<{ status: string }>("getChatMember", {
      chat_id: `@${source}`,
      user_id: Number(rt.api.botId),
    });
    if (!me.ok || me.result.status !== "administrator") {
      return reply(
        input,
        `即时同步要求机器人是 @${source} 的管理员（当前：${me.ok ? me.result.status : "读不到"}）。`,
      );
    }
  }

  await syncUpsert(rt.db, { chatId: msg.chat.id, source, intervalSeconds: interval, at: rt.now() });
  const cadence = interval === 0 ? "即时（频道有新帖就转）" : `每 ${interval} 秒检查一次`;
  await say(
    rt,
    msg.chat.id,
    `已添加 @${source} → 本群，${cadence}。\n注意：机器人必须能读到该频道；私有频道要先把机器人加进去。`,
    {
      replyTo: msg.message_id,
    },
  );
  return true;
}

// ---------------------------------------------------------------------------
// R4: toolbox
// ---------------------------------------------------------------------------

async function handleToolCommand(input: CommandInput, name: string): Promise<boolean> {
  if (name === "tool") return cmdToolIndex(input);
  if (name === "ts") return cmdTimestamp(input);
  if (name === "expand") return cmdExpand(input);
  if (name === "splitpdf") return cmdSplitPdf(input);
  return cmdSlice(input);
}

async function cmdToolIndex(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const lines = ["工具箱（都只处理你回复的那条消息，不上传第三方）："];
  for (const tool of TOOLS) lines.push(`· ${tool.command} ${tool.usage} — ${tool.what}`);
  const stats = await toolStats(rt.db, msg.chat.id, rt.now() - 30 * 86_400_000).catch(() => []);
  if (stats.length) {
    lines.push("本群近 30 天：" + stats.map((row) => `${row.tool} ${row.runs} 次`).join("｜"));
  }
  await say(rt, msg.chat.id, lines.join("\n"), { replyTo: msg.message_id });
  return true;
}

async function cmdTimestamp(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const raw = input.args.trim();
  if (!raw) return reply(input, "用法：/ts 1700000000 或 /ts 2026-10-28 18:00");
  if (!allowTool(rt, msg.from?.id ?? 0, 8)) return reply(input, "太频繁了，等一分钟再试。");
  const view = convertTimestamp(raw, rt.tzOffset);
  if (!view)
    return reply(input, "认不出这个时间。支持 10 位秒、13 位毫秒、ISO，或 2026-10-28 18:00。");
  await say(
    rt,
    msg.chat.id,
    `Unix：${view.unix}\n毫秒：${view.ms}\nUTC：${view.iso}\n本地：${view.local}`,
    {
      replyTo: msg.message_id,
    },
  );
  return true;
}

async function cmdExpand(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const raw = input.args.trim() || msg.reply_to_message?.text?.trim() || "";
  if (!raw) return reply(input, "用法：/expand https://t.me/频道 或 /expand https://t.me/频道/123");
  if (!allowTool(rt, msg.from?.id ?? 0)) return reply(input, "太频繁了，等一分钟再试。");
  const result = await resolveTelegramLink(raw);
  if (!result.ok) return reply(input, `展开失败：${result.error}`);
  const info = result.info;
  const lines = [`频道：@${info.channel}`];
  if (info.post) lines.push(`帖子号：${info.post}`);
  if (info.title) lines.push(`标题：${info.title}`);
  if (info.excerpt) lines.push(`摘要：${info.excerpt}`);
  if (!info.public) lines.push("（预览页没有公开内容，可能是私有频道）");
  await say(rt, msg.chat.id, lines.join("\n"), { replyTo: msg.message_id });
  return true;
}

async function cmdSplitPdf(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const doc = msg.reply_to_message?.document;
  if (!doc) return reply(input, "回复一个 PDF 文件再发 /splitpdf。");
  const isPdf = /pdf/i.test(doc.mime_type ?? "") || /\.pdf$/i.test(doc.file_name ?? "");
  if (!isPdf) return reply(input, "这条不是 PDF。");
  if (Number(doc.file_size ?? 0) > MAX_PDF_BYTES) return reply(input, "PDF 超过 8MB，先压缩再发。");
  if (!allowTool(rt, msg.from?.id ?? 0)) return reply(input, "太频繁了，等一分钟再试。");

  const download = await rt.api.download(doc.file_id, MAX_PDF_BYTES);
  if (!download.ok) {
    await toolStatsLog(rt, msg, "splitpdf", false);
    return reply(input, `下载失败：${download.error}`);
  }

  if (looksEncrypted(download.bytes)) {
    await toolStatsLog(rt, msg, "splitpdf", false);
    return reply(input, "这个 PDF 有打开密码，先解锁再发（我不猜密码）。");
  }

  let pages: Awaited<ReturnType<typeof splitPdf>>;
  try {
    pages = await splitPdf(download.bytes);
  } catch (err) {
    await toolStatsLog(rt, msg, "splitpdf", false);
    return reply(input, `解析失败：${describePdfError(err)}`);
  }

  const total = pages[0]?.total ?? 0;
  if (total <= 1) return reply(input, "这个 PDF 只有一页，不用拆。");
  if (total > pages.length) {
    await say(rt, msg.chat.id, `共 ${total} 页，一次只发前 ${pages.length} 页。`, {
      replyTo: msg.message_id,
    });
  }

  let sent = 0;
  for (const page of pages) {
    const res = await rt.api.sendDocument(
      msg.chat.id,
      page.data,
      `page-${page.page}-of-${total}.pdf`,
      {
        replyTo: msg.message_id,
        caption: `第 ${page.page}/${total} 页`,
      },
    );
    if (!res.ok) {
      await say(rt, msg.chat.id, `第 ${page.page} 页没发出去：${res.error}`, {
        replyTo: msg.message_id,
      });
      break;
    }
    sent += 1;
  }
  await toolStatsLog(rt, msg, "splitpdf", sent > 0, sent);
  return true;
}

async function cmdSlice(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  if (!rt.sliceImage) {
    return reply(
      input,
      "长图切分需要自托管版（Worker 里没有图像处理原生库）。本机跑 npm run dev 时可用。",
    );
  }
  const photo = msg.reply_to_message?.photo?.at(-1) as
    { file_id: string; file_size?: number } | undefined;
  const doc = msg.reply_to_message?.document;
  const fileId = photo?.file_id ?? doc?.file_id;
  const looksImage = photo || /^image\//i.test(doc?.mime_type ?? "");
  if (!fileId || !looksImage) return reply(input, "回复一张图片（或图片文件）再发 /slice。");
  if (!allowTool(rt, msg.from?.id ?? 0)) return reply(input, "太频繁了，等一分钟再试。");

  const download = await rt.api.download(fileId, 20 * 1024 * 1024);
  if (!download.ok) {
    await toolStatsLog(rt, msg, "slice", false);
    return reply(input, `下载失败：${download.error}`);
  }

  let result: Awaited<ReturnType<NonNullable<Runtime["sliceImage"]>>>;
  try {
    result = await rt.sliceImage(download.bytes);
  } catch (err) {
    await toolStatsLog(rt, msg, "slice", false);
    return reply(input, err instanceof Error ? err.message : String(err));
  }

  const slices = result.slices;
  if (result.truncated) {
    // Never drop the bottom of somebody's screenshot without saying so.
    await say(rt, msg.chat.id, `这张图有 ${result.total} 段，一次只发前 ${slices.length} 段。`, {
      replyTo: msg.message_id,
    });
  }

  let sent = 0;
  for (const slice of slices) {
    const res = await rt.api.sendDocument(msg.chat.id, slice.data, `part-${slice.index}.png`, {
      replyTo: msg.message_id,
      caption: `第 ${slice.index}/${slices.length} 段`,
    });
    if (!res.ok) break;
    sent += 1;
  }
  await toolStatsLog(rt, msg, "slice", sent > 0, sent);
  return true;
}

async function toolStatsLog(
  rt: Runtime,
  msg: TgMessage,
  tool: string,
  ok: boolean,
  count = 0,
): Promise<void> {
  await import("../db/repo.ts")
    .then((repo) =>
      repo.toolLog(rt.db, {
        chatId: msg.chat.id,
        userId: msg.from?.id,
        tool,
        ok,
        bytes: count,
        at: rt.now(),
      }),
    )
    .catch(() => undefined);
}

export { TOOL_USAGE_LINE };

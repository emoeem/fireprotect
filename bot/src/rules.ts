/**
 * Per-chat configuration.
 *
 * Stored per chat, so changing a keyword never requires a redeploy. Validation
 * is a zod schema rather than hand-written coercion: every field a chat admin
 * can reach arrives over Telegram as free text, and a `NaN` reaching a Bot API
 * call is a silent ban that lasts forever.
 *
 * Two schemas, on purpose:
 *  - `configSchema` parses a full config (fills defaults) — used on read;
 *  - `configPatchSchema` validates a partial update — used on write. It is
 *    `configSchema.partial()`, and callers only copy back the keys the admin
 *    actually sent, so "absent" never means "reset to default".
 */
import { z } from "zod";

export const LOCK_KINDS = [
  "links",
  "photos",
  "videos",
  "stickers",
  "gifs",
  "files",
  "polls",
  "voice",
  "forwards",
  "invites",
  "mentions",
  "bots",
  "channels",
] as const;
export type LockKind = (typeof LOCK_KINDS)[number];

export const SPAM_ACTIONS = ["delete", "mute", "ban"] as const;
export type SpamAction = (typeof SPAM_ACTIONS)[number];

export const CAPTCHA_MODES = ["button", "math", "question"] as const;
export type CaptchaMode = (typeof CAPTCHA_MODES)[number];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Regex filter limits. Exported so `keywords.ts` validates against the same numbers. */
export const MAX_PATTERN_CHARS = 200;
export const MAX_PATTERNS = 20;

const strikeSchema = z.object({
  at: z.number().int().min(1).max(20),
  action: z.enum(["warn", "mute", "ban", "kick"]),
  minutes: z.number().int().min(0).max(525_600),
});

export type Strike = z.infer<typeof strikeSchema>;

export const configSchema = z.object({
  /** Master switch: off means the bot only answers admin commands. */
  enabled: z.boolean().default(true),
  // --- newcomer verification ------------------------------------------------
  captcha: z.boolean().default(true),
  captchaMode: z.enum(CAPTCHA_MODES).default("button"),
  /** Free-text answer for `question` mode; matched case-insensitively. */
  captchaAnswer: z.array(z.string().max(80)).max(20).default([]),
  captchaQuestion: z.string().max(200).default("本群的主题是什么？（回复答案即可）"),
  captchaPrompt: z.string().max(300).default("{name}，先完成验证。通过之前不能发言。"),
  captchaTimeout: z.number().int().min(30).max(86_400).default(900),
  /** Remove from the group when the window closes instead of leaving them muted. */
  captchaKick: z.boolean().default(true),

  // --- greetings ------------------------------------------------------------
  welcome: z.boolean().default(true),
  welcomeText: z.string().max(500).default("欢迎 {name}。群规就一句：不发广告、不转发来路不明的消息。"),
  farewell: z.boolean().default(false),
  farewellText: z.string().max(300).default("{name} 离开了 {chat}。"),
  deleteJoinMessages: z.boolean().default(true),

  // --- content rules --------------------------------------------------------
  keywords: z.array(z.string().min(1).max(80)).max(200).default(["加微信", "代理", "博彩", "日赚", "兼职刷单"]),
  locks: z.array(z.enum(LOCK_KINDS)).max(LOCK_KINDS.length).default(["links"]),
  /** 0 disables the length filter. */
  maxLength: z.number().int().min(0).max(4000).default(1200),
  /**
   * What a keyword hit does. `record` is the "show me, don't touch" mode an
   * admin uses for a week before committing to a rule.
   */
  keywordAction: z.enum(["delete", "mute", "record"]).default("delete"),
  /** Regular expressions, same match semantics as keywords. */
  keywordPatterns: z.array(z.string().min(1).max(MAX_PATTERN_CHARS)).max(MAX_PATTERNS).default([]),
  /** Sponsors: their keyword hits are recorded, never acted on. */
  adWhitelist: z.array(z.number().int().min(1)).max(200).default([]),

  // --- AI vision (optional, off by default) --------------------------------
  ai: z.boolean().default(false),
  aiProvider: z.enum(["generic", "cloud-vision"]).default("generic"),
  /** 0-100; a category must reach this to count as a hit. */
  aiMinScore: z.number().int().min(50).max(100).default(80),
  aiCategories: z.array(z.enum(["nsfw", "gambling", "ad", "qr"])).max(4).default(["nsfw", "gambling", "ad", "qr"]),
  /** Calls per day per chat; crossing it alerts once and stops calling. */
  aiDailyBudget: z.number().int().min(10).max(20_000).default(500),

  // --- link parsing (optional) ---------------------------------------------
  /** Parse supported links the moment they appear, without /parse. */
  parseAuto: z.boolean().default(false),
  parsePerHour: z.number().int().min(1).max(200).default(10),
  /** Daily hot-word counting. Cheap, but a group may not want it. */
  hotWords: z.boolean().default(true),

  // --- flood ----------------------------------------------------------------
  floodLimit: z.number().int().min(0).max(60).default(0),
  floodWindow: z.number().int().min(3).max(3600).default(10),

  // --- punishment -----------------------------------------------------------
  spamAction: z.enum(SPAM_ACTIONS).default("delete"),
  muteMinutes: z.number().int().min(1).max(10_080).default(30),
  /** Warnings before an automatic ban; 0 disables the flat escalation. */
  warnLimit: z.number().int().min(0).max(20).default(3),
  /** Ladder applied on top of warnings; empty means "use warnLimit only". */
  strikes: z.array(strikeSchema).max(10).default([
    { at: 1, action: "mute", minutes: 60 },
    { at: 2, action: "mute", minutes: 1440 },
    { at: 3, action: "ban", minutes: 0 },
  ]),

  // --- newbie window --------------------------------------------------------
  /** Hours after joining during which `newbieBlocks` applies; 0 disables. */
  newbieHours: z.number().int().min(0).max(720).default(24),
  newbieBlocks: z.array(z.enum(["links", "mentions"])).max(2).default(["links", "mentions"]),

  // --- join-rate (raid) protection -----------------------------------------
  /** Joins within `joinRateWindow` that trigger a batch response; 0 disables. */
  joinRateMax: z.number().int().min(0).max(200).default(0),
  joinRateWindow: z.number().int().min(5).max(600).default(30),
  joinRateAction: z.enum(["notify", "lock"]).default("notify"),

  // --- night mode -----------------------------------------------------------
  nightMode: z.boolean().default(false),
  nightStart: z.string().regex(HHMM).default("23:00"),
  nightEnd: z.string().regex(HHMM).default("07:00"),

  // --- external anti-spam ---------------------------------------------------
  cas: z.boolean().default(false),
  federation: z.boolean().default(false),

  /** Where moderation actions are reported; "" disables logging. */
  logChatId: z.string().regex(/^-?\d*$/).default(""),
});

export type ChatConfig = z.infer<typeof configSchema>;

export const configPatchSchema = configSchema.partial();
export type ConfigPatch = z.infer<typeof configPatchSchema>;

export const DEFAULT_CONFIG: ChatConfig = configSchema.parse({});

/** Fields `/set` accepts, with the one-line help shown when the syntax is wrong. */
export const SETTABLE: Record<string, string> = {
  enabled: "on/off — 本群总开关（关=只答命令，不处置）",
  captcha: "on/off — 新人验证",
  captchaMode: "button/math/question — 验证方式",
  captchaTimeout: "秒，30–86400 — 验证时限",
  captchaPrompt: "文字，可用 {name} {chat}",
  captchaQuestion: "文字 — question 模式的问题",
  captchaKick: "on/off — 超时移出群（off 只保持禁言）",
  welcome: "on/off — 欢迎语",
  welcomeText: "文字，可用 {name} {chat} {username} {id}",
  farewell: "on/off — 告别语",
  farewellText: "文字，占位符同上",
  deleteJoinMessages: "on/off — 删除「X 加入」系统消息",
  maxLength: "字数，0=关 — 超长拦截",
  floodLimit: "条数，0=关 — 刷屏上限",
  floodWindow: "秒 — 刷屏统计窗口",
  spamAction: "delete/mute/ban — 违规处置",
  muteMinutes: "分钟 — 默认禁言时长",
  warnLimit: "次数，0=关 — 警告满额封禁",
  newbieHours: "小时，0=关 — 新人限制窗口",
  joinRateMax: "人数，0=关 — 进群频率阈值",
  joinRateWindow: "秒 — 进群频率统计窗口",
  joinRateAction: "notify/lock — 触发后仅提醒或直接锁群",
  nightMode: "on/off — 夜间模式",
  nightStart: "HH:MM — 夜间开始",
  nightEnd: "HH:MM — 夜间结束",
  cas: "on/off — 接入 CAS 反垃圾库",
  federation: "on/off — 接入联邦黑名单",
  keywordAction: "delete/mute/record — 关键词命中后的动作",
  ai: "on/off — 图片视觉审核（需 VISION_KEY/VISION_URL）",
  aiProvider: "generic/cloud-vision — 视觉服务类型",
  aiMinScore: "50–100 — 判定阈值",
  aiDailyBudget: "次/天 — 视觉调用上限，超了告警并停用",
  parseAuto: "on/off — 自动解析群里的抖音/小红书/推特/B站链接",
  parsePerHour: "次 — 每群每小时解析上限",
  hotWords: "on/off — 每日热词统计",
  logChatId: "频道/群数字 ID，或 off",
};

const NUMBER_FIELDS = new Set([
  "captchaTimeout",
  "maxLength",
  "floodLimit",
  "floodWindow",
  "muteMinutes",
  "warnLimit",
  "newbieHours",
  "joinRateMax",
  "joinRateWindow",
  "aiMinScore",
  "aiDailyBudget",
  "parsePerHour",
]);

const BOOL_FIELDS = new Set([
  "enabled",
  "captcha",
  "captchaKick",
  "welcome",
  "farewell",
  "deleteJoinMessages",
  "nightMode",
  "cas",
  "federation",
  "ai",
  "parseAuto",
  "hotWords",
]);

/** Coerce one `/set` value the way the field's type demands. */
export function coerceField(field: string, raw: string): unknown {
  const text = raw.trim();
  if (NUMBER_FIELDS.has(field)) return Number(text);
  if (BOOL_FIELDS.has(field)) return ["on", "true", "1", "yes"].includes(text.toLowerCase());
  if (field === "logChatId") return text.toLowerCase() === "off" ? "" : text;
  return text;
}

/**
 * Merge a validated patch over `base`.
 *
 * Only keys present in `raw` survive: `configPatchSchema` fills defaults for
 * the rest, and copying those back would silently reset every rule the admin
 * did not mention in this one command.
 */
export function applyPatch(base: ChatConfig, raw: Record<string, unknown>): ChatConfig {
  if (!raw || typeof raw !== "object") return base;
  const parsed = configPatchSchema.safeParse(raw);
  if (!parsed.success) return base;
  const next: Record<string, unknown> = { ...base };
  for (const key of Object.keys(raw)) {
    const value = (parsed.data as Record<string, unknown>)[key];
    if (value !== undefined) next[key] = value;
  }
  return configSchema.parse(next);
}

/** First error message for a rejected patch, or "" when it parses. */
export function patchError(raw: Record<string, unknown>): string {
  const parsed = configPatchSchema.safeParse(raw);
  if (parsed.success) return "";
  const issue = parsed.error.issues[0];
  if (!issue) return "参数不合法";
  return `${issue.path.join(".") || "参数"}：${issue.message}`;
}

/**
 * Bring a stored config forward.
 *
 * Rules saved by the first release carry `filterLinks/filterForwards/
 * filterChannels` and no `locks`. Without this they would silently lose their
 * link filter on upgrade — the most common rule of all.
 */
export function normalizeLegacy(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const source = { ...(raw as Record<string, unknown>) };
  if (source.locks === undefined) {
    const locks: string[] = [];
    if (source.filterLinks === true) locks.push("links");
    if (source.filterForwards === true) locks.push("forwards");
    if (source.filterChannels === true) locks.push("channels");
    source.locks = locks;
  }
  delete source.filterLinks;
  delete source.filterForwards;
  delete source.filterChannels;
  return source;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const LOCK_LABELS: Record<LockKind, string> = {
  links: "链接",
  photos: "图片",
  videos: "视频",
  stickers: "贴纸",
  gifs: "动图",
  files: "文件",
  polls: "投票",
  voice: "语音",
  forwards: "转发",
  invites: "邀请链接",
  mentions: "提及",
  bots: "机器人消息",
  channels: "频道身份发言",
};

export function lockLabel(kind: string): string {
  return LOCK_LABELS[kind as LockKind] ?? kind;
}

export function parseKeywords(input: unknown, limit = 200): string[] {
  const parts = Array.isArray(input) ? input.map(String) : String(input ?? "").split(/[\n,，、]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const word = raw.trim();
    // An 80-character "keyword" is a paste accident that would match every
    // message in the group.
    if (!word || word.length > 80) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

export function describeConfig(config: ChatConfig): string[] {
  const lines: string[] = [];
  const mode = { button: "按钮", math: "算术", question: "问答题" }[config.captchaMode];
  lines.push(
    config.captcha
      ? `新人验证：开（${mode}），${Math.round(config.captchaTimeout / 60)} 分钟内完成，超时${config.captchaKick ? "移出" : "保持禁言"}。`
      : "新人验证：关，进群即可发言。",
  );
  lines.push(`欢迎语：${config.welcome ? "开" : "关"}｜告别语：${config.farewell ? "开" : "关"}`);
  if (config.keywords.length) {
    lines.push(`关键词 ${config.keywords.length} 个：${config.keywords.slice(0, 8).join("、")}${config.keywords.length > 8 ? "…" : ""}`);
  }
  const kinds = config.locks.map(lockLabel);
  if (config.maxLength > 0) kinds.push(`超过 ${config.maxLength} 字`);
  if (config.floodLimit > 0) kinds.push(`${config.floodWindow} 秒超过 ${config.floodLimit} 条`);
  lines.push(kinds.length ? `拦截：${kinds.join("、")}` : "拦截：只按关键词");
  const action =
    config.spamAction === "ban" ? "直接封禁" : config.spamAction === "mute" ? `禁言 ${config.muteMinutes} 分钟` : "只删除";
  lines.push(`违规处置：${action}`);
  if (config.strikes.length) {
    const ladder = config.strikes
      .map((s) => `${s.at}→${s.action === "mute" ? `禁言${s.minutes}分` : s.action}`)
      .join("，");
    lines.push(`阶梯：${ladder}`);
  } else if (config.warnLimit > 0) {
    lines.push(`警告：累计 ${config.warnLimit} 次自动封禁`);
  }
  if (config.newbieHours > 0) lines.push(`新人限制：入群 ${config.newbieHours} 小时内禁${config.newbieBlocks.map((b) => (b === "links" ? "链接" : "提及")).join("和")}`);
  if (config.joinRateMax > 0) lines.push(`进群限速：${config.joinRateWindow} 秒最多 ${config.joinRateMax} 人，超限${config.joinRateAction === "lock" ? "锁群" : "提醒"}`);
  if (config.nightMode) lines.push(`夜间模式：${config.nightStart}–${config.nightEnd} 只允许管理员发言`);
  if (config.keywordPatterns.length) lines.push(`正则：${config.keywordPatterns.length} 条`);
  if (config.keywordAction !== "delete") lines.push(`关键词命中：${config.keywordAction === "mute" ? "删除并禁言" : "只记录"}`);
  if (config.adWhitelist.length) lines.push(`广告白名单：${config.adWhitelist.length} 人（只记录）`);
  lines.push(`图片审核：${config.ai ? `开（${config.aiProvider}，阈值 ${config.aiMinScore}，预算 ${config.aiDailyBudget}/天）` : "关"}`);
  if (config.parseAuto) lines.push(`链接解析：开（${config.parsePerHour} 次/小时）`);
  const ext = [config.cas && "CAS", config.federation && "联邦"].filter(Boolean);
  lines.push(`外部库：${ext.length ? ext.join("、") : "全关"}`);
  lines.push(`记录：${config.logChatId || "未设置"}`);
  return lines;
}

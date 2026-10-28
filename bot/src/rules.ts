/**
 * Per-chat rules.
 *
 * The generator baked one configuration into the script, so changing a keyword
 * meant redeploying. Here every chat keeps its own rules in the store, the
 * environment only supplies defaults for chats that never said otherwise.
 */

export type SpamAction = "delete" | "mute" | "ban";

export type ChatRules = {
  /** New members are muted until they press the button. */
  captcha: boolean;
  /** Sent together with the button. Placeholders: {name} {chat} {username}. */
  captchaPrompt: string;
  /** Seconds a member has to press it before being removed. */
  captchaTimeout: number;
  welcome: boolean;
  welcomeText: string;
  /** Delete "X joined" service messages. */
  deleteJoinMessages: boolean;
  keywords: string[];
  filterLinks: boolean;
  filterForwards: boolean;
  filterChannels: boolean;
  /** 0 disables the length filter. */
  maxLength: number;
  /** Messages allowed per window; 0 disables flood control. */
  floodLimit: number;
  floodWindow: number;
  spamAction: SpamAction;
  muteMinutes: number;
  /** Warnings before an automatic ban; 0 disables the escalation. */
  warnLimit: number;
  /** Where moderation actions are reported; "" disables logging. */
  logChatId: string;
};

export const SPAM_ACTIONS: SpamAction[] = ["delete", "mute", "ban"];

export const DEFAULT_RULES: ChatRules = {
  captcha: true,
  captchaPrompt: "{name}，先点下面的按钮。通过之前不能发言。",
  captchaTimeout: 900,
  welcome: true,
  welcomeText: "欢迎 {name}。群规就一句：不发广告、不转发来路不明的消息。",
  deleteJoinMessages: true,
  keywords: ["加微信", "代理", "博彩", "日赚", "兼职刷单"],
  filterLinks: true,
  filterForwards: false,
  filterChannels: true,
  maxLength: 1200,
  floodLimit: 0,
  floodWindow: 10,
  spamAction: "delete",
  muteMinutes: 30,
  warnLimit: 3,
  logChatId: "",
};

/** Fields a chat is allowed to change from the chat itself. */
export const EDITABLE_FIELDS = [
  "captcha",
  "captchaPrompt",
  "captchaTimeout",
  "welcome",
  "welcomeText",
  "deleteJoinMessages",
  "keywords",
  "filterLinks",
  "filterForwards",
  "filterChannels",
  "maxLength",
  "floodLimit",
  "floodWindow",
  "spamAction",
  "muteMinutes",
  "warnLimit",
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "on" || value === "true" || value === "1") return true;
  if (value === "off" || value === "false" || value === "0") return false;
  return fallback;
}

export function parseKeywords(input: unknown, limit = 200): string[] {
  const parts = Array.isArray(input)
    ? input.map(String)
    : String(input ?? "").split(/[\n,，、]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const word = raw.trim();
    // A 200-character "keyword" is a paragraph; it would match everything and
    // is far more likely a paste accident than an intent.
    if (!word || word.length > 80) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Merge an untrusted partial rules object over `base`.
 *
 * Every field is coerced and bounded here, once: the stored value comes from a
 * chat admin (and, after a downgrade, possibly an older schema), so a bad value
 * must never reach a Telegram call as `NaN` or an unknown action.
 */
export function mergeRules(base: ChatRules, patch: Partial<Record<string, unknown>>): ChatRules {
  const next: ChatRules = { ...base };
  if (!patch || typeof patch !== "object") return next;

  next.captcha = asBool(patch.captcha, base.captcha);
  if (typeof patch.captchaPrompt === "string") {
    const prompt = patch.captchaPrompt.trim().slice(0, 300);
    if (prompt) next.captchaPrompt = prompt;
  }
  next.captchaTimeout = clampInt(patch.captchaTimeout, 30, 86_400, base.captchaTimeout);
  next.welcome = asBool(patch.welcome, base.welcome);
  if (typeof patch.welcomeText === "string") {
    const text = patch.welcomeText.trim().slice(0, 500);
    if (text) next.welcomeText = text;
  }
  next.deleteJoinMessages = asBool(patch.deleteJoinMessages, base.deleteJoinMessages);
  if (patch.keywords !== undefined) next.keywords = parseKeywords(patch.keywords);
  next.filterLinks = asBool(patch.filterLinks, base.filterLinks);
  next.filterForwards = asBool(patch.filterForwards, base.filterForwards);
  next.filterChannels = asBool(patch.filterChannels, base.filterChannels);
  // 0 is a meaningful value ("off"), so it must survive the clamp.
  const maxLength = clampInt(patch.maxLength, 0, 4000, base.maxLength);
  next.maxLength = maxLength === 0 ? 0 : Math.max(40, maxLength);
  next.floodLimit = clampInt(patch.floodLimit, 0, 60, base.floodLimit);
  next.floodWindow = clampInt(patch.floodWindow, 3, 3600, base.floodWindow);
  if (SPAM_ACTIONS.includes(patch.spamAction as SpamAction)) {
    next.spamAction = patch.spamAction as SpamAction;
  }
  next.muteMinutes = clampInt(patch.muteMinutes, 1, 10_080, base.muteMinutes);
  next.warnLimit = clampInt(patch.warnLimit, 0, 20, base.warnLimit);
  if (typeof patch.logChatId === "string") {
    next.logChatId = /^-?\d+$/.test(patch.logChatId.trim()) ? patch.logChatId.trim() : "";
  }
  return next;
}

/** Fill `{name}` / `{chat}` / `{username}` — no template engine, no evaluation. */
export function fillTemplate(template: string, user: { first_name?: string; username?: string } | undefined, chat: { title?: string } | undefined): string {
  const name = user?.first_name || user?.username || "新成员";
  const title = chat?.title || "本群";
  const username = user?.username ? "@" + user.username : name;
  return template.split("{name}").join(name).split("{chat}").join(title).split("{username}").join(username);
}

export function describeRules(rules: ChatRules): string[] {
  const lines: string[] = [];
  lines.push(rules.captcha ? `新人验证：开，${Math.round(rules.captchaTimeout / 60)} 分钟内点按钮，否则移出。` : "新人验证：关，进群即可发言。");
  lines.push(rules.welcome ? `欢迎语：${rules.welcome ? "开" : "关"}` : "欢迎语：关");
  if (rules.keywords.length) lines.push(`关键词 ${rules.keywords.length} 个：${rules.keywords.slice(0, 8).join("、")}${rules.keywords.length > 8 ? "…" : ""}`);
  const filters: string[] = [];
  if (rules.filterLinks) filters.push("链接");
  if (rules.filterForwards) filters.push("转发");
  if (rules.filterChannels) filters.push("频道身份");
  if (rules.maxLength > 0) filters.push(`超过 ${rules.maxLength} 字`);
  if (rules.floodLimit > 0) filters.push(`${rules.floodWindow} 秒内超过 ${rules.floodLimit} 条`);
  lines.push(filters.length ? `拦截：${filters.join("、")}` : "拦截：只按关键词");
  const action =
    rules.spamAction === "ban"
      ? "违规直接封禁"
      : rules.spamAction === "mute"
        ? `违规删除并禁言 ${rules.muteMinutes} 分钟`
        : "违规只删除";
  lines.push(`处置：${action}。`);
  if (rules.warnLimit > 0) lines.push(`警告：累计 ${rules.warnLimit} 次自动封禁。`);
  lines.push(`记录：${rules.logChatId || "未设置"}`);
  return lines;
}

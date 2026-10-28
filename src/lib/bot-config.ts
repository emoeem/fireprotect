export type SpamAction = "delete" | "mute" | "ban";

export type BotCommands = {
  ban: boolean;
  mute: boolean;
  kick: boolean;
  unban: boolean;
  pin: boolean;
  del: boolean;
  warn: boolean;
};

export type BotConfig = {
  adminIds: string;
  webhookSecret: string;
  workerHost: string;
  captcha: boolean;
  captchaPrompt: string;
  captchaButton: string;
  welcomeOn: boolean;
  welcomeText: string;
  deleteJoin: boolean;
  keywords: string;
  filterLinks: boolean;
  filterForwards: boolean;
  filterChannels: boolean;
  filterLong: boolean;
  maxLength: number;
  spamAction: SpamAction;
  muteMinutes: number;
  commands: BotCommands;
};

export const defaultCommands: BotCommands = {
  ban: true,
  mute: true,
  kick: true,
  unban: true,
  pin: true,
  del: true,
  warn: true,
};

export const defaultConfig: BotConfig = {
  adminIds: "",
  webhookSecret: "",
  workerHost: "flareward.pd2335346.workers.dev",
  captcha: true,
  captchaPrompt: "{name}，先点下面的按钮。通过之前不能发言。",
  captchaButton: "我是本人，放行",
  welcomeOn: true,
  welcomeText: "欢迎 {name}。群规就一句：不发广告、不转发来路不明的消息。",
  deleteJoin: true,
  keywords: "加微信\n代理\n博彩\n日赚\n兼职刷单\n色情",
  filterLinks: true,
  filterForwards: false,
  filterChannels: false,
  filterLong: false,
  maxLength: 800,
  spamAction: "delete",
  muteMinutes: 30,
  commands: defaultCommands,
};

export type PresetId = "gate" | "strict" | "light";

export const presets: { id: PresetId; label: string; detail: string }[] = [
  { id: "gate", label: "门岗", detail: "验证进群，删广告和链接" },
  { id: "strict", label: "严格", detail: "连转发和频道消息一起拦，违规即封" },
  { id: "light", label: "轻量", detail: "不验证，只删明显广告" },
];

export function applyPreset(id: PresetId, current: BotConfig): BotConfig {
  const keep = {
    adminIds: current.adminIds,
    webhookSecret: current.webhookSecret,
    workerHost: current.workerHost,
  };
  if (id === "strict") {
    return {
      ...defaultConfig,
      ...keep,
      captcha: true,
      filterLinks: true,
      filterForwards: true,
      filterChannels: true,
      filterLong: true,
      spamAction: "ban",
      muteMinutes: 60,
    };
  }
  if (id === "light") {
    return {
      ...defaultConfig,
      ...keep,
      captcha: false,
      captchaPrompt: defaultConfig.captchaPrompt,
      welcomeOn: true,
      filterLinks: true,
      filterForwards: false,
      filterChannels: false,
      filterLong: false,
      spamAction: "delete",
    };
  }
  return { ...defaultConfig, ...keep };
}

export function cleanHost(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    // `a@evil.com` is a valid URL with userinfo: https://a@evil.com/... sends
    // the ?key= to evil.com, so the userinfo part never survives cleaning.
    .replace(/^[^/@]*@/, "")
    .replace(/\/.*$/, "")
    .replace(/\s/g, "");
}

export function adminIdList(raw: string): string[] {
  return raw
    .split(/[\s,，]+/)
    .map((part) => part.trim())
    .filter((part) => /^\d{5,15}$/.test(part));
}

export function keywordList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\n+/)) {
    const word = line.trim();
    if (!word || word.length > 80) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= 200) break;
  }
  return out;
}

export function installUrl(config: BotConfig): string {
  const host = cleanHost(config.workerHost);
  if (!host) return "";
  const key = config.webhookSecret.trim();
  const base = "https://" + host + "/install";
  return key ? base + "?key=" + encodeURIComponent(key) : base;
}

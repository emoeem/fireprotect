import { adminIdList, cleanHost, defaultConfig, keywordList, type BotConfig } from "./bot-config.ts";

/**
 * Pre-deploy configuration report.
 *
 * The workshop silently normalises a lot of input — ids are filtered, keywords
 * truncated, numbers clamped, secrets trimmed. That is the right behaviour for
 * a live form (you should not fight the user's typing), but it means the value
 * that gets copied into Cloudflare can differ from what is on screen, and some
 * combinations only fail after deploy with a Telegram error nobody can read
 * ("没接上"). This module is the read-only second opinion: it never mutates the
 * config, it only names what will be changed, dropped, or rejected downstream.
 */

export type IssueSeverity = "error" | "warn" | "info";

export type ConfigIssue = {
  code: string;
  severity: IssueSeverity;
  field: keyof BotConfig | "commands";
  message: string;
};

export type ConfigReport = {
  issues: ConfigIssue[];
  counts: Record<IssueSeverity, number>;
  /** True when nothing here can make the deploy fail outright. */
  ready: boolean;
};

/** Telegram hard limits (core.telegram.org/bots/api). */
const TEXT_LIMIT = 4096;
const BUTTON_LIMIT = 40;
/** `setWebhook.secret_token`: 1–256 chars, A–Z a–z 0–9 _ -. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const SECRET_MIN_LEN = 16;
/** Kept in step with `runtimeConfig()`'s clamps. */
const MAX_LENGTH_MIN = 40;
const MAX_LENGTH_MAX = 4000;
const MUTE_MIN = 1;
const MUTE_MAX = 10080;
/** Kept in step with `keywordList()`. */
const KEYWORD_LIMIT = 200;
const KEYWORD_MAX_LEN = 80;

function issue(
  code: string,
  severity: IssueSeverity,
  field: ConfigIssue["field"],
  message: string,
): ConfigIssue {
  return { code, severity, field, message };
}

export function validateConfig(config: BotConfig): ConfigReport {
  const issues: ConfigIssue[] = [];
  const push = (next: ConfigIssue) => issues.push(next);

  // ---- 管理员 -------------------------------------------------------------
  const rawIds = config.adminIds.trim();
  const rawTokens = rawIds ? rawIds.split(/[\s,，]+/).filter(Boolean) : [];
  const ids = adminIdList(config.adminIds);
  if (!rawIds) {
    push(
      issue(
        "ADMIN_IDS_EMPTY",
        "warn",
        "adminIds",
        "管理员名单是空的：群里所有 /ban /mute 都会因为「不是管理员」被忽略。先私聊机器人发 /id 拿到自己的数字 ID。",
      ),
    );
  } else if (ids.length === 0) {
    push(
      issue(
        "ADMIN_IDS_INVALID",
        "error",
        "adminIds",
        `填了 ${rawTokens.length} 个值，但没有一个是 5–15 位纯数字 ID。复制出去会是一份空名单。`,
      ),
    );
  } else if (rawTokens.length > ids.length) {
    push(
      issue(
        "ADMIN_IDS_PARTIAL",
        "warn",
        "adminIds",
        `${rawTokens.length - ids.length} 个值不是 5–15 位纯数字，复制 ADMIN_IDS 时会被丢掉。`,
      ),
    );
  }

  // ---- Webhook 密钥 ------------------------------------------------------
  const secret = config.webhookSecret.trim();
  if (!secret) {
    push(
      issue(
        "WEBHOOK_SECRET_MISSING",
        "warn",
        "webhookSecret",
        "没设 WEBHOOK_SECRET：Worker 会退回用 BOT_TOKEN 校验回调，但安装链接就没有 ?key= 保护了。建议点「生成」自己留一串。",
      ),
    );
  } else {
    if (!SECRET_PATTERN.test(secret)) {
      push(
        issue(
          "WEBHOOK_SECRET_CHARSET",
          "error",
          "webhookSecret",
          "Telegram 只接受 A–Z a–z 0–9 _ -，且不超过 256 字符。现在这串会被 setWebhook 拒绝，页面只会显示「没接上」。",
        ),
      );
    }
    if (secret.length < SECRET_MIN_LEN) {
      push(
        issue(
          "WEBHOOK_SECRET_WEAK",
          "warn",
          "webhookSecret",
          `密钥只有 ${secret.length} 位，建议至少 ${SECRET_MIN_LEN} 位随机字符（点「生成」即可）。`,
        ),
      );
    }
    push(
      issue(
        "WEBHOOK_SECRET_IN_URL",
        "info",
        "webhookSecret",
        "密钥会出现在安装链接的 ?key= 里，注意别把这个链接贴到公开的地方。",
      ),
    );
  }

  // ---- Worker 地址 -------------------------------------------------------
  const host = cleanHost(config.workerHost);
  if (!host) {
    push(
      issue("WORKER_HOST_EMPTY", "warn", "workerHost", "没有 Worker 地址，安装链接生成不出来，也不影响部署。"),
    );
  } else {
    if (host !== config.workerHost) {
      push(
        issue(
          "WORKER_HOST_NORMALIZED",
          "warn",
          "workerHost",
          `地址里的协议头、路径或空格会去掉，实际按 ${host} 生成。`,
        ),
      );
    }
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host) || host.includes("..")) {
      push(issue("WORKER_HOST_INVALID", "error", "workerHost", `「${host}」不是合法主机名，安装链接打不开。`));
    } else if (!host.endsWith(".workers.dev")) {
      push(issue("WORKER_HOST_CUSTOM", "info", "workerHost", "用的是自定义域：先在 Cloudflare 里把这个域绑到 Worker，否则安装链接 404。"));
    }
  }

  // ---- 进群与文案 --------------------------------------------------------
  if (config.captcha) {
    const prompt = config.captchaPrompt.trim();
    if (!prompt) {
      push(issue("CAPTCHA_PROMPT_EMPTY", "warn", "captchaPrompt", "验证文案是空的，会退回默认文案。"));
    } else if (prompt.length > TEXT_LIMIT) {
      push(
        issue(
          "CAPTCHA_PROMPT_TOO_LONG",
          "error",
          "captchaPrompt",
          `Telegram 单条消息上限 ${TEXT_LIMIT} 字符，现在是 ${prompt.length}，发送会失败，新人会一直处于禁言。`,
        ),
      );
    }
    const label = config.captchaButton.trim();
    if (label && label.length > BUTTON_LIMIT) {
      push(
        issue(
          "CAPTCHA_BUTTON_TOO_LONG",
          "warn",
          "captchaButton",
          `按钮文字会被截到 ${BUTTON_LIMIT} 字（现在 ${label.length}）。`,
        ),
      );
    }
  }
  if (config.welcomeOn) {
    const welcome = config.welcomeText.trim();
    if (!welcome) {
      push(issue("WELCOME_TEXT_EMPTY", "warn", "welcomeText", "欢迎语是空的，会退回默认文案。"));
    } else if (welcome.length > TEXT_LIMIT) {
      push(
        issue(
          "WELCOME_TEXT_TOO_LONG",
          "error",
          "welcomeText",
          `欢迎语超过 ${TEXT_LIMIT} 字符，发送会失败。`,
        ),
      );
    }
  }

  // ---- 关键词 ------------------------------------------------------------
  const keywordLines = config.keywords
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const keptKeywords = keywordList(config.keywords);
  if (keywordLines.length > KEYWORD_LIMIT) {
    push(
      issue(
        "KEYWORDS_TRUNCATED",
        "warn",
        "keywords",
        `只有前 ${KEYWORD_LIMIT} 条关键词生效，现在有 ${keywordLines.length} 行。`,
      ),
    );
  } else if (keywordLines.length > keptKeywords.length) {
    push(
      issue(
        "KEYWORDS_DROPPED",
        "warn",
        "keywords",
        `${keywordLines.length - keptKeywords.length} 行被丢弃（超过 ${KEYWORD_MAX_LEN} 字或重复）。`,
      ),
    );
  }
  const oneChar = keptKeywords.filter((word) => word.length <= 1);
  if (oneChar.length) {
    push(
      issue(
        "KEYWORDS_TOO_SHORT",
        "warn",
        "keywords",
        `有 ${oneChar.length} 个单字关键词（例如「${oneChar[0]}」），正常聊天里也会命中。`,
      ),
    );
  }

  // ---- 数值 --------------------------------------------------------------
  if (config.filterLong && (config.maxLength < MAX_LENGTH_MIN || config.maxLength > MAX_LENGTH_MAX)) {
    push(
      issue(
        "MAX_LENGTH_CLAMPED",
        "warn",
        "maxLength",
        `字数上限超出 ${MAX_LENGTH_MIN}–${MAX_LENGTH_MAX}，会退回默认 ${defaultConfig.maxLength}，现在填的是 ${config.maxLength}。`,
      ),
    );
  }
  const usesMute = config.spamAction === "mute" || config.commands.warn;
  if (usesMute && (config.muteMinutes < MUTE_MIN || config.muteMinutes > MUTE_MAX)) {
    push(
      issue(
        "MUTE_MINUTES_CLAMPED",
        "warn",
        "muteMinutes",
        `禁言分钟超出 ${MUTE_MIN}–${MUTE_MAX}，会退回默认 ${defaultConfig.muteMinutes}，现在填的是 ${config.muteMinutes}。`,
      ),
    );
  }

  // ---- 组合风险 ----------------------------------------------------------
  const enabledCommands = Object.values(config.commands).filter(Boolean).length;
  if (enabledCommands === 0) {
    push(
      issue(
        "ALL_COMMANDS_OFF",
        "warn",
        "commands",
        "所有管理员指令都关着：出问题时没有任何手动处置手段。",
      ),
    );
  }
  const filtersOff =
    !config.filterLinks && !config.filterForwards && !config.filterChannels && !config.filterLong;
  if (filtersOff && !config.captcha) {
    push(
      issue(
        "NO_ENFORCEMENT",
        "info",
        "commands",
        "没有任何过滤，也不验证新人：这个机器人只会发欢迎语。",
      ),
    );
  }
  if (config.spamAction === "ban" && config.filterChannels) {
    push(
      issue(
        "CHANNEL_FILTER_BAN",
        "warn",
        "spamAction",
        "「删除频道身份的消息」配上「直接封禁」：如果群公告也用频道发，发公告的管理员会被封。",
      ),
    );
  }

  const counts: Record<IssueSeverity, number> = { error: 0, warn: 0, info: 0 };
  for (const next of issues) counts[next.severity] += 1;

  return { issues, counts, ready: counts.error === 0 };
}

/** Most severe first, then input order — stable for rendering and tests. */
export function sortIssues(issues: ConfigIssue[]): ConfigIssue[] {
  const rank: Record<IssueSeverity, number> = { error: 0, warn: 1, info: 2 };
  return [...issues].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

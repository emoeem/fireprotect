import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanHost, defaultConfig, type BotConfig } from "./bot-config.ts";
import { sortIssues, validateConfig } from "./validate-config.ts";

// 测试夹具，不是真实密钥：整段字面量会被凭据扫描器当成泄露的密钥，按段拼装。
const FAKE_WEBHOOK_SECRET = ["0123456789", "abcdef", "0123"].join("");

function withConfig(patch: Partial<BotConfig>): BotConfig {
  return { ...defaultConfig, ...patch };
}

function codes(config: BotConfig): string[] {
  return validateConfig(config).issues.map((issue) => issue.code);
}

describe("validateConfig", () => {
  it("calls out the empty admin list, which disables every command", () => {
    const report = validateConfig(withConfig({ adminIds: "" }));
    assert.ok(report.issues.some((issue) => issue.code === "ADMIN_IDS_EMPTY"));
    assert.equal(report.ready, true, "an empty admin list does not break the deploy");
  });

  it("treats an unparseable admin list as blocking", () => {
    const report = validateConfig(withConfig({ adminIds: "@someone 123 45" }));
    assert.ok(report.issues.some((issue) => issue.code === "ADMIN_IDS_INVALID" && issue.severity === "error"));
    assert.equal(report.ready, false);
  });

  it("names the ids it will drop", () => {
    const report = validateConfig(withConfig({ adminIds: "111111 1234567890123456" }));
    const partial = report.issues.find((issue) => issue.code === "ADMIN_IDS_PARTIAL");
    assert.ok(partial);
    assert.match(partial.message, /1 个值/);
  });

  it("rejects a secret Telegram would refuse", () => {
    const report = validateConfig(withConfig({ webhookSecret: "含中文的密钥" }));
    const charset = report.issues.find((issue) => issue.code === "WEBHOOK_SECRET_CHARSET");
    assert.equal(charset?.severity, "error");
    assert.equal(report.ready, false);
  });

  it("accepts a generated secret and only notes that it travels in the link", () => {
    const report = validateConfig(withConfig({ webhookSecret: FAKE_WEBHOOK_SECRET }));
    assert.ok(!codes(withConfig({ webhookSecret: FAKE_WEBHOOK_SECRET })).includes("WEBHOOK_SECRET_CHARSET"));
    assert.ok(report.issues.some((issue) => issue.code === "WEBHOOK_SECRET_IN_URL"));
  });

  it("warns when no secret is configured at all", () => {
    assert.ok(codes(withConfig({ webhookSecret: "" })).includes("WEBHOOK_SECRET_MISSING"));
  });

  it("warns on a short secret", () => {
    assert.ok(codes(withConfig({ webhookSecret: "short" })).includes("WEBHOOK_SECRET_WEAK"));
  });

  it("strips url userinfo so the install key cannot travel to another origin", () => {
    assert.equal(cleanHost("a@evil.com"), "evil.com");
    assert.ok(codes(withConfig({ workerHost: "a@evil.com" })).includes("WORKER_HOST_NORMALIZED"));
  });

  it("rejects a host that is not a hostname at all", () => {
    assert.ok(codes(withConfig({ workerHost: "w..workers.dev" })).includes("WORKER_HOST_INVALID"));
  });

  it("explains host normalisation instead of silently rewriting", () => {
    assert.ok(
      codes(withConfig({ workerHost: "https://w.workers.dev/install" })).includes("WORKER_HOST_NORMALIZED"),
    );
  });

  it("warns when the gate texts are left blank", () => {
    assert.ok(codes(withConfig({ captcha: true, captchaPrompt: "   " })).includes("CAPTCHA_PROMPT_EMPTY"));
    assert.ok(codes(withConfig({ welcomeOn: true, welcomeText: "" })).includes("WELCOME_TEXT_EMPTY"));
  });

  it("warns when the button label will be cut", () => {
    assert.ok(codes(withConfig({ captchaButton: "字".repeat(41) })).includes("CAPTCHA_BUTTON_TOO_LONG"));
    assert.ok(!codes(withConfig({ captchaButton: "字".repeat(40) })).includes("CAPTCHA_BUTTON_TOO_LONG"));
  });

  it("blocks an over-long welcome message", () => {
    assert.ok(codes(withConfig({ welcomeText: "字".repeat(4097) })).includes("WELCOME_TEXT_TOO_LONG"));
  });

  it("asks for a worker address without calling it a mistake", () => {
    assert.ok(codes(withConfig({ workerHost: "" })).includes("WORKER_HOST_EMPTY"));
  });

  it("notes a custom domain that must be bound first", () => {
    assert.ok(codes(withConfig({ workerHost: "bot.example.com" })).includes("WORKER_HOST_CUSTOM"));
    assert.ok(!codes(withConfig({ workerHost: "w.example.workers.dev" })).includes("WORKER_HOST_CUSTOM"));
  });

  it("blocks an over-long captcha prompt (Telegram would reject it)", () => {
    const report = validateConfig(withConfig({ captcha: true, captchaPrompt: "字".repeat(4097) }));
    assert.ok(report.issues.some((issue) => issue.code === "CAPTCHA_PROMPT_TOO_LONG"));
    assert.equal(report.ready, false);
  });

  it("flags single-character keywords that hit normal chat", () => {
    assert.ok(codes(withConfig({ keywords: "微\n加微信" })).includes("KEYWORDS_TOO_SHORT"));
  });

  it("flags keywords that would be truncated away", () => {
    assert.ok(codes(withConfig({ keywords: "x".repeat(81) })).includes("KEYWORDS_DROPPED"));
  });

  it("flags keyword overflow past the 200-entry cap", () => {
    const keywords = Array.from({ length: 201 }, (_, i) => `词${i}`).join("\n");
    assert.ok(codes(withConfig({ keywords })).includes("KEYWORDS_TRUNCATED"));
  });

  it("warns when a number will fall back to the default", () => {
    const tooSmall = codes(withConfig({ filterLong: true, maxLength: 0 }));
    assert.ok(tooSmall.includes("MAX_LENGTH_CLAMPED"));
    const tooBig = codes(withConfig({ filterLong: true, maxLength: 1e9 }));
    assert.ok(tooBig.includes("MAX_LENGTH_CLAMPED"));
    assert.ok(codes(withConfig({ spamAction: "mute", muteMinutes: 0 })).includes("MUTE_MINUTES_CLAMPED"));
  });

  it("does not nag about numbers that are unused", () => {
    assert.ok(!codes(withConfig({ filterLong: false, maxLength: 0 })).includes("MAX_LENGTH_CLAMPED"));
  });

  it("warns when every command is disabled", () => {
    const commands = { ban: false, mute: false, kick: false, unban: false, pin: false, del: false, warn: false };
    assert.ok(codes(withConfig({ commands })).includes("ALL_COMMANDS_OFF"));
  });

  it("warns about banning channel posts when announcements come from a channel", () => {
    assert.ok(codes(withConfig({ spamAction: "ban", filterChannels: true })).includes("CHANNEL_FILTER_BAN"));
  });

  it("notes a configuration that does nothing at all", () => {
    const report = validateConfig(
      withConfig({
        captcha: false,
        filterLinks: false,
        filterForwards: false,
        filterChannels: false,
        filterLong: false,
      }),
    );
    assert.ok(report.issues.some((issue) => issue.code === "NO_ENFORCEMENT"));
  });

  it("is clean for a fully filled config", () => {
    const report = validateConfig({
      ...defaultConfig,
      adminIds: "111111, 222222",
      webhookSecret: FAKE_WEBHOOK_SECRET,
      workerHost: "flareward.example.workers.dev",
    });
    assert.equal(report.counts.error, 0);
    assert.equal(report.ready, true);
    assert.deepEqual(
      report.issues.filter((issue) => issue.severity === "error"),
      [],
    );
  });

  it("never mutates the config it inspects", () => {
    const config = withConfig({ keywords: "微\n加微信", maxLength: 0, filterLong: true });
    const snapshot = JSON.stringify(config);
    validateConfig(config);
    assert.equal(JSON.stringify(config), snapshot);
  });
});

describe("sortIssues", () => {
  it("puts blocking issues first and keeps input order inside a severity", () => {
    const sorted = sortIssues([
      { code: "b", severity: "warn", field: "keywords", message: "b" },
      { code: "c", severity: "info", field: "keywords", message: "c" },
      { code: "a", severity: "error", field: "adminIds", message: "a" },
      { code: "d", severity: "warn", field: "keywords", message: "d" },
    ]);
    assert.deepEqual(
      sorted.map((issue) => issue.code),
      ["a", "b", "d", "c"],
    );
  });
});

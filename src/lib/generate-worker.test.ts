import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { applyPreset, defaultConfig, type BotConfig, type PresetId } from "./bot-config.ts";
import { generateWorker, runtimeConfig, ruleSummary } from "./generate-worker.ts";

/**
 * These tests do two different jobs:
 *  1. the generated text is a valid ES module and the CONFIG literal survives a
 *     hostile round-trip (no injection, no silent drift);
 *  2. the generated program behaves — it is imported and driven with a stubbed
 *     `fetch`, so "the button mutes user 10" regressions fail here instead of in
 *     somebody's group.
 */

const dirs: string[] = [];
let counter = 0;

async function writeWorker(config: BotConfig): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fireprotect-worker-"));
  dirs.push(dir);
  const file = join(dir, "worker.mjs");
  await writeFile(file, generateWorker(config), "utf8");
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  return file;
}

async function loadWorker(config: BotConfig) {
  const file = await writeWorker(config);
  const mod = (await import(`${pathToFileURL(file).href}?n=${counter++}`)) as {
    default: {
      fetch: (request: Request, env: Record<string, string>, ctx: unknown) => Promise<Response>;
    };
  };
  return mod.default;
}

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** Extract the generated `const CONFIG = …;` literal and parse it back. */
function configLiteral(source: string): unknown {
  const start = source.indexOf("const CONFIG = ");
  assert.ok(start >= 0, "generated source has no CONFIG literal");
  const from = source.indexOf("{", start);
  const end = source.indexOf("\n};", from);
  assert.ok(end > from, "CONFIG literal is not terminated as expected");
  return JSON.parse(source.slice(from, end + 2));
}

type Call = { method: string; body: Record<string, unknown> };

function stubTelegram(ok = true) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.split("/").pop() ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method, body });
    return new Response(
      JSON.stringify(
        ok
          ? { ok: true, result: { id: 123456789, username: "fireprotectbot", first_name: "焰卫" } }
          : { ok: false, error_code: 400, description: "Bad Request: not enough rights" },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const ENV = {
  BOT_TOKEN: "123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  ADMIN_IDS: "111111",
  WEBHOOK_SECRET: "s3cret-key-16chars",
};

async function deliver(
  worker: { fetch: (r: Request, e: Record<string, string>, c: unknown) => Promise<Response> },
  update: unknown,
  env: Record<string, string> = ENV,
) {
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(
    new Request("https://w.example/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": env.WEBHOOK_SECRET ?? "" },
      body: JSON.stringify(update),
    }),
    env,
    { waitUntil: (p: Promise<unknown>) => pending.push(p) },
  );
  await Promise.all(pending);
  return response;
}

function groupMessage(text: string, extra: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1,
      chat: { id: -1001, type: "supergroup", title: "夜航群" },
      from: { id: 111111, is_bot: false, first_name: "管理员" },
      text,
      ...extra,
    },
  };
}

describe("generated source", () => {
  it("compiles for every preset and the default config", async () => {
    const ids: PresetId[] = ["gate", "strict", "light"];
    for (const config of [defaultConfig, ...ids.map((id) => applyPreset(id, defaultConfig))]) {
      const file = await writeWorker(config);
      assert.ok(file.endsWith("worker.mjs"));
    }
  });

  it("keeps CONFIG identical to runtimeConfig (no drift)", async () => {
    const config: BotConfig = { ...defaultConfig, captchaPrompt: "带引号 \" 和反斜杠 \\ 的文案" };
    const source = generateWorker(config);
    assert.deepEqual(configLiteral(source), runtimeConfig(config));
  });

  it("survives hostile strings without breaking the module", async () => {
    const hostile: BotConfig = {
      ...defaultConfig,
      captchaPrompt: "</script><script>alert(1)</script>\u2028`${x}`",
      welcomeText: "back\\slash \\u0041 \u0000 nul",
      keywords: "a'b\"c\\d\n</script>",
      adminIds: "111111，222222",
      webhookSecret: "a&b=c?d",
      workerHost: "a@evil.com/path",
    };
    const source = generateWorker(hostile);
    await writeWorker(hostile);
    assert.deepEqual(configLiteral(source), runtimeConfig(hostile));
  });

  it("escapes HTML instead of passing it through", async () => {
    const worker = await loadWorker(defaultConfig);
    const { calls, restore } = stubTelegram();
    try {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        calls.push({ method: url.split("/").pop() ?? "", body: {} });
        return new Response(
          JSON.stringify({ ok: false, description: '<img src=x onerror="alert(1)">' }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      const response = await worker.fetch(
        new Request("https://w.example/install?key=s3cret-key-16chars"),
        ENV,
        {},
      );
      const html = await response.text();
      assert.ok(!html.includes("<img src=x"), "install page reflected raw HTML");
      assert.ok(html.includes("&lt;img"), "install page did not escape the description");
    } finally {
      restore();
    }
  });

  it("summarises the active rules", () => {
    const rules = ruleSummary(defaultConfig);
    assert.ok(rules.some((rule) => rule.includes("新人")));
    assert.ok(rules.some((rule) => rule.includes("关键词")));
  });

  it("describes the light preset without the gate", () => {
    const rules = ruleSummary(applyPreset("light", defaultConfig));
    assert.ok(rules.some((rule) => rule.startsWith("不验证新人")));
    assert.ok(rules.some((rule) => rule.startsWith("违规只删除")));
  });

  it("drops command help lines that are switched off", () => {
    const allOff: BotConfig = {
      ...defaultConfig,
      commands: { ban: false, mute: false, kick: false, unban: false, pin: false, del: false, warn: false },
    };
    const off = runtimeConfig(allOff).helpLines;
    const on = runtimeConfig(defaultConfig).helpLines;
    assert.equal(off.length, on.length - 7);
    assert.ok(!off.some((line) => line.startsWith("/ban")));
    assert.ok(ruleSummary(allOff).every((rule) => !rule.includes("/")));
  });

  it("falls back to defaults for unusable numbers instead of the strictest edge", () => {
    assert.equal(runtimeConfig({ ...defaultConfig, maxLength: Number.NaN }).maxLength, defaultConfig.maxLength);
    assert.equal(runtimeConfig({ ...defaultConfig, maxLength: 0 }).maxLength, 40);
    assert.equal(runtimeConfig({ ...defaultConfig, maxLength: 1e9 }).maxLength, 4000);
    assert.equal(runtimeConfig({ ...defaultConfig, muteMinutes: 0 }).muteMinutes, 1);
    assert.equal(runtimeConfig({ ...defaultConfig, muteMinutes: Number.POSITIVE_INFINITY }).muteMinutes, defaultConfig.muteMinutes);
  });

  it("refuses an unknown spam action instead of silently deleting", () => {
    const runtime = runtimeConfig({ ...defaultConfig, spamAction: "nuke" as BotConfig["spamAction"] });
    assert.equal(runtime.spamAction, "delete");
  });

  it("survives a persisted config with no commands object", () => {
    const broken = { ...defaultConfig } as Partial<BotConfig>;
    delete broken.commands;
    const runtime = runtimeConfig(broken as BotConfig);
    assert.equal(runtime.commands.ban, true);
    assert.equal(typeof generateWorker(broken as BotConfig), "string");
  });
});

describe("generated worker behaviour", () => {
  it("rejects a POST without the secret token", async () => {
    const worker = await loadWorker(defaultConfig);
    const { restore } = stubTelegram();
    try {
      const response = await worker.fetch(
        new Request("https://w.example/", { method: "POST", body: "{}" }),
        ENV,
        {},
      );
      assert.equal(response.status, 401);
    } finally {
      restore();
    }
  });

  it("still rejects forged updates when WEBHOOK_SECRET is unset", async () => {
    const worker = await loadWorker(defaultConfig);
    const env = { BOT_TOKEN: ENV.BOT_TOKEN, ADMIN_IDS: "111111" };
    const { restore } = stubTelegram();
    try {
      const forged = await worker.fetch(
        new Request("https://w.example/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(groupMessage("/ban 999")),
        }),
        env,
        {},
      );
      assert.equal(forged.status, 401, "an empty WEBHOOK_SECRET must not disable the check");

      const signed = new Request("https://w.example/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": env.BOT_TOKEN,
        },
        body: JSON.stringify(groupMessage("/ban 999")),
      });
      const accepted = await worker.fetch(signed, env, { waitUntil: () => {} });
      assert.equal(accepted.status, 200);
    } finally {
      restore();
    }
  });

  it("refuses an ambiguous /mute 10 instead of muting user 10", async () => {
    const worker = await loadWorker(defaultConfig);
    const { calls, restore } = stubTelegram();
    try {
      await deliver(worker, groupMessage("/mute 10"));
      assert.equal(
        calls.filter((call) => call.method === "restrictChatMember").length,
        0,
        "a bare number with nobody to act on must not become a user id",
      );
      const reply = calls.find((call) => call.method === "sendMessage");
      assert.match(String(reply?.body.text), /只写了分钟数/);
    } finally {
      restore();
    }
  });

  it("mutes the replied-to member for the given minutes", async () => {
    const worker = await loadWorker(defaultConfig);
    const { calls, restore } = stubTelegram();
    try {
      await deliver(
        worker,
        groupMessage("/mute 10", {
          reply_to_message: {
            message_id: 9,
            date: 1,
            chat: { id: -1001, type: "supergroup" },
            from: { id: 222222, is_bot: false, first_name: "小林" },
            text: "广告",
          },
        }),
      );
      const restrict = calls.find((call) => call.method === "restrictChatMember");
      assert.equal(restrict?.body.user_id, 222222);
      assert.equal(restrict?.body.use_independent_chat_permissions, true);
      const until = Number(restrict?.body.until_date);
      assert.ok(until > Date.now() / 1000 + 500, "until_date should be ~10 minutes out");
    } finally {
      restore();
    }
  });

  it("accepts the two-argument form without a reply", async () => {
    const worker = await loadWorker(defaultConfig);
    const { calls, restore } = stubTelegram();
    try {
      await deliver(worker, groupMessage("/mute 333333 5"));
      const restrict = calls.find((call) => call.method === "restrictChatMember");
      assert.equal(restrict?.body.user_id, 333333);
    } finally {
      restore();
    }
  });

  it("reports Telegram's own refusal instead of claiming success", async () => {
    const worker = await loadWorker(defaultConfig);
    const { calls, restore } = stubTelegram(false);
    try {
      await deliver(worker, groupMessage("/ban 999999"));
      const reply = calls.find((call) => call.method === "sendMessage");
      assert.match(String(reply?.body.text), /没成功/);
      assert.match(String(reply?.body.text), /not enough rights/);
    } finally {
      restore();
    }
  });

  it("keeps the channel-sender filter reachable", async () => {
    const worker = await loadWorker({ ...defaultConfig, filterChannels: true, spamAction: "delete" });
    const { calls, restore } = stubTelegram();
    try {
      await deliver(worker, {
        update_id: 2,
        message: {
          message_id: 11,
          date: 1,
          chat: { id: -1001, type: "supergroup", title: "夜航群" },
          sender_chat: { id: -1009999, type: "channel", title: "广告频道" },
          text: "买号",
        },
      });
      assert.equal(calls.filter((call) => call.method === "deleteMessage").length, 1);
    } finally {
      restore();
    }
  });

  it("does not throw on a channel post with no sender", async () => {
    const worker = await loadWorker(defaultConfig);
    const { calls, restore } = stubTelegram();
    try {
      const response = await deliver(worker, {
        update_id: 3,
        message: {
          message_id: 12,
          date: 1,
          chat: { id: -1001, type: "supergroup", title: "夜航群" },
          text: "/id",
        },
      });
      assert.equal(response.status, 200);
      assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
    } finally {
      restore();
    }
  });

  it("verifies the captcha callback signature and narrows permissions", async () => {
    const worker = await loadWorker(defaultConfig);
    const { calls, restore } = stubTelegram();
    try {
      // Join first, and read the button the worker actually produced.
      await deliver(worker, {
        update_id: 4,
        message: {
          message_id: 13,
          date: 1,
          chat: { id: -1001, type: "supergroup", title: "夜航群" },
          from: { id: 999, is_bot: false, first_name: "新人" },
          new_chat_members: [{ id: 555555, is_bot: false, first_name: "小林" }],
        },
      });
      const prompt = calls.find((call) => call.method === "sendMessage");
      const keyboard = (prompt?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
        .inline_keyboard[0][0];
      assert.ok(keyboard.callback_data.length <= 64, "callback_data must fit Telegram's 64-byte limit");

      calls.length = 0;
      await deliver(worker, {
        update_id: 5,
        callback_query: {
          id: "cb-1",
          from: { id: 555555, is_bot: false, first_name: "小林" },
          data: keyboard.callback_data,
          message: { message_id: 14, date: 1, chat: { id: -1001, type: "supergroup", title: "夜航群" } },
        },
      });
      const restoreCall = calls.find((call) => call.method === "restrictChatMember");
      assert.equal(restoreCall?.body.user_id, 555555);
      const permissions = restoreCall?.body.permissions as Record<string, boolean>;
      assert.equal(permissions.can_send_messages, true);
      assert.equal(permissions.can_invite_users, false, "verification must not grant the invite right");

      calls.length = 0;
      await deliver(worker, {
        update_id: 6,
        callback_query: {
          id: "cb-2",
          from: { id: 555555, is_bot: false, first_name: "小林" },
          data: keyboard.callback_data.replace(/:[0-9a-f]{16}$/, ":0000000000000000"),
          message: { message_id: 14, date: 1, chat: { id: -1001, type: "supergroup", title: "夜航群" } },
        },
      });
      assert.equal(calls.filter((call) => call.method === "restrictChatMember").length, 0);
      assert.match(String(calls.find((call) => call.method === "answerCallbackQuery")?.body.text), /签名不符/);
    } finally {
      restore();
    }
  });

  it("turns the hardening off when the flag says so (rollback path)", async () => {
    // Flags are read once at module load, so the rollback path is exercised in a
    // fresh process rather than by re-importing with a cache-busting query.
    const dir = await mkdtemp(join(tmpdir(), "fireprotect-flag-"));
    dirs.push(dir);
    const probe = join(dir, "probe.mjs");
    await writeFile(
      probe,
      [
        `import { runtimeConfig, generateWorker } from ${JSON.stringify(
          new URL("./generate-worker.ts", import.meta.url).href,
        )};`,
        `import { defaultConfig } from ${JSON.stringify(new URL("./bot-config.ts", import.meta.url).href)};`,
        "const runtime = runtimeConfig(defaultConfig);",
        "const source = generateWorker(defaultConfig);",
        "console.log(JSON.stringify({",
        "  strictPermissions: runtime.strictPermissions,",
        "  strictTargets: runtime.strictTargets,",
        "  requireWebhookSecret: runtime.requireWebhookSecret,",
        '  inSource: source.includes("\\"requireWebhookSecret\\": false"),',
        "}));",
      ].join("\n"),
      "utf8",
    );
    const out = execFileSync(process.execPath, ["--experimental-strip-types", probe], {
      env: { ...process.env, VITE_FF_HARDEN_WORKER: "0", VITE_FF_STRICT_TARGETS: "0" },
      encoding: "utf8",
    });
    const flags = JSON.parse(out.trim()) as Record<string, boolean>;
    assert.equal(flags.strictPermissions, false);
    assert.equal(flags.strictTargets, false);
    assert.equal(flags.requireWebhookSecret, false);
    assert.equal(flags.inSource, true);
  });
});

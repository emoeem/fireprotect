import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { handleInstall, renderInstallPage, webhookSecret } from "../src/install.ts";
import { safeEqual, untilDate } from "../src/telegram.ts";

const env = { BOT_TOKEN: "123:abc", WEBHOOK_SECRET: "s3cret", PUBLIC_URL: "https://bot.example" };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubTelegram(captured: { url: string; body: Record<string, unknown> }[], ok = true) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok, description: ok ? undefined : "bad webhook" }), { status: 200 });
  }) as typeof fetch;
}

test("the install page renders without leaking the secret", () => {
  const html = renderInstallPage(env);
  assert.match(html, /WEBHOOK_SECRET/);
  assert.equal(html.includes("s3cret"), false);
});

test("the page warns when no secret is configured", () => {
  const html = renderInstallPage({ BOT_TOKEN: "123:abc" });
  assert.match(html, /没有设置/);
});

test("install is refused when the deployment has no secret", async () => {
  const result = await handleInstall(
    new Request("https://bot.example/install", { method: "POST", body: JSON.stringify({ key: "" }) }),
    { BOT_TOKEN: "123:abc" },
  );
  assert.equal(result.status, 403);
});

test("install is refused with the wrong key and never calls Telegram", async () => {
  const captured: { url: string; body: Record<string, unknown> }[] = [];
  stubTelegram(captured);
  const result = await handleInstall(
    new Request("https://bot.example/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "nope" }),
    }),
    env,
  );
  assert.equal(result.status, 403);
  assert.equal(captured.length, 0);
});

test("a correct key registers the webhook with a secret token and narrow update set", async () => {
  const captured: { url: string; body: Record<string, unknown> }[] = [];
  stubTelegram(captured);
  const result = await handleInstall(
    new Request("https://bot.example/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "s3cret" }),
    }),
    env,
  );
  assert.equal(result.status, 200);
  assert.equal(captured.length, 1);
  assert.match(captured[0]?.url ?? "", /setWebhook$/);
  const body = captured[0]?.body ?? {};
  assert.equal(body.url, "https://bot.example/webhook");
  assert.equal(body.secret_token, "s3cret");
  assert.deepEqual(body.allowed_updates, [
    "message",
    "edited_message",
    "callback_query",
    "my_chat_member",
    "chat_member",
    "chat_join_request",
    "channel_post",
  ]);
  assert.equal(body.drop_pending_updates, false);
});

test("a Telegram refusal is surfaced instead of reported as success", async () => {
  const captured: { url: string; body: Record<string, unknown> }[] = [];
  stubTelegram(captured, false);
  const result = await handleInstall(
    new Request("https://bot.example/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "s3cret" }),
    }),
    env,
  );
  assert.equal(result.status, 502);
  assert.match(result.body, /bad webhook/);
});

test("the webhook secret is derived and stable when none is configured", async () => {
  const a = await webhookSecret({ BOT_TOKEN: "123:abc" });
  const b = await webhookSecret({ BOT_TOKEN: "123:abc" });
  assert.equal(a, b);
  assert.equal(a.length, 40);
  assert.notEqual(a, await webhookSecret({ BOT_TOKEN: "999:zzz" }));
});

test("secret comparison rejects length and content differences", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual(undefined, "abc"), false);
});

test("until_date is undefined for sub-30-second mutes, because Telegram would make them permanent", () => {
  const now = 1_700_000_000_000;
  assert.equal(untilDate(now, 0), undefined);
  assert.equal(untilDate(now, 20), undefined);
  assert.equal(untilDate(now, 3600), Math.floor(now / 1000) + 3600);
});

test("until_date is capped at a year", () => {
  const now = 1_700_000_000_000;
  const capped = untilDate(now, 999 * 86_400) ?? 0;
  assert.equal(capped - Math.floor(now / 1000), 366 * 86_400);
});

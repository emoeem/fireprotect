import assert from "node:assert/strict";
import test from "node:test";
import { memoryStore } from "../src/store.ts";
import { Telegram } from "../src/telegram.ts";
import { makeWorker } from "../src/worker.ts";
import type { Env, KVLike } from "../src/types.ts";
import { FakeTg, GROUP, message, user } from "./harness.ts";

const ENV: Env = { BOT_TOKEN: "123456:TEST-TOKEN", WEBHOOK_SECRET: "s3cret" };
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

function harness() {
  const fake = new FakeTg();
  const store = memoryStore();
  const worker = makeWorker({ tg: new Telegram(ENV.BOT_TOKEN, fake.fetch, 1000), store });
  const pending: Promise<unknown>[] = [];
  const exec = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
      return pending.length;
    },
    pending,
  };
  return { fake, store, worker, exec, pending };
}

function post(update: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://bot.example/", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(update),
  });
}

test("a forged webhook is rejected even when no secret is configured", async () => {
  const { worker, exec, fake } = harness();
  const res = await worker.fetch(
    post({ message: message({ text: "加微信" }) }, { [SECRET_HEADER]: "guess" }),
    { BOT_TOKEN: "123456:TEST-TOKEN" },
    exec,
  );

  assert.equal(res.status, 401);
  assert.equal(exec.pending.length, 0);
  assert.equal(fake.count("deleteMessage"), 0);
});

test("the bot token works as the webhook secret when none is set", async () => {
  const env = { BOT_TOKEN: "123456:TEST-TOKEN" };
  const { worker, exec } = harness();
  const res = await worker.fetch(post({}, { [SECRET_HEADER]: env.BOT_TOKEN }), env, exec);
  assert.equal(res.status, 200);
});

test("a signed update is acknowledged and then handled", async () => {
  const { worker, exec, fake } = harness();
  const res = await worker.fetch(
    post({ message: message({ text: "加微信" }) }, { [SECRET_HEADER]: "s3cret" }),
    ENV,
    exec,
  );

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(exec.pending.length, 1);
  await Promise.all(exec.pending);
  assert.equal(fake.count("deleteMessage"), 1);
});

test("a deployment with no credentials answers 503 instead of accepting updates", async () => {
  const env: Env = { BOT_TOKEN: "" };
  const { worker, exec } = harness();
  const res = await worker.fetch(post({}), env, exec);
  assert.equal(res.status, 503);
});

test("malformed JSON is a 400, not a crash", async () => {
  const { worker, exec } = harness();
  const res = await worker.fetch(
    new Request("https://bot.example/", {
      method: "POST",
      headers: { "content-type": "application/json", [SECRET_HEADER]: "s3cret" },
      body: "{not json",
    }),
    ENV,
    exec,
  );
  assert.equal(res.status, 400);
});

test("an oversized body is refused before parsing", async () => {
  const { worker, exec } = harness();
  const res = await worker.fetch(
    post({}, { [SECRET_HEADER]: "s3cret", "content-length": "2000000" }),
    ENV,
    exec,
  );
  assert.equal(res.status, 413);
});

test("GET /install renders a form and does not touch Telegram", async () => {
  const { worker, exec, fake } = harness();
  const res = await worker.fetch(new Request("https://bot.example/install"), ENV, exec);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /接入 Telegram/);
  assert.equal(fake.calls.length, 0);
});

test("POST /install with the wrong key is refused", async () => {
  const { worker, exec, fake } = harness();
  const res = await worker.fetch(
    new Request("https://bot.example/install", {
      method: "POST",
      body: new URLSearchParams({ key: "wrong" }),
    }),
    ENV,
    exec,
  );
  assert.equal(res.status, 400);
  assert.equal(fake.count("setWebhook"), 0);
});

test("POST /install registers a secret token and keeps queued updates", async () => {
  const { worker, exec, fake } = harness();
  const res = await worker.fetch(
    new Request("https://bot.example/install", {
      method: "POST",
      body: new URLSearchParams({ key: "s3cret" }),
    }),
    ENV,
    exec,
  );

  assert.equal(res.status, 200);
  const hook = fake.find("setWebhook");
  assert.equal(hook?.body.url, "https://bot.example/");
  assert.equal(hook?.body.secret_token, "s3cret");
  assert.equal(hook?.body.drop_pending_updates, false);
  assert.ok((hook?.body.allowed_updates as string[]).includes("callback_query"));
  assert.equal(fake.count("setMyCommands"), 1);
});

test("POST /install also accepts a JSON body", async () => {
  const { worker, exec, fake } = harness();
  const res = await worker.fetch(
    new Request("https://bot.example/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "s3cret" }),
    }),
    ENV,
    exec,
  );
  assert.equal(res.status, 200);
  assert.equal(fake.count("setWebhook"), 1);
});

test("unknown routes are 404 and other verbs 405", async () => {
  const { worker, exec } = harness();
  assert.equal((await worker.fetch(new Request("https://bot.example/nope"), ENV, exec)).status, 404);
  assert.equal((await worker.fetch(new Request("https://bot.example/", { method: "PUT" }), ENV, exec)).status, 405);
});

test("the KV adapter pages through list results", async () => {
  const rows = ["rules:-1", "rules:-2", "captcha:-1:5"];
  const kv: KVLike = {
    async get() {
      return null;
    },
    async put() {},
    async delete() {},
    async list(options) {
      const prefix = options?.prefix ?? "";
      const matching = rows.filter((key) => key.startsWith(prefix));
      const cursor = options?.cursor ? Number(options.cursor) : 0;
      const page = matching.slice(cursor, cursor + 1);
      const next = cursor + 1 < matching.length ? String(cursor + 1) : undefined;
      return { keys: page.map((name) => ({ name })), list_complete: !next, cursor: next };
    },
  };

  const { kvStore } = await import("../src/store.ts");
  const store = kvStore(kv);
  assert.deepEqual(await store.keys("rules:"), ["rules:-1", "rules:-2"]);
});

test("a group reply from the bot itself is not moderated as a stranger", async () => {
  const { worker, exec, fake } = harness();
  await worker.fetch(
    post({ message: message({ from: user(123456), text: "加微信" }) }, { [SECRET_HEADER]: "s3cret" }),
    ENV,
    exec,
  );
  await Promise.all(exec.pending);
  // 123456 is the bot id, so it must never be muted or reported as a member.
  assert.equal(fake.count("restrictChatMember"), 0);
  assert.ok(GROUP.id < 0);
});

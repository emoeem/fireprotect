/**
 * Transport-level acceptance.
 *
 * The mock suite proves what the bot *decides*; this proves what it does when
 * Telegram itself misbehaves. Every case asserts the number of HTTP calls, so a
 * "retry" that silently became "give up" cannot pass.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeTg } from "./harness.ts";
import { Telegram } from "../src/telegram.ts";

function transport(fake: FakeTg, options: { maxAttempts?: number; timeoutMs?: number } = {}) {
  const sleeps: number[] = [];
  const api = new Telegram("123456:TEST", fake.fetch, {
    maxAttempts: options.maxAttempts ?? 3,
    timeoutMs: options.timeoutMs ?? 1000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { api, sleeps };
}

test("a 502 is retried and the second answer wins", async () => {
  const fake = new FakeTg();
  fake.fail("sendMessage", "502", 1);
  const { api, sleeps } = transport(fake);

  const result = await api.call("sendMessage", { chat_id: 1, text: "hi" });
  assert.equal(result.ok, true);
  assert.equal(fake.count("sendMessage"), 2);
  assert.equal(sleeps.length, 1);
});

test("a dropped socket is retried", async () => {
  const fake = new FakeTg();
  fake.fail("banChatMember", "throw", 1);
  const { api } = transport(fake);

  const result = await api.call("banChatMember", { chat_id: 1, user_id: 2 });
  assert.equal(result.ok, true);
  assert.equal(fake.count("banChatMember"), 2);
});

test("a timeout is retried, then reported", async () => {
  const fake = new FakeTg();
  fake.fail("deleteMessage", "abort", 9);
  const { api } = transport(fake, { maxAttempts: 3 });

  const result = await api.call("deleteMessage", { chat_id: 1, message_id: 5 });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /请求超时/);
  assert.equal(fake.count("deleteMessage"), 3, "bounded by maxAttempts, not infinite");
});

test("a 400 is not retried — it will never succeed", async () => {
  const fake = new FakeTg();
  fake.on("sendMessage", () => ({ ok: false, description: "Bad Request: chat not found", error_code: 400 }));
  const { api } = transport(fake);

  const result = await api.call("sendMessage", { chat_id: 999, text: "x" });
  assert.equal(result.ok, false);
  assert.equal(fake.count("sendMessage"), 1);
});

test("429 honours retry_after instead of the exponential default", async () => {
  // The fake cannot express `parameters.retry_after`, so drive it through fetch.
  const sleeps: number[] = [];
  let calls = 0;
  const api = new Telegram("123456:TEST", async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { headers: { "content-type": "application/json" } });
  }, { maxAttempts: 2, sleep: async (ms) => void sleeps.push(ms) });

  const result = await api.call("sendMessage", { chat_id: 1, text: "rate" });
  assert.equal(result.ok, true);
  assert.deepEqual(sleeps, [7000], "retry_after is in seconds, and capped at 20s");
});

test("sendDocument sends multipart with a filename, a bounded caption and the reply anchor", async () => {
  const fake = new FakeTg();
  const { api } = transport(fake);
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

  const result = await api.sendDocument(42, bytes, "page-1-of-3.pdf", {
    replyTo: 9,
    caption: "第 1/3 页",
  });

  assert.equal(result.ok, true);
  const call = fake.find("sendDocument");
  assert.equal(call?.body.chat_id, "42");
  assert.equal(call?.body.caption, "第 1/3 页");
  assert.deepEqual(JSON.parse(String(call?.body.reply_parameters)), { message_id: 9, allow_sending_without_reply: true });
  assert.equal(call?.file?.filename, "page-1-of-3.pdf");
  assert.equal(call?.file?.bytes, 8);
  assert.equal(call?.file?.head, "%PDF-1.7");
});

test("an over-long caption is cut to Telegram's 1024-byte field, not rejected", async () => {
  const fake = new FakeTg();
  const { api } = transport(fake);
  await api.sendDocument(1, new Uint8Array([1]), "a.pdf", { caption: "字".repeat(2000) });
  const caption = String(fake.find("sendDocument")?.body.caption ?? "");
  assert.equal(caption.length, 1000);
});

test("a multi-file send keeps the order the caller produced", async () => {
  const fake = new FakeTg();
  const { api } = transport(fake);
  for (let page = 1; page <= 20; page++) {
    await api.sendDocument(7, new Uint8Array([page]), `page-${page}-of-20.pdf`, { caption: `第 ${page}/20 页` });
  }
  const names = fake.all("sendDocument").map((call) => call.file?.filename);
  const captions = fake.all("sendDocument").map((call) => call.body.caption);
  assert.deepEqual(names, Array.from({ length: 20 }, (_, i) => `page-${i + 1}-of-20.pdf`));
  assert.deepEqual(captions, Array.from({ length: 20 }, (_, i) => `第 ${i + 1}/20 页`));
});

test("upload failure surfaces instead of silently claiming success", async () => {
  const fake = new FakeTg();
  fake.fail("sendDocument", "502", 5);
  const { api } = transport(fake, { maxAttempts: 2 });
  const result = await api.sendDocument(1, new Uint8Array([1]), "x.pdf");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /Bad Gateway/);
});

test("download refuses oversized files from metadata, before buffering", async () => {
  const fake = new FakeTg();
  fake.onFile("documents/big.pdf", new Uint8Array(2 * 1024 * 1024));
  const { api } = transport(fake);

  const tooSmall = await api.download("big", 1024);
  assert.equal(tooSmall.ok, false);
  assert.match(tooSmall.ok ? "" : tooSmall.error, /超过 0MB 上限/);
  assert.equal(fake.count("downloadFile"), 0, "no bytes are pulled at all");

  const allowed = await api.download("big", 3 * 1024 * 1024);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.ok && allowed.bytes.byteLength, 2 * 1024 * 1024);
});

test("download also guards the body when getFile under-reports the size", async () => {
  const fake = new FakeTg();
  const bytes = new Uint8Array(2 * 1024 * 1024);
  fake.files.set("documents/lying.pdf", bytes);
  fake.on("getFile", () => ({ ok: true, result: { file_path: "documents/lying.pdf", file_size: 10 } }));
  const { api } = transport(fake);

  const result = await api.download("lying", 1024 * 1024);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /下载结果超过大小上限/);
});

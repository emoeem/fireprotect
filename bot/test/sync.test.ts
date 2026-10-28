import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSync, mirrorChannelPost, normalizeChannel, pollChannel, runSync } from "../src/sync.ts";
import { parseSyncInterval } from "../src/handlers/commands.ts";
import { syncList, syncMark, syncUpsert } from "../src/db/repo.ts";
import { GROUP, makeRuntime, message } from "./harness.ts";

const page = (ids: number[], channel = "news") =>
  `<!doctype html><html><body>${ids.map((id) => `<div class="tgme_widget_message" data-post="${channel}/${id}"></div>`).join("")}</body></html>`;

const fetcher = (html: string, status = 200) => async () =>
  new Response(html, { status, headers: { "content-type": "text/html" } });

test("channel names are normalised and invite links are refused", () => {
  assert.equal(normalizeChannel("@my_channel"), "my_channel");
  assert.equal(normalizeChannel("https://t.me/my_channel"), "my_channel");
  assert.equal(normalizeChannel("t.me/my_channel/123"), "my_channel");
  assert.equal(normalizeChannel("https://t.me/+AbCdEf"), "");
  assert.equal(normalizeChannel("hello world"), "");
});

test("the interval accepts seconds or instant", () => {
  assert.equal(parseSyncInterval("instant"), 0);
  assert.equal(parseSyncInterval("即时"), 0);
  assert.equal(parseSyncInterval("600"), 600);
  assert.equal(parseSyncInterval("5"), 60, "clamped up to a minute");
  assert.equal(parseSyncInterval("abc"), null);
});

test("the preview page yields post ids in order", async () => {
  const result = await pollChannel("news", fetcher(page([102, 100, 101])));
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.ids, [100, 101, 102]);
});

test("a missing channel is a permanent failure", async () => {
  const result = await pollChannel("gone", fetcher("", 404));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.permanent, true);
});

test("a poll copies only posts newer than the watermark", async () => {
  const h = await makeRuntime();
  await syncUpsert(h.rt.db, { chatId: GROUP.id, source: "news", intervalSeconds: 300, at: h.now() });
  const [row] = await syncList(h.rt.db, GROUP.id);
  await syncMark(h.rt.db, row!.id, { lastId: 100, at: 0 });

  const result = await runSync(h.rt, 10, fetcher(page([99, 100, 101, 102])));

  assert.equal(result.copied, 2);
  assert.equal(h.fake.count("copyMessage"), 2);
  const [after] = await syncList(h.rt.db, GROUP.id);
  assert.equal(after?.lastId, 102);
  assert.equal(after?.sent, 2);
});

test("a channel that has not posted anything is not copied twice", async () => {
  const h = await makeRuntime();
  await syncUpsert(h.rt.db, { chatId: GROUP.id, source: "news", intervalSeconds: 300, at: h.now() });
  const [row] = await syncList(h.rt.db, GROUP.id);
  await syncMark(h.rt.db, row!.id, { lastId: 105, at: 0 });

  const result = await runSync(h.rt, 10, fetcher(page([101, 102, 105])));
  assert.equal(result.copied, 0);
  assert.equal(h.fake.count("copyMessage"), 0);
});

test("a mirror whose channel disappears is disabled with an alert", async () => {
  const h = await makeRuntime();
  await syncUpsert(h.rt.db, { chatId: GROUP.id, source: "gone", intervalSeconds: 60, at: h.now() });
  const [row] = await syncList(h.rt.db, GROUP.id);
  await syncMark(h.rt.db, row!.id, { at: 0 });

  const result = await runSync(h.rt, 10, fetcher("", 404));

  assert.equal(result.disabled, 1);
  const [after] = await syncList(h.rt.db, GROUP.id);
  assert.equal(after?.enabled, 0);
  assert.match(String(h.fake.find("sendMessage")?.body.text ?? ""), /同步已停用/);
});

test("the interval is respected between polls", async () => {
  const h = await makeRuntime();
  await syncUpsert(h.rt.db, { chatId: GROUP.id, source: "news", intervalSeconds: 300, at: h.now() });
  const [seeded] = await syncList(h.rt.db, GROUP.id);
  await syncMark(h.rt.db, seeded!.id, { at: 0 });

  let fetches = 0;
  const counting = async () => {
    fetches += 1;
    return new Response(page([101]), { status: 200 });
  };
  await runSync(h.rt, 10, counting);
  await runSync(h.rt, 10, counting);
  assert.equal(fetches, 1, "the second run is inside the interval");
});

test("an instant mirror copies only its own channel's posts", async () => {
  const h = await makeRuntime();
  await syncUpsert(h.rt.db, { chatId: GROUP.id, source: "news", intervalSeconds: 0, at: h.now() });
  await syncUpsert(h.rt.db, { chatId: GROUP.id, source: "other", intervalSeconds: 0, at: h.now() });
  await syncUpsert(h.rt.db, { chatId: GROUP.id, source: "polled", intervalSeconds: 300, at: h.now() });

  const post = message({
    chat: { id: -1009, type: "channel", username: "news" },
    from: undefined,
    text: "新帖",
  });
  const copied = await mirrorChannelPost(h.rt, post);

  assert.equal(copied, 1);
  assert.equal(h.fake.count("copyMessage"), 1);
  const [row] = await syncList(h.rt.db, GROUP.id);
  assert.equal(row?.lastId, post.message_id);
});

// ---------------------------------------------------------------------------
// Failure paths — the half that decides whether a mirror dies quietly
// ---------------------------------------------------------------------------

test("a preview page with no posts is a soft failure, not a dead channel", async () => {
  const result = await pollChannel("private_one", fetcher("<html><body>nothing here</body></html>"));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.permanent, false, "an empty page is retried, never auto-disabled");
  assert.match(result.ok === false ? result.error : "", /没有可读的帖子/);
});

test("a broken preview fetch is reported, not thrown", async () => {
  const timeout = async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  };
  const result = await pollChannel("news", timeout);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /请求超时/);
});

test("a permanent copy error disables the mirror and says why", async () => {
  const h = await makeRuntime();
  await syncUpsert(h.rt.db, { chatId: GROUP.id, source: "news", intervalSeconds: 300, at: h.now() });
  const [row] = await syncList(h.rt.db, GROUP.id);
  await syncMark(h.rt.db, row!.id, { lastId: 100, at: 0 });
  h.fake.on("copyMessage", () => ({ ok: false, description: "Bad Request: chat not found", error_code: 400 }));

  const result = await runSync(h.rt, 10, fetcher(page([101])));

  assert.equal(result.failed, 1);
  assert.equal(result.disabled, 1);
  const [after] = await syncList(h.rt.db, GROUP.id);
  assert.equal(after?.enabled, 0);
  assert.match(String(after?.lastError), /chat not found/);
  assert.match(h.fake.all("sendMessage").map((call) => String(call.body.text)).join("\n"), /同步已停用：@news/);
});

test("a transient copy error is retried until the failure budget runs out", async () => {
  const h = await makeRuntime();
  await syncUpsert(h.rt.db, { chatId: GROUP.id, source: "news", intervalSeconds: 300, at: h.now() });
  const [row] = await syncList(h.rt.db, GROUP.id);
  await syncMark(h.rt.db, row!.id, { lastId: 100, at: 0 });
  h.fake.on("copyMessage", () => ({ ok: false, description: "Too Many Requests: retry later", error_code: 429 }));

  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await runSync(h.rt, 10, fetcher(page([101])));
    assert.equal(result.disabled, 0, `attempt ${attempt + 1} must stay enabled`);
    h.advance(301_000); // past the per-channel interval, so the next run polls again
  }
  const fifth = await runSync(h.rt, 10, fetcher(page([101])));
  assert.equal(fifth.disabled, 1, "the fifth consecutive failure disables the mirror");
});

test("an instant mirror that loses its rights disables itself", async () => {
  const h = await makeRuntime();
  await syncUpsert(h.rt.db, { chatId: GROUP.id, source: "news", intervalSeconds: 0, at: h.now() });
  h.fake.on("copyMessage", () => ({ ok: false, description: "Forbidden: bot was kicked", error_code: 403 }));

  const copied = await mirrorChannelPost(h.rt, {
    message_id: 200,
    chat: { id: -100777, type: "channel", title: "news", username: "news" },
    text: "post",
  });

  assert.equal(copied, 0);
  const [after] = await syncList(h.rt.db, GROUP.id);
  assert.equal(after?.enabled, 0);
  assert.match(String(after?.lastError), /kicked/);
});

test("a transient instant-mirror failure keeps the mirror alive", async () => {
  const h = await makeRuntime();
  await syncUpsert(h.rt.db, { chatId: GROUP.id, source: "news", intervalSeconds: 0, at: h.now() });
  h.fake.on("copyMessage", () => ({ ok: false, description: "Internal Server Error", error_code: 500 }));

  assert.equal(
    await mirrorChannelPost(h.rt, { message_id: 201, chat: { id: -100777, type: "channel", username: "news" }, text: "x" }),
    0,
  );
  const [after] = await syncList(h.rt.db, GROUP.id);
  assert.equal(after?.enabled, 1);
  assert.equal(after?.failures, 1);
});

test("describeSync shows the cadence, the watermark and the last error", () => {
  const base = { id: 1, chatId: -1, source: "news", intervalSeconds: 600, lastId: 42, failures: 0, lastError: "", enabled: 1, sent: 7, at: 0 };
  assert.match(describeSync(base), /每 600 秒/);
  assert.match(describeSync(base), /已转 7/);
  assert.match(describeSync(base), /最新 #42/);
  assert.doesNotMatch(describeSync(base), /错误/);
  assert.match(describeSync({ ...base, enabled: 0, lastError: "chat not found" }), /已停用 · .*错误：chat not found/);
  assert.match(describeSync({ ...base, intervalSeconds: 0, lastId: 0 }), /即时/);
});

test("mirroring stops at MAX_PER_RUN even when many posts are waiting", async () => {
  const h = await makeRuntime();
  await syncUpsert(h.rt.db, { chatId: GROUP.id, source: "news", intervalSeconds: 300, at: h.now() });
  const [row] = await syncList(h.rt.db, GROUP.id);
  await syncMark(h.rt.db, row!.id, { lastId: 0, at: 0 });

  const result = await runSync(h.rt, 10, fetcher(page([1, 2, 3, 4, 5, 6, 7, 8])));
  assert.equal(result.copied, 3, "one poll copies at most three posts");
});

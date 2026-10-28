import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUpdate } from "../src/bot.ts";
import { warnCount, warnInc } from "../src/db/repo.ts";
import { DEFAULT_CONFIG } from "../src/rules.ts";
import { GROUP, command, makeRuntime, message, nextUpdate, user } from "./harness.ts";

const spam = (patch: Record<string, unknown> = {}) => message({ text: "加微信 赚快钱", ...patch });

async function seed(h: Awaited<ReturnType<typeof makeRuntime>>, patch: Record<string, unknown>) {
  await h.rt.saveConfig(GROUP.id, patch);
}

test("a keyword hit is deleted, and the first strike mutes for an hour", async () => {
  const h = await makeRuntime();
  await seed(h, { keywords: ["加微信"], locks: [] });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: spam() });

  assert.equal(h.fake.count("deleteMessage"), 1);
  const restrict = h.fake.all("restrictChatMember");
  assert.equal(restrict.length, 1);
  assert.equal(restrict[0]?.body.user_id, 500);
  assert.equal(restrict[0]?.body.permissions.can_send_messages, false);
  const until = Number(restrict[0]?.body.until_date);
  assert.ok(until > h.now() / 1000 + 3000, "mute should last about an hour");
  assert.equal(await warnCount(h.rt.db, GROUP.id, 500, h.now()), 1);
});

test("the second strike mutes for a day, the third bans and clears the count", async () => {
  const h = await makeRuntime();
  await seed(h, { keywords: ["加微信"], locks: [] });

  await handleUpdate(h.rt, { update_id: nextUpdate(), message: spam() });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: spam() });
  const second = h.fake.all("restrictChatMember").at(-1);
  const until = Number(second?.body.until_date) - Math.floor(h.now() / 1000);
  assert.ok(until > 86_000 && until <= 86_400, `expected ~24h, got ${until}`);

  await handleUpdate(h.rt, { update_id: nextUpdate(), message: spam() });
  assert.equal(h.fake.count("banChatMember"), 1);
  assert.equal(await warnCount(h.rt.db, GROUP.id, 500, h.now()), 0, "a ban resets the ladder");
});

test("a redelivered update is processed once", async () => {
  const h = await makeRuntime();
  await seed(h, { keywords: ["加微信"], locks: [] });
  const update = { update_id: nextUpdate(), message: spam() };
  await handleUpdate(h.rt, update);
  await handleUpdate(h.rt, update);
  assert.equal(h.fake.count("deleteMessage"), 1);
});

test("warnings older than 30 days decay and the ladder starts over", async () => {
  const h = await makeRuntime();
  await warnInc(h.rt.db, GROUP.id, 500, h.now());
  await warnInc(h.rt.db, GROUP.id, 500, h.now());
  assert.equal(await warnCount(h.rt.db, GROUP.id, 500, h.now()), 2);

  h.advance(31 * 86_400_000);
  assert.equal(await warnCount(h.rt.db, GROUP.id, 500, h.now()), 0, "a month-old strike is served");
  assert.equal(await warnInc(h.rt.db, GROUP.id, 500, h.now()), 1, "a fresh warning restarts the ladder");
});

test("admins are never filtered", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: "9001" } });
  await seed(h, { keywords: ["加微信"], locks: [] });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: spam({ from: user(9001, "群主") }) });
  assert.equal(h.fake.count("deleteMessage"), 0);
});

test("a locked media type is deleted", async () => {
  const h = await makeRuntime();
  await seed(h, { keywords: [], locks: ["photos"] });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ text: "", photo: [{ file_id: "ph1" }] }) });
  assert.equal(h.fake.count("deleteMessage"), 1);
  assert.match(String(h.fake.find("sendMessage")?.body.text ?? ""), /图片/);
});

test("night mode deletes but tells the group once", async () => {
  const h = await makeRuntime();
  // 2026-10-28T15:30:00Z is 23:30 in UTC+8 → inside 23:00–07:00.
  h.advance(Date.parse("2026-10-28T15:30:00Z") - h.now());
  await seed(h, { nightMode: true, nightStart: "23:00", nightEnd: "07:00", keywords: [], locks: [] });

  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ text: "有人吗" }) });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ text: "有人吗" }) });
  assert.equal(h.fake.count("deleteMessage"), 2);
  const notices = h.fake.all("sendMessage").filter((call) => String(call.body.text).includes("夜间模式"));
  assert.equal(notices.length, 1, "the notice is rate-limited to one per ten minutes");
});

test("flood control triggers on the configured number of messages", async () => {
  const h = await makeRuntime();
  await seed(h, { floodLimit: 2, floodWindow: 10, keywords: [], locks: [] });
  for (let i = 0; i < 4; i++) {
    await handleUpdate(h.rt, { update_id: i + 1, message: message({ text: "刷屏" }) });
  }
  assert.ok(h.fake.count("deleteMessage") >= 2, "the third message onwards is punished");
});

test("an auto-reply fires without touching moderation", async () => {
  const h = await makeRuntime();
  await seed(h, { keywords: [], locks: [] });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/filter add exact 规则 => 看 /rules", { from: user(9001, "群主") }) });
  h.fake.reset();
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ text: "规则" }) });
  assert.equal(h.fake.count("deleteMessage"), 0);
  assert.match(String(h.fake.find("sendMessage")?.body.text ?? ""), /看 \/rules/);
});

test("a stranger cannot run admin commands", async () => {
  const h = await makeRuntime();
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/set maxLength 0") });
  assert.equal(h.fake.count("sendMessage"), 1);
  const text = String(h.fake.find("sendMessage")?.body.text ?? "");
  assert.match(text, /没有这个权限/);
});

test("an admin can change a rule from the group", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: "9001" } });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/set maxLength 0", { from: user(9001, "群主") }) });
  const config = await h.rt.configFor(GROUP.id);
  assert.equal(config.maxLength, 0);
});

test("an admin without the specific right is refused", async () => {
  const h = await makeRuntime();
  // A moderator allowed to delete messages only.
  h.fake.on("getChatMember", () => ({
    ok: true,
    result: { status: "administrator", can_delete_messages: true, can_restrict_members: false },
  }));
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/ban", { from: user(7777), reply_to_message: message({ from: user(8888) }) }) });
  assert.equal(h.fake.count("banChatMember"), 0);
  assert.match(String(h.fake.find("sendMessage")?.body.text ?? ""), /没有这个权限/);

  h.fake.reset();
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/del", { from: user(7777), reply_to_message: message({ from: user(8888) }) }) });
  assert.equal(h.fake.count("deleteMessage"), 1, "deleting is allowed");
});

test("a corrupt stored config falls back to defaults instead of locking the group out", async () => {
  const h = await makeRuntime();
  await h.rt.store.put(`rules:${GROUP.id}`, "{not json");
  h.rt.invalidate(GROUP.id);
  const config = await h.rt.configFor(GROUP.id);
  assert.equal(config.captcha, DEFAULT_CONFIG.captcha);
  assert.deepEqual(config.keywords, DEFAULT_CONFIG.keywords);
});

test("a legacy stored config keeps its link filter", async () => {
  const h = await makeRuntime();
  await h.rt.store.put(`rules:${GROUP.id}`, JSON.stringify({ filterLinks: true, captcha: false }));
  h.rt.invalidate(GROUP.id);
  const config = await h.rt.configFor(GROUP.id);
  assert.deepEqual(config.locks.includes("links"), true);
  assert.equal(config.captcha, false);
});

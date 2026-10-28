import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUpdate } from "../src/bot.ts";
import { answerButton, answerChallenge, pendingChallenge } from "../src/handlers/verify.ts";
import { captchaCode, renderCaptchaPng, CAPTCHA_CHARSET } from "../src/captcha-image.ts";
import { buttonDataAll, makeRuntime, message, nextUpdate, user } from "./harness.ts";
import type { TgMessage } from "../src/types.ts";

const join = (member = user(500)): TgMessage => message({ text: "", from: member, new_chat_members: [member] });

// Deterministic LCG so the PNG bytes are stable across runs.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("captchaCode stays in the unambiguous alphabet", () => {
  const random = seeded(42);
  for (let i = 0; i < 50; i++) {
    const code = captchaCode(random);
    assert.equal(code.length, 5);
    for (const char of code) assert.ok(CAPTCHA_CHARSET.includes(char), char);
  }
  assert.equal(captchaCode(seeded(42)), captchaCode(seeded(42)), "same seed, same code");
});

test("renderCaptchaPng emits a decodable PNG with the expected dimensions", async () => {
  const png = await renderCaptchaPng("AB34X", seeded(7));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR: width/height big-endian at bytes 16-23.
  const view = new DataView(png.buffer, png.byteOffset + 16, 8);
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  assert.equal(width, 10 * 2 + 5 * 6 * 5 - 5);
  assert.equal(height, 10 * 2 + 7 * 5);
  assert.ok(png.byteLength > 1_000, "noise must make the image non-trivial");

  const sharp = (await import("sharp")).default;
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, width);
  assert.equal(meta.height, height);
  assert.equal(meta.format, "png");

  const again = await renderCaptchaPng("AB34X", seeded(7));
  assert.deepEqual([...again], [...png], "same seed, same bytes");
});

test("image mode sends a photo, leaves the member able to type, and a typed code verifies", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { captcha: true, captchaMode: "image" });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: join() });

  assert.equal(h.fake.count("sendPhoto"), 1, "the code ships as an image");
  assert.equal(h.fake.count("restrictChatMember"), 0, "typed answers need the keyboard");

  const challenge = await pendingChallenge(h.rt, -1001, 500);
  assert.ok(challenge?.answers?.[0]?.length, "the code is stored server-side only");
  h.fake.reset();

  await handleUpdate(h.rt, { update_id: nextUpdate(), message: message({ from: user(500), text: "错的答案" }) });
  assert.equal(h.fake.count("deleteMessage"), 1, "wrong pre-answer text is deleted");

  const outcome = await answerChallenge(h.rt, message({ from: user(500), text: challenge!.answers![0] }), await h.rt.configFor(-1001));
  assert.equal(outcome?.ok, true);
  assert.equal(await h.rt.store.get("verify:-1001:500"), null);
});

test("subscribe mode checks the channel instead of trusting the tap", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { captcha: true, captchaMode: "subscribe", captchaChannel: "@chan" });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: join() });

  // Prompt carries both the open-channel URL and the check button.
  const payloads = buttonDataAll(h.fake);
  assert.equal(payloads.length, 1, "only the check button is a callback");
  const markup = h.fake.find("sendMessage")?.body.reply_markup ?? { inline_keyboard: [] };
  const row = JSON.stringify(markup);
  assert.match(row, /t\.me\/chan/);

  // Not subscribed yet: the tap counts a wrong attempt, no unmute.
  h.fake.on("getChatMember", () => ({ ok: true, result: { status: "left" } }));
  h.fake.reset();
  const wrong = await answerButton(h.rt, { chatId: -1001 }, user(500), payloads[0], await h.rt.configFor(-1001));
  assert.equal(wrong.status, "wrong");
  assert.equal(h.fake.count("restrictChatMember"), 0);

  // Subscribed: the same tap verifies and unmutes.
  h.fake.on("getChatMember", () => ({ ok: true, result: { status: "member" } }));
  const ok = await answerButton(h.rt, { chatId: -1001 }, user(500), payloads[0], await h.rt.configFor(-1001));
  assert.equal(ok.status, "ok");
  const restore = h.fake.all("restrictChatMember").at(-1);
  assert.equal(restore?.body.permissions.can_send_messages, true);
});

test("subscribe mode without a configured channel fails loudly instead of silently", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { captcha: true, captchaMode: "subscribe", captchaChannel: "" });
  const { issueChallenge } = await import("../src/handlers/verify.ts");
  const result = await issueChallenge(h.rt, { id: -1001, type: "supergroup", title: "群" }, user(500), await h.rt.configFor(-1001));
  assert.match(result.error ?? "", /captchaChannel/);
});

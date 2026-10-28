/**
 * Vision moderation: provider mapping, caching, and the failure that matters.
 *
 * Every failure test asserts the same contract from a different angle: the
 * provider being down must never delete a member's message. That is the whole
 * reason the feature is opt-in and fail-open, so it is the property under test
 * — not the HTTP status handling for its own sake.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Vision, toBase64 } from "../src/ai/vision.ts";
import { aiUsageGet } from "../src/db/repo.ts";
import { handleMessage } from "../src/handlers/message.ts";
import { message, makeRuntime, user } from "./harness.ts";

const bytes = new Uint8Array([1, 2, 3, 4]);

function stub(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push(String(url));
    return handler(String(url));
  };
  return { fetchImpl, calls };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("base64 survives a payload larger than one spread", () => {
  const big = new Uint8Array(100_000).fill(65);
  const encoded = toBase64(big);
  assert.equal(encoded.length, Math.ceil(big.length / 3) * 4);
  assert.ok(encoded.startsWith("QUFB"));
});

test("a generic provider's labels map onto the configured threshold", async () => {
  const { fetchImpl, calls } = stub(() => json({ labels: [{ name: "adult", score: 0.91 }] }));
  const vision = new Vision({ key: "k", url: "https://vision.test/check", fetchImpl });
  const verdict = await vision.check({ provider: "generic", bytes, mime: "image/jpeg", cacheKey: "u1", minScore: 80, categories: ["nsfw"] });
  assert.equal(verdict.hit, true);
  assert.equal(verdict.category, "nsfw");
  assert.match(verdict.reason, /色情/);
  assert.equal(calls.length, 1);
});

test("a score under the threshold is a clean miss, not a hit", async () => {
  const { fetchImpl } = stub(() => json({ labels: [{ name: "adult", score: 0.62 }] }));
  const vision = new Vision({ key: "k", url: "https://vision.test/check", fetchImpl });
  const verdict = await vision.check({ provider: "generic", bytes, mime: "image/jpeg", cacheKey: "u2", minScore: 80, categories: ["nsfw"] });
  assert.equal(verdict.hit, false);
});

test("a category the chat did not enable is ignored", async () => {
  const { fetchImpl } = stub(() => json({ labels: [{ name: "adult", score: 0.99 }] }));
  const vision = new Vision({ key: "k", url: "https://vision.test/check", fetchImpl });
  const verdict = await vision.check({ provider: "generic", bytes, mime: "image/jpeg", cacheKey: "u3", minScore: 50, categories: ["gambling"] });
  assert.equal(verdict.hit, false);
});

test("cloud-vision's safeSearch likelihood becomes a score", async () => {
  const { fetchImpl } = stub(() =>
    json({
      responses: [
        {
          safeSearchAnnotation: { adult: "VERY_LIKELY", racy: "POSSIBLE", violence: "UNLIKELY" },
          labelAnnotations: [{ description: "Poster", score: 0.7 }],
        },
      ],
    }),
  );
  const vision = new Vision({ key: "k", url: "https://vision.test/check", fetchImpl });
  const verdict = await vision.check({ provider: "cloud-vision", bytes, mime: "image/jpeg", cacheKey: "u4", minScore: 80, categories: ["nsfw"] });
  assert.equal(verdict.hit, true);
  assert.ok(verdict.score >= 80);
});

test("the same image is judged once", async () => {
  const { fetchImpl, calls } = stub(() => json({ labels: [{ name: "casino", score: 0.95 }] }));
  const vision = new Vision({ key: "k", url: "https://vision.test/check", fetchImpl });
  const first = await vision.check({ provider: "generic", bytes, mime: "image/jpeg", cacheKey: "u5", minScore: 80, categories: ["gambling"] });
  const second = await vision.check({ provider: "generic", bytes, mime: "image/jpeg", cacheKey: "u5", minScore: 80, categories: ["gambling"] });
  assert.equal(calls.length, 1, "a shot of the same sticker must not cost twice");
  assert.equal(first.used, true);
  assert.equal(second.used, false);
  assert.equal(second.hit, true);
});

test("a 502 is retried once, then fails open", async () => {
  const { fetchImpl, calls } = stub(() => new Response("bad gateway", { status: 502 }));
  const vision = new Vision({ key: "k", url: "https://vision.test/check", fetchImpl });
  const verdict = await vision.check({ provider: "generic", bytes, mime: "image/jpeg", cacheKey: "u6", minScore: 80, categories: ["nsfw"] });
  assert.equal(calls.length, 2);
  assert.equal(verdict.hit, false);
  assert.equal(verdict.failed, true);
});

test("429 is not retried — retrying a quota error makes it worse", async () => {
  const { fetchImpl, calls } = stub(() => new Response("slow down", { status: 429 }));
  const vision = new Vision({ key: "k", url: "https://vision.test/check", fetchImpl });
  const verdict = await vision.check({ provider: "generic", bytes, mime: "image/jpeg", cacheKey: "u7", minScore: 80, categories: ["nsfw"] });
  assert.equal(calls.length, 1);
  assert.equal(verdict.hit, false);
  assert.equal(verdict.failed, true);
});

test("a timeout fails open without throwing", async () => {
  const { fetchImpl, calls } = stub(() => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  });
  const vision = new Vision({ key: "k", url: "https://vision.test/check", fetchImpl });
  const verdict = await vision.check({ provider: "generic", bytes, mime: "image/jpeg", cacheKey: "u8", minScore: 80, categories: ["nsfw"] });
  assert.equal(calls.length, 1, "a timeout already spent the budget; do not retry");
  assert.equal(verdict.hit, false);
  assert.equal(verdict.failed, true);
});

test("a failed image is not retried for five minutes", async () => {
  const { fetchImpl, calls } = stub(() => new Response("nope", { status: 500 }));
  const vision = new Vision({ key: "k", url: "https://vision.test/check", fetchImpl });
  await vision.check({ provider: "generic", bytes, mime: "image/jpeg", cacheKey: "u9", minScore: 80, categories: ["nsfw"] });
  const second = await vision.check({ provider: "generic", bytes, mime: "image/jpeg", cacheKey: "u9", minScore: 80, categories: ["nsfw"] });
  assert.equal(calls.length, 2, "two attempts on the first call, none on the second");
  assert.equal(second.failed, true);
});

test("no key means no call at all", async () => {
  const { fetchImpl, calls } = stub(() => json({}));
  const vision = new Vision({ url: "https://vision.test/check", fetchImpl });
  const verdict = await vision.check({ provider: "generic", bytes, mime: "image/jpeg", cacheKey: "u10", minScore: 80, categories: ["nsfw"] });
  assert.equal(calls.length, 0);
  assert.equal(verdict.used, false);
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function photoRuntime(handler: (url: string) => Response) {
  const visionCalls: string[] = [];
  const h = await makeRuntime({
    env: { VISION_KEY: "test-key", VISION_URL: "https://vision.test/check" },
    fetchImpl: async (url: string) => {
      visionCalls.push(String(url));
      return handler(String(url));
    },
  });
  h.fake.onFile("photos/1.jpg", new Uint8Array([0xff, 0xd8, 0xff]));
  await h.rt.saveConfig(-1001, { ai: true, aiMinScore: 80, aiCategories: ["nsfw"], keywords: [] });
  return { h, visionCalls };
}

const photo = () => message({ from: user(500), text: "", photo: [{ file_id: "f1", file_unique_id: "u1" }] as never });

test("a hit deletes the image and counts a warning", async () => {
  const { h } = await photoRuntime(() => new Response(JSON.stringify({ labels: [{ name: "adult", score: 0.97 }] }), { status: 200 }));
  await handleMessage(h.rt, photo());
  assert.equal(h.fake.count("deleteMessage"), 1);
  const day = new Date(h.rt.now() + 480 * 60_000).toISOString().slice(0, 10);
  const usage = await aiUsageGet(h.rt.db, -1001, day);
  assert.equal(usage.calls, 1);
  assert.equal(usage.hits, 1);
});

test("a provider outage leaves the image in place", async () => {
  const { h } = await photoRuntime(() => new Response("bad gateway", { status: 502 }));
  await handleMessage(h.rt, photo());
  assert.equal(h.fake.count("deleteMessage"), 0, "fail-open: no provider opinion means no action");
  const day = new Date(h.rt.now() + 480 * 60_000).toISOString().slice(0, 10);
  const usage = await aiUsageGet(h.rt.db, -1001, day);
  assert.equal(usage.failures, 1);
  assert.equal(usage.hits, 0);
});

test("a 429 outage also leaves the image in place", async () => {
  const { h } = await photoRuntime(() => new Response("too many", { status: 429 }));
  await handleMessage(h.rt, photo());
  assert.equal(h.fake.count("deleteMessage"), 0);
});

test("crossing the daily budget stops calling and says so once", async () => {
  const { h, visionCalls } = await photoRuntime(() => new Response(JSON.stringify({ labels: [] }), { status: 200 }));
  await h.rt.saveConfig(-1001, { aiDailyBudget: 10 });
  const day = new Date(h.rt.now() + 480 * 60_000).toISOString().slice(0, 10);
  const { aiUsageBump } = await import("../src/db/repo.ts");
  await aiUsageBump(h.rt.db, -1001, day, { calls: 10 });

  // A fresh runtime is not needed: the counter is seeded from the row once.
  await handleMessage(h.rt, photo());
  await handleMessage(h.rt, message({ from: user(500), text: "", photo: [{ file_id: "f2", file_unique_id: "u2" }] as never }));

  assert.equal(visionCalls.length, 0, "no call once the budget is spent");
  const texts = h.fake.all("sendMessage").map((call) => String(call.body.text));
  assert.equal(texts.filter((text) => /额度已用完/.test(text)).length, 1, "one alert per day, not one per image");
});

test("the check is skipped entirely when the chat turned AI off", async () => {
  const { h, visionCalls } = await photoRuntime(() => new Response("{}", { status: 200 }));
  await h.rt.saveConfig(-1001, { ai: false });
  await handleMessage(h.rt, photo());
  assert.equal(visionCalls.length, 0);
  assert.equal(h.fake.count("deleteMessage"), 0);
});

test("usage rows accumulate across calls", async () => {
  const { h } = await photoRuntime(() => new Response(JSON.stringify({ labels: [{ name: "adult", score: 0.99 }] }), { status: 200 }));
  await handleMessage(h.rt, photo());
  await handleMessage(h.rt, message({ from: user(500), text: "", photo: [{ file_id: "f9", file_unique_id: "u9" }] as never }));
  const day = new Date(h.rt.now() + 480 * 60_000).toISOString().slice(0, 10);
  const usage = await aiUsageGet(h.rt.db, -1001, day);
  assert.equal(usage.calls, 2);
  assert.equal(usage.hits, 2);
});

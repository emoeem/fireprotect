/**
 * The media-moderation step of the message pipeline.
 *
 * Three concerns are deliberately kept in this one function, because they all
 * have to agree or the feature is worse than nothing:
 *
 *  1. **budget** — the daily cap is checked before the download, so a group
 *     that reached its limit costs one cached read and no API call;
 *  2. **cost accounting** — every call (hit, miss or failure) is written once,
 *     because "why did my bill triple" is answered by this row, not by logs;
 *  3. **fail-open** — a provider that is down returns `hit: false`. The caller
 *     keeps going, the message stays, and an admin sees the failure in /stats.
 */
import { cachesFor } from "../caches.ts";
import type { Runtime } from "../context.ts";
import { aiUsageBump, aiUsageGet } from "../db/repo.ts";
import { say } from "../moderation.ts";
import { dayKey } from "./words.ts";
import { AI_MAX_BYTES, type VisionSubject } from "./vision.ts";
import type { ChatConfig } from "../rules.ts";

export type MediaVerdict = { hit: boolean; reason: string };

export async function checkMedia(rt: Runtime, config: ChatConfig, chatId: number, subject: VisionSubject): Promise<MediaVerdict> {
  if (!config.ai) return { hit: false, reason: "" };
  if (!rt.vision.configured(config.aiProvider)) return { hit: false, reason: "" };

  const day = dayKey(rt.now(), rt.tzOffset);
  const budgetKey = `${chatId}:${day}`;
  const caches = cachesFor(rt);

  let calls = caches.aiCalls.get(budgetKey);
  if (calls === undefined) {
    const row = await aiUsageGet(rt.db, chatId, day).catch(() => ({ calls: 0, hits: 0, failures: 0, ms: 0 }));
    calls = row.calls;
    caches.aiCalls.set(budgetKey, calls);
  }

  if (calls >= config.aiDailyBudget) {
    if (!caches.aiAlerted.has(budgetKey)) {
      caches.aiAlerted.set(budgetKey, true);
      await say(rt, chatId, `图片审核今日额度已用完（${calls}/${config.aiDailyBudget} 次），明天自动恢复。`).catch(() => undefined);
    }
    return { hit: false, reason: "" };
  }

  const started = rt.now();
  const file = await rt.api.download(subject.fileId, AI_MAX_BYTES);
  if (!file.ok) {
    // Download failures are Telegram's problem, not the provider's: count them
    // as a failure but do not poison the provider's health row.
    await aiUsageBump(rt.db, chatId, day, { calls: 0, failures: 1 }).catch(() => undefined);
    return { hit: false, reason: "" };
  }

  const verdict = await rt.vision.check({
    provider: config.aiProvider,
    bytes: file.bytes,
    mime: subject.mime,
    cacheKey: subject.uniqueId,
    minScore: config.aiMinScore,
    categories: config.aiCategories,
  });
  const elapsed = rt.now() - started;

  if (verdict.used) {
    caches.aiCalls.set(budgetKey, calls + 1);
    await aiUsageBump(rt.db, chatId, day, {
      calls: 1,
      hits: verdict.hit ? 1 : 0,
      failures: verdict.failed ? 1 : 0,
      ms: elapsed,
    }).catch(() => undefined);
  }

  return { hit: verdict.hit, reason: verdict.hit ? `图片${verdict.reason}` : "" };
}

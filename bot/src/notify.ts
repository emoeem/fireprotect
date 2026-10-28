/**
 * Push critical background failures to the operators' private chats.
 *
 * Cron jobs and the webhook's catch-alls only `console.log` today, which means
 * a silently broken sweeper is discovered when the group starts complaining.
 * This is the cheapest fix that actually reaches a human: one sendMessage per
 * id in `ADMIN_IDS`, throttled per reason key so a broken cron cannot turn the
 * bot into a personal spam machine.
 *
 * Two accepted trade-offs, both consistent with update deduplication:
 *  - the throttle lives in the per-isolate caches, so a redeploy may repeat one
 *    notification;
 *  - one shared key per failure class means a second, different row failing
 *    within the window stays quiet until the first message has aged out.
 *
 * Notifying must never be the thing that crashes the caller: everything here
 * swallows its own failures on purpose.
 */
import { cachesFor } from "./caches.ts";
import type { Runtime } from "./context.ts";

const THROTTLE_MS = 24 * 3_600_000;

export async function notifyOperators(rt: Runtime, key: string, text: string): Promise<void> {
  try {
    const caches = cachesFor(rt);
    const last = caches.notifyAt.get(key) ?? 0;
    if (rt.now() - last < THROTTLE_MS) return;
    caches.notifyAt.set(key, rt.now());
    const body = { text: `焰卫告警：${String(text).slice(0, 500)}` };
    for (const chatId of rt.admin.staticIds()) {
      await rt.api.call("sendMessage", { chat_id: chatId, ...body }).catch(() => undefined);
    }
  } catch {
    // Never let the alarm be the crash.
  }
}

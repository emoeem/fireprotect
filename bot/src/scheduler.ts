/**
 * Scheduled messages.
 *
 * The cron trigger fires every minute; each run sends whatever is due and books
 * the next slot. Two rules keep this safe:
 *  - a failure is retried in five minutes, and a *permanent* failure (bot
 *    kicked, no rights) disables the row instead of retrying forever;
 *  - `next_at` advances even when the send failed, so a broken chat cannot make
 *    the same row fire in a tight loop.
 */
import type { Runtime } from "./context.ts";
import { cachesFor } from "./caches.ts";
import { aiUsagePrune, eventsPrune, parseJobsPrune, toolUsagePrune, wordStatsPrune, memberStatsPrune } from "./db/repo.ts";
import { scheduleDue, scheduleMarkSent } from "./db/repo.ts";
import { leaderboard, leaderboardText } from "./members.ts";
import { notifyOperators } from "./notify.ts";
import { say } from "./moderation.ts";
import { escapeHtml } from "./telegram.ts";

const RETRY_MS = 5 * 60_000;

/** Errors that will never succeed on retry. */
const PERMANENT = /chat not found|bot was kicked|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|user is deactivated/i;

export async function runScheduled(rt: Runtime, limit = 10): Promise<{ sent: number; failed: number; disabled: number }> {
  const due = await scheduleDue(rt.db, rt.now(), limit);
  let sent = 0;
  let failed = 0;
  let disabled = 0;

  for (const row of due) {
    // `{{top}}` in a scheduled message is a placeholder, not literal text: it
    // turns any daily slot into "post the leaderboard" without a new feature.
    const text = row.text.includes("{{top}}")
      ? row.text.split("{{top}}").join(leaderboardText(await leaderboard(rt, row.chatId, 10)))
      : row.text;
    const res = await say(rt, row.chatId, text, { html: true });
    if (res.ok) {
      sent += 1;
      await scheduleMarkSent(rt.db, row.id, row.every > 0 ? rt.now() + row.every * 1000 : null);
      continue;
    }

    failed += 1;
    if (PERMANENT.test(res.error)) {
      disabled += 1;
      await scheduleMarkSent(rt.db, row.id, null, res.error);
    } else {
      await scheduleMarkSent(rt.db, row.id, rt.now() + RETRY_MS, `${res.error}${row.lastError ? ` | 上次：${row.lastError}` : ""}`.slice(0, 200));
    }
    console.log(`scheduled #${row.id} failed: ${res.error}`);
    void notifyOperators(rt, "scheduled-row-failed", `定时消息 #${row.id} 发送失败：${res.error.slice(0, 200)}`);
  }

  return { sent, failed, disabled };
}

const RETENTION_BUCKET_MS = 3_600_000;

/**
 * Retention pruning, throttled to the first cron tick of each hour.
 *
 * The cron fires every minute; five DELETEs an hour is all an append-only
 * archive needs, and the bucket stamp in the per-runtime caches keeps tests
 * deterministic. The deletes are idempotent, so two isolates both hitting the
 * top of the hour only waste one no-op DELETE each.
 */
export async function runRetention(rt: Runtime): Promise<{ pruned: boolean; failed: string[] }> {
  const caches = cachesFor(rt);
  const bucket = Math.floor(rt.now() / RETENTION_BUCKET_MS);
  if (caches.retentionBucket === bucket) return { pruned: false, failed: [] };
  caches.retentionBucket = bucket;

  const now = rt.now();
  const jobs: [string, () => Promise<unknown>][] = [
    ["events", () => eventsPrune(rt.db, now)],
    ["word_stats", () => wordStatsPrune(rt.db, now)],
    ["ai_usage", () => aiUsagePrune(rt.db, now)],
    ["parse_jobs", () => parseJobsPrune(rt.db, now)],
    ["tool_usage", () => toolUsagePrune(rt.db, now)],
    ["member_stats", () => memberStatsPrune(rt.db, now)],
  ];
  const failed: string[] = [];
  for (const [name, job] of jobs) {
    await job().catch(() => failed.push(name));
  }
  if (failed.length) {
    console.log(`retention failed for: ${failed.join(", ")}`);
    void notifyOperators(rt, "retention-failed", `数据保留清理失败：${failed.join(", ")}`);
  }
  return { pruned: true, failed };
}

/** Human-readable summary of one row, used by /schedule and the panel. */
export function describeSchedule(row: { every: number; enabled: number; nextAt: number; sent: number; lastError: string }, tzOffset = 480): string {
  const when = new Date(row.nextAt + tzOffset * 60_000).toISOString().slice(0, 16).replace("T", " ");
  const cadence = row.every > 0 ? `每 ${row.every} 秒` : "一次性";
  const parts = [`${cadence}`, row.enabled ? `下次 ${when}` : "已停用", `已发 ${row.sent}`];
  if (row.lastError) parts.push(`错误：${escapeHtml(row.lastError.slice(0, 60))}`);
  return parts.join(" · ");
}

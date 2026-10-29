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
import {
  aiUsagePrune,
  eventsPrune,
  parseJobsPrune,
  toolUsagePrune,
  wordStatsPrune,
  memberStatsPrune,
} from "./db/repo.ts";
import { claimScheduled, scheduleDue, scheduleMarkSent } from "./db/repo.ts";
import { leaderboard, leaderboardText } from "./members.ts";
import { notifyOperators } from "./notify.ts";
import { say } from "./moderation.ts";
import { escapeHtml } from "./telegram.ts";

const RETRY_MS = 5 * 60_000;

/** Errors that will never succeed on retry. */
const PERMANENT =
  /chat not found|bot was kicked|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|user is deactivated/i;

export async function runScheduled(
  rt: Runtime,
  limit = 10,
): Promise<{ sent: number; failed: number; disabled: number }> {
  // 原子认领：cron 与 Node 长轮询共用同一张表，纯 SELECT 会让两个运行时
  // 各发一遍。逐行按 next_at 做 CAS，谁改到行谁发送；认领把 next_at 推进
  // 5 分钟，发送中途崩溃的行最多延迟 5 分钟重试。
  const nowMs = rt.now();
  const due = await scheduleDue(rt.db, nowMs, limit);
  let sent = 0;
  let failed = 0;
  let disabled = 0;

  for (const row of due) {
    const token = `${nowMs}:${Math.random().toString(36).slice(2, 10)}`;
    const claimed = await claimScheduled(rt.db, row.id, row.nextAt, token, nowMs);
    if (!claimed) continue; // 另一个运行时认领了这一行
    // `{{top}}` in a scheduled message is a placeholder, not literal text: it
    // turns any daily slot into "post the leaderboard" without a new feature.
    // 消息按 HTML 发送：管理员写的正文与 {{top}} 展开的成员名都可能含 <、&，
    // 不转义就是每 5 分钟一次的 400（bad entities），该行永远发不出去。
    // 逐段转义字面文本，排行榜本身已是构造好的 HTML，原样插入。
    const leaderboardHtml = row.text.includes("{{top}}")
      ? leaderboardText(await leaderboard(rt, row.chatId, 10))
      : "";
    const text = row.text
      .split("{{top}}")
      .map((segment) => escapeHtml(segment))
      .join(leaderboardHtml);
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
      await scheduleMarkSent(
        rt.db,
        row.id,
        rt.now() + RETRY_MS,
        `${res.error}${row.lastError ? ` | 上次：${row.lastError}` : ""}`.slice(0, 200),
      );
    }
    console.log(`scheduled #${row.id} failed: ${res.error}`);
    void notifyOperators(
      rt,
      "scheduled-row-failed",
      `定时消息 #${row.id} 发送失败：${res.error.slice(0, 200)}`,
    );
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
export function describeSchedule(
  row: { every: number; enabled: number; nextAt: number; sent: number; lastError: string },
  tzOffset = 480,
): string {
  const when = new Date(row.nextAt + tzOffset * 60_000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
  const cadence = row.every > 0 ? `每 ${row.every} 秒` : "一次性";
  const parts = [`${cadence}`, row.enabled ? `下次 ${when}` : "已停用", `已发 ${row.sent}`];
  if (row.lastError) parts.push(`错误：${escapeHtml(row.lastError.slice(0, 60))}`);
  return parts.join(" · ");
}

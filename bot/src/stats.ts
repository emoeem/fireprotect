/**
 * The `/stats` body, extracted so the in-chat command and the help card's
 * "统计" button render the same numbers.
 *
 * Two renderers over one dataset is how a report starts disagreeing with
 * itself: the console says 12 deletions, `/stats` says 9, and nobody can tell
 * which one is lying. One function, two entry points.
 */
import type { Runtime } from "./context.ts";
import { dayKey } from "./ai/words.ts";
import { aiUsageGet, banCount, chatStats, parseJobStats, recentEvents, wordTop } from "./db/repo.ts";

const LABEL: Record<string, string> = {
  delete: "删除",
  mute: "禁言",
  ban: "封禁",
  kick: "移出",
  warn: "警告",
  verify: "验证通过",
  join: "进群",
  leave: "退群",
  external: "外部命中",
  trust: "信任",
  block: "屏蔽",
  watch: "只记录",
};

/** Shared with the audit commands so `/actions` and `/stats` never disagree. */
export const KIND_LABELS = LABEL;

/** Chronological summary for one group over the last `days` days. */
export async function statsText(rt: Runtime, chatId: number, days: number): Promise<string> {
  const span = Math.max(1, Math.min(days, 90));
  const since = rt.now() - span * 86_400_000;
  const stats = await chatStats(rt.db, chatId, since);
  const banTotal = await banCount(rt.db).catch(() => 0);
  const recent = await recentEvents(rt.db, chatId, 5).catch(() => []);

  const lines = [`最近 ${span} 天（本群）：`];
  const entries = Object.entries(stats.totals).filter(([, n]) => n > 0);
  lines.push(entries.length ? entries.map(([kind, n]) => `${LABEL[kind] ?? kind} ${n}`).join("｜") : "没有记录。");

  const today = stats.perDay.filter((row) => row.day === new Date(rt.now() + rt.tzOffset * 60_000).toISOString().slice(0, 10));
  if (today.length) lines.push(`今天：${today.map((row) => `${LABEL[row.kind] ?? row.kind} ${row.n}`).join("｜")}`);

  if (recent.length) {
    lines.push("最近动作：");
    for (const row of recent) lines.push(`· ${LABEL[row.kind] ?? row.kind} ${row.userId || "-"} ${row.reason}`.slice(0, 80));
  }

  const day = dayKey(rt.now(), rt.tzOffset);
  const top = await wordTop(rt.db, chatId, day, 5).catch(() => []);
  if (top.length) lines.push(`今日热词：${top.map((row) => `${row.word} ${row.count}`).join("｜")}`);

  const ai = await aiUsageGet(rt.db, chatId, day).catch(() => null);
  if (ai && (ai.calls || ai.hits || ai.failures)) {
    lines.push(`图片审核：调用 ${ai.calls}｜命中 ${ai.hits}｜失败 ${ai.failures}`);
  }

  const jobs = await parseJobStats(rt.db, chatId, since).catch(() => null);
  if (jobs && jobs.total) lines.push(`链接解析：${jobs.total} 次｜成功 ${jobs.done}｜失败 ${jobs.failed}`);

  lines.push(`共享黑名单：${banTotal} 人`);
  return lines.join("\n");
}

/**
 * Toolbox registry and the one thing all tools share: a per-member budget.
 *
 * A file-processing tool is the only command that can make the bot upload tens
 * of megabytes. Four calls a minute per member is generous for a human and
 * useless for a loop.
 */
import { cachesFor } from "../caches.ts";
import type { Runtime } from "../context.ts";

export const TOOLS: { command: string; usage: string; what: string }[] = [
  { command: "/splitpdf", usage: "（回复一个 PDF）", what: "按页拆成多个 PDF 发回" },
  { command: "/slice", usage: "（回复一张长截图）", what: "切成可读高度，需自托管版" },
  { command: "/expand", usage: "t.me 链接", what: "展开频道 / 帖子的标题与摘要" },
  { command: "/ts", usage: "1700000000 或 2026-10-28 18:00", what: "时间戳与日期互转" },
];

export const TOOL_USAGE_LINE = "工具箱：" + TOOLS.map((tool) => `${tool.command} ${tool.usage}`).join("｜");

export function allowTool(rt: Runtime, userId: number, limit = 4, windowMs = 60_000): boolean {
  const cache = cachesFor(rt).toolRate;
  const key = String(userId);
  const now = rt.now();
  const stamps = (cache.get(key) ?? []).filter((at) => now - at < windowMs);
  if (stamps.length >= limit) {
    cache.set(key, stamps);
    return false;
  }
  stamps.push(now);
  cache.set(key, stamps);
  return true;
}

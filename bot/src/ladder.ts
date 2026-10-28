/**
 * Strike ladder.
 *
 * A flat "3 warnings then ban" is wrong for a busy group: the first offence
 * should be a short mute so the member notices, not a permanent ban. The ladder
 * is data, not code, so an admin can change it without a deploy.
 */
import type { ChatConfig, Strike } from "./rules.ts";

export function strikeAt(count: number, config: Pick<ChatConfig, "strikes" | "warnLimit">): Strike | null {
  if (count <= 0) return null;
  if (config.strikes.length === 0) {
    if (config.warnLimit > 0 && count >= config.warnLimit) return { at: config.warnLimit, action: "ban", minutes: 0 };
    return null;
  }
  let chosen: Strike | null = null;
  for (const strike of [...config.strikes].sort((a, b) => a.at - b.at)) {
    if (count >= strike.at) chosen = strike;
  }
  return chosen;
}

export function describeStrike(strike: Strike): string {
  switch (strike.action) {
    case "ban":
      return "封禁";
    case "kick":
      return "移出";
    case "mute":
      return `禁言 ${strike.minutes} 分钟`;
    default:
      return "警告";
  }
}

/** True when the ladder already covers every level, i.e. no "count-only" warning. */
export function ladderCovers(count: number, config: Pick<ChatConfig, "strikes">): boolean {
  return config.strikes.some((strike) => strike.at === count);
}

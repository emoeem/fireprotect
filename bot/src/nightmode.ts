/**
 * Night mode.
 *
 * Telegram has no per-group timezone, so the offset is a deployment setting
 * (`TZ_OFFSET`, minutes from UTC, default +480). Storing it once beats asking
 * every admin to convert their own clock.
 */

export function minutesOfDay(hhmm: string): number {
  const [hour, minute] = String(hhmm).split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return ((hour % 24) * 60 + (minute % 60) + 1440) % 1440;
}

/**
 * Window check that handles the wrap (23:00–07:00). A start equal to the end
 * means "all day" only when explicitly configured, so it is treated as empty
 * here to avoid locking a group for 24 hours by typo.
 */
export function inNightWindow(nowMs: number, start: string, end: string, tzOffsetMinutes = 480): boolean {
  const startMin = minutesOfDay(start);
  const endMin = minutesOfDay(end);
  if (startMin === endMin) return false;
  const local = (Math.floor(nowMs / 60_000) + tzOffsetMinutes + 1440) % 1440;
  return startMin < endMin ? local >= startMin && local < endMin : local >= startMin || local < endMin;
}

/** ISO-ish local clock label, for log lines and /stats. */
export function localClock(nowMs: number, tzOffsetMinutes = 480): string {
  const local = new Date(nowMs + tzOffsetMinutes * 60_000);
  return local.toISOString().slice(11, 16);
}

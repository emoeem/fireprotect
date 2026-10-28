/** `/ts` — one number or datetime in, every useful form out. */
export type StampView = { unix: number; ms: number; iso: string; local: string };

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

export function convertTimestamp(input: string, tzOffsetMinutes = 480): StampView | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  let ms: number | null = null;
  if (/^\d{10}$/.test(raw)) ms = Number(raw) * 1000;
  else if (/^\d{13}$/.test(raw)) ms = Number(raw);
  else {
    const local = raw.match(LOCAL);
    if (local) {
      // Interpret a naked datetime in the deployment's zone, not the server's.
      const [, y, mo, d, h, mi, s] = local;
      ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)) - tzOffsetMinutes * 60_000;
    } else {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) ms = parsed;
    }
  }
  if (ms === null || !Number.isFinite(ms)) return null;

  const local = new Date(ms + tzOffsetMinutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
  return {
    unix: Math.floor(ms / 1000),
    ms,
    iso: new Date(ms).toISOString(),
    local: `${local} (UTC${tzOffsetMinutes >= 0 ? "+" : ""}${(tzOffsetMinutes / 60).toFixed(1)})`,
  };
}

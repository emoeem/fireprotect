/**
 * The console-editable activation preset.
 *
 * Stored in KV rather than D1 because it is one small document that every new
 * chat reads exactly once; the default `PRESET` stays in code so a deleted key
 * cannot leave new groups unprotected.
 *
 * Validation is per present key, never a whole-object parse: `partial()` on a
 * schema whose fields carry `.default()` fills every absent field, so a
 * round-trip through it would silently turn "{floodLimit: 7}" into a full
 * configuration — and then every later edit would write all 30 fields back.
 */
import type { Runtime } from "./context.ts";
import { configSchema, type ChatConfig } from "./rules.ts";

const KEY = "preset:global";

/** Keep only the keys that were actually stored, validated one by one. */
function pick(raw: Record<string, unknown>): Partial<ChatConfig> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = (configSchema.shape as Record<string, { safeParse(input: unknown): { success: boolean; data?: unknown } }>)[key];
    if (!field) continue;
    const parsed = field.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as Partial<ChatConfig>;
}

async function readRaw(rt: Runtime): Promise<Record<string, unknown>> {
  const raw = await rt.store.get(KEY).catch(() => null);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function getPreset(rt: Runtime): Promise<Partial<ChatConfig>> {
  return pick(await readRaw(rt));
}

export async function savePreset(rt: Runtime, patch: Record<string, unknown>): Promise<string> {
  const current = pick(await readRaw(rt));
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const field = (configSchema.shape as Record<string, { safeParse(input: unknown): { success: boolean; error?: { issues: { message: string }[] } } }>)[key];
    if (!field) return `未知字段：${key}`;
    const parsed = field.safeParse(value);
    if (!parsed.success) return `${key}：${parsed.error?.issues[0]?.message ?? "不合法"}`;
    next[key] = (parsed as { data?: unknown }).data;
  }
  await rt.store.put(KEY, JSON.stringify(next));
  return "";
}

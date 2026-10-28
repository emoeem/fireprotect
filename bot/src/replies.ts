/**
 * Auto-replies (`/filter`).
 *
 * Regex comes from a chat admin, so it is compiled defensively: capped pattern
 * length, capped subject length, and a failed compile is treated as "no match"
 * rather than an exception inside the message handler. A true ReDoS guard needs
 * a worker or a linear-time engine; the caps below are the pragmatic trade for
 * a bot with no extra runtime.
 */
import type { FilterRow } from "./db/schema.ts";

export type FilterMatchMode = "exact" | "prefix" | "regex";

const MAX_PATTERN = 200;
const MAX_SUBJECT = 500;

const compiled = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
  if (pattern.length > MAX_PATTERN) return null;
  const cached = compiled.get(pattern);
  if (cached !== undefined) return cached;
  let result: RegExp | null = null;
  try {
    result = new RegExp(pattern, "i");
  } catch {
    result = null;
  }
  compiled.set(pattern, result);
  return result;
}

export function matchReplyFilter(filters: FilterRow[], text: string): FilterRow | null {
  const value = text.trim();
  if (!value) return null;
  const subject = value.slice(0, MAX_SUBJECT);
  const lower = subject.toLowerCase();

  for (const filter of filters) {
    if (filter.match === "exact") {
      if (lower === filter.trigger.toLowerCase()) return filter;
      continue;
    }
    if (filter.match === "prefix") {
      if (lower.startsWith(filter.trigger.toLowerCase())) return filter;
      continue;
    }
    const re = compile(filter.trigger);
    if (re && re.test(subject)) return filter;
  }
  return null;
}

export const MATCH_MODES: FilterMatchMode[] = ["exact", "prefix", "regex"];

/**
 * Feature flags.
 *
 * Every flag is read from a `VITE_FF_*` environment variable so a behaviour
 * change can be rolled back without reverting code: set the variable to `0`,
 * restart, done. Defaults are the shipped behaviour, so an unset environment
 * and a fresh checkout agree.
 *
 * Consequence to keep in mind: anything gated here must behave identically to
 * the old code when the flag is off — flags express rollout, not correctness.
 */

function read(name: string): string | undefined {
  // `import.meta.env` is replaced at build time by Vite and is absent when the
  // module is loaded by plain node; `process.env` covers the server and tests.
  const fromVite = (import.meta.env as Record<string, string | undefined> | undefined)?.[name];
  const fromNode =
    typeof process !== "undefined" ? (process.env as Record<string, string | undefined>)[name] : undefined;
  return (fromVite ?? fromNode)?.trim().toLowerCase();
}

function flag(name: string, fallback: boolean): boolean {
  const raw = read(name);
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return fallback;
}

export const FLAGS = {
  /** Generated worker: HTML escaping, `/id` without a sender, secret fallback. */
  hardenWorker: flag("VITE_FF_HARDEN_WORKER", true),
  /** Generated worker: refuse an ambiguous `/mute 10` instead of muting user 10. */
  strictTargets: flag("VITE_FF_STRICT_TARGETS", true),
  /** Generated worker: `/install` no longer drops pending updates. */
  keepPendingUpdates: flag("VITE_FF_KEEP_PENDING_UPDATES", true),
  /** UI: the pre-deploy configuration report. */
  configDoctor: flag("VITE_FF_CONFIG_DOCTOR", true),
} as const;

export type Flags = typeof FLAGS;

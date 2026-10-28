/**
 * Per-host circuit breaker for `/parse`.
 *
 * The failure this exists for is not "a link is broken" but "a site banned our
 * egress IP". In that state every link on that host fails the same way, and
 * retrying once per link per user is exactly what turns a one-hour ban into a
 * one-day ban. The unit that fails is the **host**, so the state is kept per
 * host; keying by URL would re-attempt the ban once per shared link.
 *
 * Deliberately pure: no timers, no `Date.now()`, no I/O. Time comes in through
 * the injected `now`, which is what lets the whole state machine — including
 * the cooldown doubling — be proven by a test with a fake clock and no network.
 *
 * States:
 *
 *   closed ──(N consecutive failures)──► open ──(cooldown elapsed)──► half-open
 *      ▲                                   ▲                              │
 *      └──────── success ──────────────────┴────── probe failed ──────────┘
 *
 * Half-open lets exactly **one** probe through. A second caller arriving while
 * that probe is in flight is rejected rather than queued: the queue would hold
 * N user updates behind a site that is probably still banned, and the answer
 * "该站暂不支持" is more useful than a spinner. `retryAfterMs: 0` in that case
 * means "a probe is already running", which the caller renders as "稍后".
 *
 * Cooldown starts at 60 s and doubles on every re-open (60 → 120 → 240 …)
 * because the two failure modes have very different time constants: a
 * transient 502 is back in seconds, an IP ban lasts minutes to hours. Doubling
 * converges on `maxCooldownMs` (30 min) so a dead site costs one probe per half
 * hour instead of one per user request.
 */

export type BreakerOptions = {
  /** Injected clock. Nothing in this file calls `Date.now()`. */
  now: () => number;
  /** Consecutive failures that open the breaker. */
  failureThreshold?: number;
  /** First cooldown; doubled on every re-open. */
  cooldownMs?: number;
  /** Ceiling for the doubled cooldown. */
  maxCooldownMs?: number;
  /**
   * How long a granted probe may stay unreported before another one is allowed.
   * Without it, a caller that forgets to report back jams the host forever.
   * Comfortably above the downloader's own 90 s budget.
   */
  probeGraceMs?: number;
};

export type BreakerState = "closed" | "open" | "half-open";

export type AllowDecision = { allow: true; probe: boolean } | { allow: false; retryAfterMs: number };

export type BreakerOutcome<T> =
  | { ok: true; probe: boolean; value: T }
  /** The gate refused before the work was attempted. */
  | { ok: false; reason: "open"; retryAfterMs: number }
  /**
   * The work ran and failed (threw, or `isFailure` said so). `value` carries
   * the work's own result when the failure was judged rather than thrown, so
   * the caller can keep its own error text.
   */
  | { ok: false; reason: "failed"; probe: boolean; retryAfterMs: number; value?: T; error?: unknown };

type HostState = {
  /** Consecutive failures; reset by any success. */
  failures: number;
  /** 0 while closed. */
  openUntil: number;
  /** Current cooldown, kept so a re-open can double it. */
  cooldownMs: number;
  /** A half-open probe is in flight. */
  probing: boolean;
  /** When that probe was granted, for the "caller never reported" escape. */
  probeStartedAt: number;
};

export class HostBreaker {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly maxCooldownMs: number;
  readonly probeGraceMs: number;
  private readonly now: () => number;
  private readonly hosts = new Map<string, HostState>();

  constructor(options: BreakerOptions) {
    this.now = options.now;
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.cooldownMs = Math.max(1, options.cooldownMs ?? 60_000);
    this.maxCooldownMs = Math.max(this.cooldownMs, options.maxCooldownMs ?? 30 * 60_000);
    this.probeGraceMs = Math.max(1, options.probeGraceMs ?? 120_000);
  }

  /** Ask the gate. A granted `probe: true` is the single half-open attempt. */
  allow(host: string): AllowDecision {
    const state = this.hosts.get(normalize(host));
    if (!state || state.openUntil === 0) return { allow: true, probe: false };

    const remaining = state.openUntil - this.now();
    if (remaining > 0) return { allow: false, retryAfterMs: remaining };
    // Cooldown elapsed: one probe, and only one.
    if (state.probing && this.now() - state.probeStartedAt < this.probeGraceMs) {
      return { allow: false, retryAfterMs: 0 };
    }
    state.probing = true;
    state.probeStartedAt = this.now();
    return { allow: true, probe: true };
  }

  /**
   * Success closes the breaker and resets the cooldown to its base value.
   *
   * Resetting the cooldown (not just the counter) is the point: a site that
   * recovered must not stay on a 30-minute probation forever because it once
   * had a bad afternoon.
   */
  recordSuccess(host: string): void {
    const key = normalize(host);
    const state = this.hosts.get(key);
    if (!state) return;
    this.hosts.delete(key);
  }

  /** A failure, consecutive per host. Opens at the threshold, doubles on re-open. */
  recordFailure(host: string): void {
    const key = normalize(host);
    const state = this.hosts.get(key) ?? { failures: 0, openUntil: 0, cooldownMs: this.cooldownMs, probing: false, probeStartedAt: 0 };

    if (state.openUntil !== 0) {
      // A failure while open is either the half-open probe coming back bad, or
      // a straggler request that started before the breaker opened. Only the
      // probe re-arms the timer; a straggler must not extend the ban.
      if (!state.probing && state.openUntil > this.now()) return;
      state.probing = false;
      state.cooldownMs = Math.min(state.cooldownMs * 2, this.maxCooldownMs);
      state.openUntil = this.now() + state.cooldownMs;
      this.hosts.set(key, state);
      return;
    }

    state.failures += 1;
    if (state.failures >= this.failureThreshold) {
      state.probing = false;
      state.cooldownMs = Math.min(state.cooldownMs, this.maxCooldownMs);
      state.openUntil = this.now() + state.cooldownMs;
    }
    this.hosts.set(key, state);
  }

  /**
   * Gate + work + accounting in one call.
   *
   * `isFailure` lets a caller whose work reports failure as a value (instead of
   * throwing) count it as a host failure without wrapping it in an exception.
   * Nothing is thrown out of here: the caller decides what a failure means.
   */
  async run<T>(host: string, work: () => Promise<T>, options: { isFailure?: (value: T) => boolean } = {}): Promise<BreakerOutcome<T>> {
    const decision = this.allow(host);
    if (!decision.allow) return { ok: false, reason: "open", retryAfterMs: decision.retryAfterMs };

    let value: T;
    try {
      value = await work();
    } catch (error) {
      this.recordFailure(host);
      return { ok: false, reason: "failed", probe: decision.probe, retryAfterMs: this.retryAfterMs(host), error };
    }
    if (options.isFailure?.(value)) {
      this.recordFailure(host);
      return { ok: false, reason: "failed", probe: decision.probe, retryAfterMs: this.retryAfterMs(host), value };
    }
    this.recordSuccess(host);
    return { ok: true, probe: decision.probe, value };
  }

  /** How long the caller should wait, or 0 when the gate is open. */
  retryAfterMs(host: string): number {
    const state = this.hosts.get(normalize(host));
    if (!state || state.openUntil === 0) return 0;
    return Math.max(0, state.openUntil - this.now());
  }

  /** Read-only view, for tests and for an admin-facing status line. */
  inspect(host: string): { state: BreakerState; failures: number; cooldownMs: number; retryAfterMs: number } {
    const key = normalize(host);
    const entry = this.hosts.get(key);
    if (!entry || entry.openUntil === 0) {
      return { state: "closed", failures: entry?.failures ?? 0, cooldownMs: entry?.cooldownMs ?? this.cooldownMs, retryAfterMs: 0 };
    }
    const remaining = Math.max(0, entry.openUntil - this.now());
    return {
      state: remaining > 0 ? "open" : "half-open",
      failures: entry.failures,
      cooldownMs: entry.cooldownMs,
      retryAfterMs: remaining,
    };
  }

  /** Drop all state. Used by tests and by an operator override. */
  reset(host?: string): void {
    if (host === undefined) this.hosts.clear();
    else this.hosts.delete(normalize(host));
  }
}

export function createBreaker(options: BreakerOptions): HostBreaker {
  return new HostBreaker(options);
}

/** Hosts are case-insensitive and never carry a port or a trailing dot. */
export function normalize(host: string): string {
  return String(host ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

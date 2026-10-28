/**
 * Screener: local list first, then the optional external services.
 *
 * Order matters. The local ban list is authoritative and free, so it runs
 * first; CAS and the federation list are opt-in per chat because each one is a
 * third party learning that a given user id exists.
 *
 * Fail-open is the rule for all three: a timeout or a 500 means "no opinion",
 * never "ban". A false ban in a 5,000-member group costs far more than a spam
 * message that survives thirty seconds.
 */
import { LRUCache } from "lru-cache";
import { EXTERNAL_CACHE_TTL_MS, fetchJson, type FetchLike } from "./http.ts";

export type ScreenVerdict = {
  /** True when some source says this user is a known spammer. */
  banned: boolean;
  /** Which source answered. */
  source: "local" | "cas" | "federation" | "";
  reason: string;
  /** Sources that failed; logged, never acted on. */
  failures: string[];
};

export type ScreenDeps = {
  fetchImpl?: FetchLike;
  /** Returns the local ban row, if any. */
  local: (userId: number) => Promise<{ reason: string; source: string } | null>;
  casEndpoint?: string;
  /** Combot API key; CAS answers 401 without it. */
  casKey?: string;
  federationUrl?: string;
  federationToken?: string;
  /** Called for every external outcome so `/stats` can report health. */
  onHealth?: (name: string, ok: boolean, error: string) => Promise<void> | void;
  cache?: LRUCache<number, ScreenVerdict>;
};

const CAS_DEFAULT = "https://api.cas.chat/check";


type CasBody = { ok?: boolean; result?: { offenses?: number } };


export class Screener {
  private readonly deps: ScreenDeps;
  private readonly cache: LRUCache<number, ScreenVerdict>;

  constructor(deps: ScreenDeps) {
    this.deps = deps;
    this.cache = deps.cache ?? new LRUCache<number, ScreenVerdict>({ max: 2_000, ttl: EXTERNAL_CACHE_TTL_MS });
  }

  /**
   * `enabled` decides which external sources are asked. A chat with everything
   * off still gets the local list — that is the whole point of having one.
   */
  async check(userId: number, enabled: { cas: boolean; federation: boolean }): Promise<ScreenVerdict> {
    const local = await this.deps.local(userId).catch(() => null);
    if (local) return { banned: true, source: "local", reason: local.reason || "本地黑名单", failures: [] };

    if (!enabled.cas && !enabled.federation) {
      return { banned: false, source: "", reason: "", failures: [] };
    }

    const cached = this.cache.get(userId);
    if (cached) return cached;

    const failures: string[] = [];
    const verdict: ScreenVerdict = { banned: false, source: "", reason: "", failures };

    if (enabled.cas) {
      const cas = await this.cas(userId);
      if (cas === null) failures.push("cas");
      else if (cas.banned) return this.remember(userId, { banned: true, source: "cas", reason: `CAS 命中 ${cas.offenses} 次`, failures });
    }

    if (enabled.federation && this.deps.federationUrl) {
      const fed = await this.federation(userId);
      if (fed === null) failures.push("federation");
      else if (fed.banned) return this.remember(userId, { banned: true, source: "federation", reason: fed.reason || "联邦黑名单", failures });
    }

    return this.remember(userId, verdict);
  }

  private remember(userId: number, verdict: ScreenVerdict): ScreenVerdict {
    // Do not cache an answer that only says "all sources failed" — that would
    // turn one bad minute into five minutes of blindness.
    if (!verdict.banned && verdict.failures.length > 0) return verdict;
    this.cache.set(userId, verdict);
    return verdict;
  }

  private async cas(userId: number): Promise<{ banned: boolean; offenses: number } | null> {
    const endpoint = this.deps.casEndpoint ?? CAS_DEFAULT;
    const res = await fetchJson<CasBody>(`${endpoint}?user_id=${userId}`, {
      fetchImpl: this.deps.fetchImpl,
      // CAS (Combot) refuses anonymous checks; without a key every answer is a
      // 401, which is a configuration mistake rather than "user is clean".
      headers: this.deps.casKey ? { Authorization: `Bearer ${this.deps.casKey}` } : undefined,
    });
    if (!res.ok && (res.status === 401 || res.status === 403)) {
      await this.health("cas", false, res.status === 401 ? "缺少或无效的 CAS key" : "CAS 拒绝访问");
      return null;
    }
    await this.health("cas", res.ok, res.ok ? "" : res.reason);
    if (!res.ok) return null;
    const result = res.data?.result;
    if (!res.data?.ok || !result) return { banned: false, offenses: 0 };
    const offenses = Number(result.offenses ?? 0);
    return { banned: offenses > 0, offenses };
  }

  private async federation(userId: number): Promise<{ banned: boolean; reason: string } | null> {
    const base = String(this.deps.federationUrl ?? "").replace(/\/+$/, "");
    if (!base) return null;
    const res = await fetchJson<{ banned?: boolean; reason?: string }>(`${base}/check?user_id=${userId}`, {
      fetchImpl: this.deps.fetchImpl,
      headers: this.deps.federationToken ? { Authorization: `Bearer ${this.deps.federationToken}` } : undefined,
    });
    await this.health("federation", res.ok, res.ok ? "" : res.reason);
    if (!res.ok) return null;
    return { banned: res.data?.banned === true, reason: String(res.data?.reason ?? "") };
  }

  private async health(name: string, ok: boolean, error: string): Promise<void> {
    if (!this.deps.onHealth) return;
    try {
      await this.deps.onHealth(name, ok, error);
    } catch {
      // Health bookkeeping must never break a message.
    }
  }

  /** Report a confirmed ban so other groups in the federation can see it. */
  async report(userId: number, reason: string): Promise<boolean> {
    const base = String(this.deps.federationUrl ?? "").replace(/\/+$/, "");
    if (!base) return false;
    const res = await fetchJson<{ ok?: boolean }>(`${base}/report`, {
      method: "POST",
      fetchImpl: this.deps.fetchImpl,
      headers: {
        "content-type": "application/json",
        ...(this.deps.federationToken ? { Authorization: `Bearer ${this.deps.federationToken}` } : {}),
      },
      body: JSON.stringify({ user_id: userId, reason: reason.slice(0, 200) }),
    });
    await this.health("federation", res.ok, res.ok ? "" : res.reason);
    return res.ok;
  }
}

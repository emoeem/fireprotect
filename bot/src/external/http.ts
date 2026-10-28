/**
 * The only place the bot talks to a third party.
 *
 * Every external call follows the same contract, because "the anti-spam service
 * was down" must never mean "the group got flooded" or "an innocent member was
 * banned":
 *  - a hard 3 s timeout;
 *  - never throws — the caller gets `{ok:false}` and decides;
 *  - results are cached for 5 minutes, including failures, so a dead service
 *    costs one request per five minutes instead of one per message;
 *  - failures are counted per service so `/stats` can show which one is sick.
 */
export type ExternalResult<T> = { ok: true; data: T } | { ok: false; reason: string; status?: number };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// 2 s, not the 5 s the reference implementations use: this call sits between a
// member joining and being able to talk, and a dead service must not hold the
// queue. Two attempts, because a second slow timeout helps nobody.
export const EXTERNAL_TIMEOUT_MS = 2_000;
export const EXTERNAL_CACHE_TTL_MS = 5 * 60_000;

export async function fetchJson<T>(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    attempts?: number;
  } = {},
): Promise<ExternalResult<T>> {
  // Three attempts for transient trouble only. 401/403 mean "wrong key" and
  // 404 means "not on the list" — retrying either just wastes the timeout
  // budget while a raid is in progress.
  const attempts = Math.max(1, Math.min(options.attempts ?? 2, 4));
  let last: ExternalResult<T> = { ok: false, reason: "未执行" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await once<T>(url, options);
    if (last.ok) return last;
    const status = last.status ?? 0;
    const retryable = status === 0 || status >= 500 || status === 429;
    if (!retryable || attempt === attempts) return last;
    await sleep(300 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
  }
  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function once<T>(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; fetchImpl?: FetchLike },
): Promise<ExternalResult<T>> {
  const doFetch = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? EXTERNAL_TIMEOUT_MS);
  try {
    const response = await doFetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      return { ok: false, reason: `非 JSON 响应 (HTTP ${response.status})`, status: response.status };
    }
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}`, status: response.status };
    }
    return { ok: true, data: parsed as T };
  } catch (err) {
    const reason = err instanceof Error ? (err.name === "AbortError" ? "请求超时" : err.message) : String(err);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

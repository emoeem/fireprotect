/**
 * Optional image moderation through a vision API.
 *
 * The contract every provider is squeezed into:
 *
 * ```
 * POST <endpoint>  { image: "<base64>", mime: "image/jpeg", categories: [...] }
 * 200 { labels: [{ name, score }], nsfw?: 0-100, gambling?: 0-100, ad?: 0-100, qr?: bool }
 * ```
 *
 * `labels[].score` is 0–1 (Cloud Vision's scale). A provider that returns
 * 0–100 must divide before returning; otherwise every image scores 100 and the
 * threshold becomes meaningless.
 *
 * `cloud-vision` is the same idea mapped from Google's SafeSearch + label
 * annotations, so a deployment that already has a Google key needs no shim.
 * Anything else (阿里云内容安全、腾讯天御、自建模型) is a ten-line function that
 * returns that shape — that is the whole point of keeping the adapter this thin.
 *
 * Rules that exist because this call sits in the message path:
 *  - 3 s hard timeout: a vision provider that hangs must not hold the update;
 *  - fail-open: a failure returns `hit: false`. A false ban in a 900-member
 *    group costs more than an ad image that survives thirty seconds;
 *  - results are cached by `file_unique_id`, so the same sticker posted twice
 *    costs one call, and failures are cached for five minutes so a dead
 *    provider costs one call per five minutes instead of one per image;
 *  - one retry on 5xx only. 429 means "you are over quota" and retrying makes
 *    it worse; a timeout has already spent the budget.
 */
import { LRUCache } from "lru-cache";
import type { FetchLike } from "../external/http.ts";

export const AI_TIMEOUT_MS = 3_000;
export const AI_HIT_TTL_MS = 6 * 3_600_000;
export const AI_FAIL_TTL_MS = 5 * 60_000;
/** Vision APIs reject or bill per image; 5 MB covers every photo Telegram sends. */
export const AI_MAX_BYTES = 5 * 1024 * 1024;

export type AiCategory = "nsfw" | "gambling" | "ad" | "qr";
export const AI_CATEGORIES: AiCategory[] = ["nsfw", "gambling", "ad", "qr"];

export type VisionVerdict = {
  /** True only when a category scored at or above the threshold. */
  hit: boolean;
  /** Human-readable, shown in the moderation notice. */
  reason: string;
  category: AiCategory | "";
  label: string;
  score: number;
  /** An HTTP request was actually made (drives the usage counter). */
  used: boolean;
  /** The provider failed; `hit` is false and the caller must carry on. */
  failed: boolean;
};

export type VisionProvider = "generic" | "cloud-vision";

export type VisionInput = {
  provider: VisionProvider;
  bytes: Uint8Array;
  mime: string;
  /** Stable id for caching: `file_unique_id`, never the mutable `file_id`. */
  cacheKey: string;
  minScore: number;
  categories: AiCategory[];
};

export type VisionDeps = {
  key?: string;
  url?: string;
  fetchImpl?: FetchLike;
  onHealth?: (name: string, ok: boolean, error: string) => Promise<void> | void;
  cache?: LRUCache<string, VisionVerdict>;
  failCache?: LRUCache<string, true>;
  timeoutMs?: number;
};

const CLOUD_VISION = "https://vision.googleapis.com/v1/images:annotate";

type GenericBody = {
  labels?: { name?: string; score?: number }[];
  nsfw?: number;
  gambling?: number;
  ad?: number;
  qr?: boolean;
  error?: string;
};

type CloudBody = {
  responses?: {
    safeSearchAnnotation?: Record<string, string>;
    labelAnnotations?: { description?: string; score?: number }[];
    error?: { message?: string };
  }[];
};

/** Likelihood words → 0-100, the scale the threshold lives on. */
const LIKELIHOOD: Record<string, number> = {
  VERY_UNLIKELY: 5,
  UNLIKELY: 20,
  POSSIBLE: 50,
  LIKELY: 80,
  VERY_LIKELY: 95,
  UNKNOWN: 0,
};

const LABEL_RULES: { category: AiCategory; re: RegExp; weight: number }[] = [
  { category: "nsfw", re: /adult|explicit|nudity|nude|nsfw|porn|sexual|色情|裸/i, weight: 1 },
  { category: "gambling", re: /casino|gambl|lottery|poker|betting|roulette|slot machine|赌|博彩|彩票/i, weight: 1 },
  { category: "qr", re: /qr code|qrcode|二维码/i, weight: 1 },
  { category: "ad", re: /advertisement|poster|flyer|promotion|banner|广告|推广/i, weight: 1 },
];

/**
 * Base64 without Buffer and without a spread over the whole array: a 4 MB
 * photo is 4 million arguments and blows the stack.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export class Vision {
  private readonly deps: VisionDeps;
  private readonly cache: LRUCache<string, VisionVerdict>;
  private readonly failCache: LRUCache<string, true>;
  private readonly timeoutMs: number;

  constructor(deps: VisionDeps = {}) {
    this.deps = deps;
    this.cache = deps.cache ?? new LRUCache<string, VisionVerdict>({ max: 2_000, ttl: AI_HIT_TTL_MS });
    this.failCache = deps.failCache ?? new LRUCache<string, true>({ max: 2_000, ttl: AI_FAIL_TTL_MS });
    this.timeoutMs = deps.timeoutMs ?? AI_TIMEOUT_MS;
  }

  /** `cloud-vision` needs only an API key; `generic` needs an endpoint too. */
  configured(provider: VisionProvider = "generic"): boolean {
    if (!this.deps.key) return false;
    return provider === "cloud-vision" ? true : Boolean(this.deps.url);
  }

  async check(input: VisionInput): Promise<VisionVerdict> {
    const cached = this.cache.get(input.cacheKey);
    if (cached) return { ...cached, used: false };
    if (this.failCache.has(input.cacheKey)) {
      return miss("上次失败，5 分钟内不再重试", true, false);
    }
    if (!this.configured(input.provider)) return miss("未配置视觉服务", false, false);
    if (input.bytes.byteLength > AI_MAX_BYTES) return miss("图片超过 5MB，跳过视觉审核", false, false);

    const first = await this.request(input);
    if (first.ok) {
      const verdict = this.judge(first.body, input);
      this.cache.set(input.cacheKey, verdict);
      await this.report(true, "");
      return verdict;
    }

    // One retry, and only for "the provider broke", not "we are over quota".
    if (first.status >= 500) {
      const second = await this.request(input);
      if (second.ok) {
        const verdict = this.judge(second.body, input);
        this.cache.set(input.cacheKey, verdict);
        await this.report(true, "");
        return verdict;
      }
    }

    this.failCache.set(input.cacheKey, true);
    await this.report(false, first.reason);
    return miss(`视觉服务不可用（${first.reason}），本次放行`, true, true);
  }

  private async report(ok: boolean, error: string): Promise<void> {
    try {
      await this.deps.onHealth?.("vision", ok, error);
    } catch {
      // Health reporting is never allowed to break moderation.
    }
  }

  private async request(input: VisionInput): Promise<{ ok: true; body: GenericBody | CloudBody } | { ok: false; status: number; reason: string }> {
    const doFetch = this.deps.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const cloud = input.provider === "cloud-vision";
    const url = cloud ? `${CLOUD_VISION}?key=${encodeURIComponent(this.deps.key ?? "")}` : String(this.deps.url);
    const payload = cloud
      ? {
          requests: [
            {
              image: { content: toBase64(input.bytes) },
              features: [
                { type: "SAFE_SEARCH_DETECTION" },
                { type: "LABEL_DETECTION", maxResults: 12 },
              ],
            },
          ],
        }
      : { image: toBase64(input.bytes), mime: input.mime, categories: input.categories };

    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cloud ? {} : { authorization: `Bearer ${this.deps.key ?? ""}` }) },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
      const body = (await response.json().catch(() => ({}))) as GenericBody & CloudBody;
      return { ok: true, body };
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      return { ok: false, status: 0, reason: name === "AbortError" ? "请求超时" : "连接失败" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Map either provider's payload onto one verdict. */
  private judge(raw: GenericBody | CloudBody, input: VisionInput): VisionVerdict {
    const scores = new Map<AiCategory, { score: number; label: string }>();

    const bump = (category: AiCategory, score: number, label: string) => {
      const current = scores.get(category);
      if (!current || score > current.score) scores.set(category, { score, label });
    };

    const generic = raw as GenericBody;
    const cloud = raw as CloudBody;

    if (Array.isArray(generic.labels)) {
      for (const label of generic.labels) {
        const name = String(label.name ?? "");
        const score = clamp(Number(label.score ?? 0) * 100);
        for (const rule of LABEL_RULES) if (rule.re.test(name)) bump(rule.category, score * rule.weight, name);
      }
    }
    if (typeof generic.nsfw === "number") bump("nsfw", clamp(generic.nsfw), "nsfw");
    if (typeof generic.gambling === "number") bump("gambling", clamp(generic.gambling), "gambling");
    if (typeof generic.ad === "number") bump("ad", clamp(generic.ad), "ad");
    if (generic.qr === true) bump("qr", 100, "qr");

    const answer = cloud.responses?.[0];
    if (answer?.safeSearchAnnotation) {
      const nsfw = Math.max(
        LIKELIHOOD[answer.safeSearchAnnotation.adult] ?? 0,
        Math.round((LIKELIHOOD[answer.safeSearchAnnotation.racy] ?? 0) * 0.8),
      );
      bump("nsfw", nsfw, `safeSearch:${answer.safeSearchAnnotation.adult ?? ""}`);
    }
    if (Array.isArray(answer?.labelAnnotations)) {
      for (const label of answer.labelAnnotations) {
        const name = String(label.description ?? "");
        const score = clamp(Number(label.score ?? 0) * 100);
        for (const rule of LABEL_RULES) if (rule.re.test(name)) bump(rule.category, score, name);
      }
    }

    let best: { category: AiCategory; score: number; label: string } | null = null;
    for (const [category, value] of scores) {
      if (!input.categories.includes(category)) continue;
      if (!best || value.score > best.score) best = { category, score: value.score, label: value.label };
    }

    if (best && best.score >= input.minScore) {
      return {
        hit: true,
        reason: `${CATEGORY_LABELS[best.category]}（${Math.round(best.score)} 分）`,
        category: best.category,
        label: best.label,
        score: Math.round(best.score),
        used: true,
        failed: false,
      };
    }
    return miss("", false, false, true);
  }
}

const CATEGORY_LABELS: Record<AiCategory, string> = {
  nsfw: "疑似色情图片",
  gambling: "疑似博彩图片",
  ad: "疑似广告图片",
  qr: "疑似引流二维码",
};

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function miss(reason: string, failed: boolean, used: boolean, clean = false): VisionVerdict {
  return { hit: false, reason: clean ? "" : reason, category: "", label: "", score: 0, used, failed };
}

/**
 * Which part of a message the vision check looks at, if any.
 *
 * Photos have several sizes; the largest is the one worth paying for. Stickers
 * and video thumbnails are included because that is where a spammer puts a QR
 * code — the video itself is not downloaded.
 */
export type VisionSubject = { fileId: string; uniqueId: string; mime: string; kind: "photo" | "sticker" | "thumbnail" };

export function visionSubject(msg: {
  photo?: { file_id: string; file_unique_id?: string }[];
  sticker?: { file_id: string; file_unique_id?: string };
  video?: { thumbnail?: { file_id: string; file_unique_id?: string } };
  animation?: { thumbnail?: { file_id: string; file_unique_id?: string } };
  document?: { thumbnail?: { file_id: string; file_unique_id?: string } };
}): VisionSubject | null {
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    return { fileId: largest.file_id, uniqueId: largest.file_unique_id ?? largest.file_id, mime: "image/jpeg", kind: "photo" };
  }
  if (msg.sticker) {
    return {
      fileId: msg.sticker.file_id,
      uniqueId: msg.sticker.file_unique_id ?? msg.sticker.file_id,
      mime: "image/webp",
      kind: "sticker",
    };
  }
  const thumb = msg.video?.thumbnail ?? msg.animation?.thumbnail ?? msg.document?.thumbnail;
  if (thumb) {
    return {
      fileId: thumb.file_id,
      uniqueId: thumb.file_unique_id ?? thumb.file_id,
      mime: "image/jpeg",
      kind: "thumbnail",
    };
  }
  return null;
}

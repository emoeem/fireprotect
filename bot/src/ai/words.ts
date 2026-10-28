/**
 * Daily hot words ("词云") without a segmentation dependency.
 *
 * Chinese has no spaces, and the mature segmenters (jieba et al.) are either
 * native modules or multi-megabyte dictionaries — neither belongs in a Worker
 * bundle. What a group admin actually wants is "what is this group talking
 * about today", and over daily volume a bigram index answers that well:
 *
 *   今天有人问显卡价格 → 今天 天有 有人 人问 显卡 卡价 价格
 *
 * Bigrams of ordinary sentences are dominated by function words, which is why
 * the stop list matters more than the tokenizer. ASCII words are taken whole
 * (`rtx4090`, `docker`), because those are exactly the terms people search for.
 *
 * Cost control: counting happens in memory, and the day's map is written to D1
 * in one batched upsert only when it grows past `FLUSH_AT` or ten minutes have
 * passed. One write per thirty messages instead of one per message keeps this
 * inside the free tier's 100k writes/day even for a busy group.
 */
import { cachesFor } from "../caches.ts";
import type { Runtime } from "../context.ts";
import { wordBump } from "../db/repo.ts";

export const FLUSH_AT = 30;
export const FLUSH_EVERY_MS = 10 * 60_000;
export const MAX_TOKENS_PER_MESSAGE = 40;

const CJK = /[\u4e00-\u9fff]+/g;
const WORD = /[a-zA-Z][a-zA-Z0-9_+#.-]{1,23}/g;

/**
 * Function words and fillers.
 *
 * Kept short and explicit: a long list is a maintenance liability, and the
 * cutoff of "appears in at least two messages" removes most of what is left.
 */
const STOP = new Set([
  "我们", "你们", "他们", "她们", "这个", "那个", "什么", "怎么", "就是", "不是", "可以", "没有",
  "一个", "现在", "今天", "明天", "昨天", "已经", "还是", "因为", "所以", "但是", "如果", "这样",
  "那样", "自己", "知道", "觉得", "真的", "应该", "可能", "需要", "时间", "问题", "大家", "谢谢",
  "哈哈", "呵呵", "好的", "收到", "一下", "有点", "一些", "这些", "那些", "感觉", "东西", "事情",
  "然后", "而且", "不过", "只是", "还有", "也是", "都很", "的是", "了的", "了一", "我了", "你了",
  "他我", "是你", "是我", "是不", "不错", "看看", "说的", "的话", "时候", "以及", "或者", "另外",
  "the", "and", "for", "you", "are", "was", "with", "this", "that", "have", "from", "not", "but",
]);

/** `2026-10-28` in the deployment's own timezone. */
export function dayKey(nowMs: number, tzOffsetMinutes: number): string {
  const shifted = new Date(nowMs + tzOffsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export function tokenize(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const match of text.matchAll(WORD)) {
    const word = match[0].toLowerCase();
    if (word.length < 2 || STOP.has(word)) continue;
    out.add(word);
  }
  for (const match of text.matchAll(CJK)) {
    const run = match[0];
    if (run.length === 2) {
      if (!STOP.has(run)) out.add(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) {
      const gram = run.slice(i, i + 2);
      if (!STOP.has(gram) && !/^[的了是在和与就都也还很有个我你他她它]/.test(gram)) out.add(gram);
    }
    if (out.size > MAX_TOKENS_PER_MESSAGE) break;
  }
  return [...out].slice(0, MAX_TOKENS_PER_MESSAGE);
}

type Bucket = { day: string; counts: Map<string, number> };

/**
 * Count one message's tokens. Never throws: a statistics feature must not be
 * able to break moderation, so every failure here is swallowed.
 */
export async function bumpWords(rt: Runtime, chatId: number, text: string): Promise<void> {
  try {
    const day = dayKey(rt.now(), rt.tzOffset);
    const key = `${chatId}:${day}`;
    const cache = cachesFor(rt).words;
    let bucket = cache.get(key);
    if (!bucket || bucket.day !== day) {
      bucket = { day, counts: new Map() };
      cache.set(key, bucket);
    }
    for (const token of tokenize(text)) bucket.counts.set(token, (bucket.counts.get(token) ?? 0) + 1);

    // `undefined` is "never flushed in this isolate", not "flushed in 1970".
    // Treating it as 0 made the very first message of every chat write a row,
    // which defeats the whole batching budget.
    const lastKey = cachesFor(rt).wordsFlushedAt;
    const last = lastKey.get(chatId);
    if (last === undefined) lastKey.set(chatId, rt.now());
    if (bucket.counts.size >= FLUSH_AT || (last !== undefined && rt.now() - last >= FLUSH_EVERY_MS)) {
      await flushWords(rt, chatId, bucket);
    }
  } catch (err) {
    console.log(`words: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Write the current bucket and clear it. Idempotent and safe to call twice. */
export async function flushWords(rt: Runtime, chatId: number, bucket?: Bucket): Promise<number> {
  const caches = cachesFor(rt);
  const day = bucket?.day ?? dayKey(rt.now(), rt.tzOffset);
  const key = `${chatId}:${day}`;
  const current = bucket ?? caches.words.get(key);
  if (!current || current.counts.size === 0) return 0;
  const entries = [...current.counts.entries()];
  current.counts.clear();
  caches.wordsFlushedAt.set(chatId, rt.now());
  try {
    await wordBump(rt.db, chatId, day, entries);
    return entries.length;
  } catch (err) {
    // Put the counts back: losing a day of statistics to one D1 hiccup is worse
    // than retrying on the next message.
    for (const [word, count] of entries) current.counts.set(word, (current.counts.get(word) ?? 0) + count);
    console.log(`words flush: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/** Flush whatever this isolate is holding for a chat (used by cron and /stats). */
export async function flushAllWords(rt: Runtime, chatIds: number[]): Promise<void> {
  for (const chatId of chatIds) await flushWords(rt, chatId);
}

export type WordRow = { word: string; count: number };

/** Everything this runtime is holding but has not written yet, merged in. */
export function pendingWords(rt: Runtime, chatId: number, day: string): WordRow[] {
  const bucket = cachesFor(rt).words.get(`${chatId}:${day}`);
  if (!bucket) return [];
  return [...bucket.counts.entries()].map(([word, count]) => ({ word, count }));
}

/**
 * Per-runtime caches.
 *
 * In production there is exactly one runtime per isolate, so a module-level
 * `Map` would be equivalent. It is not equivalent in tests, where every case
 * builds a fresh runtime with the same chat ids — a shared cache would leak one
 * test's config into the next and hide real bugs. Keying by runtime keeps the
 * production behaviour (per isolate) and the test behaviour (per case) aligned.
 */
import { LRUCache } from "lru-cache";

export type RuntimeCaches = {
  /** join timestamp per member, mirrored from KV to avoid a read per message. */
  join: LRUCache<string, number>;
  /** members an admin unbanned by hand. */
  trust: LRUCache<string, boolean>;
  /** last in-chat moderation notice, for the one-a-minute throttle. */
  notice: LRUCache<number, number>;
  /** auto-reply rules per chat. */
  filters: LRUCache<number, object>;
  /** flood window per member. */
  flood: LRUCache<string, number[]>;
  /** join-rate window per chat. */
  joins: LRUCache<string, number[]>;
  /** duplicate-content fingerprints per chat. */
  fingerprints: LRUCache<string, number[]>;
  /** update ids already handled by this runtime. */
  seenUpdates: LRUCache<number, true>;
  /** shadow-ban answers, so the hot path costs no query. */
  blocked: LRUCache<string, boolean>;
  /** toolbox calls per member, to stop one person driving the file pipeline. */
  toolRate: LRUCache<string, number[]>;
  /** chats already written to the registry by this isolate. */
  registered: LRUCache<number, true>;
  /** hot-word buckets, keyed `chatId:YYYY-MM-DD`. */
  words: LRUCache<string, { day: string; counts: Map<string, number> }>;
  /** last time each chat's word bucket was written, for the ten-minute flush. */
  wordsFlushedAt: LRUCache<number, number>;
  /** parse calls per chat, for `parsePerHour`. */
  parseRate: LRUCache<number, number[]>;
  /** AI budget per `chatId:day`, so the daily cap costs no read per image. */
  aiCalls: LRUCache<string, number>;
  /** chats already warned about today's AI budget. */
  aiAlerted: LRUCache<string, true>;
  /** last operator notification per reason key, for the daily throttle. */
  notifyAt: LRUCache<string, number>;
  /** hour bucket of the last retention prune run on this runtime. */
  retentionBucket: number;
  /** the bot's own numeric id, fetched once per isolate for rights lookups. */
  botId: number;
  /** the bot's admin rights per chat, for the console's rights badges. */
  botRights: LRUCache<number, { admin: boolean; delete: boolean; restrict: boolean; pin: boolean }>;
};

const registry = new WeakMap<object, RuntimeCaches>();

export function cachesFor(key: object): RuntimeCaches {
  const existing = registry.get(key);
  if (existing) return existing;
  const created: RuntimeCaches = {
    join: new LRUCache({ max: 20_000, ttl: 30 * 60_000 }),
    trust: new LRUCache({ max: 5_000, ttl: 10 * 60_000 }),
    notice: new LRUCache({ max: 5_000, ttl: 10 * 60_000 }),
    filters: new LRUCache<number, object>({ max: 2_000, ttl: 60_000 }),
    flood: new LRUCache({ max: 20_000, ttl: 3_600_000 }),
    joins: new LRUCache({ max: 5_000, ttl: 3_600_000 }),
    fingerprints: new LRUCache({ max: 5_000, ttl: 6 * 3_600_000 }),
    seenUpdates: new LRUCache({ max: 20_000, ttl: 10 * 60_000 }),
    blocked: new LRUCache({ max: 20_000, ttl: 60_000 }),
    toolRate: new LRUCache({ max: 5_000, ttl: 300_000 }),
    registered: new LRUCache({ max: 5_000, ttl: 24 * 3_600_000 }),
    words: new LRUCache<string, { day: string; counts: Map<string, number> }>({ max: 2_000, ttl: 48 * 3_600_000 }),
    wordsFlushedAt: new LRUCache<number, number>({ max: 5_000, ttl: 48 * 3_600_000 }),
    parseRate: new LRUCache<number, number[]>({ max: 5_000, ttl: 3_600_000 }),
    aiCalls: new LRUCache<string, number>({ max: 20_000, ttl: 25 * 3_600_000 }),
    aiAlerted: new LRUCache<string, true>({ max: 5_000, ttl: 25 * 3_600_000 }),
    notifyAt: new LRUCache<string, number>({ max: 200, ttl: 25 * 3_600_000 }),
    retentionBucket: 0,
    botId: 0,
    botRights: new LRUCache<number, { admin: boolean; delete: boolean; restrict: boolean; pin: boolean }>({ max: 2_000, ttl: 10 * 60_000 }),
  };
  registry.set(key, created);
  return created;
}

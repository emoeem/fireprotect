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
  };
  registry.set(key, created);
  return created;
}

import type { KVLike, Store } from "./types.ts";

/** In-memory store. Tests and `--dry-run` only; nothing survives a restart. */
export function memoryStore(): Store {
  const data = new Map<string, { value: string; exp: number }>();

  const alive = (key: string): string | null => {
    const hit = data.get(key);
    if (!hit) return null;
    if (hit.exp !== 0 && hit.exp <= Date.now()) {
      data.delete(key);
      return null;
    }
    return hit.value;
  };

  return {
    async get(key) {
      return alive(key);
    },
    async put(key, value, ttlSeconds) {
      data.set(key, {
        value,
        exp: ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0,
      });
    },
    async del(key) {
      data.delete(key);
    },
    async keys(prefix) {
      return [...data.keys()].filter((key) => key.startsWith(prefix) && alive(key) !== null);
    },
  };
}

/**
 * Cloudflare KV adapter.
 *
 * `list` needs paging: a chat with a few hundred pending captchas would
 * otherwise silently stop sweeping after the first 1000 keys.
 */
export function kvStore(kv: KVLike): Store {
  return {
    get(key) {
      return kv.get(key);
    },
    async put(key, value, ttlSeconds) {
      await kv.put(key, value, ttlSeconds && ttlSeconds > 0 ? { expirationTtl: ttlSeconds } : undefined);
    },
    async del(key) {
      await kv.delete(key);
    },
    async keys(prefix) {
      const out: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = await kv.list(cursor ? { prefix, cursor } : { prefix });
        for (const item of result.keys) out.push(item.name);
        if (result.list_complete !== false || !result.cursor) break;
        cursor = result.cursor;
      }
      return out;
    },
  };
}

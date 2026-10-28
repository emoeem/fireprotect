import type { Store } from "./types.ts";

/**
 * Disk-backed store for the local polling runner.
 *
 * One JSON file per key; the real key lives inside the file because the
 * filename is a sanitised version of it. Good enough for a single process and
 * it makes "what does the bot remember" inspectable with `ls`.
 */
export function fileStore(root: string): Store {
  let ready: Promise<unknown> | null = null;
  const fs = () => import("node:fs/promises");
  const path = () => import("node:path");

  const ensure = async () => {
    if (!ready) {
      ready = (async () => {
        const { mkdir } = await fs();
        await mkdir(root, { recursive: true });
      })();
    }
    await ready;
  };

  const fileFor = async (key: string) => {
    const { join } = await path();
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
    return join(root, `${safe}.json`);
  };

  type Row = { key: string; value: string; exp: number };

  const read = async (key: string): Promise<Row | null> => {
    const { readFile } = await fs();
    const { unlink } = await fs();
    try {
      const raw = await readFile(await fileFor(key), "utf8");
      const row = JSON.parse(raw) as Row;
      if (row.exp !== 0 && row.exp <= Date.now()) {
        await unlink(await fileFor(key)).catch(() => {});
        return null;
      }
      return row;
    } catch {
      return null;
    }
  };

  return {
    async get(key) {
      const row = await read(key);
      return row ? row.value : null;
    },
    async put(key, value, ttlSeconds) {
      await ensure();
      const { writeFile } = await fs();
      const row: Row = {
        key,
        value,
        exp: ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0,
      };
      await writeFile(await fileFor(key), JSON.stringify(row), "utf8");
    },
    async del(key) {
      const { unlink } = await fs();
      await unlink(await fileFor(key)).catch(() => {});
    },
    async keys(prefix) {
      await ensure();
      const { readdir, readFile } = await fs();
      const { join } = await path();
      const out: string[] = [];
      for (const name of await readdir(root)) {
        if (!name.endsWith(".json")) continue;
        try {
          const row = JSON.parse(await readFile(join(root, name), "utf8")) as Row;
          if (row.key.startsWith(prefix) && (row.exp === 0 || row.exp > Date.now())) out.push(row.key);
        } catch {
          // Half-written or hand-edited file: ignore, never throw.
        }
      }
      return out;
    },
  };
}

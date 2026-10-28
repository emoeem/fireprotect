/**
 * Local SQLite connection for the polling runner and the tests.
 *
 * `node:sqlite` ships with Node 22.5+, so the local runner needs no native
 * build and no extra dependency. This is the only file in the repo that
 * imports a `node:` builtin — the Worker never reaches it.
 */
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { asDb, type SqliteHandle } from "./connect.ts";

type Bound = string | number | bigint | null | Uint8Array;

function normalize(params: unknown[]): Bound[] {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
      return value;
    }
    if (value instanceof Uint8Array) return value;
    return String(value);
  });
}

export function openSqlite(path: string): SqliteHandle {
  const database = new DatabaseSync(path);
  if (path !== ":memory:") database.exec("pragma journal_mode = WAL");

  const client = async (query: string, params: unknown[], method: "run" | "all" | "get" | "values") => {
    const statement = database.prepare(query);
    const bound = normalize(params);
    if (method === "run") {
      statement.run(...bound);
      return { rows: [] };
    }
    // drizzle indexes result rows positionally (`row[columnIndex]`), so the
    // proxy must hand back values in column order — not objects.
    if (method === "get") {
      const row = statement.get(...bound);
      return { rows: row === undefined ? [] : [Object.values(row as Record<string, unknown>)] };
    }
    return { rows: statement.all(...bound).map((row) => Object.values(row as Record<string, unknown>)) };
  };

  return {
    db: asDb(drizzle(client)),
    async get<T>(sql: string, params: unknown[] = []) {
      const row = database.prepare(sql).get(...normalize(params));
      return (row as T | undefined) ?? null;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return database.prepare(sql).all(...normalize(params)) as T[];
    },
    async run(sql: string, params: unknown[] = []) {
      database.prepare(sql).run(...normalize(params));
    },
    close() {
      database.close();
    },
  };
}

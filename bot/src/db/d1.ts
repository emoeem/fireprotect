/** Cloudflare D1 connection. The only storage file the Worker imports. */
import { drizzle } from "drizzle-orm/d1";
import { asDb, type SqliteHandle } from "./connect.ts";
import type { D1Like } from "../types.ts";

export function openD1(d1: D1Like): SqliteHandle {
  const statement = (sql: string, params: unknown[] = []) => {
    const prepared = d1.prepare(sql);
    return params.length ? prepared.bind(...params) : prepared;
  };

  return {
    db: asDb(drizzle(d1 as never)),
    get: <T>(sql: string, params: unknown[] = []) => statement(sql, params).first<T>(),
    async all<T>(sql: string, params: unknown[] = []) {
      const result = await statement(sql, params).all<T>();
      return result.results;
    },
    async run(sql: string, params: unknown[] = []) {
      await statement(sql, params).run();
    },
  };
}

/**
 * Driver-agnostic connection surface.
 *
 * The schema and queries are identical on Cloudflare D1 and on `node:sqlite`,
 * so only the few lines that build each handle differ per platform. The raw
 * helpers (`get`/`all`/`run`/`exec`) exist for the migration runner, which must
 * work before any typed table exists.
 *
 * Keeping `node:sqlite` out of this file is what keeps the Worker bundle free
 * of `node:` builtins.
 */
import type { Db } from "./repo.ts";

export type SqliteHandle = {
  db: Db;
  get: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
  all: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  run: (sql: string, params?: unknown[]) => Promise<void>;
  close?: () => void;
};

export function asDb(value: unknown): Db {
  return value as Db;
}

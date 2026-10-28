/**
 * Test harness: a fake Bot API that records every call.
 *
 * The point is to assert on what the bot *sends*. A handler that mutates
 * nothing and reports success is exactly the failure mode a mock-free test
 * cannot see. The fake sits under the real `Telegram` client, so timeout and
 * retry behaviour is the production code path.
 */
import { createRuntime, ensureSchema, type Runtime } from "../src/context.ts";
import { openSqlite } from "../src/db/node-sqlite.ts";
import { memoryStore } from "../src/store.ts";
import { Telegram } from "../src/telegram.ts";
import type { SqliteHandle } from "../src/db/connect.ts";
import type { Env, TgCallbackQuery, TgChat, TgMessage, TgUser } from "../src/types.ts";

export type Call = { method: string; body: Record<string, any> };

type Reply = { ok: true; result?: unknown } | { ok: false; description: string; error_code: number };

export class FakeTg {
  calls: Call[] = [];
  private handlers = new Map<string, (body: Record<string, any>) => Reply>();

  constructor() {
    this.handlers.set("getMe", () => ({ ok: true, result: { id: 123456, username: "test_bot" } }));
    this.handlers.set("getChatAdministrators", () => ({ ok: true, result: [] }));
    this.handlers.set("getChatMember", () => ({ ok: true, result: { status: "member" } }));
  }

  on(method: string, reply: Reply | ((body: Record<string, any>) => Reply)): void {
    this.handlers.set(method, typeof reply === "function" ? reply : () => reply);
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = String(url).split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
    this.calls.push({ method, body });
    const handler = this.handlers.get(method);
    const reply: Reply = handler ? handler(body) : { ok: true, result: true };
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  all(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  count(method: string): number {
    return this.all(method).length;
  }

  find(method: string): Call | undefined {
    return this.calls.find((call) => call.method === method);
  }

  reset(): void {
    this.calls = [];
  }
}

export type Harness = {
  rt: Runtime;
  fake: FakeTg;
  sql: SqliteHandle;
  now: () => number;
  advance: (ms: number) => void;
};

export async function makeRuntime(
  options: { env?: Partial<Env>; now?: () => number; fake?: FakeTg; store?: ReturnType<typeof memoryStore> } = {},
): Promise<Harness> {
  const fake = options.fake ?? new FakeTg();
  const sql = openSqlite(":memory:");
  await ensureSchema(sql);

  let clock = 1_700_000_000_000;
  const now = options.now ?? (() => clock);

  const rt = createRuntime(
    { BOT_TOKEN: "123456:TEST-TOKEN", ADMIN_IDS: "9001", ...options.env },
    {
      sqlite: sql,
      store: options.store ?? memoryStore(),
      now,
      api: new Telegram("123456:TEST-TOKEN", fake.fetch, { timeoutMs: 1000, maxAttempts: 1 }),
    },
  );

  return {
    rt,
    fake,
    sql,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export const GROUP: TgChat = { id: -1001, type: "supergroup", title: "测试群" };

export function user(id: number, first_name = "小明"): TgUser {
  return { id, first_name, is_bot: false };
}

let messageId = 100;
let updateSeq = 10_000;

/**
 * A fresh `update_id` for every dispatched update.
 *
 * The dedupe cache is keyed by update_id and lives for the process, exactly as
 * it lives for the isolate in production — so tests must not reuse ids, or the
 * second test in the file would be silently skipped.
 */
export function nextUpdate(): number {
  updateSeq += 1;
  return updateSeq;
}

export function message(patch: Partial<TgMessage> = {}): TgMessage {
  messageId += 1;
  return { message_id: messageId, chat: GROUP, from: user(500), text: "hello", ...patch } as TgMessage;
}

export function command(text: string, patch: Partial<TgMessage> = {}): TgMessage {
  return message({ text, ...patch });
}

export function callback(data: string, fromId = 500, chat: TgChat = GROUP): TgCallbackQuery {
  return { id: "cb-1", from: user(fromId), data, message: { message_id: 999, chat, from: user(1, "焰卫") } };
}

/** The signed button payload the bot actually sent. */
export function buttonData(fake: FakeTg): string {
  const sent = fake.all("sendMessage").find((call) => call.body?.reply_markup);
  return String(sent?.body?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data ?? "");
}

/** All callback payloads from the last keyboard sent (math mode has four). */
export function buttonDataAll(fake: FakeTg): string[] {
  const sent = fake.all("sendMessage").find((call) => call.body?.reply_markup);
  const rows = sent?.body?.reply_markup?.inline_keyboard?.[0] ?? [];
  return rows.map((button: { callback_data?: string }) => String(button.callback_data ?? ""));
}

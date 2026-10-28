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

/**
 * Default external transport for tests: refuse everything.
 *
 * A preview or vision call that silently reaches the internet makes the suite
 * slow, flaky and dependent on four third parties. Tests that care inject their
 * own stub; everything else gets a deterministic failure, which is also the
 * fail-open path we want covered by default.
 */
const offline = async (input: string): Promise<Response> => {
  throw new Error(`offline: ${String(input).slice(0, 80)}`);
};

export type Call = {
  method: string;
  body: Record<string, any>;
  /** Set for multipart uploads, where the body is a FormData and not JSON. */
  file?: { filename: string; bytes: number; head: string };
};

type Reply = { ok: true; result?: unknown } | { ok: false; description: string; error_code: number };

export class FakeTg {
  calls: Call[] = [];
  /** Bytes served by the `/file/bot<token>/<path>` endpoint. */
  files = new Map<string, Uint8Array>();
  private handlers = new Map<string, (body: Record<string, any>) => Reply>();
  /** Fault injection: `{times: 2, kind: "throw"}` makes the next two calls fail. */
  private faults = new Map<string, { times: number; kind: "throw" | "abort" | "502" }>();
  private faultsUsed = new Map<string, number>();

  constructor() {
    this.handlers.set("getMe", () => ({ ok: true, result: { id: 123456, username: "test_bot" } }));
    this.handlers.set("getChatAdministrators", () => ({ ok: true, result: [] }));
    this.handlers.set("getChatMember", () => ({ ok: true, result: { status: "member" } }));
  }

  on(method: string, reply: Reply | ((body: Record<string, any>) => Reply)): void {
    this.handlers.set(method, typeof reply === "function" ? reply : () => reply);
  }

  /** Publish a file the bot may download, and point `getFile` at it. */
  onFile(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes);
    this.on("getFile", () => ({ ok: true, result: { file_path: path, file_size: bytes.byteLength } }));
  }

  /**
   * Make the next `times` calls to `method` fail before any handler runs.
   *
   * "throw" is a dead socket, "abort" is our own timeout firing, "502" is
   * Telegram being briefly broken — the three failures the retry path exists for.
   */
  fail(method: string, kind: "throw" | "abort" | "502", times = 1): void {
    this.faults.set(method, { times, kind });
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const text = String(url);
    if (text.includes("/file/bot")) {
      const path = text.split("/file/bot")[1]?.split("/").slice(1).join("/") ?? "";
      const bytes = this.files.get(path);
      if (!bytes) return new Response("not found", { status: 404 });
      this.calls.push({ method: "downloadFile", body: { path } });
      return new Response(bytes.slice(), { status: 200 });
    }
    const method = String(url).split("/").pop() ?? "";

    // sendDocument is multipart: record the filename and payload size so a test
    // can assert what was actually attached, not just that a call happened.
    let body: Record<string, any>;
    let file: Call["file"];
    if (init?.body instanceof FormData) {
      body = {};
      for (const [key, value] of init.body.entries()) {
        if (typeof value === "string") body[key] = value;
        else {
          const bytes = new Uint8Array(await value.arrayBuffer());
          file = { filename: value.name, bytes: bytes.byteLength, head: String.fromCharCode(...bytes.slice(0, 8)) };
        }
      }
    } else {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
    }
    this.calls.push(file ? { method, body, file } : { method, body });

    const fault = this.faults.get(method);
    if (fault && fault.times > 0) {
      fault.times -= 1;
      this.faultsUsed.set(method, (this.faultsUsed.get(method) ?? 0) + 1);
      if (fault.kind === "throw") throw new Error("socket hang up");
      if (fault.kind === "abort") {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return new Response(JSON.stringify({ ok: false, error_code: 502, description: "Bad Gateway" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }

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
    this.faults.clear();
    this.faultsUsed.clear();
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
  options: {
    env?: Partial<Env>;
    now?: () => number;
    fake?: FakeTg;
    store?: ReturnType<typeof memoryStore>;
    /** External HTTP. Defaults to a hard offline stub: tests must not hit the net. */
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  } = {},
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
      fetchImpl: options.fetchImpl ?? offline,
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

/** All callback payloads from the last keyboard sent, across every row. */
export function buttonDataAll(fake: FakeTg): string[] {
  const sent = fake.all("sendMessage").find((call) => call.body?.reply_markup);
  const rows = sent?.body?.reply_markup?.inline_keyboard ?? [];
  return rows.flatMap((row: { callback_data?: string }[]) =>
    row.map((button) => String(button.callback_data ?? "")).filter(Boolean),
  );
}

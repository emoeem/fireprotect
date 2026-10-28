/**
 * Test harness: a fake Bot API that records every call.
 *
 * The point is to assert on what the bot *sends* — a handler that mutates
 * nothing and reports success is exactly the failure mode a mock-free test
 * cannot see.
 */
import { createContext, type Ctx } from "../src/context.ts";
import { memoryStore } from "../src/store.ts";
import { Telegram } from "../src/telegram.ts";
import type { Env, TgCallbackQuery, TgChat, TgMessage, TgUpdate, TgUser } from "../src/types.ts";

export type Call = { method: string; body: Record<string, any> };

type Reply = { ok: true; result?: unknown } | { ok: false; description: string; error_code: number };

export class FakeTg {
  calls: Call[] = [];
  private handlers = new Map<string, (body: Record<string, any>) => Reply>();

  constructor() {
    // Sensible defaults: a group with no extra admins, and a bot that exists.
    // Without these every handler would trip over `result: true` where the
    // production code expects an array.
    this.handlers.set("getChatAdministrators", () => ({ ok: true, result: [] }));
    this.handlers.set("getMe", () => ({ ok: true, result: { id: 123456, username: "test_bot" } }));
  }

  /** Override one method; every other method succeeds with `true`. */
  on(method: string, reply: Reply | ((body: Record<string, any>) => Reply)): void {
    this.handlers.set(method, typeof reply === "function" ? reply : () => reply);
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = String(url).split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
    this.calls.push({ method, body });
    const handler = this.handlers.get(method);
    const reply: Reply = handler ? handler(body) : { ok: true, result: true };
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  find(method: string): Call | undefined {
    return this.calls.find((call) => call.method === method);
  }

  all(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  count(method: string): number {
    return this.all(method).length;
  }

  reset(): void {
    this.calls = [];
  }
}

export function makeCtx(options: {
  env?: Partial<Env>;
  now?: () => number;
  fake?: FakeTg;
  store?: ReturnType<typeof memoryStore>;
} = {}): { ctx: Ctx; fake: FakeTg; now: () => number; advance: (ms: number) => void } {
  const fake = options.fake ?? new FakeTg();
  let clock = 1_700_000_000_000;
  const ctx = createContext(
    {
      BOT_TOKEN: "123456:TEST-TOKEN",
      ADMIN_IDS: "9001",
      ...options.env,
    },
    {
      store: options.store ?? memoryStore(),
      tg: new Telegram("123456:TEST-TOKEN", fake.fetch, 1000),
      now: options.now ?? (() => clock),
    },
  );
  return {
    ctx,
    fake,
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

export function message(patch: Partial<TgMessage> = {}): TgMessage {
  messageId += 1;
  return {
    message_id: messageId,
    chat: GROUP,
    from: user(500),
    text: "hello",
    ...patch,
  } as TgMessage;
}

export function command(text: string, patch: Partial<TgMessage> = {}): TgMessage {
  return message({ text, ...patch });
}

export function callback(data: string, fromId = 500, chat: TgChat = GROUP): TgCallbackQuery {
  return {
    id: "cb-1",
    from: user(fromId),
    data,
    message: { message_id: 999, chat, from: user(1, "焰卫") },
  };
}

export function update(patch: Partial<TgUpdate>): TgUpdate {
  return { update_id: 1, ...patch };
}

/** The prompt message the bot sent, with the signed button data inside it. */
export function buttonData(fake: FakeTg): string {
  const sent = fake.all("sendMessage").find((call) => call.body?.reply_markup);
  return String(sent?.body?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data ?? "");
}

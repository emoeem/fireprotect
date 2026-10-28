import { createServerFn } from "@tanstack/react-start";

const TOKEN = /^\d{6,15}:[A-Za-z0-9_-]{20,}$/;
const TIMEOUT_MS = 8000;
/** Best effort only: a warm serverless instance holds one bucket. */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits: number[] = [];

function allowRequest(now: number): boolean {
  while (hits.length && now - hits[0] > WINDOW_MS) hits.shift();
  if (hits.length >= MAX_PER_WINDOW) return false;
  hits.push(now);
  return true;
}

export const checkBotToken = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const token =
      typeof input === "object" && input !== null && "token" in input
        ? String((input as { token: unknown }).token).trim()
        : "";
    if (!TOKEN.test(token)) {
      throw new Error("令牌格式不对。它应该类似 123456789:AAxxxx，从 @BotFather 的 /newbot 回复里复制。");
    }
    return { token };
  })
  .handler(async ({ data }) => {
    // Without a cap this endpoint is an open Telegram token oracle: anonymous
    // callers could validate harvested tokens through our egress.
    if (!allowRequest(Date.now())) {
      return { ok: false as const, error: "这个页面一分钟内已经问了太多次，等一会儿再试。" };
    }
    let response: Response;
    try {
      response = await fetch("https://api.telegram.org/bot" + data.token + "/getMe", {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false as const, error: "连不上 Telegram。过一会儿再试。" };
    }
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
      result?: { id?: number; username?: string; first_name?: string };
    } | null;
    if (!payload?.ok || !payload.result) {
      return { ok: false as const, error: payload?.description || "Telegram 不认识这枚令牌。" };
    }
    return {
      ok: true as const,
      id: payload.result.id ?? 0,
      username: payload.result.username ?? "",
      name: payload.result.first_name ?? "",
    };
  });

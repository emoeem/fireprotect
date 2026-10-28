import { createServerFn } from "@tanstack/react-start";

const TOKEN = /^\d{6,15}:[A-Za-z0-9_-]{20,}$/;

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
    let response: Response;
    try {
      response = await fetch("https://api.telegram.org/bot" + data.token + "/getMe");
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

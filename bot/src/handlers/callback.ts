/**
 * Inline-button callbacks: verification and nothing else.
 *
 * `answerCallbackQuery` is always called, even on failure — otherwise the
 * member's Telegram client spins on a button that will never resolve.
 */
import type { Runtime } from "../context.ts";
import { answerButton } from "./verify.ts";
import type { TgCallbackQuery } from "../types.ts";

export async function handleCallback(rt: Runtime, query: TgCallbackQuery): Promise<void> {
  const chatId = query.message?.chat.id;
  if (!chatId) {
    await rt.api.call("answerCallbackQuery", { callback_query_id: query.id });
    return;
  }

  const config = await rt.configFor(chatId);
  const outcome = await answerButton(rt, { chatId, messageId: query.message?.message_id }, query.from, query.data ?? "", config);

  const toast =
    outcome.status === "ok"
      ? "验证通过，可以发言了。"
      : outcome.status === "already"
        ? "你已经通过验证了。"
        : outcome.status === "expired"
          ? "验证已超时。"
          : outcome.status === "wrong"
            ? outcome.reason
            : "这个按钮不是给你的。";

  await rt.api.call("answerCallbackQuery", {
    callback_query_id: query.id,
    text: toast,
    show_alert: outcome.status === "forged" || outcome.status === "expired",
  });

  // The prompt has done its job; leaving it in the group leaves a dead button.
  if ((outcome.status === "ok" || outcome.status === "already") && query.message) {
    await rt.api.call("deleteMessage", { chat_id: chatId, message_id: query.message.message_id });
  }
}

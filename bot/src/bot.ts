/**
 * Update dispatch.
 *
 * Two guards wrap every update:
 *  - deduplication by `update_id`, because Telegram redelivers when the webhook
 *    times out and a redelivered `/ban` must not ban twice;
 *  - a per-chat lock, because a burst of messages from one group can be handled
 *    concurrently and two of them must not each apply a punishment.
 */
import { cachesFor } from "./caches.ts";
import type { Runtime } from "./context.ts";
import { handleEditedMessage, handleMessage } from "./handlers/message.ts";
import { handleCallback } from "./handlers/callback.ts";
import { handlePanel } from "./panel.ts";
import { handleJoinRequest, handleLeftMember, handleMemberUpdate, handleMyChatMember, handleNewMembers } from "./handlers/join.ts";
import { ensureChat } from "./preset.ts";
import { handleHelpCallback } from "./help.ts";
import { mirrorChannelPost } from "./sync.ts";
import { notifyOperators } from "./notify.ts";
import type { TgUpdate } from "./types.ts";

export async function handleUpdate(rt: Runtime, update: TgUpdate): Promise<void> {
  if (typeof update.update_id === "number") {
    // Per runtime, not per module: one runtime is one isolate in production, and
    // a module-level set would leak "already seen" across unrelated runtimes in
    // tests — which is exactly how a real double-punish bug hides.
    const seen = cachesFor(rt).seenUpdates;
    if (seen.has(update.update_id)) return;
    seen.set(update.update_id, true);
  }

  const chatId = update.message?.chat.id ?? update.edited_message?.chat.id ?? update.callback_query?.message?.chat.id ?? update.my_chat_member?.chat.id ?? update.chat_member?.chat.id ?? update.chat_join_request?.chat.id;

  // A group's first contact is what triggers the activation preset. Channels
  // are skipped: a mirrored source channel must not get a rules entry.
  const chat = update.message?.chat ?? update.edited_message?.chat ?? update.callback_query?.message?.chat ?? update.my_chat_member?.chat ?? update.chat_member?.chat;
  if (chat && (chat.type === "group" || chat.type === "supergroup") && !update.channel_post) {
    await ensureChat(rt, chat.id).catch((err) => console.log(`preset failed: ${String(err)}`));
  }

  const run = async () => {
    if (update.channel_post) return mirrorChannelPost(rt, update.channel_post);
    if (update.message) {
      const msg = update.message;
      if (msg.new_chat_members?.length) return handleNewMembers(rt, msg);
      if (msg.left_chat_member) return handleLeftMember(rt, msg);
      return handleMessage(rt, msg);
    }
    if (update.callback_query) {
      // Panel presses are ours; everything else is verification.
      if (await handlePanel(rt, update.callback_query)) return;
      if (await handleHelpCallback(rt, update.callback_query)) return;
      return handleCallback(rt, update.callback_query);
    }
    if (update.my_chat_member) return handleMyChatMember(rt, update.my_chat_member);
    if (update.chat_member) return handleMemberUpdate(rt, update.chat_member);
    if (update.chat_join_request) return handleJoinRequest(rt, update.chat_join_request);
    // An edit is a fresh message to every reader — Telegram re-renders it in
    // place — so a clean post edited into spam must hit the same rules. The
    // edited path only deletes and records: it never feeds the warn ladder.
    // Cross-isolate redelivery may repeat the delete call (seenUpdates is
    // per-isolate); the D1 warn counter is what keeps a redelivery from
    // double-punishing, so one extra 400 on deleteMessage is the accepted cost.
    if (update.edited_message) return handleEditedMessage(rt, update.edited_message);
  };

  try {
    if (typeof chatId === "number") await rt.withChatLock(chatId, run);
    else await run();
  } catch (err) {
    // One bad update must never take down the webhook: Telegram would retry it
    // forever and block every later update behind it.
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.log(`update failed: ${message}`);
    // notifyOperators swallows its own failures and throttles per reason, so an
    // update that crashes a hundred times costs one message, not a hundred.
    void notifyOperators(rt, "update-failed", `update 处理失败：${message}`);
  }
}

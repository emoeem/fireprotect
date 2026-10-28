/**
 * Update dispatch.
 *
 * Two guards wrap every update:
 *  - deduplication by `update_id`, because Telegram redelivers when the webhook
 *    times out and a redelivered `/ban` must not ban twice;
 *  - a per-chat lock, because a burst of messages from one group can be handled
 *    concurrently and two of them must not each apply a punishment.
 */
import { LRUCache } from "lru-cache";
import type { Runtime } from "./context.ts";
import { handleMessage } from "./handlers/message.ts";
import { handleCallback } from "./handlers/callback.ts";
import { handleJoinRequest, handleLeftMember, handleMemberUpdate, handleMyChatMember, handleNewMembers } from "./handlers/join.ts";
import type { TgUpdate } from "./types.ts";

const seen = new LRUCache<number, true>({ max: 20_000, ttl: 10 * 60_000 });

export async function handleUpdate(rt: Runtime, update: TgUpdate): Promise<void> {
  if (typeof update.update_id === "number") {
    if (seen.has(update.update_id)) return;
    seen.set(update.update_id, true);
  }

  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? update.my_chat_member?.chat.id ?? update.chat_member?.chat.id ?? update.chat_join_request?.chat.id;

  const run = async () => {
    if (update.message) {
      const msg = update.message;
      if (msg.new_chat_members?.length) return handleNewMembers(rt, msg);
      if (msg.left_chat_member) return handleLeftMember(rt, msg);
      return handleMessage(rt, msg);
    }
    if (update.callback_query) return handleCallback(rt, update.callback_query);
    if (update.my_chat_member) return handleMyChatMember(rt, update.my_chat_member);
    if (update.chat_member) return handleMemberUpdate(rt, update.chat_member);
    if (update.chat_join_request) return handleJoinRequest(rt, update.chat_join_request);
    // `edited_message` is intentionally ignored: an edit cannot add a link to a
    // message the group already saw without the member sending it again, and
    // moderating edits doubles the API traffic for no coverage gain.
  };

  try {
    if (typeof chatId === "number") await rt.withChatLock(chatId, run);
    else await run();
  } catch (err) {
    // One bad update must never take down the webhook: Telegram would retry it
    // forever and block every later update behind it.
    console.log(`update failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  }
}

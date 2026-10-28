/**
 * Channel → group mirrors.
 *
 * Two modes, because the Bot API gives us two different affordances:
 *
 *  - instant (`interval=0`): the bot is an admin in the channel, so every new
 *    post arrives as a `channel_post` update and is copied immediately. No
 *    polling, no scraping, no delay.
 *  - interval: the Bot API has **no** "list channel posts" method, so the only
 *    way to discover a backlog is the public `t.me/s/<name>` preview. We read
 *    the post ids from it and `copyMessage` the few that are new.
 *
 * A mirror that cannot work is disabled instead of retried forever: five
 * consecutive failures, or one permanent error, turns it off and says why in
 * the target group.
 */
import type { Runtime } from "./context.ts";
import { syncList, syncMark, syncPollable, type SyncRow } from "./db/repo.ts";
import { say } from "./moderation.ts";
import type { FetchLike } from "./external/http.ts";
import type { TgMessage } from "./types.ts";

const PREVIEW = "https://t.me/s/";
const MAX_PER_RUN = 3;
const MAX_FAILURES = 5;
/** Errors that will never fix themselves by waiting. */
const PERMANENT = /chat not found|channel_invalid|not enough rights|have no rights|bot was kicked|no rights to/i;

/** `https://t.me/foo/12` → `foo`; returns "" for invite links and junk. */
export function normalizeChannel(input: string): string {
  const raw = String(input ?? "").trim();
  const fromUrl = raw.match(/^(?:https?:\/\/)?t(?:elegram)?\.me\/([A-Za-z][A-Za-z0-9_]{3,31})(?:\/.*)?$/);
  const candidate = (fromUrl?.[1] ?? raw.replace(/^@/, "")).trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(candidate)) return "";
  return candidate;
}

export type PollResult = { ok: true; ids: number[] } | { ok: false; error: string; permanent: boolean };

/**
 * Read the post ids from the public preview.
 *
 * The page carries `data-post="channel/123"` on every post, which is the only
 * stable machine-readable bit; the rest is markup that changes.
 */
export async function pollChannel(source: string, fetchImpl?: FetchLike): Promise<PollResult> {
  const doFetch = fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await doFetch(`${PREVIEW}${source}`, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; flareward/1.0)" },
      signal: controller.signal,
    });
    if (response.status === 404) return { ok: false, error: "频道不存在或未公开", permanent: true };
    if (!response.ok) return { ok: false, error: `预览页 HTTP ${response.status}`, permanent: false };
    const html = await response.text();
    const ids: number[] = [];
    const pattern = new RegExp(`data-post="${source}/(\\d+)"`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html))) {
      const id = Number(match[1]);
      if (Number.isFinite(id) && !ids.includes(id)) ids.push(id);
    }
    if (!ids.length) {
      // A real channel always has at least one post in the preview; an empty
      // page usually means "private channel" or "not a channel at all".
      return { ok: false, error: "预览页没有可读的帖子（私有频道？）", permanent: false };
    }
    return { ok: true, ids: ids.sort((a, b) => a - b) };
  } catch (err) {
    const reason = err instanceof Error ? (err.name === "AbortError" ? "请求超时" : err.message) : String(err);
    return { ok: false, error: reason, permanent: false };
  } finally {
    clearTimeout(timer);
  }
}

export type SyncRunResult = { checked: number; copied: number; failed: number; disabled: number };

export async function runSync(rt: Runtime, limit = 20, fetchImpl?: FetchLike): Promise<SyncRunResult> {
  const rows = (await syncPollable(rt.db)).slice(0, limit);
  let copied = 0;
  let failed = 0;
  let disabled = 0;
  const now = rt.now();

  for (const row of rows) {
    // Respect the per-channel interval; `at` doubles as "last polled".
    if (now - row.at < row.intervalSeconds * 1000) continue;

    const poll = await pollChannel(row.source, fetchImpl);
    if (!poll.ok) {
      failed += 1;
      const failures = row.failures + 1;
      const stop = poll.permanent || failures >= MAX_FAILURES;
      await syncMark(rt.db, row.id, {
        failures,
        lastError: poll.error,
        enabled: stop ? 0 : 1,
        at: now,
      });
      if (stop) {
        disabled += 1;
        await say(rt, row.chatId, `同步已停用：@${row.source} — ${poll.error}`);
      }
      continue;
    }

    const fresh = poll.ids.filter((id) => id > row.lastId).slice(0, MAX_PER_RUN);
    if (!fresh.length) {
      await syncMark(rt.db, row.id, { failures: 0, lastError: "", at: now });
      continue;
    }

    let sent = 0;
    let lastId = row.lastId;
    let error = "";
    for (const messageId of fresh) {
      const res = await rt.api.call("copyMessage", {
        chat_id: row.chatId,
        from_chat_id: `@${row.source}`,
        message_id: messageId,
      });
      if (res.ok) {
        sent += 1;
        lastId = messageId;
      } else {
        error = res.error;
        break;
      }
    }

    if (sent === 0 && error) {
      failed += 1;
      const failures = row.failures + 1;
      const stop = PERMANENT.test(error) || failures >= MAX_FAILURES;
      await syncMark(rt.db, row.id, {
        failures,
        lastError: error,
        enabled: stop ? 0 : 1,
        at: now,
      });
      if (stop) {
        disabled += 1;
        await say(rt, row.chatId, `同步已停用：@${row.source} — ${error}`);
      }
      continue;
    }

    copied += sent;
    await syncMark(rt.db, row.id, { lastId, sent, failures: 0, lastError: "", at: now });
  }

  return { checked: rows.length, copied, failed, disabled };
}

/**
 * Instant mirror: called for every `channel_post` update.
 *
 * Only rows with `intervalSeconds === 0` and a matching source are touched, so
 * a channel that is also polled does not get each post twice.
 */
export async function mirrorChannelPost(rt: Runtime, msg: TgMessage): Promise<number> {
  const username = String(msg.chat.username ?? "").toLowerCase();
  if (!username) return 0;
  const rows = (await syncList(rt.db)).filter(
    (row) => row.enabled === 1 && row.intervalSeconds === 0 && row.source.toLowerCase() === username,
  );
  let copied = 0;
  for (const row of rows) {
    const res = await rt.api.call("copyMessage", {
      chat_id: row.chatId,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id,
    });
    if (res.ok) {
      copied += 1;
      await syncMark(rt.db, row.id, { lastId: msg.message_id, sent: 1, failures: 0, lastError: "", at: rt.now() });
    } else {
      const failures = row.failures + 1;
      const stop = PERMANENT.test(res.error) || failures >= MAX_FAILURES;
      await syncMark(rt.db, row.id, {
        failures,
        lastError: res.error,
        enabled: stop ? 0 : 1,
        at: rt.now(),
      });
      if (stop) await say(rt, row.chatId, `同步已停用：@${row.source} — ${res.error}`);
    }
  }
  return copied;
}

export function describeSync(row: SyncRow): string {
  const cadence = row.intervalSeconds > 0 ? `每 ${row.intervalSeconds} 秒` : "即时";
  const parts = [cadence, row.enabled ? "启用" : "已停用", `已转 ${row.sent}`, `最新 #${row.lastId || "-"}`];
  if (row.lastError) parts.push(`错误：${row.lastError.slice(0, 60)}`);
  return parts.join(" · ");
}

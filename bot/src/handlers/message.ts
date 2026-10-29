/**
 * The message pipeline.
 *
 * Order is the design:
 *   1. commands — an admin must be able to `/lock` even while the group is in
 *      night mode or flooded;
 *   2. a pending free-text answer — that message is the answer, not spam;
 *   3. admins — never filtered, or the bot would delete its own moderators;
 *   4. cheap rules (night mode, flood, keywords, locks, length);
 *   5. the local score, then auto-replies.
 *
 * The point of 4-before-5 is that a keyword hit never pays for the analysis.
 */
import { cachesFor } from "../caches.ts";
import { type Runtime } from "../context.ts";
import { inspect } from "../filters.ts";
import { duplicateSignal, scoreMessage } from "../heuristics.ts";
import { trackFlood } from "../flood.ts";
import { matchReplyFilter } from "../replies.ts";
import { keywordPolicy } from "../keywords.ts";
import { checkMedia } from "../ai/pipeline.ts";
import { visionSubject } from "../ai/vision.ts";
import { bumpWords } from "../ai/words.ts";
import { allowParse, enqueueParse, runParseJob } from "../parse/service.ts";
import { firstSupported } from "../parse/sites.ts";
import { bumpMemberStat, touchMember } from "../members.ts";
import { PDF_RENDER_MAX_BYTES, PDF_RENDER_MAX_PAGES, PDF_RENDER_WIDTH, isPdfDocument, pageCaption } from "../pdf-render.ts";
import { allowTool } from "../tools/index.ts";
import { toolLog } from "../db/repo.ts";
import type { ChatConfig } from "../rules.ts";
import { inNightWindow } from "../nightmode.ts";
import { deleteMessages, muteFor, punishAuto, record, say } from "../moderation.ts";
import { blocked } from "../block.ts";
import { filterList, isTrusted, rememberChat } from "../db/repo.ts";
import { handleCommand } from "./commands.ts";
import { TYPED_MODES, answerChallenge, pendingChallenge } from "./verify.ts";
import type { FilterRow } from "../db/schema.ts";
import type { TgMessage } from "../types.ts";

export function rememberJoin(rt: Runtime, chatId: number, userId: number): void {
  cachesFor(rt).join.set(`${chatId}:${userId}`, rt.now());
}

export function forgetJoin(rt: Runtime, chatId: number, userId: number): void {
  cachesFor(rt).join.delete(`${chatId}:${userId}`);
}

export function invalidateFilters(rt: Runtime, chatId: number): void {
  cachesFor(rt).filters.delete(chatId);
}

/**
 * Put the chat in the console's list the first time this isolate sees it.
 *
 * A group where nobody ever runs a command would otherwise never appear in the
 * admin console, and its owner would conclude the bot is broken. One write per
 * chat per isolate keeps that free.
 */
async function ensureRegistered(rt: Runtime, chat: TgMessage["chat"]): Promise<void> {
  const registry = cachesFor(rt).registered;
  if (registry.has(chat.id)) return;
  registry.set(chat.id, true);
  await rememberChat(rt.db, {
    chatId: chat.id,
    title: chat.title ?? String(chat.id),
    type: chat.type,
    at: rt.now(),
  }).catch(() => registry.delete(chat.id));
}

export async function handleMessage(rt: Runtime, msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  if (msg.chat.type !== "private") await ensureRegistered(rt, msg.chat);
  const config = await rt.configFor(chatId);
  const text = msg.text ?? "";

  // 1. commands
  if (text.startsWith("/")) {
    const handled = await handleCommand({ rt, msg, config, args: text.trim().split(/\s+/).slice(1).join(" ") });
    if (handled) return;
  }

  const from = msg.from;
  if (!from) return;

  // Shadow ban: delete and say nothing. This sits before verification on
  // purpose — a blocked member must not be able to earn their way back in by
  // answering a captcha they were never meant to see.
  if (await blocked(rt, chatId, from.id)) {
    await deleteMessages(rt, chatId, [msg.message_id]);
    await record(rt, { chatId, userId: from.id, kind: "delete", reason: "已屏蔽成员（静默）" });
    return;
  }

  // Master switch: off still lets commands through (so an admin can turn it
  // back on) but stops every automatic action.
  if (!config.enabled) return;

  // 2. a pending free-text answer is not spam (question and image modes both
  //    answer by typing — see verify.ts TYPED_MODES)
  const pending = await pendingChallenge(rt, chatId, from.id);
  if (pending && TYPED_MODES.has(pending.mode)) {
    const outcome = await answerChallenge(rt, msg, config);
    await deleteMessages(rt, chatId, [msg.message_id]);
    if (outcome && !outcome.ok) {
      await say(rt, chatId, `答案不对，再试一次（已错 ${outcome.attempts}/${5} 次）。`, { replyTo: msg.message_id });
    }
    return;
  }

  // 3. admins are never filtered
  // 匿名管理员的消息 from 是 GroupAnonymousBot、sender_chat 是群本身：
  // isAdmin(bot-id) 必然 false，会照常吃验证/夜禁/处罚——先按群身份豁免。
  if (msg.sender_chat && msg.sender_chat.id === chatId) return;
  if (await rt.admin.isAdmin(chatId, from.id)) return;
  // A bot that is not us: only the `bots` lock applies, and it is handled below.
  if (from.is_bot && !config.locks.includes("bots")) return;

  // 4a. night mode
  if (config.nightMode && inNightWindow(rt.now(), config.nightStart, config.nightEnd, rt.tzOffset)) {
    await deleteMessages(rt, chatId, [msg.message_id]);
    const noticeCache = cachesFor(rt).notice;
    const last = noticeCache.get(chatId) ?? 0;
    if (rt.now() - last > 10 * 60_000) {
      noticeCache.set(chatId, rt.now());
      await say(rt, chatId, `夜间模式（${config.nightStart}–${config.nightEnd}）期间只有管理员能发言。`, {
        replyTo: msg.message_id,
      });
    }
    return;
  }

  // 4b. flood
  const flood = trackFlood(rt, chatId, from.id, config.floodLimit, config.floodWindow, rt.now());
  if (flood.exceeded) {
    await punishAuto(rt, msg, config, `刷屏（${config.floodWindow} 秒内 ${flood.count} 条）`);
    return;
  }

  // 4c. content rules + 5. local score
  const duplicate = duplicateSignal(rt, chatId, msg);
  const heuristic = Math.min(scoreMessage(msg).score + duplicate.score, 100);
  const joinedAt = await joinedAtOf(rt, chatId, from.id);
  const trusted = joinedAt ? await trustedOf(rt, chatId, from.id) : false;
  const verdict = inspect({ msg, config, nowMs: rt.now(), joinedAt, trusted, heuristicScore: heuristic });
  if (verdict.hit) {
    // A keyword hit has three possible outcomes; every other rule has one.
    if (verdict.kind === "keyword") {
      if (keywordPolicy(config, from.id) === "record") {
        // Recorded, never touched: the whitelist exists so a sponsor can post
        // "加微信" without the bot deleting their livelihood.
        await record(rt, { chatId, userId: from.id, kind: "watch", reason: `只记录：${verdict.reason}` });
        return;
      }
      if (config.keywordAction === "mute") {
        await muteFor(rt, msg, config.muteMinutes, verdict.reason);
        return;
      }
    }
    await punishAuto(rt, msg, config, verdict.reason);
    return;
  }

  // 5b. media moderation. Paid per image, so it runs only after every free rule
  // has already passed — a message a keyword already caught never costs a call.
  if (config.ai) {
    const subject = visionSubject(msg);
    if (subject) {
      const media = await checkMedia(rt, config, chatId, subject);
      if (media.hit) {
        await punishAuto(rt, msg, config, media.reason);
        return;
      }
    }
  }

  // 5c. hot words: counting only, never a moderation decision.
  if (config.hotWords && text) await bumpWords(rt, chatId, text);

  // 5e. roster + per-member message counter (batched; never a moderation input).
  void touchMember(rt, chatId, from);
  void bumpMemberStat(rt, chatId, from.id);

  // 5c-b. PDF → per-page images. A phone cannot read a PDF comfortably; this
  // turns the document into something you swipe through. Opt-in per group
  // (`pdfAutoImages`) because it downloads and re-uploads every page, and it
  // runs after every free rule so a blocked/locked message never pays for it.
  if (config.pdfAutoImages && msg.document && isPdfDocument(msg.document)) {
    await maybeRenderPdf(rt, msg, config);
    return;
  }

  // 5d. optional auto-parse. Off by default because it costs a request per link  // and most groups would rather choose when to spend it. Failure is silent by
  // design: the original message is never touched.
  if (config.parseAuto) {
    const found = firstSupported(text, msg.entities ?? []);
    if (found && allowParse(rt, chatId, config.parsePerHour)) {
      const jobId = await enqueueParse(rt, { chatId, userId: from.id, messageId: msg.message_id, url: found.url, site: found.site });
      await runParseJob(rt, { id: jobId, chatId, messageId: msg.message_id, url: found.url, site: found.site }).catch(() => undefined);
    }
  }

  // 6. auto-replies
  const filters = await filtersOf(rt, chatId);
  const match = matchReplyFilter(filters, text);
  if (match) await say(rt, chatId, match.response, { replyTo: msg.message_id });
}

/**
 * The edit path: same rules as a fresh message, narrower consequences.
 *
 * An edit is visible to every reader the moment Telegram re-renders it, so a
 * clean post edited into spam must hit the same rules. But it only ever deletes
 * and records: no flood tracking (the message was already admitted), no
 * duplicate fingerprint (an edit must not poison the fingerprints cache), and
 * no `punishAuto` — so one message can never advance the warn ladder twice.
 */
export async function handleEditedMessage(rt: Runtime, msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return;
  const config = await rt.configFor(chatId);
  if (!config.enabled) return;
  const from = msg.from;
  if (!from) return;

  if (await blocked(rt, chatId, from.id)) {
    await deleteMessages(rt, chatId, [msg.message_id]);
    await record(rt, { chatId, userId: from.id, kind: "delete", reason: "已屏蔽成员（编辑）" });
    return;
  }
  if (await rt.admin.isAdmin(chatId, from.id)) return;
  if (from.is_bot && !config.locks.includes("bots")) return;

  const heuristic = scoreMessage(msg).score;
  const joinedAt = await joinedAtOf(rt, chatId, from.id);
  const trusted = joinedAt ? await trustedOf(rt, chatId, from.id) : false;
  const verdict = inspect({ msg, config, nowMs: rt.now(), joinedAt, trusted, heuristicScore: heuristic });
  if (!verdict.hit) return;
  if (verdict.kind === "keyword" && keywordPolicy(config, from.id) === "record") {
    await record(rt, { chatId, userId: from.id, kind: "watch", reason: `编辑只记录：${verdict.reason}` });
    return;
  }
  await deleteMessages(rt, chatId, [msg.message_id]);
  await record(rt, { chatId, userId: from.id, kind: "delete", reason: `编辑后命中：${verdict.reason}` });
}

/**
 * Render a posted PDF into per-page images and send them back.
 *
 * Silence is the wrong default here: if the group asked for this, a member who
 * posts a PDF deserves to know why nothing happened (too big, password-locked,
 * or the deployment cannot render at all). Every early return therefore says
 * something — except the size cap, which stays quiet when the file is simply
 * bigger than the group configured, because that is the group's own rule.
 */
async function maybeRenderPdf(rt: Runtime, msg: TgMessage, config: ChatConfig): Promise<void> {
  const doc = msg.document;
  const from = msg.from;
  if (!doc || !from) return;
  const render = rt.pdfRender;
  if (!render) {
    await say(rt, msg.chat.id, "这个部署不能把 PDF 转成图片（Worker 需要重新部署带 PDF 引擎的版本）。", {
      replyTo: msg.message_id,
    });
    return;
  }
  const maxKb = config.pdfAutoMaxKb;
  const sizeKb = Math.ceil(Number(doc.file_size ?? 0) / 1024);
  if (maxKb > 0 && sizeKb > maxKb) return; // the group's own ceiling: stay silent
  // One member cannot turn this into a file-conversion service.
  if (!allowTool(rt, from.id, 3, 5 * 60_000)) {
    await say(rt, msg.chat.id, "转 PDF 太频繁了，过几分钟再试。", { replyTo: msg.message_id });
    return;
  }

  const download = await rt.api.download(doc.file_id, PDF_RENDER_MAX_BYTES);
  if (!download.ok) {
    await say(rt, msg.chat.id, `PDF 下载失败：${download.error}`, { replyTo: msg.message_id });
    return;
  }

  const rendered = await render(download.bytes, { width: PDF_RENDER_WIDTH, maxPages: PDF_RENDER_MAX_PAGES });
  if (!rendered.ok) {
    await say(rt, msg.chat.id, rendered.error, { replyTo: msg.message_id });
    return;
  }

  let sent = 0;
  for (const page of rendered.pages) {
    const res = await rt.api.sendPhoto(msg.chat.id, page.data, `page-${page.page}.png`, {
      replyTo: msg.message_id,
      caption: pageCaption(page.page, rendered.total),
    });
    if (!res.ok) break;
    sent += 1;
  }
  if (rendered.total > rendered.pages.length) {
    await say(rt, msg.chat.id, `共 ${rendered.total} 页，这次只转前 ${rendered.pages.length} 页。`, {
      replyTo: msg.message_id,
    });
  }
  await toolStatsLog(rt, msg, "pdfimages", sent === rendered.pages.length, sent);
}

async function toolStatsLog(rt: Runtime, msg: TgMessage, tool: string, ok: boolean, count = 0): Promise<void> {
  await toolLog(rt.db, { chatId: msg.chat.id, userId: msg.from?.id, tool, ok, bytes: count, at: rt.now() }).catch(() => undefined);
}

async function joinedAtOf(rt: Runtime, chatId: number, userId: number): Promise<number | undefined> {
  const caches = cachesFor(rt);
  const key = `${chatId}:${userId}`;
  const cached = caches.join.get(key);
  if (cached) return cached;
  const raw = await rt.store.get(`join:${chatId}:${userId}`);
  if (!raw) return undefined;
  const at = Number(raw);
  if (!Number.isFinite(at) || at <= 0) return undefined;
  caches.join.set(key, at);
  return at;
}

async function trustedOf(rt: Runtime, chatId: number, userId: number): Promise<boolean> {
  const caches = cachesFor(rt);
  const key = `${chatId}:${userId}`;
  const cached = caches.trust.get(key);
  if (cached !== undefined) return cached;
  const value = await isTrusted(rt.db, chatId, userId).catch(() => false);
  caches.trust.set(key, value);
  return value;
}

async function filtersOf(rt: Runtime, chatId: number): Promise<FilterRow[]> {
  const cache = cachesFor(rt).filters;
  const cached = cache.get(chatId) as unknown as FilterRow[] | undefined;
  if (cached) return cached;
  const rows = await filterList(rt.db, chatId).catch(() => [] as FilterRow[]);
  cache.set(chatId, rows);
  return rows;
}

/**
 * Commands.
 *
 * Two gates before anything runs: is the sender an admin, and does that admin
 * hold the specific right this command needs. A group can promote someone to
 * "delete messages only"; without the second gate, `/ban` turns the bot into a
 * privilege-escalation path inside the group.
 */
import { PERMS_MEMBER, PERMS_MUTED, type Right, type Runtime } from "../context.ts";
import { LOCK_KINDS, SETTABLE, coerceField, describeConfig, lockLabel, parseKeywords, type ChatConfig, type LockKind } from "../rules.ts";
import { ban, deleteMessages, kick, logAction, record, recordBan, restrict, say, unban, unmute } from "../moderation.ts";
import { MATCH_MODES, type FilterMatchMode } from "../replies.ts";
import { inNightWindow } from "../nightmode.ts";
import {
  banCount,
  chatStats,
  filterAdd,
  filterDelete,
  filterList,
  noteDelete,
  noteGet,
  noteList,
  noteSave,
  recentEvents,
  trustAdd,
  warnDec,
  warnInc,
} from "../db/repo.ts";
import { describeStrike, strikeAt } from "../ladder.ts";
import type { TgMessage, TgUser } from "../types.ts";

export type CommandInput = {
  rt: Runtime;
  msg: TgMessage;
  config: ChatConfig;
  args: string;
};

const COMMAND_RIGHTS: Record<string, Right> = {
  ban: "can_restrict_members",
  mute: "can_restrict_members",
  kick: "can_restrict_members",
  unban: "can_restrict_members",
  warn: "can_restrict_members",
  unwarn: "can_restrict_members",
  verify: "can_restrict_members",
  del: "can_delete_messages",
  purge: "can_delete_messages",
  pin: "can_pin_messages",
  unpin: "can_pin_messages",
  set: "can_change_info",
  keywords: "can_change_info",
  logs: "can_change_info",
  captcha: "can_change_info",
  lock: "can_restrict_members",
  unlock: "can_restrict_members",
  nightmode: "can_change_info",
  save: "can_change_info",
  delnote: "can_change_info",
  filter: "can_change_info",
  delfilter: "can_change_info",
  import: "can_change_info",
  trust: "can_restrict_members",
};

const PUBLIC = new Set(["id", "start", "help", "rules", "get", "notes", "stats"]);
/** Commands that are harmless to *read* but must not mutate anything. */
const READ_ONLY = new Set(["id", "start", "help", "rules", "get", "notes", "stats", "config", "filters", "export"]);

export type Target = { id: number; minutes: number; error: string; user?: TgUser };

/**
 * Work out who a command is aimed at.
 *
 * A replied-to message always wins and any number is a duration. Without a
 * reply, two numbers mean `id duration`; a single small number is a duration
 * with nobody to act on — reading it as a user id, as the original template
 * did, mutes a stranger whose id happens to be `10`.
 */
export function parseTarget(msg: TgMessage, args: string): Target {
  const numbers = String(args || "")
    .trim()
    .split(/\s+/)
    .filter((part) => /^\d+$/.test(part))
    .map(Number);

  const replied = msg.reply_to_message?.from;
  const out: Target = { id: replied?.id ?? 0, minutes: 0, error: "", user: replied };

  if (replied) {
    if (numbers.length >= 1) out.minutes = numbers[0];
  } else if (numbers.length >= 2) {
    out.id = numbers[0];
    out.minutes = numbers[1];
  } else if (numbers.length === 1) {
    if (numbers[0] >= 10_000) out.id = numbers[0];
    else out.error = `只写了分钟数，没指定对象。先回复对方再发，或写成 /命令 用户ID ${numbers[0]}`;
  }

  out.minutes = Math.max(0, Math.min(out.minutes, 525_600));
  return out;
}

async function guardTarget(rt: Runtime, msg: TgMessage, id: number): Promise<boolean> {
  if (!id) {
    await say(rt, msg.chat.id, "请回复对方的消息，或写成 /命令 用户ID。", { replyTo: msg.message_id });
    return false;
  }
  if (String(id) === rt.api.botId) {
    await say(rt, msg.chat.id, "不能对我自己这么做。", { replyTo: msg.message_id });
    return false;
  }
  if (await rt.admin.isAdmin(msg.chat.id, id)) {
    await say(rt, msg.chat.id, "不能对管理员这么做。", { replyTo: msg.message_id });
    return false;
  }
  return true;
}

const HELP = [
  "焰卫在岗。把我设为管理员，权限勾上：删除消息、封禁用户、置顶消息。",
  "再到 @BotFather 发 /setprivacy，对本机器人选 Disable —— 不关的话我看不见群里的广告。",
  "",
  "所有人可用：/id /rules /notes /get <名字> /help",
  "",
  "管理员（回复对方后发）：",
  "/ban [分钟] /mute [分钟] /kick /unban /warn /unwarn /verify",
  "/del /purge [数量] /pin /unpin",
  "/lock [类型|all] /unlock [类型|all] —— 不带参数时是全群禁言/解除",
  "/set 字段 值 —— 例：/set captchaMode math、/set strikes off",
  "/captcha on|off｜/keywords add 词1,词2｜/logs 频道ID|off",
  "/nightmode on|off [23:00-07:00]｜/stats [天数]",
  "/save 名字 内容｜/delnote 名字｜/filter add exact|prefix|regex 触发词 => 回复",
  "/filters｜/delfilter ID｜/export｜/import <JSON>｜/trust（信任此人，免验证）",
  "",
  "锁类型：" + LOCK_KINDS.join(" "),
].join("\n");

// ---------------------------------------------------------------------------

export async function handleCommand(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const text = msg.text ?? "";
  if (!text.startsWith("/")) return false;
  if (!msg.from) return false;

  const bits = text.trim().split(/\s+/);
  const name = bits[0].slice(1).split("@")[0].toLowerCase();
  const chat = msg.chat;
  const from = msg.from;

  if (name === "id") {
    const dm = await say(rt, from.id, `你的 Telegram ID 是 ${from.id}。`, { html: false });
    if (!dm.ok && chat.type !== "private") {
      await say(rt, chat.id, `你的 ID 是 <code>${from.id}</code>。先私聊我发一次 /start，以后只发到私聊。`, {
        replyTo: msg.message_id,
        html: true,
      });
    }
    return true;
  }

  if (chat.type === "private") {
    if (name === "start" || name === "help") {
      await say(rt, from.id, HELP);
      return true;
    }
    return true;
  }

  if (name === "start" || name === "help") {
    if (await rt.admin.isAdmin(chat.id, from.id)) await say(rt, chat.id, HELP, { replyTo: msg.message_id });
    else await say(rt, chat.id, "我在。管理员发 /help 看命令。", { replyTo: msg.message_id });
    return true;
  }

  if (name === "rules") {
    await say(rt, chat.id, describeConfig(input.config).join("\n"), { replyTo: msg.message_id });
    return true;
  }

  // Notes and note-reading are open to everyone: that is their point.
  if (name === "get" || name === "notes") {
    return handleNoteRead(input, name);
  }
  if (name === "stats") {
    if (!(await rt.admin.isAdmin(chat.id, from.id))) return false;
    return handleStats(input);
  }

  if (PUBLIC.has(name) && !COMMAND_RIGHTS[name]) return false;

  // --- admin gate -----------------------------------------------------------
  const required = COMMAND_RIGHTS[name];
  if (!required) return false;
  const allowed = READ_ONLY.has(name)
    ? await rt.admin.isAdmin(chat.id, from.id)
    : await rt.admin.can(chat.id, from.id, required);
  if (!allowed) {
    if (!READ_ONLY.has(name)) {
      await say(rt, chat.id, "你没有这个权限（或该命令需要对应群管理权限）。", { replyTo: msg.message_id });
    }
    return true;
  }

  // Commands from the anonymous-admin bot cannot be attributed to a person, so
  // anything that mutates is refused rather than logged as "unknown admin".
  const GROUP_ANON = 1087968824;
  if (from.id === GROUP_ANON && !READ_ONLY.has(name)) {
    await say(rt, chat.id, "匿名管理员请用具体账号操作。", { replyTo: msg.message_id });
    return true;
  }

  switch (name) {
    case "ban":
      return cmdBan(input);
    case "mute":
      return cmdMute(input);
    case "kick":
      return cmdKick(input);
    case "unban":
      return cmdUnban(input);
    case "warn":
      return cmdWarn(input);
    case "unwarn":
      return cmdUnwarn(input);
    case "verify":
      return cmdVerify(input);
    case "del":
      return cmdDel(input);
    case "purge":
      return cmdPurge(input);
    case "pin":
      return cmdPin(input, true);
    case "unpin":
      return cmdPin(input, false);
    case "lock":
      return cmdLock(input, true);
    case "unlock":
      return cmdLock(input, false);
    case "set":
      return cmdSet(input);
    case "captcha":
      return cmdCaptcha(input);
    case "keywords":
      return cmdKeywords(input);
    case "logs":
      return cmdLogs(input);
    case "nightmode":
      return cmdNight(input);
    case "save":
    case "delnote":
      return handleNoteWrite(input, name);
    case "filter":
    case "filters":
    case "delfilter":
      return handleFilters(input, name);
    case "trust":
      return cmdTrust(input);
    case "export":
      return cmdExport(input);
    case "import":
      return cmdImport(input);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

async function cmdBan(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const target = parseTarget(msg, input.args);
  if (target.error) {
    await reply(input, target.error);
    return true;
  }
  if (!(await guardTarget(rt, msg, target.id))) return true;
  const res = await ban(rt, msg.chat.id, target.id, target.minutes);
  if (res.ok) await report(input, true, target.minutes ? `已封禁 ${target.minutes} 分钟。` : "已封禁。");
  else await report(input, false, res.error);
  if (res.ok) await recordBan(rt, config, target.id, "管理员手动封禁");
  if (res.ok) {
    await logAction(rt, config, {
      chat: msg.chat,
      user: target.user ?? { id: target.id, first_name: `ID ${target.id}` },
      action: target.minutes ? `封禁 ${target.minutes} 分钟` : "封禁",
      reason: "管理员手动操作",
      by: msg.from,
      kind: "ban",
      minutes: target.minutes || undefined,
    });
  }
  return true;
}

async function cmdMute(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const target = parseTarget(msg, input.args);
  if (target.error) {
    await reply(input, target.error);
    return true;
  }
  if (!(await guardTarget(rt, msg, target.id))) return true;
  const minutes = target.minutes || config.muteMinutes;
  const res = await restrict(rt, msg.chat.id, target.id, minutes);
  if (res.ok) await report(input, true, `已禁言 ${minutes} 分钟。`);
  else await report(input, false, res.error);
  if (res.ok) {
    await logAction(rt, config, {
      chat: msg.chat,
      user: target.user ?? { id: target.id },
      action: `禁言 ${minutes} 分钟`,
      reason: "管理员手动操作",
      by: msg.from,
      kind: "mute",
      minutes,
    });
  }
  return true;
}

async function cmdKick(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const target = parseTarget(msg, input.args);
  if (!(await guardTarget(rt, msg, target.id))) return true;
  const res = await kick(rt, msg.chat.id, target.id);
  await report(input, res.ok, res.ok ? "已移出，对方可以再进来。" : res.error);
  if (res.ok) await record(rt, { chatId: msg.chat.id, userId: target.id, kind: "kick", reason: "管理员手动", byId: msg.from?.id });
  return true;
}

async function cmdUnban(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const target = parseTarget(msg, input.args);
  if (!(await guardTarget(rt, msg, target.id))) return true;
  const res = await unban(rt, msg.chat.id, target.id);
  // Unbanning by hand means "this person is fine": exempt them from the newbie
  // window so the next link they post is not auto-deleted.
  await trustAdd(rt.db, msg.chat.id, target.id, rt.now()).catch(() => undefined);
  await report(input, res.ok, res.ok ? "已解除限制，并记为可信成员（免新人限制）。" : res.error);
  return true;
}

async function cmdWarn(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const target = parseTarget(msg, input.args);
  if (!target.id) {
    await say(rt, msg.chat.id, "请回复要警告的消息。", { replyTo: msg.message_id });
    return true;
  }
  if (!(await guardTarget(rt, msg, target.id))) return true;
  if (msg.reply_to_message) await deleteMessages(rt, msg.chat.id, [msg.reply_to_message.message_id]);
  const count = await warnInc(rt.db, msg.chat.id, target.id, rt.now());
  const strike = strikeAt(count, input.config);
  if (strike && strike.action !== "warn") {
    if (strike.action === "ban") await ban(rt, msg.chat.id, target.id, strike.minutes);
    else if (strike.action === "kick") await kick(rt, msg.chat.id, target.id);
    else await restrict(rt, msg.chat.id, target.id, strike.minutes);
    await say(rt, msg.chat.id, `警告 ${count} 次：${describeStrike(strike)}。`, { replyTo: msg.message_id });
  } else {
    await say(rt, msg.chat.id, `已警告 <code>${target.id}</code>（第 ${count} 次），并删掉那条消息。`, {
      replyTo: msg.message_id,
      html: true,
    });
  }
  await record(rt, { chatId: msg.chat.id, userId: target.id, kind: "warn", reason: `手动警告第 ${count} 次`, byId: msg.from?.id });
  return true;
}

async function cmdUnwarn(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const target = parseTarget(msg, input.args);
  if (!target.id) {
    await say(rt, msg.chat.id, "请回复对方的消息，或写成 /unwarn 用户ID。", { replyTo: msg.message_id });
    return true;
  }
  const left = await warnDec(rt.db, msg.chat.id, target.id, rt.now());
  await say(rt, msg.chat.id, `已撤销一次警告，剩 ${left} 次。`, { replyTo: msg.message_id });
  return true;
}

async function cmdVerify(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const target = parseTarget(msg, input.args);
  if (!target.id) {
    await say(rt, msg.chat.id, "请回复要放行的人。", { replyTo: msg.message_id });
    return true;
  }
  await unmute(rt, msg.chat.id, target.id);
  await rt.store.del(`verify:${msg.chat.id}:${target.id}`);
  await trustAdd(rt.db, msg.chat.id, target.id, rt.now()).catch(() => undefined);
  await record(rt, { chatId: msg.chat.id, userId: target.id, kind: "verify", reason: "管理员手动放行", byId: msg.from?.id });
  const answer = await say(rt, msg.chat.id, "已放行。", { replyTo: msg.message_id });
  if (answer.ok && !config.deleteJoinMessages) return true;
  return true;
}

async function cmdDel(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  if (!msg.reply_to_message) {
    await say(rt, msg.chat.id, "请回复要删除的消息。", { replyTo: msg.message_id });
    return true;
  }
  await deleteMessages(rt, msg.chat.id, [msg.reply_to_message.message_id]);
  await record(rt, { chatId: msg.chat.id, kind: "delete", reason: "管理员删除", byId: msg.from?.id });
  return true;
}

async function cmdPurge(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  if (!msg.reply_to_message) {
    await say(rt, msg.chat.id, "请回复要开始删除的那条消息。", { replyTo: msg.message_id });
    return true;
  }
  const asked = Number(input.args.trim().split(/\s+/)[0]) || 50;
  const count = Math.max(1, Math.min(asked, 100));
  const start = msg.reply_to_message.message_id;
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const id = start + i;
    if (id > msg.message_id) break;
    ids.push(id);
  }
  // `deleteMessages` caps at 100 per call; the loop above already respects it.
  const res = await deleteMessages(rt, msg.chat.id, ids);
  if (!res.ok) await say(rt, msg.chat.id, `没成功：${res.error}`, { replyTo: msg.message_id });
  await record(rt, { chatId: msg.chat.id, kind: "delete", reason: `批量删除 ${ids.length} 条`, byId: msg.from?.id });
  return true;
}

async function cmdPin(input: CommandInput, pin: boolean): Promise<boolean> {
  const { rt, msg } = input;
  if (pin) {
    if (!msg.reply_to_message) {
      await say(rt, msg.chat.id, "请回复要置顶的消息。", { replyTo: msg.message_id });
      return true;
    }
    const res = await rt.api.call("pinChatMessage", {
      chat_id: msg.chat.id,
      message_id: msg.reply_to_message.message_id,
      disable_notification: true,
    });
    await report(input, res.ok, res.ok ? "已置顶。" : res.error);
    return true;
  }
  const res = await rt.api.call("unpinChatMessage", { chat_id: msg.chat.id });
  await report(input, res.ok, res.ok ? "已取消置顶。" : res.error);
  return true;
}

/**
 * `/lock` does two different jobs, and the argument decides which:
 *   /lock            → mute the whole group (the behaviour people know)
 *   /lock links ...  → stop that message type
 */
async function cmdLock(input: CommandInput, locking: boolean): Promise<boolean> {
  const { rt, msg, config } = input;
  const arg = input.args.trim().toLowerCase();
  if (!arg) {
    const res = await rt.api.call("setChatPermissions", {
      chat_id: msg.chat.id,
      permissions: locking ? PERMS_MUTED : PERMS_MEMBER,
      use_independent_chat_permissions: true,
    });
    await report(input, res.ok, res.ok ? (locking ? "全群已禁言，管理员不受影响。" : "已解除全群禁言。") : res.error);
    return true;
  }

  const requested = arg === "all" ? [...LOCK_KINDS] : arg.split(/[\s,]+/).filter(Boolean);
  const unknown = requested.filter((kind) => !(LOCK_KINDS as readonly string[]).includes(kind));
  if (unknown.length) {
    await say(rt, msg.chat.id, `不认识的类型：${unknown.join("、")}。可用：${LOCK_KINDS.join(" ")}`, {
      replyTo: msg.message_id,
    });
    return true;
  }

  const next = new Set(config.locks);
  for (const kind of requested) {
    if (locking) next.add(kind as LockKind);
    else next.delete(kind as LockKind);
  }
  const saved = await rt.saveConfig(msg.chat.id, { locks: [...next] });
  const list = [...next].map(lockLabel);
  await say(rt, msg.chat.id, list.length ? `已拦截：${list.join("、")}` : "内容拦截已全部关闭，只剩关键词。", {
    replyTo: msg.message_id,
  });
  if (saved.error) await say(rt, msg.chat.id, `但保存失败：${saved.error}`, { replyTo: msg.message_id });
  return true;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

async function cmdSet(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const [field, ...rest] = input.args.trim().split(/\s+/);
  if (!field) {
    await say(rt, msg.chat.id, "用法：/set 字段 值。字段：" + Object.keys(SETTABLE).join(" "), { replyTo: msg.message_id });
    return true;
  }
  if (field === "keywords") {
    await say(rt, msg.chat.id, "关键词请用 /keywords add 词1,词2", { replyTo: msg.message_id });
    return true;
  }
  if (field === "strikes") {
    const value = (rest[0] ?? "").toLowerCase();
    if (!["on", "off"].includes(value)) {
      await say(rt, msg.chat.id, "用法：/set strikes on|off（on = 1次禁言1h，2次禁言24h，3次封禁）", { replyTo: msg.message_id });
      return true;
    }
    const strikes = value === "off" ? [] : [
      { at: 1, action: "mute" as const, minutes: 60 },
      { at: 2, action: "mute" as const, minutes: 1440 },
      { at: 3, action: "ban" as const, minutes: 0 },
    ];
    const saved = await rt.saveConfig(msg.chat.id, { strikes });
    await say(rt, msg.chat.id, saved.error ? `没成功：${saved.error}` : `阶梯制裁已${value === "on" ? "打开" : "关闭（回退到单次处置）"}。`, {
      replyTo: msg.message_id,
    });
    return true;
  }
  if (!(field in SETTABLE)) {
    await say(rt, msg.chat.id, `未知字段。可用：${Object.keys(SETTABLE).join(" ")}`, { replyTo: msg.message_id });
    return true;
  }
  if (!rest.length) {
    await say(rt, msg.chat.id, `用法：/set ${field} <${SETTABLE[field]}>`, { replyTo: msg.message_id });
    return true;
  }

  const raw = rest.join(" ");
  const value = coerceField(field, raw);
  if (field === "nightStart" || field === "nightEnd") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) {
      await say(rt, msg.chat.id, "时间要写成 HH:MM，例如 23:00。", { replyTo: msg.message_id });
      return true;
    }
  }
  const saved = await rt.saveConfig(msg.chat.id, { [field]: value });
  if (saved.error) {
    await say(rt, msg.chat.id, `没成功：${saved.error}`, { replyTo: msg.message_id });
    return true;
  }
  const shown = (saved.config as unknown as Record<string, unknown>)[field];
  await say(rt, msg.chat.id, `已设置 ${field} = ${Array.isArray(shown) ? shown.join(",") : String(shown)}`, {
    replyTo: msg.message_id,
  });
  return true;
}

async function cmdCaptcha(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const value = input.args.trim().toLowerCase();
  if (!value) {
    await say(rt, msg.chat.id, `新人验证现在是 ${config.captcha ? "开" : "关"}（${config.captchaMode}）。用法：/captcha on|off|button|math|question`, {
      replyTo: msg.message_id,
    });
    return true;
  }
  if (["on", "off"].includes(value)) {
    const saved = await rt.saveConfig(msg.chat.id, { captcha: value === "on" });
    await say(rt, msg.chat.id, `新人验证已${saved.config.captcha ? "打开" : "关闭"}。`, { replyTo: msg.message_id });
    return true;
  }
  if (["button", "math", "question"].includes(value)) {
    const saved = await rt.saveConfig(msg.chat.id, { captcha: true, captchaMode: value });
    await say(rt, msg.chat.id, `验证方式已切换为 ${saved.config.captchaMode}。`, { replyTo: msg.message_id });
    return true;
  }
  await say(rt, msg.chat.id, "用法：/captcha on|off|button|math|question", { replyTo: msg.message_id });
  return true;
}

async function cmdKeywords(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const [sub, ...rest] = input.args.trim().split(/\s+/);
  const action = (sub ?? "list").toLowerCase();
  if (action === "list" || !sub) {
    await say(rt, msg.chat.id, config.keywords.length ? `关键词（${config.keywords.length}）：\n${config.keywords.join("\n")}` : "还没有关键词。用法：/keywords add 词1,词2", {
      replyTo: msg.message_id,
    });
    return true;
  }
  if (action === "add") {
    const merged = parseKeywords([...config.keywords, ...parseKeywords(rest.join(" "))]);
    const saved = await rt.saveConfig(msg.chat.id, { keywords: merged });
    await say(rt, msg.chat.id, saved.error ? `没成功：${saved.error}` : `已加入，现在共 ${merged.length} 个关键词。`, {
      replyTo: msg.message_id,
    });
    return true;
  }
  if (action === "del" || action === "remove") {
    const words = parseKeywords(rest.join(" ")).map((word) => word.toLowerCase());
    const kept = config.keywords.filter((word) => !words.includes(word.toLowerCase()));
    await rt.saveConfig(msg.chat.id, { keywords: kept });
    await say(rt, msg.chat.id, `已删除 ${config.keywords.length - kept.length} 个，剩 ${kept.length} 个。`, {
      replyTo: msg.message_id,
    });
    return true;
  }
  await say(rt, msg.chat.id, "用法：/keywords add 词1,词2 / del 词 / list", { replyTo: msg.message_id });
  return true;
}

async function cmdLogs(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const value = input.args.trim();
  if (!value) {
    await say(rt, msg.chat.id, `记录目标：${config.logChatId || rt.env.LOG_CHAT_ID || "未设置"}`, { replyTo: msg.message_id });
    return true;
  }
  if (value.toLowerCase() === "off") {
    await rt.saveConfig(msg.chat.id, { logChatId: "" });
    await say(rt, msg.chat.id, "已关闭记录（若部署里配了 LOG_CHAT_ID，会继续发到那里）。", { replyTo: msg.message_id });
    return true;
  }
  if (!/^-?\d+$/.test(value)) {
    await say(rt, msg.chat.id, "请给频道或群的数字 ID，或 /logs off", { replyTo: msg.message_id });
    return true;
  }
  await rt.saveConfig(msg.chat.id, { logChatId: value });
  await say(rt, msg.chat.id, `记录会发到 ${value}（记得把我加进去并给发消息权限）。`, { replyTo: msg.message_id });
  return true;
}

async function cmdNight(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const parts = input.args.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    const state = config.nightMode ? `${config.nightStart}–${config.nightEnd}` : "关";
    const nowIn = config.nightMode && inNightWindow(rt.now(), config.nightStart, config.nightEnd, rt.tzOffset);
    await say(rt, msg.chat.id, `夜间模式：${state}${config.nightMode ? `（当前${nowIn ? "在" : "不在"}夜间）` : ""}`, {
      replyTo: msg.message_id,
    });
    return true;
  }
  const head = parts[0].toLowerCase();
  if (["on", "off"].includes(head)) {
    await rt.saveConfig(msg.chat.id, { nightMode: head === "on" });
    await say(rt, msg.chat.id, `夜间模式已${head === "on" ? "打开" : "关闭"}。`, { replyTo: msg.message_id });
    return true;
  }
  const range = parts[0].match(/^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/);
  if (!range) {
    await say(rt, msg.chat.id, "用法：/nightmode on|off，或 /nightmode 23:00-07:00", { replyTo: msg.message_id });
    return true;
  }
  await rt.saveConfig(msg.chat.id, {
    nightMode: true,
    nightStart: `${range[1]}:${range[2]}`,
    nightEnd: `${range[3]}:${range[4]}`,
  });
  await say(rt, msg.chat.id, `夜间模式：${range[1]}:${range[2]}–${range[3]}:${range[4]}，期间只有管理员能发言。`, {
    replyTo: msg.message_id,
  });
  return true;
}

async function cmdTrust(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const target = parseTarget(msg, input.args);
  if (!target.id) {
    await say(rt, msg.chat.id, "请回复要信任的人。", { replyTo: msg.message_id });
    return true;
  }
  await unmute(rt, msg.chat.id, target.id);
  await trustAdd(rt.db, msg.chat.id, target.id, rt.now()).catch(() => undefined);
  await record(rt, { chatId: msg.chat.id, userId: target.id, kind: "trust", reason: "管理员信任", byId: msg.from?.id });
  await say(rt, msg.chat.id, "已信任：不再走新人限制。", { replyTo: msg.message_id });
  return true;
}

// ---------------------------------------------------------------------------
// Notes, filters, stats, export/import
// ---------------------------------------------------------------------------

async function handleNoteRead(input: CommandInput, name: string): Promise<boolean> {
  const { rt, msg } = input;
  if (name === "notes") {
    const list = await noteList(rt.db, msg.chat.id);
    await say(rt, msg.chat.id, list.length ? `本群有 ${list.length} 条：${list.map((n) => n.name).join("、")}` : "本群还没有保存的说明。", {
      replyTo: msg.message_id,
    });
    return true;
  }
  const key = input.args.trim().split(/\s+/)[0];
  if (!key) {
    await say(rt, msg.chat.id, "用法：/get 名字", { replyTo: msg.message_id });
    return true;
  }
  const note = await noteGet(rt.db, msg.chat.id, key.toLowerCase());
  await say(rt, msg.chat.id, note ? note.content : `没有叫「${key}」的说明。`, { replyTo: msg.message_id });
  return true;
}

async function handleNoteWrite(input: CommandInput, name: string): Promise<boolean> {
  const { rt, msg } = input;
  if (name === "delnote") {
    const key = input.args.trim().toLowerCase();
    if (!key) {
      await reply(input, "用法：/delnote 名字");
      return true;
    }
    await noteDelete(rt.db, msg.chat.id, key);
    await say(rt, msg.chat.id, `已删除「${key}」。`, { replyTo: msg.message_id });
    return true;
  }
  const [rawName, ...rest] = input.args.trim().split(/\s+/);
  if (!rawName) {
    await reply(input, "用法：/save 名字 内容（或回复一条消息 /save 名字）");
    return true;
  }
  const key = rawName.toLowerCase().slice(0, 40);
  const content = rest.join(" ").trim() || (msg.reply_to_message?.text ?? "").trim();
  if (!content) {
    await reply(input, "内容不能是空的。");
    return true;
  }
  await noteSave(rt.db, {
    chatId: msg.chat.id,
    name: key,
    content: content.slice(0, 3500),
    createdBy: msg.from?.id ?? 0,
    at: rt.now(),
  });
  await say(rt, msg.chat.id, `已保存「${key}」。任何人都可以用 /get ${key} 看。`, { replyTo: msg.message_id });
  return true;
}

async function handleFilters(input: CommandInput, name: string): Promise<boolean> {
  const { rt, msg } = input;
  if (name === "filters") {
    const list = await filterList(rt.db, msg.chat.id);
    if (!list.length) {
      await reply(input, "还没有自动回复。用法：/filter add exact 你好 => 你也好");
      return true;
    }
    await say(rt, msg.chat.id, list.map((f) => `#${f.id} [${f.match}] ${f.trigger} → ${f.response.slice(0, 40)}`).join("\n"), {
      replyTo: msg.message_id,
    });
    return true;
  }
  if (name === "delfilter") {
    const id = Number(input.args.trim().split(/\s+/)[0]);
    if (!Number.isFinite(id)) {
      await reply(input, "用法：/delfilter ID（用 /filters 看 ID）");
      return true;
    }
    await filterDelete(rt.db, msg.chat.id, id);
    await say(rt, msg.chat.id, "已删除。", { replyTo: msg.message_id });
    return true;
  }

  const args = input.args.trim();
  if (!args.toLowerCase().startsWith("add")) {
    await reply(input, "用法：/filter add exact|prefix|regex 触发词 => 回复");
    return true;
  }
  const body = args.slice(3).trim();
  const [head, ...tail] = body.split("=>");
  if (!head || !tail.length) {
    await reply(input, "格式：/filter add exact 触发词 => 回复内容");
    return true;
  }
  const headParts = head.trim().split(/\s+/);
  const mode = (headParts[0] ?? "exact").toLowerCase() as FilterMatchMode;
  if (!MATCH_MODES.includes(mode)) {
    await reply(input, `匹配方式只能是 ${MATCH_MODES.join("/")}`);
    return true;
  }
  const trigger = headParts.slice(1).join(" ").trim();
  if (!trigger) {
    await reply(input, "触发词不能为空。");
    return true;
  }
  const response = tail.join("=>").trim();
  if (!response) {
    await reply(input, "回复内容不能为空。");
    return true;
  }

  await filterAdd(rt.db, {
    chatId: msg.chat.id,
    trigger: trigger.slice(0, 200),
    match: mode,
    response: response.slice(0, 1000),
    createdBy: msg.from?.id ?? 0,
    at: rt.now(),
  });
  await say(rt, msg.chat.id, `已添加自动回复：[${mode}] ${trigger}`, { replyTo: msg.message_id });
  return true;
}

async function handleStats(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const days = Math.max(1, Math.min(Number(input.args.trim().split(/\s+/)[0]) || 7, 90));
  const since = rt.now() - days * 86_400_000;
  const stats = await chatStats(rt.db, msg.chat.id, since);
  const banTotal = await banCount(rt.db).catch(() => 0);
  const recent = await recentEvents(rt.db, msg.chat.id, 5).catch(() => []);
  const label: Record<string, string> = {
    delete: "删除",
    mute: "禁言",
    ban: "封禁",
    kick: "移出",
    warn: "警告",
    verify: "验证通过",
    join: "进群",
    leave: "退群",
    external: "外部命中",
  };
  const lines = [`最近 ${days} 天（本群）：`];
  const entries = Object.entries(stats.totals).filter(([, n]) => n > 0);
  lines.push(entries.length ? entries.map(([kind, n]) => `${label[kind] ?? kind} ${n}`).join("｜") : "没有记录。");
  const today = stats.perDay.filter((row) => row.day === new Date(rt.now() + rt.tzOffset * 60_000).toISOString().slice(0, 10));
  if (today.length) lines.push(`今天：${today.map((row) => `${label[row.kind] ?? row.kind} ${row.n}`).join("｜")}`);
  if (recent.length) {
    lines.push("最近动作：");
    for (const row of recent) lines.push(`· ${label[row.kind] ?? row.kind} ${row.userId || "-"} ${row.reason}`.slice(0, 80));
  }
  lines.push(`共享黑名单：${banTotal} 人`);
  await say(rt, msg.chat.id, lines.join("\n"), { replyTo: msg.message_id });
  return true;
}

async function cmdExport(input: CommandInput): Promise<boolean> {
  const { rt, msg, config } = input;
  const notes = await noteList(rt.db, msg.chat.id);
  const filters = await filterList(rt.db, msg.chat.id);
  const payload = JSON.stringify(
    { v: 1, config, notes: notes.map((n) => ({ name: n.name, content: n.content })), filters: filters.map((f) => ({ trigger: f.trigger, match: f.match, response: f.response })) },
    null,
    0,
  );
  // 4096 is Telegram's message limit; a rule set that big is chunked rather
  // than truncated so nothing silently disappears from an export.
  const chunks: string[] = [];
  for (let i = 0; i < payload.length; i += 3500) chunks.push(payload.slice(i, i + 3500));
  for (const chunk of chunks.slice(0, 4)) await say(rt, msg.chat.id, chunk);
  if (chunks.length > 4) await say(rt, msg.chat.id, "规则太大，导出被截断，请先删掉一些说明或自动回复。");
  return true;
}

async function cmdImport(input: CommandInput): Promise<boolean> {
  const { rt, msg } = input;
  const raw = (input.args.trim() || msg.reply_to_message?.text || "").trim();
  if (!raw) {
    await reply(input, "用法：/import <JSON>（先 /export 拿到 JSON）");
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await reply(input, "不是合法 JSON。");
    return true;
  }
  const data = parsed as { config?: Record<string, unknown>; notes?: { name?: string; content?: string }[]; filters?: { trigger?: string; match?: string; response?: string }[] };
  let applied = 0;
  if (data.config && typeof data.config === "object") {
    const safe = { ...data.config };
    // Never import a log target: it would send another group's audit trail here.
    delete safe.logChatId;
    const saved = await rt.saveConfig(msg.chat.id, safe);
    if (saved.error) {
      await reply(input, `配置没导入：${saved.error}`);
      return true;
    }
    applied += 1;
  }
  const noteRows = (Array.isArray(data.notes) ? data.notes : []) as { name?: string; content?: string }[];
  for (const row of noteRows) {
    const name = String(row?.name ?? "").toLowerCase().slice(0, 40);
    const content = String(row?.content ?? "").slice(0, 3500);
    if (!name || !content) continue;
    await noteSave(rt.db, { chatId: msg.chat.id, name, content, createdBy: msg.from?.id ?? 0, at: rt.now() });
    applied += 1;
  }

  const filterRows = (Array.isArray(data.filters) ? data.filters : []) as {
    trigger?: string;
    match?: string;
    response?: string;
  }[];
  for (const row of filterRows) {
    const trigger = String(row?.trigger ?? "").slice(0, 200);
    const response = String(row?.response ?? "").slice(0, 1000);
    if (!trigger || !response) continue;
    const mode = String(row?.match ?? "exact") as FilterMatchMode;
    if (!MATCH_MODES.includes(mode)) continue;
    await filterAdd(rt.db, { chatId: msg.chat.id, trigger, match: mode, response, createdBy: msg.from?.id ?? 0, at: rt.now() });
    applied += 1;
  }

  await say(rt, msg.chat.id, `已导入 ${applied} 项。`, { replyTo: msg.message_id });
  return true;
}

// ---------------------------------------------------------------------------

async function reply(input: CommandInput, text: string): Promise<boolean> {
  await say(input.rt, input.msg.chat.id, text, { replyTo: input.msg.message_id });
  return true;
}

async function report(input: CommandInput, ok: boolean, text: string): Promise<void> {
  await say(input.rt, input.msg.chat.id, ok ? text : `没成功：${text}`, { replyTo: input.msg.message_id });
}

export { guardTarget, unmute };

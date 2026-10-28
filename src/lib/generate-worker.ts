import { keywordList, type BotConfig } from "./bot-config";

type RuntimeConfig = {
  captcha: boolean;
  captchaPrompt: string;
  captchaButton: string;
  welcomeOn: boolean;
  welcomeText: string;
  deleteJoin: boolean;
  keywords: string[];
  filterLinks: boolean;
  filterForwards: boolean;
  filterChannels: boolean;
  filterLong: boolean;
  maxLength: number;
  spamAction: BotConfig["spamAction"];
  muteMinutes: number;
  commands: BotConfig["commands"];
  helpLines: string[];
};

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function helpLines(config: BotConfig): string[] {
  const lines = [
    "焰卫在岗。",
    "把我拉进群，设成管理员，并打开：删除消息、封禁用户、置顶消息。",
    "再到 @BotFather 对本机器人发送 /setprivacy，选择 Disable。不关的话我看不见广告。",
    "任何人发送 /id 都能看到自己的数字 ID。",
    "",
    "管理员在群里回复对方的消息后可以使用：",
  ];
  if (config.commands.ban) lines.push("/ban — 封禁。加上分钟数则到期解封，例如 /ban 30");
  if (config.commands.mute) lines.push("/mute — 禁言。例如 /mute 10");
  if (config.commands.kick) lines.push("/kick — 踢出群，对方还可以再进来");
  if (config.commands.unban) lines.push("/unban — 解封并恢复发言");
  if (config.commands.warn) lines.push("/warn — 删掉这条并禁言一段时间");
  if (config.commands.del) lines.push("/del — 删除被回复的消息");
  if (config.commands.pin) lines.push("/pin — 置顶被回复的消息");
  lines.push("也可以不回复，直接写 /ban 用户ID。");
  return lines;
}

export function runtimeConfig(config: BotConfig): RuntimeConfig {
  return {
    captcha: config.captcha,
    captchaPrompt: config.captchaPrompt.trim() || "{name}，请点击按钮完成验证。",
    captchaButton: config.captchaButton.trim().slice(0, 40) || "我是本人",
    welcomeOn: config.welcomeOn,
    welcomeText: config.welcomeText.trim() || "欢迎 {name}。",
    deleteJoin: config.deleteJoin,
    keywords: keywordList(config.keywords),
    filterLinks: config.filterLinks,
    filterForwards: config.filterForwards,
    filterChannels: config.filterChannels,
    filterLong: config.filterLong,
    maxLength: clamp(config.maxLength, 40, 4096),
    spamAction: config.spamAction,
    muteMinutes: clamp(config.muteMinutes, 1, 10080),
    commands: { ...config.commands },
    helpLines: helpLines(config),
  };
}

const WORKER_BODY = `
var encoder = new TextEncoder();

var PERMS_OFF = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false
};

var PERMS_ON = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_invite_users: true,
  can_pin_messages: false,
  can_change_info: false
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function page(title, body) {
  var html = "<!doctype html><html lang=zh><meta charset=utf-8><meta name=viewport content=\\"width=device-width,initial-scale=1\\"><title>"
    + title
    + "</title><body style=\\"margin:0;background:#14110e;color:#f3ece3;font-family:sans-serif;line-height:1.55\\"><main style=\\"max-width:36rem;padding:2rem 1.25rem\\"><p style=\\"letter-spacing:.2em;font-size:.75rem;color:#b3a496\\">焰卫</p><h1 style=\\"font-size:1.8rem;font-weight:560\\">"
    + title
    + "</h1><p style=\\"color:#b3a496\\">"
    + body
    + "</p></main></body></html>";
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">");
}

function admins(env) {
  return String(env.ADMIN_IDS || "").split(/[,\\s]+/).map(function (part) {
    return part.trim();
  }).filter(function (part) {
    return /^\\d+$/.test(part);
  });
}

function isAdmin(env, id) {
  return admins(env).indexOf(String(id)) !== -1;
}

function botId(env) {
  return String(env.BOT_TOKEN || "").split(":")[0];
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  var out = 0;
  for (var i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function tg(env, method, body) {
  var res = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  try {
    return await res.json();
  } catch (err) {
    return { ok: false, description: "bad json" };
  }
}

function secretOf(env) {
  return env.WEBHOOK_SECRET || env.BOT_TOKEN || "flareward";
}

async function hmac(secret, text) {
  var key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  var buf = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  var bytes = new Uint8Array(buf).slice(0, 8);
  var hex = "";
  for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

function fill(tpl, user, chat) {
  var name = (user && (user.first_name || user.username)) || "新成员";
  var title = (chat && chat.title) || "本群";
  var username = user && user.username ? "@" + user.username : name;
  return String(tpl).split("{name}").join(name).split("{chat}").join(title).split("{username}").join(username);
}

async function reply(env, msg, text) {
  return tg(env, "sendMessage", {
    chat_id: msg.chat.id,
    text: text,
    reply_parameters: { message_id: msg.message_id }
  });
}

function textOf(msg) {
  return msg.text || msg.caption || "";
}

function hasLink(msg) {
  var text = textOf(msg);
  if (/https?:\\/\\/|t\\.me\\/|telegram\\.me\\/|www\\./i.test(text)) return true;
  var entities = (msg.entities || []).concat(msg.caption_entities || []);
  return entities.some(function (entity) {
    return entity.type === "url" || entity.type === "text_link";
  });
}

function hitKeyword(text) {
  var low = String(text || "").toLowerCase();
  for (var i = 0; i < CONFIG.keywords.length; i++) {
    var word = String(CONFIG.keywords[i] || "").trim().toLowerCase();
    if (word && low.indexOf(word) !== -1) return word;
  }
  return "";
}

async function punish(msg, env) {
  await tg(env, "deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
  if (!msg.from) return;
  if (CONFIG.spamAction === "mute") {
    await tg(env, "restrictChatMember", {
      chat_id: msg.chat.id,
      user_id: msg.from.id,
      permissions: PERMS_OFF,
      until_date: Math.floor(Date.now() / 1000) + CONFIG.muteMinutes * 60
    });
  } else if (CONFIG.spamAction === "ban") {
    await tg(env, "banChatMember", { chat_id: msg.chat.id, user_id: msg.from.id });
  }
}

async function onJoin(msg, env) {
  var members = msg.new_chat_members || [];
  for (var i = 0; i < members.length; i++) {
    var user = members[i];
    if (!user || user.is_bot || isAdmin(env, user.id)) continue;
    if (CONFIG.captcha) {
      await tg(env, "restrictChatMember", {
        chat_id: msg.chat.id,
        user_id: user.id,
        permissions: PERMS_OFF
      });
      var exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
      var sig = await hmac(secretOf(env), String(msg.chat.id) + ":" + user.id + ":" + exp);
      await tg(env, "sendMessage", {
        chat_id: msg.chat.id,
        text: fill(CONFIG.captchaPrompt, user, msg.chat),
        reply_markup: {
          inline_keyboard: [[{ text: CONFIG.captchaButton, callback_data: "v:" + user.id + ":" + exp + ":" + sig }]]
        }
      });
    } else if (CONFIG.welcomeOn) {
      await tg(env, "sendMessage", {
        chat_id: msg.chat.id,
        text: fill(CONFIG.welcomeText, user, msg.chat)
      });
    }
  }
  if (CONFIG.deleteJoin) {
    await tg(env, "deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
  }
}

async function onCallback(q, env) {
  var data = String(q.data || "");
  if (data.indexOf("v:") !== 0) {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
    return;
  }
  var parts = data.split(":");
  if (parts.length !== 4 || !q.message) {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "验证数据无效", show_alert: true });
    return;
  }
  if (String(q.from.id) !== parts[1]) {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "这不是你的验证", show_alert: true });
    return;
  }
  var exp = Number(parts[2]);
  if (!isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "验证已过期，请退群后重新加入", show_alert: true });
    return;
  }
  var expect = await hmac(secretOf(env), String(q.message.chat.id) + ":" + parts[1] + ":" + parts[2]);
  if (expect !== parts[3]) {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "签名不符", show_alert: true });
    return;
  }
  await tg(env, "restrictChatMember", {
    chat_id: q.message.chat.id,
    user_id: Number(parts[1]),
    permissions: PERMS_ON
  });
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "通过了，可以发言" });
  await tg(env, "deleteMessage", { chat_id: q.message.chat.id, message_id: q.message.message_id });
  if (CONFIG.welcomeOn) {
    await tg(env, "sendMessage", {
      chat_id: q.message.chat.id,
      text: fill(CONFIG.welcomeText, q.from, q.message.chat)
    });
  }
}

function parseTarget(msg, args) {
  var parts = String(args || "").trim().split(/\\s+/).filter(Boolean);
  var id = msg.reply_to_message && msg.reply_to_message.from ? msg.reply_to_message.from.id : 0;
  var minutes = 0;
  if (!id && parts[0] && /^\\d+$/.test(parts[0])) {
    id = Number(parts[0]);
    if (parts[1] && /^\\d+$/.test(parts[1])) minutes = Number(parts[1]);
  } else if (parts[0] && /^\\d+$/.test(parts[0])) {
    minutes = Number(parts[0]);
  }
  if (minutes > 525600) minutes = 525600;
  return { id: id, minutes: minutes };
}

async function guardTarget(env, msg, id) {
  if (!id) {
    await reply(env, msg, "请回复对方的消息，或写成 /命令 用户ID");
    return false;
  }
  if (String(id) === botId(env)) {
    await reply(env, msg, "不能对我自己这么做。");
    return false;
  }
  if (isAdmin(env, id)) {
    await reply(env, msg, "不能对管理员这么做。");
    return false;
  }
  return true;
}

async function onCommand(msg, env) {
  var text = msg.text || "";
  if (text.charAt(0) !== "/") return false;
  var bits = text.trim().split(/\\s+/);
  var name = bits[0].slice(1).split("@")[0].toLowerCase();
  var args = bits.slice(1).join(" ");
  var chat = msg.chat;

  if (name === "id") {
    var sent = await tg(env, "sendMessage", {
      chat_id: msg.from.id,
      text: "你的 Telegram ID 是 " + msg.from.id + "。填进焰卫的管理员名单，或 Cloudflare 的 ADMIN_IDS。"
    });
    if (!sent.ok && chat.type !== "private") {
      await reply(env, msg, "你的 ID 是 " + msg.from.id + "。先私聊我发一次 /start，下次 ID 就只发到私聊。");
    }
    return true;
  }

  if (name === "start" || name === "help") {
    if (chat.type !== "private" && !isAdmin(env, msg.from.id)) return false;
    await tg(env, "sendMessage", {
      chat_id: chat.id,
      text: CONFIG.helpLines.join("\\n")
    });
    return true;
  }

  if (chat.type === "private") return true;
  if (!isAdmin(env, msg.from.id)) return false;

  var target = parseTarget(msg, args);
  if (name === "ban" && CONFIG.commands.ban) {
    if (!(await guardTarget(env, msg, target.id))) return true;
    var payload = { chat_id: chat.id, user_id: target.id };
    if (target.minutes) payload.until_date = Math.floor(Date.now() / 1000) + target.minutes * 60;
    await tg(env, "banChatMember", payload);
    await reply(env, msg, target.minutes ? "已封禁 " + target.minutes + " 分钟。" : "已封禁。");
    return true;
  }
  if (name === "mute" && CONFIG.commands.mute) {
    if (!(await guardTarget(env, msg, target.id))) return true;
    var mins = target.minutes || CONFIG.muteMinutes;
    await tg(env, "restrictChatMember", {
      chat_id: chat.id,
      user_id: target.id,
      permissions: PERMS_OFF,
      until_date: Math.floor(Date.now() / 1000) + mins * 60
    });
    await reply(env, msg, "已禁言 " + mins + " 分钟。");
    return true;
  }
  if (name === "kick" && CONFIG.commands.kick) {
    if (!(await guardTarget(env, msg, target.id))) return true;
    await tg(env, "banChatMember", { chat_id: chat.id, user_id: target.id });
    await tg(env, "unbanChatMember", { chat_id: chat.id, user_id: target.id, only_if_banned: true });
    await reply(env, msg, "已踢出。");
    return true;
  }
  if (name === "unban" && CONFIG.commands.unban) {
    if (!target.id) {
      await reply(env, msg, "请回复对方的消息，或写成 /unban 用户ID");
      return true;
    }
    await tg(env, "unbanChatMember", { chat_id: chat.id, user_id: target.id, only_if_banned: false });
    await tg(env, "restrictChatMember", {
      chat_id: chat.id,
      user_id: target.id,
      permissions: PERMS_ON
    });
    await reply(env, msg, "已解除限制。");
    return true;
  }
  if (name === "warn" && CONFIG.commands.warn) {
    if (!(await guardTarget(env, msg, target.id))) return true;
    if (msg.reply_to_message) {
      await tg(env, "deleteMessage", { chat_id: chat.id, message_id: msg.reply_to_message.message_id });
    }
    await tg(env, "restrictChatMember", {
      chat_id: chat.id,
      user_id: target.id,
      permissions: PERMS_OFF,
      until_date: Math.floor(Date.now() / 1000) + CONFIG.muteMinutes * 60
    });
    await reply(env, msg, "已警告，并禁言 " + CONFIG.muteMinutes + " 分钟。");
    return true;
  }
  if (name === "del" && CONFIG.commands.del) {
    if (!msg.reply_to_message) {
      await reply(env, msg, "请回复要删除的消息。");
      return true;
    }
    await tg(env, "deleteMessage", { chat_id: chat.id, message_id: msg.reply_to_message.message_id });
    await tg(env, "deleteMessage", { chat_id: chat.id, message_id: msg.message_id });
    return true;
  }
  if (name === "pin" && CONFIG.commands.pin) {
    if (!msg.reply_to_message) {
      await reply(env, msg, "请回复要置顶的消息。");
      return true;
    }
    await tg(env, "pinChatMessage", {
      chat_id: chat.id,
      message_id: msg.reply_to_message.message_id,
      disable_notification: true
    });
    await reply(env, msg, "已置顶。");
    return true;
  }
  return false;
}

async function guard(msg, env) {
  if (!msg || !msg.chat || msg.chat.type === "private" || msg.chat.type === "channel") return;
  if (!msg.from || msg.from.is_bot || isAdmin(env, msg.from.id)) return;
  if (CONFIG.filterChannels && msg.sender_chat && msg.sender_chat.id !== msg.chat.id) {
    await punish(msg, env);
    return;
  }
  if (CONFIG.filterForwards && (msg.forward_origin || msg.forward_from || msg.forward_date || msg.forward_sender_name)) {
    await punish(msg, env);
    return;
  }
  var text = textOf(msg);
  if (hitKeyword(text) || (CONFIG.filterLinks && hasLink(msg)) || (CONFIG.filterLong && text.length > CONFIG.maxLength)) {
    await punish(msg, env);
  }
}

async function onMessage(msg, env) {
  if (!msg || !msg.chat) return;
  if (msg.new_chat_members && msg.new_chat_members.length) {
    await onJoin(msg, env);
    return;
  }
  if (msg.left_chat_member && CONFIG.deleteJoin) {
    await tg(env, "deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
    return;
  }
  if (msg.text && msg.text.charAt(0) === "/") {
    var handled = await onCommand(msg, env);
    if (handled) return;
  }
  await guard(msg, env);
}

async function onMyMembership(update, env) {
  var member = update.my_chat_member;
  if (!member) return;
  var now = member.new_chat_member && member.new_chat_member.status;
  var prev = member.old_chat_member && member.old_chat_member.status;
  var joined = (now === "member" || now === "administrator") && (prev === "left" || prev === "kicked");
  if (!joined) return;
  await tg(env, "sendMessage", {
    chat_id: member.chat.id,
    text: "焰卫到了。请把我设为管理员，打开删除消息、封禁用户和置顶。然后在 @BotFather 发送 /setprivacy，对本机器人选择 Disable。"
  });
}

function commandList() {
  var list = [
    { command: "id", description: "查看自己的数字 ID" },
    { command: "help", description: "焰卫会做什么" }
  ];
  if (CONFIG.commands.ban) list.push({ command: "ban", description: "回复消息：封禁" });
  if (CONFIG.commands.mute) list.push({ command: "mute", description: "回复消息：禁言" });
  if (CONFIG.commands.kick) list.push({ command: "kick", description: "回复消息：踢出" });
  if (CONFIG.commands.unban) list.push({ command: "unban", description: "回复消息：解除" });
  if (CONFIG.commands.warn) list.push({ command: "warn", description: "回复消息：警告并禁言" });
  if (CONFIG.commands.del) list.push({ command: "del", description: "回复消息：删除" });
  if (CONFIG.commands.pin) list.push({ command: "pin", description: "回复消息：置顶" });
  return list;
}

async function handleInstall(request, env) {
  if (!env.BOT_TOKEN) {
    return page("还差令牌", "在 Worker 的设置 → 变量和机密里添加机密 BOT_TOKEN，保存后再打开本页。");
  }
  if (env.WEBHOOK_SECRET) {
    var key = new URL(request.url).searchParams.get("key") || "";
    if (!safeEqual(key, env.WEBHOOK_SECRET)) {
      return page("需要钥匙", "地址后面加上 ?key= 你在 Cloudflare 里填写的 WEBHOOK_SECRET。");
    }
  }
  var origin = new URL(request.url).origin;
  var hookBody = {
    url: origin + "/",
    allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member"],
    drop_pending_updates: true
  };
  if (env.WEBHOOK_SECRET) hookBody.secret_token = env.WEBHOOK_SECRET;
  var me = await tg(env, "getMe", {});
  var hook = await tg(env, "setWebhook", hookBody);
  var cmds = await tg(env, "setMyCommands", { commands: commandList() });
  if (!me.ok || !hook.ok) {
    return page("没接上", esc((hook && hook.description) || (me && me.description) || "Telegram 拒绝了这次设置。检查 BOT_TOKEN。"));
  }
  var who = me.result && me.result.username ? "@" + me.result.username : "你的机器人";
  var extra = cmds.ok ? "命令菜单也写好了。" : "命令菜单没写成，不影响收消息。";
  return page("已经接上 Telegram", esc(who) + " 会把消息送到这个 Worker。" + extra + " 现在把机器人拉进群，并设为管理员。");
}

async function handleUpdate(update, env) {
  if (update.callback_query) return onCallback(update.callback_query, env);
  if (update.my_chat_member) return onMyMembership(update, env);
  if (update.edited_message) return guard(update.edited_message, env);
  if (update.message) return onMessage(update.message, env);
}

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/install" || url.pathname === "/install/")) {
      return handleInstall(request, env);
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return page("焰卫在线", "Worker 已经起来了。打开 /install 把它接到你的 Telegram 机器人。如果设置了 WEBHOOK_SECRET，地址要带 ?key=。");
    }
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    if (env.WEBHOOK_SECRET) {
      var got = request.headers.get("x-telegram-bot-api-secret-token") || "";
      if (!safeEqual(got, env.WEBHOOK_SECRET)) return new Response("unauthorized", { status: 401 });
    }
    var update;
    try {
      update = await request.json();
    } catch (err) {
      return new Response("bad json", { status: 400 });
    }
    ctx.waitUntil(handleUpdate(update, env).catch(function (err) {
      console.log(err && err.message ? err.message : err);
    }));
    return json({ ok: true });
  }
};
`;

export function generateWorker(config: BotConfig): string {
  const header = `/**
 * 焰卫 — 你自己的 Telegram 群管机器人
 * 整段粘贴到 Cloudflare Worker 编辑器，然后部署。
 *
 * 不要把令牌写进这个文件。到 Worker → 设置 → 变量和机密：
 *   BOT_TOKEN        机密，@BotFather 给你的令牌
 *   ADMIN_IDS        管理员数字 ID，英文逗号分隔
 *   WEBHOOK_SECRET   机密，可选。设了的话，安装地址要带 ?key=同一串
 *
 * 关键词、欢迎语和开关烤在下面的 CONFIG 里。
 * 改这些要重新粘贴并部署。改令牌或管理员只改变量。
 */

const CONFIG = ${JSON.stringify(runtimeConfig(config), null, 2)};
`;
  return header + WORKER_BODY;
}

export function ruleSummary(config: BotConfig): string[] {
  const runtime = runtimeConfig(config);
  const lines: string[] = [];
  if (runtime.captcha) lines.push("新人进群后先被禁言，点按钮才可以发言，按钮 24 小时内有效。");
  else lines.push("不验证新人，进群就能说话。");
  if (runtime.welcomeOn) {
    lines.push(runtime.captcha ? "验证通过后发送欢迎语。" : "进群时发送欢迎语。");
  }
  if (runtime.deleteJoin) lines.push("删掉「某某加入了群组」这类系统消息。");
  if (runtime.keywords.length) {
    lines.push("消息里出现 " + runtime.keywords.length + " 个关键词时处理。");
  }
  if (runtime.filterLinks) lines.push("带链接的消息会处理。");
  if (runtime.filterForwards) lines.push("转发来的消息会处理。");
  if (runtime.filterChannels) lines.push("以频道身份发来的消息会处理。");
  if (runtime.filterLong) lines.push("超过 " + runtime.maxLength + " 字的消息会处理。");
  const action =
    runtime.spamAction === "ban"
      ? "违规直接封禁"
      : runtime.spamAction === "mute"
        ? "违规删除并禁言 " + runtime.muteMinutes + " 分钟"
        : "违规只删除，不封人";
  lines.push(action + "。管理员除外。");
  return lines;
}

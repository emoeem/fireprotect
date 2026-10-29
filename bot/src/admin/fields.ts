/**
 * Chinese metadata for every `ChatConfig` key.
 *
 * The console used to render `Object.keys(config)` — forty-four raw keys such as
 * `captchaTimeout` and `captchaKick`, in schema order, with no grouping and no
 * hint. Readable to whoever wrote the schema, useless to the person who runs the
 * group. This table is the fix: one row per key with a name, a sentence saying
 * what actually happens when you flip it, the unit, and the group it belongs to.
 *
 * It is deliberately *data*, not markup: `page.ts` stays a string template, and
 * a test can assert every schema key appears exactly once. A field added to
 * `rules.ts` without a row here fails that test rather than silently rendering
 * as an English identifier — which is exactly how this file came to exist.
 */
import { LOCK_KINDS, type LockKind } from "../rules.ts";

export type FieldKind = "switch" | "number" | "select" | "text" | "list" | "locks" | "ladder";

export type FieldOption = { value: string; label: string };

export type FieldMeta = {
  key: string;
  label: string;
  /** What happens if you change it. One sentence, no restating the label. */
  hint?: string;
  group: string;
  kind: FieldKind;
  unit?: string;
  options?: FieldOption[];
};

export type FieldGroup = { id: string; title: string; note?: string };

export const FIELD_GROUPS: FieldGroup[] = [
  {
    id: "basic",
    title: "总开关",
    note: "关掉之后机器人只答管理命令，不删消息、不处罚、不欢迎。",
  },
  {
    id: "captcha",
    title: "进群验证",
    note: "新人进群先禁言，完成验证后自动放开。超时按下面的设置处置。",
  },
  { id: "greet", title: "欢迎与告别" },
  {
    id: "content",
    title: "关键词与内容拦截",
    note: "先查白名单，再查关键词和正则，最后才看内容类型和长度。顺序决定了误伤率。",
  },
  {
    id: "punish",
    title: "违规与处罚",
    note: "阶梯优先于「警告满额封禁」：设了阶梯就按阶梯走，清空阶梯才回退到按次数封禁。",
  },
  { id: "flood", title: "刷屏与新成员" },
  { id: "night", title: "夜间模式", note: "只允许管理员发言，普通成员的消息直接删除。" },
  {
    id: "ai",
    title: "图片与视频封面审核",
    note: "默认关。开启后每条媒体都会调一次外部接口，按每日预算封顶，接口不可用时放行而不误删。",
  },
  { id: "media", title: "链接解析与热词" },
  {
    id: "tools",
    title: "文档与工具箱",
    note: "PDF 转图片要完整下载再渲染：手机上看 PDF 要不停缩放，转成每页一张图可以直接滑。",
  },
  { id: "external", title: "外部名单与日志" },
];

const LOCK_LABELS: Record<LockKind, string> = {
  links: "链接",
  photos: "图片",
  videos: "视频",
  stickers: "贴纸",
  gifs: "动图",
  files: "文件",
  polls: "投票",
  voice: "语音",
  forwards: "转发",
  invites: "群邀请",
  mentions: "提及",
  bots: "机器人消息",
  channels: "频道消息",
};

export const FIELDS: FieldMeta[] = [
  // --- basic ---------------------------------------------------------------
  {
    key: "enabled",
    label: "启用本群管理",
    hint: "关掉后仍然响应 /help、/stats 这类只读命令，不会退群。",
    group: "basic",
    kind: "switch",
  },

  // --- captcha -------------------------------------------------------------
  {
    key: "captcha",
    label: "新人验证",
    hint: "开：新人进群先禁言，验证通过才放开。关：进群即可发言。",
    group: "captcha",
    kind: "switch",
  },
  {
    key: "captchaMode",
    label: "验证方式",
    hint: "按钮最松，图形验证码和订阅频道最紧；问答/图形要求新人能打字（不预禁言）。",
    group: "captcha",
    kind: "select",
    options: [
      { value: "button", label: "点按钮" },
      { value: "math", label: "算术题" },
      { value: "question", label: "问答题" },
      { value: "image", label: "图形验证码" },
      { value: "subscribe", label: "订阅频道" },
    ],
  },
  {
    key: "captchaTimeout",
    label: "验证时限",
    hint: "从进群开始计时，到点还没验证就按下面那条处置。",
    group: "captcha",
    kind: "number",
    unit: "秒",
  },
  {
    key: "captchaKick",
    label: "超时移出群",
    hint: "开：超时直接踢。关：留在群里但一直禁言，需要管理员手动处理。",
    group: "captcha",
    kind: "switch",
  },
  {
    key: "captchaQuestion",
    label: "问答题的问题",
    hint: "只在「问答题」方式下使用。答案见下一条。",
    group: "captcha",
    kind: "text",
  },
  {
    key: "captchaAnswer",
    label: "问答题答案",
    hint: "多个答案用逗号分隔，每个都算对；不区分大小写。",
    group: "captcha",
    kind: "list",
  },
  {
    key: "captchaChannel",
    label: "订阅验证频道",
    hint: "「订阅频道」方式要求新人加入这个公开频道；机器人需先加入该频道。",
    group: "captcha",
    kind: "text",
  },
  {
    key: "captchaPrompt",
    label: "验证提示语",
    hint: "可用占位符 {name} {chat}。",
    group: "captcha",
    kind: "text",
  },

  // --- greetings -----------------------------------------------------------
  { key: "welcome", label: "欢迎语", hint: "新人进群时发一条。", group: "greet", kind: "switch" },
  {
    key: "welcomeText",
    label: "欢迎语内容",
    hint: "可用占位符 {name} {chat} {username} {id}。",
    group: "greet",
    kind: "text",
  },
  { key: "farewell", label: "告别语", hint: "成员退群或被踢时发一条。", group: "greet", kind: "switch" },
  { key: "farewellText", label: "告别语内容", hint: "占位符同上。", group: "greet", kind: "text" },
  {
    key: "deleteJoinMessages",
    label: "删除「X 加入」系统消息",
    hint: "群里人多时这类消息很吵，默认删。",
    group: "greet",
    kind: "switch",
  },
  {
    key: "pdfAutoImages",
    label: "PDF 自动转图片",
    hint: "开：有人发 PDF 时自动转成每页一张图片，手机上直接滑动看。关：只在发 /splitpdf 时处理。",
    group: "tools",
    kind: "switch",
  },
  {
    key: "pdfAutoMaxKb",
    label: "自动转图的大小上限",
    hint: "超过这个大小的 PDF 不自动转（0 = 不限）。转图要完整下载再渲染，大文件很慢。",
    group: "tools",
    kind: "number",
    unit: "KB",
  },

  // --- content -------------------------------------------------------------
  {
    key: "keywords",
    label: "关键词",
    hint: "普通的包含匹配（不分大小写）。命中后按「关键词命中动作」处置。",
    group: "content",
    kind: "list",
  },
  {
    key: "keywordPatterns",
    label: "正则关键词",
    hint: "高级用法，例如 加\\s*V 能匹配「加 V」。写错的正则会整条失效，不会误伤。",
    group: "content",
    kind: "list",
  },
  {
    key: "keywordAction",
    label: "关键词命中动作",
    hint: "「只记录」是先观察一周、确认误伤率再动手的档位。",
    group: "content",
    kind: "select",
    options: [
      { value: "delete", label: "只删除" },
      { value: "mute", label: "删除并禁言" },
      { value: "record", label: "只记录，不处置" },
    ],
  },
  {
    key: "adWhitelist",
    label: "广告合作白名单",
    hint: "这些用户 ID 命中关键词时只记录、不处置。填数字 ID，逗号分隔。",
    group: "content",
    kind: "list",
  },
  {
    key: "locks",
    label: "禁止发送的内容类型",
    hint: "选中即拦截。链接、图片、贴纸这类最常被广告利用。",
    group: "content",
    kind: "locks",
    options: LOCK_KINDS.map((kind) => ({ value: kind, label: LOCK_LABELS[kind] })),
  },
  {
    key: "maxLength",
    label: "超长拦截",
    hint: "超过这个字数的消息直接删除。填 0 关闭。",
    group: "content",
    kind: "number",
    unit: "字",
  },

  // --- punishment ----------------------------------------------------------
  {
    key: "spamAction",
    label: "违规默认处置",
    hint: "阶梯没设或没走完时的兜底动作。",
    group: "punish",
    kind: "select",
    options: [
      { value: "delete", label: "只删除" },
      { value: "mute", label: "禁言" },
      { value: "ban", label: "封禁" },
    ],
  },
  {
    key: "muteMinutes",
    label: "默认禁言时长",
    hint: "「违规默认处置」选禁言时用这个时长。",
    group: "punish",
    kind: "number",
    unit: "分钟",
  },
  {
    key: "warnLimit",
    label: "警告满额封禁",
    hint: "累计警告到这个次数自动封禁。填 0 关闭。设了阶梯就以阶梯为准。",
    group: "punish",
    kind: "number",
    unit: "次",
  },
  {
    key: "strikes",
    label: "违规阶梯",
    hint: "第几次违规 → 怎么处理 → 多久。留空表示只用上面的「警告满额封禁」。",
    group: "punish",
    kind: "ladder",
  },

  // --- flood ---------------------------------------------------------------
  {
    key: "floodLimit",
    label: "刷屏上限",
    hint: "统计窗口内超过这个条数就按刷屏处理。填 0 关闭。",
    group: "flood",
    kind: "number",
    unit: "条",
  },
  {
    key: "floodWindow",
    label: "刷屏统计窗口",
    hint: "配合上一条：窗口内最多发几条。",
    group: "flood",
    kind: "number",
    unit: "秒",
  },
  {
    key: "newbieHours",
    label: "新人限制时长",
    hint: "进群后这段时间内禁止下面勾选的行为。填 0 关闭。",
    group: "flood",
    kind: "number",
    unit: "小时",
  },
  {
    key: "newbieBlocks",
    label: "新人被禁的行为",
    hint: "通常勾「链接」和「提及」：拉人进群和刷屏广告都靠这两样。",
    group: "flood",
    kind: "locks",
    options: [
      { value: "links", label: "发链接" },
      { value: "mentions", label: "大量提及（@）" },
    ],
  },
  {
    key: "joinRateMax",
    label: "进群限速阈值",
    hint: "短时间涌入这么多人说明在被爆群。填 0 关闭。",
    group: "flood",
    kind: "number",
    unit: "人",
  },
  {
    key: "joinRateWindow",
    label: "进群限速窗口",
    hint: "配合上一条：这段时间内进多少人算异常。",
    group: "flood",
    kind: "number",
    unit: "秒",
  },
  {
    key: "joinRateAction",
    label: "进群超限后的动作",
    hint: "「直接锁群」会立刻全员禁言，自己记得手动解开。",
    group: "flood",
    kind: "select",
    options: [
      { value: "notify", label: "只提醒管理员" },
      { value: "lock", label: "直接锁群" },
    ],
  },

  // --- night ---------------------------------------------------------------
  { key: "nightMode", label: "夜间模式", hint: "开启后按下面的时间段限制发言。", group: "night", kind: "switch" },
  { key: "nightStart", label: "夜间开始", hint: "24 小时制，格式 23:00。", group: "night", kind: "text" },
  { key: "nightEnd", label: "夜间结束", hint: "可以跨午夜，例如 23:00 → 07:00。", group: "night", kind: "text" },

  // --- ai ------------------------------------------------------------------
  {
    key: "ai",
    label: "开启图片审核",
    hint: "必须在部署里配好 VISION_KEY，否则开了也不会调用。",
    group: "ai",
    kind: "switch",
  },
  {
    key: "aiProvider",
    label: "视觉服务类型",
    hint: "「通用接口」适用于任何返回 {labels:[{name,score}]} 的服务。",
    group: "ai",
    kind: "select",
    options: [
      { value: "generic", label: "通用接口" },
      { value: "cloud-vision", label: "谷歌 Cloud Vision" },
    ],
  },
  {
    key: "aiMinScore",
    label: "判定阈值",
    hint: "分数越高越保守。调高减少误删，调低减少漏网。80 是 Cloud Vision 量纲下的经验值。",
    group: "ai",
    kind: "number",
    unit: "分",
  },
  {
    key: "aiCategories",
    label: "要识别的类别",
    hint: "「广告」和「二维码」误伤面最大——海报里常出现二维码。",
    group: "ai",
    kind: "locks",
    options: [
      { value: "nsfw", label: "色情" },
      { value: "gambling", label: "博彩" },
      { value: "ad", label: "广告图" },
      { value: "qr", label: "二维码" },
    ],
  },
  {
    key: "aiDailyBudget",
    label: "每日调用预算",
    hint: "到顶后只告警一次，然后当天的审核整体停用，明天恢复。这是账单保险。",
    group: "ai",
    kind: "number",
    unit: "次/天",
  },

  // --- media ---------------------------------------------------------------
  {
    key: "parseAuto",
    label: "自动解析链接",
    hint: "开：群里出现抖音/小红书/推特/B站链接就自动取原始文件。每条都可能触发一次外部请求。",
    group: "media",
    kind: "switch",
  },
  {
    key: "parsePerHour",
    label: "每小时解析上限",
    hint: "按群计。到顶后只回一句提示，不做任何处理。",
    group: "media",
    kind: "number",
    unit: "次",
  },
  {
    key: "hotWords",
    label: "热词统计",
    hint: "每天统计群内高频词，进 /stats 和统计页。关掉会更省。",
    group: "media",
    kind: "switch",
  },

  // --- external ------------------------------------------------------------
  {
    key: "cas",
    label: "接入 CAS 反垃圾库",
    hint: "只在进群时查一次。需要部署里配好 CAS_KEY，无 key 时按失败处理、不误杀。",
    group: "external",
    kind: "switch",
  },
  {
    key: "federation",
    label: "接入联邦黑名单",
    hint: "需要部署里配好 FEDERATION_URL。服务不可用时放行。",
    group: "external",
    kind: "switch",
  },
  {
    key: "logChatId",
    label: "管理日志频道",
    hint: "填数字 ID（-100 开头）把每次处置同步一份到频道。留空关闭。",
    group: "external",
    kind: "text",
  },
];

/** Label for one key; falls back to the raw key so nothing renders blank. */
export function fieldLabel(key: string): string {
  return FIELDS.find((field) => field.key === key)?.label ?? key;
}

/**
 * The payload handed to the browser.
 *
 * Only what the UI needs: no zod schemas, no defaults. Sending the whole module
 * would drag `rules.ts` and its validator into a page that already has them on
 * the server side.
 */
export function fieldPayload(): { groups: FieldGroup[]; fields: FieldMeta[] } {
  return { groups: FIELD_GROUPS, fields: FIELDS };
}

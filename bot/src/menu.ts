/**
 * The command menu Telegram shows in the `/` popup.
 *
 * One list, because it was two: `node.ts` registered fifteen commands on start
 * and `scripts/live-check.ts` checked eight of them, so the health check could
 * pass while a command was missing from the menu a user actually taps.
 *
 * Descriptions are what the admin reads before typing, so they say what the
 * command is for, not what it is called.
 */
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: "help", description: "面板 · 管理后台入口" },
  { command: "rules", description: "本群规则" },
  { command: "id", description: "看自己的数字 ID" },
  { command: "notes", description: "本群保存的说明" },
  { command: "stats", description: "近 7 天处置统计" },
  { command: "lock", description: "全群禁言 / 锁类型" },
  { command: "unlock", description: "解除禁言 / 解锁类型" },
  { command: "nightmode", description: "夜间模式" },
  { command: "config", description: "当前配置（管理员）" },
  { command: "block", description: "屏蔽成员（静默删除其消息）" },
  { command: "sync", description: "频道新帖同步到本群" },
  { command: "tool", description: "工具箱：PDF 拆分 / 长图切分 / 链接展开" },
  { command: "parse", description: "解析抖音/小红书/X/B站链接" },
  { command: "ai", description: "图片审核开关与阈值（管理员）" },
  { command: "words", description: "今天的热词" },
  // Kept short on purpose: `/unsub` and `/unsubthis` are documented in the
  // `/sub list` footer and in `/help`, so they do not need their own menu slot.
  { command: "sub", description: "RSS 订阅（/sub list｜/sub export）" },
  { command: "ocr", description: "回复图片读文字（需自托管）" },
];

/** Label on the button Telegram shows left of the input box. */
export const MENU_BUTTON_TEXT = "管理后台";

/**
 * `setChatMenuButton` payload for the console.
 *
 * Bot API has no "open this URL" menu button — the only type that carries a URL
 * is `web_app`, which launches a Mini App. That is fine here: the console
 * authenticates the Mini App with the `initData` signature instead of a cookie
 * (see `admin/tginit.ts`), so no `SameSite` compromise is needed.
 *
 * Returns `null` when there is no absolute http(s) origin to point at, because
 * Telegram rejects a relative URL and a failed setup call is worse than none.
 */
export function menuButton(publicUrl: string | undefined): {
  type: "web_app";
  text: string;
  web_app: { url: string };
} | null {
  const base = String(publicUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/i.test(base)) return null;
  return { type: "web_app", text: MENU_BUTTON_TEXT, web_app: { url: `${base}/admin` } };
}

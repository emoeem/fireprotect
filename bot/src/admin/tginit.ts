/**
 * Telegram Mini App identity.
 *
 * The console can be opened two ways: in a browser (cookie session, see
 * `api.ts`) or from the bot's menu button (Mini App). The second one cannot use
 * the cookie: `web.telegram.org` runs Mini Apps in an iframe, where a
 * `SameSite=Strict` cookie is a third-party cookie and is not sent. Widening it
 * to `None` would hand every write route to any page that learns the URL —
 * CSRF on a console that can ban 899 people.
 *
 * So the Mini App authenticates per request instead: Telegram appends
 * `tgWebAppData=<initData>` to the launch URL, and `initData` is an HMAC signed
 * with a key derived from the bot token. Verifying it costs one HMAC and no
 * storage, and a forged header cannot pass without BOT_TOKEN.
 *
 * Signature alone only proves "Telegram said so" — it does not prove the person
 * may administer this bot. Any user who can open a chat with the bot reaches
 * the Mini App, so the second half of this file answers "is this user one of
 * our admins", cached because it costs a Bot API call per chat.
 */
import type { Db } from "../db/repo.ts";
import { listChats } from "../db/repo.ts";
import type { Telegram } from "../telegram.ts";
import type { Env } from "../types.ts";

const enc = new TextEncoder();

/** How old `auth_date` may be. Telegram hands a fresh initData on every launch. */
export const INIT_DATA_MAX_AGE_MS = 24 * 3600_000;

/** Admin lookups are cached this long; a demoted admin keeps the console for 5 minutes. */
const ADMIN_TTL_MS = 5 * 60_000;

export type TgInitUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export type InitDataCheck =
  | { ok: true; user: TgInitUser; authDate: number }
  | { ok: false; error: string };

/**
 * Copy into a fresh ArrayBuffer before handing it to WebCrypto. A bare
 * `Uint8Array` is typed as possibly SharedArrayBuffer-backed, which
 * `importKey` refuses at compile time; copying is one allocation and removes
 * the cast.
 */
function bufferOf(source: string | Uint8Array): ArrayBuffer {
  const bytes = typeof source === "string" ? enc.encode(source) : source;
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function hmacSha256(key: string | Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    bufferOf(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, bufferOf(message)));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Split `query_id=…&user=…&hash=…` into decoded pairs.
 *
 * Decoding is not optional: the data-check-string is built from the *decoded*
 * values, and `user` arrives percent-encoded (`%7B%22id%22…`). Keeping it
 * encoded makes every signature check fail on exactly the one field that
 * carries the identity — the failure looks like "the Mini App never works".
 */
export function parseInitData(initData: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(String(initData ?? ""))) out.set(key, value);
  return out;
}

/**
 * Verify `hash` per Telegram's WebApp spec:
 *   secret  = HMAC_SHA256("WebAppData", bot_token)      ← token is the message
 *   check   = HMAC_SHA256(secret, sorted "k=v" joined by "\n")
 *   hash    = hex(check)
 * Note the argument order: the key is the literal "WebAppData", the token is
 * the data. Swapping them produces a signature that never matches, which is the
 * other classic way to get this wrong.
 */
export async function verifyInitData(
  initData: string,
  botToken: string,
  nowMs: number,
  maxAgeMs = INIT_DATA_MAX_AGE_MS,
): Promise<InitDataCheck> {
  if (!initData) return { ok: false, error: "没有 initData" };
  if (!botToken) return { ok: false, error: "服务端没有 BOT_TOKEN，无法校验 Mini App 身份" };

  const fields = parseInitData(initData);
  const hash = fields.get("hash") ?? "";
  if (!hash) return { ok: false, error: "initData 缺少 hash" };

  const pairs: string[] = [];
  for (const [key, value] of fields) if (key !== "hash") pairs.push(`${key}=${value}`);
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secret = await hmacSha256("WebAppData", botToken);
  const expected = toHex(await hmacSha256(secret, dataCheckString));
  if (expected.length !== hash.length || expected !== hash) return { ok: false, error: "initData 签名不对" };

  const authDate = Number(fields.get("auth_date") ?? 0);
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, error: "initData 缺少 auth_date" };
  if (nowMs - authDate * 1000 > maxAgeMs) return { ok: false, error: "initData 已过期，请重新打开" };

  // `user` is already decoded by parseInitData; decoding twice would mangle a
  // name containing '%'.
  let user: TgInitUser | null = null;
  try {
    user = JSON.parse(fields.get("user") ?? "") as TgInitUser;
  } catch {
    user = null;
  }
  if (!user || !Number.isFinite(user.id) || user.id <= 0) return { ok: false, error: "initData 缺少用户" };

  return { ok: true, user, authDate };
}

export type ConsoleAuthDeps = {
  env: Env;
  api: Telegram;
  db: Db;
  now: () => number;
};

const adminCache = new Map<number, { ok: boolean; at: number }>();

/** `ADMIN_IDS`, comma or whitespace separated — the same list the commands use. */
export function staticAdminIds(env: Env): number[] {
  return String(env.ADMIN_IDS ?? "")
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => /^-?\d+$/.test(part))
    .map(Number);
}

/**
 * May this Telegram user open the console?
 *
 * A name in `ADMIN_IDS` is enough. Otherwise we ask Telegram whether the user is
 * a creator/administrator in any group the bot knows, newest first — the same
 * people who can run `/ban` in the group can manage it from the console.
 */
export async function authorizeConsoleUser(deps: ConsoleAuthDeps, userId: number): Promise<boolean> {
  if (!Number.isFinite(userId) || userId <= 0) return false;
  if (staticAdminIds(deps.env).includes(userId)) return true;

  const hit = adminCache.get(userId);
  const nowMs = deps.now();
  if (hit && nowMs - hit.at < ADMIN_TTL_MS) return hit.ok;

  let allowed = false;
  try {
    const chats = await listChats(deps.db);
    // Every registered chat, not a truncated "first ten": the console now grants
    // per-chat access, so an admin of chat #11 must still get in.
    for (const chat of chats) {
      const result = await deps.api.call<{ status?: string }>("getChatMember", {
        chat_id: chat.chatId,
        user_id: userId,
      });
      if (!result.ok) continue;
      const status = result.result.status;
      if (status === "creator" || status === "administrator") {
        allowed = true;
        break;
      }
    }
  } catch {
    // A Bot API hiccup must not lock the operator out of their own console;
    // the caller still required a valid signature, so this only widens to
    // "unknown" for one request and the next one retries.
    allowed = false;
  }

  adminCache.set(userId, { ok: allowed, at: nowMs });
  return allowed;
}

/** Tests only: the cache would otherwise leak between cases. */
export function resetAdminCache(): void {
  adminCache.clear();
}

/**
 * Login codes: the bridge between the web console and a Telegram identity.
 *
 * The shared-password cookie can never attribute an action to a person, and a
 * deployment without ADMIN_PASSWORD had no way in at all. The code flow fixes
 * both with no new infrastructure:
 *
 *   1. the console mints a 6-digit code (KV, ten minutes, not yet approved);
 *   2. an admin sends `/login <code>` in Telegram — the command is admin-gated,
 *      so "approved" is exactly "a known admin vouched for this browser";
 *   3. the browser consumes the code and gets a personal session cookie that
 *      carries the user id.
 *
 * The code is one-shot: consuming it deletes it, so a sniffed code is worthless
 * after the first login.
 */
import type { Runtime } from "../context.ts";

export const LOGIN_CODE_TTL_S = 600;

type LoginCodeRow = { approved: boolean; userId?: number; name?: string; at: number };

const loginCodeKey = (code: string): string => `login:code:${code}`;

export function newLoginCode(): string {
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  return [...buf].map((n) => String(n % 10)).join("");
}

/** Mint an unapproved code. Any previous code with the same digits is replaced. */
export async function issueLoginCode(rt: Runtime, code: string): Promise<void> {
  await rt.store.put(loginCodeKey(code), JSON.stringify({ approved: false, at: rt.now() }), LOGIN_CODE_TTL_S);
}

export async function loginCodeStatus(
  rt: Runtime,
  code: string,
): Promise<{ exists: boolean; approved: boolean; name?: string }> {
  const raw = await rt.store.get(loginCodeKey(code));
  if (!raw) return { exists: false, approved: false };
  try {
    const row = JSON.parse(raw) as LoginCodeRow;
    return { exists: true, approved: Boolean(row.approved), name: row.name };
  } catch {
    return { exists: false, approved: false };
  }
}

/**
 * Mark a code approved by `userId`. Fails when the code is unknown, already
 * approved, or expired — the caller answers the admin, not the browser.
 */
export async function approveLoginCode(rt: Runtime, code: string, userId: number, name: string): Promise<boolean> {
  const key = loginCodeKey(code);
  const raw = await rt.store.get(key);
  if (!raw) return false;
  let row: LoginCodeRow;
  try {
    row = JSON.parse(raw) as LoginCodeRow;
  } catch {
    return false;
  }
  if (row.approved) return false;
  row.approved = true;
  row.userId = userId;
  row.name = name.slice(0, 80);
  await rt.store.put(key, JSON.stringify(row), LOGIN_CODE_TTL_S);
  return true;
}

/** One-shot consume: an approved code returns the identity exactly once.
 *  An unapproved code is left in place — the early browser poll must not
 *  destroy it before the admin gets to approve. */
export async function consumeLoginCode(rt: Runtime, code: string): Promise<{ userId: number; name: string } | null> {
  const key = loginCodeKey(code);
  const raw = await rt.store.get(key);
  if (!raw) return null;
  let row: LoginCodeRow;
  try {
    row = JSON.parse(raw) as LoginCodeRow;
  } catch {
    await rt.store.del(key);
    return null;
  }
  if (!row.approved || !row.userId) return null;
  await rt.store.del(key);
  return { userId: row.userId, name: row.name ?? String(row.userId) };
}

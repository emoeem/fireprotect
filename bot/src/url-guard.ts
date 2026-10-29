/**
 * The one gate every externally-influenced URL must pass before it reaches a
 * subprocess argv or a server-side fetch.
 *
 * Three distinct risks live behind one check:
 *  - a string starting with `-` is parsed as a CLI flag, and yt-dlp has an
 *    `--exec` option — argv injection, not just a bad request;
 *  - a loopback / private / link-local host turns an innocent fetch into a
 *    probe of the machine or network the caller sits on (SSRF);
 *  - a non-http(s) scheme was never a supported target in the first place.
 *
 * Bare `host/path` inputs are promoted to `https://`, because chat text and
 * page metadata routinely carry URLs without a scheme.
 */

export function publicHttpUrl(input: string): string | null {
  if (typeof input !== "string" || input.startsWith("-")) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((value) => value > 255)) return null;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return null; // this-host, private, loopback, multicast/reserved
    if (a === 172 && b >= 16 && b <= 31) return null;
    if (a === 192 && b === 168) return null;
    if (a === 169 && b === 254) return null; // link-local, incl. cloud metadata endpoints
    if (a === 100 && b >= 64 && b <= 127) return null; // carrier-grade NAT
    return candidate;
  }

  if (host.includes(":")) {
    // IPv6 literal: only a global unicast address may pass.
    if (host === "::" || host === "::1" || host.startsWith("::ffff:")) return null;
    if (/^f[cd]/.test(host)) return null; // fc00::/7 unique local
    if (/^fe[89ab]/.test(host)) return null; // fe80::/10 link-local
    return candidate;
  }

  return candidate;
}

/**
 * 受控重定向的出站 fetch：每一跳都重新过 publicHttpUrl——redirect: "follow"
 * 会静默跟随 302，公网 URL 一跳到 127.0.0.1 / 169.254.169.254（云元数据），
 * 首跳守卫就被绕过了。手动跟跳 + 逐跳复检（上限 5 跳）封住这条 SSRF 面。
 */
/** Node 侧依赖注入的 fetch 只收字符串 URL（与全局 fetch 的宽签名兼容）。 */
export type UrlFetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function guardedFetch(
  url: string,
  init: Omit<RequestInit, "redirect"> & { fetchImpl?: UrlFetch },
): Promise<Response> {
  const doFetch = init.fetchImpl ?? fetch;
  const { fetchImpl: _ignored, ...rest } = init;
  let current = publicHttpUrl(url);
  if (!current) throw new Error(`不接受的地址：${url}`);
  for (let hops = 0; hops <= 5; hops += 1) {
    const response = await doFetch(current, { ...rest, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    let next: string | null = null;
    try {
      next = publicHttpUrl(new URL(location, current).toString());
    } catch {
      next = null;
    }
    if (!next) throw new Error(`重定向目标被拒：${location.slice(0, 120)}`);
    current = next;
  }
  throw new Error("重定向次数过多");
}

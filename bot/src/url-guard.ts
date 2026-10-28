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

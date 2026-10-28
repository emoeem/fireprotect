import { createContext, type Ctx } from "./context.ts";
import { installPage, installResultPage, performInstall, statusPage } from "./install.ts";
import { handleUpdate } from "./router.ts";
import { kvStore } from "./store.ts";
import { safeEqual, type Telegram } from "./telegram.ts";
import type { Env, Store } from "./types.ts";

/** Only the bit of `ExecutionContext` we use. */
export type WorkerExec = { waitUntil: (promise: Promise<unknown>) => void };

const MAX_BODY = 1_000_000;

export type WorkerOverrides = { tg?: Telegram; store?: Store };

/**
 * Cloudflare Worker entry point.
 *
 * The webhook POST is authenticated unconditionally against
 * `WEBHOOK_SECRET || BOT_TOKEN`. The previous template skipped the check when
 * the secret was empty — which was the default — turning every fresh
 * deployment into an unauthenticated remote control for the bot.
 *
 * Built through a factory so tests can inject a fake Bot API without a real
 * network call; `export default` below is the production instance.
 */
export function makeWorker(overrides: WorkerOverrides = {}) {
  const ctxFor = (env: Env): Ctx =>
    createContext(env, {
      store: overrides.store ?? (env.STORE ? kvStore(env.STORE) : undefined),
      tg: overrides.tg,
    });

  return {
    async fetch(request: Request, env: Env, exec: WorkerExec): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (request.method === "GET" || request.method === "HEAD") {
        if (path === "/install") return new Response(installPage(env), { headers: htmlHeaders() });
        if (path === "/") return new Response(statusPage(env), { headers: htmlHeaders() });
        return new Response("not found", { status: 404 });
      }

      if (request.method === "POST" && path === "/install") {
        // Read the body once: a failed `formData()` has already consumed it, so
        // `request.clone().json()` afterwards would throw "body used" — the JSON
        // fallback was dead code until this was a single `text()` read.
        let key = "";
        try {
          const raw = await request.text();
          key = new URLSearchParams(raw).get("key") ?? "";
          if (!key) {
            try {
              key = String((JSON.parse(raw) as { key?: string }).key ?? "");
            } catch {
              key = "";
            }
          }
        } catch {
          key = "";
        }
        const result = await performInstall(ctxFor(env), key, url.origin);
        return new Response(installResultPage(result.ok, result.detail), {
          status: result.ok ? 200 : 400,
          headers: htmlHeaders(),
        });
      }

      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (path !== "/") return new Response("not found", { status: 404 });

      const expected = env.WEBHOOK_SECRET || env.BOT_TOKEN || "";
      if (!expected) return new Response("not configured", { status: 503 });

      const got = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!safeEqual(got, expected)) return new Response("unauthorized", { status: 401 });

      const length = Number(request.headers.get("content-length") ?? "0");
      if (length > MAX_BODY) return new Response("too large", { status: 413 });

      let update: unknown;
      try {
        update = await request.json();
      } catch {
        return new Response("bad json", { status: 400 });
      }

      // Acknowledge immediately: Telegram retries on any non-2xx and on a slow
      // reply, which would replay the same moderation action several times.
      exec.waitUntil(
        handleUpdate(ctxFor(env), update as never).catch((err: unknown) => {
          console.log("update failed:", err instanceof Error ? err.message : String(err));
        }),
      );
      return Response.json({ ok: true });
    },
  };
}

export default makeWorker();

function htmlHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

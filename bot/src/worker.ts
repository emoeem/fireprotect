/**
 * Cloudflare Worker entry.
 *
 * Responds 200 immediately and finishes the update in `waitUntil`: Telegram
 * retries anything slower than its own patience, and a retried `/ban` is a
 * second ban. The per-update dedupe in `bot.ts` plus this early ack is what
 * makes redelivery harmless.
 *
 * `scheduled()` runs once a minute (see `wrangler.toml`) and is the only
 * reliable timer on the edge — it closes expired verification windows.
 */
import { handleUpdate } from "./bot.ts";
import { createRuntime, ensureSchema, type Runtime } from "./context.ts";
import { openD1 } from "./db/d1.ts";
import { handleInstall, healthBody, webhookSecret } from "./install.ts";
import { sweepExpired } from "./handlers/verify.ts";
import { safeEqual } from "./telegram.ts";
import type { Env, TgUpdate } from "./types.ts";

type ExecutionCtx = { waitUntil(promise: Promise<unknown>): void };

type Cache = { env: Env; runtime: Runtime };
let cached: Cache | null = null;

function runtimeFor(env: Env): Runtime {
  if (cached && cached.env === env) return cached.runtime;
  if (!env.DB) {
    throw new Error("D1 绑定 DB 缺失：在 wrangler.toml 里配置 d1_databases 并执行 wrangler d1 create");
  }
  const sqlite = openD1(env.DB);
  const runtime = createRuntime(env, { sqlite });
  cached = { env, runtime };
  return runtime;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionCtx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      const body = healthBody(env);
      try {
        const runtime = runtimeFor(env);
        await ensureSchema(runtime.sql);
      } catch (err) {
        return json({ ...body, ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
      }
      return json(body);
    }

    if (path === "/install") {
      const result = await handleInstall(request, env);
      return new Response(result.body, {
        status: result.status,
        headers: { "content-type": result.html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" },
      });
    }

    if (path === "/webhook") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const expected = await webhookSecret(env);
      const got = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!safeEqual(got, expected)) return new Response("forbidden", { status: 401 });

      let update: TgUpdate;
      try {
        update = (await request.json()) as TgUpdate;
      } catch {
        return new Response("bad request", { status: 400 });
      }
      try {
        const runtime = runtimeFor(env);
        ctx.waitUntil(handleUpdate(runtime, update));
      } catch (err) {
        // A configuration error must be visible in the response, otherwise the
        // operator sees a green webhook and a silent bot.
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
      }
      return new Response("ok");
    }

    if (path === "/") {
      return new Response("flareward bot: /install · /health · /webhook", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: unknown, env: Env, ctx: ExecutionCtx): Promise<void> {
    try {
      const runtime = runtimeFor(env);
      await ensureSchema(runtime.sql);
      ctx.waitUntil(
        sweepExpired(runtime)
          .then((result) => {
            if (result.expired) console.log(`sweep: expired ${result.expired}/${result.checked}`);
          })
          .catch((err) => console.log(`sweep failed: ${err instanceof Error ? err.message : String(err)}`)),
      );
    } catch (err) {
      console.log(`scheduled failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

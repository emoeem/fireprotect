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
import { handleApi } from "./admin/api.ts";
import { renderConsole } from "./admin/page.ts";
import { notifyOperators } from "./notify.ts";
import { runRetention, runScheduled } from "./scheduler.ts";
import { runSync } from "./sync.ts";
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

    if (path === "/admin" || path === "/admin/") {
      return new Response(renderConsole(), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (path.startsWith("/api/")) {
      try {
        const runtime = runtimeFor(env);
        await ensureSchema(runtime.sql);
        return await handleApi(request, env, runtime, url);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 503);
      }
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
      return new Response("flareward bot: /admin · /install · /health · /webhook", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: unknown, env: Env, ctx: ExecutionCtx): Promise<void> {
    let runtime: Runtime | undefined;
    try {
      const rt = runtimeFor(env);
      runtime = rt;
      await ensureSchema(rt.sql);
      ctx.waitUntil(
        runScheduled(rt)
          .then((result) => {
            if (result.sent || result.failed) console.log(`scheduled: sent=${result.sent} failed=${result.failed} disabled=${result.disabled}`);
          })
          .catch((err) => {
            console.log(`scheduler failed: ${err instanceof Error ? err.message : String(err)}`);
            void notifyOperators(rt, "cron-scheduled", `定时消息任务失败：${err instanceof Error ? err.message : String(err)}`);
          }),
      );
      ctx.waitUntil(
        (async () => {
          const swept = await sweepExpired(rt).catch((err) => {
            console.log(`sweep failed: ${err instanceof Error ? err.message : String(err)}`);
            void notifyOperators(rt, "cron-sweep", `验证过期清理失败：${err instanceof Error ? err.message : String(err)}`);
            return { checked: 0, expired: 0 };
          });
          if (swept.expired) console.log(`sweep: expired ${swept.expired}/${swept.checked}`);

          // Mirrors run on the same tick: the interval is enforced per row, so
          // a channel set to 10 minutes is checked once every ten minutes.
          const synced = await runSync(rt).catch((err) => {
            console.log(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
            void notifyOperators(rt, "cron-sync", `频道同步失败：${err instanceof Error ? err.message : String(err)}`);
            return { checked: 0, copied: 0, failed: 0, disabled: 0 };
          });
          if (synced.copied) console.log(`sync: copied ${synced.copied}`);

          await runRetention(rt).catch((err) => {
            console.log(`retention failed: ${err instanceof Error ? err.message : String(err)}`);
            void notifyOperators(rt, "cron-retention", `数据保留清理失败：${err instanceof Error ? err.message : String(err)}`);
          });
        })(),
      );
    } catch (err) {
      console.log(`scheduled failed: ${err instanceof Error ? err.message : String(err)}`);
      // `runtime` exists only if runtimeFor and the schema step succeeded;
      // without it there is no transport to send anything with.
      if (runtime) void notifyOperators(runtime, "cron", `cron 任务失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

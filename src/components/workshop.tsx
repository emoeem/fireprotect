import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Ban,
  Check,
  Copy,
  Download,
  KeyRound,
  Link,
  MessageSquare,
  Shield,
  TriangleAlert,
  Users,
} from "lucide-react";
import { adminIdList, installUrl, presets, type BotConfig } from "@/lib/bot-config";
import { generateWorker, ruleSummary } from "@/lib/generate-worker";
import { FLAGS } from "@/lib/flags";
import { sortIssues, validateConfig } from "@/lib/validate-config";
import { useBotStore } from "@/lib/store";
import { checkBotToken } from "@/lib/telegram.functions";

const inputClass =
  "w-full rounded-xl border border-line bg-ink px-3 py-3 text-base text-paper outline-none transition-colors placeholder:text-muted focus:border-ember";

const commandMeta: { key: keyof BotConfig["commands"]; name: string; detail: string }[] = [
  { key: "ban", name: "/ban", detail: "封禁。可加分钟数" },
  { key: "mute", name: "/mute", detail: "禁言一段时间" },
  { key: "kick", name: "/kick", detail: "踢出，还能再进" },
  { key: "unban", name: "/unban", detail: "解封并恢复发言" },
  { key: "warn", name: "/warn", detail: "删消息并禁言" },
  { key: "del", name: "/del", detail: "删除被回复的消息" },
  { key: "pin", name: "/pin", detail: "静音置顶" },
];

function sample(text: string): string {
  return text
    .replaceAll("{name}", "小林")
    .replaceAll("{chat}", "夜航群")
    .replaceAll("{username}", "@kobayashi");
}

function randomSecret(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function Workshop() {
  const config = useBotStore((state) => state.config);
  const patch = useBotStore((state) => state.patch);
  const patchCommands = useBotStore((state) => state.patchCommands);
  const apply = useBotStore((state) => state.applyPreset);
  const reset = useBotStore((state) => state.reset);
  const [ready, setReady] = useState(false);
  const [copied, setCopied] = useState("");
  const [token, setToken] = useState("");
  const [tokenState, setTokenState] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "ok"; username: string; name: string; id: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    // `ready` means "the stored config has landed": the code preview reads
    // better once it stops showing defaults that are about to be replaced.
    let alive = true;
    void Promise.resolve(useBotStore.persist.rehydrate()).finally(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const worker = useMemo(() => generateWorker(config), [config]);
  const rules = useMemo(() => ruleSummary(config), [config]);
  const ids = adminIdList(config.adminIds);
  const link = installUrl(config);
  const idPaste = ids.join(",");
  const report = useMemo(() => validateConfig(config), [config]);
  const shownIssues = useMemo(() => sortIssues(report.issues).slice(0, 8), [report]);

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied((current) => (current === id ? "" : current)), 1600);
    } catch {
      setCopied("");
    }
  }

  function download() {
    const blob = new Blob([worker], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "worker.js";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoking synchronously can cancel the download in some browsers; the
    // object URL is cheap, so give the fetch a tick to start.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function testToken() {
    setTokenState({ kind: "checking" });
    try {
      const result = await checkBotToken({ data: { token } });
      if (!result.ok) {
        setTokenState({ kind: "error", message: result.error });
        return;
      }
      setTokenState({
        kind: "ok",
        username: result.username,
        name: result.name,
        id: result.id,
      });
    } catch (error) {
      setTokenState({
        kind: "error",
        message: error instanceof Error ? error.message : "没测成。",
      });
    }
  }

  return (
    <div className="min-h-screen bg-ink text-paper">
      <div className="h-1 bg-ember" />
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-5xl flex-wrap items-end justify-between gap-4 px-4 py-5">
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-ember font-display text-xl text-ember-ink">
              焰
            </span>
            <div>
              <p className="text-sm tracking-widest text-muted">CLOUDFLARE · TELEGRAM</p>
              <h1 className="font-display text-3xl leading-none">焰卫</h1>
            </div>
          </div>
          <p className="max-w-sm text-sm text-muted">
            @fireprotcectbot 已经接在你的 Cloudflare 上。令牌只放在那里，不在这个页面里。
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        <section className="rounded-3xl border border-ember bg-panel p-5">
          <p className="text-sm tracking-widest text-ember">已经在线</p>
          <h2 className="mt-1 font-display text-2xl">@fireprotcectbot</h2>
          <p className="mt-2 text-sm text-muted">
            Worker 名叫 flareward，地址是 flareward.pd2335346.workers.dev。现在跑的是「门岗」：新人要点按钮，链接和关键词会被删掉。
          </p>
          <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
            <li className="rounded-xl border border-line bg-ink px-3 py-3">私聊机器人发 /id，把数字填进管理员。</li>
            <li className="rounded-xl border border-line bg-ink px-3 py-3">@BotFather 里 /setprivacy，对这个机器人选 Disable。</li>
            <li className="rounded-xl border border-line bg-ink px-3 py-3">拉进超级群，设成管理员，打开删除、封禁、置顶。</li>
          </ul>
        </section>

        <section className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="font-display text-2xl">先选一种脾气</h2>
            <p className="mt-1 text-sm text-muted">之后每一项都能改。配置记在这台浏览器里。</p>
          </div>
          <button type="button" onClick={reset} className="text-sm text-muted underline-offset-4 hover:text-paper hover:underline">
            恢复门岗
          </button>
        </section>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => apply(preset.id)}
              className="rounded-2xl border border-line bg-panel px-4 py-4 text-left transition-colors hover:border-ember"
            >
              <span className="block font-display text-xl">{preset.label}</span>
              <span className="mt-1 block text-sm text-muted">{preset.detail}</span>
            </button>
          ))}
        </div>

        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          <section className="rounded-3xl border border-line bg-panel p-5">
            <div className="flex items-center gap-2 text-ember">
              <Shield className="size-5" strokeWidth={1.75} />
              <h2 className="font-display text-2xl text-paper">进门</h2>
            </div>
            <div className="mt-4 divide-y divide-line">
              <Toggle
                on={config.captcha}
                label="新人必须点按钮"
                hint="没点之前不能发言。不点就一直不能说，管理员可以踢。"
                onToggle={() => patch({ captcha: !config.captcha })}
              />
              <Toggle
                on={config.welcomeOn}
                label="发送欢迎语"
                hint={config.captcha ? "验证通过后才发，避免广告号刷屏。" : "有人进群就发。"}
                onToggle={() => patch({ welcomeOn: !config.welcomeOn })}
              />
              <Toggle
                on={config.deleteJoin}
                label="藏起进群提示"
                hint="删掉系统那条「某某加入了群组」。"
                onToggle={() => patch({ deleteJoin: !config.deleteJoin })}
              />
            </div>
            {config.captcha ? (
              <div className="mt-5 grid gap-4">
                <Field label="验证时对他说" hint="可用 {name}、{username}、{chat}">
                  <textarea
                    className={inputClass + " min-h-24 resize-y"}
                    value={config.captchaPrompt}
                    onChange={(event) => patch({ captchaPrompt: event.target.value })}
                  />
                </Field>
                <Field label="按钮上的字">
                  <input
                    className={inputClass}
                    value={config.captchaButton}
                    maxLength={40}
                    onChange={(event) => patch({ captchaButton: event.target.value })}
                  />
                </Field>
              </div>
            ) : null}
            {config.welcomeOn ? (
              <div className="mt-4">
                <Field label="欢迎语" hint="可用 {name}、{username}、{chat}">
                  <textarea
                    className={inputClass + " min-h-24 resize-y"}
                    value={config.welcomeText}
                    onChange={(event) => patch({ welcomeText: event.target.value })}
                  />
                </Field>
              </div>
            ) : null}
            <div className="mt-5 rounded-2xl border border-line bg-ink p-4">
              <p className="flex items-center gap-2 text-sm text-muted">
                <MessageSquare className="size-4" />
                群里大致会看到
              </p>
              <p className="mt-3 whitespace-pre-wrap text-base">
                {sample(config.captcha ? config.captchaPrompt : config.welcomeOn ? config.welcomeText : "（不发消息）")}
              </p>
              {config.captcha ? (
                <span className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-ember px-4 text-sm font-medium text-ember-ink">
                  {config.captchaButton || "我是本人"}
                </span>
              ) : null}
            </div>
          </section>

          <section className="rounded-3xl border border-line bg-panel p-5">
            <div className="flex items-center gap-2 text-ember">
              <Ban className="size-5" strokeWidth={1.75} />
              <h2 className="font-display text-2xl text-paper">广告</h2>
            </div>
            <div className="mt-4 divide-y divide-line">
              <Toggle
                on={config.filterLinks}
                label="删除链接"
                hint="含 http、t.me、带链接的文字。"
                onToggle={() => patch({ filterLinks: !config.filterLinks })}
              />
              <Toggle
                on={config.filterForwards}
                label="删除转发"
                hint="从别处转进来的消息。闲聊群转发多的话就别开。"
                onToggle={() => patch({ filterForwards: !config.filterForwards })}
              />
              <Toggle
                on={config.filterChannels}
                label="删除频道身份的消息"
                hint="有人用频道往群里扔广告时有用。群公告若也用频道发，会被一起删。"
                onToggle={() => patch({ filterChannels: !config.filterChannels })}
              />
              <Toggle
                on={config.filterLong}
                label="删除超长消息"
                hint={"现在的上限是 " + config.maxLength + " 字。"}
                onToggle={() => patch({ filterLong: !config.filterLong })}
              />
            </div>
            {config.filterLong ? (
              <label className="mt-4 block text-sm">
                字数上限
                <input
                  className={inputClass + " mt-2"}
                  inputMode="numeric"
                  value={String(config.maxLength)}
                  onChange={(event) => patch({ maxLength: Number(event.target.value.replace(/\D/g, "") || 0) })}
                />
              </label>
            ) : null}
            <div className="mt-5">
              <Field label="关键词，一行一个" hint="写完整一点。「微」这种单字会误伤。">
                <textarea
                  className={inputClass + " min-h-36 resize-y font-mono"}
                  value={config.keywords}
                  onChange={(event) => patch({ keywords: event.target.value })}
                  spellCheck={false}
                />
              </Field>
            </div>
            <fieldset className="mt-5">
              <legend className="text-sm font-medium">碰到之后</legend>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {(
                  [
                    ["delete", "只删除"],
                    ["mute", "禁言"],
                    ["ban", "封禁"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => patch({ spamAction: id })}
                    className={
                      "min-h-11 rounded-xl border px-2 text-sm " +
                      (config.spamAction === id
                        ? "border-ember bg-ember text-ember-ink"
                        : "border-line bg-ink text-paper")
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </fieldset>
            {config.spamAction !== "delete" || config.commands.mute || config.commands.warn ? (
              <label className="mt-4 block text-sm">
                禁言分钟
                <input
                  className={inputClass + " mt-2"}
                  inputMode="numeric"
                  value={String(config.muteMinutes)}
                  onChange={(event) =>
                    patch({ muteMinutes: Number(event.target.value.replace(/\D/g, "") || 0) })
                  }
                />
              </label>
            ) : null}
          </section>
        </div>

        <section className="mt-4 rounded-3xl border border-line bg-panel p-5">
          <div className="flex items-center gap-2 text-ember">
            <Users className="size-5" strokeWidth={1.75} />
            <h2 className="font-display text-2xl text-paper">管理员指令</h2>
          </div>
          <p className="mt-2 text-sm text-muted">在群里回复某人的消息再发。普通成员发这些不会生效。</p>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {commandMeta.map((command) => {
              const on = config.commands[command.key];
              return (
                <li key={command.key}>
                  <button
                    type="button"
                    onClick={() => patchCommands({ [command.key]: !on })}
                    className={
                      "flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left " +
                      (on ? "border-ember bg-ink" : "border-line bg-ink text-muted")
                    }
                  >
                    <span>
                      <span className="block font-mono text-base text-paper">{command.name}</span>
                      <span className="block text-sm text-muted">{command.detail}</span>
                    </span>
                    <span className={"text-sm " + (on ? "text-ember" : "text-muted")}>{on ? "开" : "关"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="mt-4 rounded-3xl border border-line bg-panel p-5">
          <div className="flex items-center gap-2 text-ember">
            <KeyRound className="size-5" strokeWidth={1.75} />
            <h2 className="font-display text-2xl text-paper">部署到 Cloudflare</h2>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            线上那一份已经部署好了。这里再改欢迎语或关键词，不会自动生效，要重新复制 Worker，覆盖 Cloudflare 里同名的 flareward。
          </p>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <Field label="管理员数字 ID" hint="找 @userinfobot，或部署后私聊机器人发 /id。多个用逗号。这不是机器人自己的 ID。">
              <input
                className={inputClass}
                inputMode="numeric"
                placeholder="123456789, 987654321"
                value={config.adminIds}
                onChange={(event) => patch({ adminIds: event.target.value })}
              />
            </Field>
            <Field label="Webhook 密钥" hint="自己留一份。等下在 Cloudflare 的 WEBHOOK_SECRET 里填同一串。">
              <div className="flex gap-2">
                <input
                  className={inputClass + " font-mono"}
                  value={config.webhookSecret}
                  onChange={(event) => patch({ webhookSecret: event.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => patch({ webhookSecret: randomSecret() })}
                  className="shrink-0 rounded-xl border border-line px-3 text-sm hover:border-ember"
                >
                  生成
                </button>
              </div>
            </Field>
            <Field label="Worker 地址" hint="部署后形如 flareward.你的名字.workers.dev，先空着也行。">
              <input
                className={inputClass}
                placeholder="flareward.xxx.workers.dev"
                value={config.workerHost}
                onChange={(event) => patch({ workerHost: event.target.value })}
                spellCheck={false}
              />
            </Field>
            <Field label="可选：先确认令牌没抄错" hint="只问 Telegram 这是谁，不会写进代码，也不会记住。">
              <div className="flex gap-2">
                <input
                  className={inputClass + " font-mono"}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="123456:AA..."
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => void testToken()}
                  disabled={tokenState.kind === "checking" || token.trim().length < 20}
                  className="shrink-0 rounded-xl bg-paper px-3 text-sm font-medium text-ink disabled:opacity-50"
                >
                  {tokenState.kind === "checking" ? "在问…" : "测试"}
                </button>
              </div>
            </Field>
          </div>

          {config.adminIds.trim() && ids.length === 0 ? (
            <p className="mt-3 flex items-start gap-2 text-sm text-ember">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              这些看起来不是数字 ID。
            </p>
          ) : null}
          {tokenState.kind === "ok" ? (
            <p className="mt-3 text-sm text-muted">
              令牌有效，机器人是 @{tokenState.username || tokenState.name}。它自己的 ID 是{" "}
              <span className="font-mono text-paper">{tokenState.id}</span>
              ，别填进管理员。管理员要填你本人的 ID。
            </p>
          ) : null}
          {tokenState.kind === "error" ? (
            <p className="mt-3 text-sm text-ember">{tokenState.message}</p>
          ) : null}

          {FLAGS.configDoctor && report.issues.length > 0 ? (
            <div className="mt-5 rounded-2xl border border-line bg-ink p-4">
              <p className="flex items-start gap-2 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-ember" />
                <span>
                  部署前检查：
                  {[
                    report.counts.error > 0 ? `${report.counts.error} 项必须改` : "",
                    report.counts.warn > 0 ? `${report.counts.warn} 项建议改` : "",
                    report.counts.info > 0 ? `${report.counts.info} 项提示` : "",
                  ]
                    .filter(Boolean)
                    .join("，")}
                  。改完这里会跟着消失。
                </span>
              </p>
              <ul className="mt-3 grid gap-2 text-sm">
                {shownIssues.map((item) => (
                  <li key={item.code + item.message} className="flex gap-2">
                    <span
                      className={
                        "mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-xs " +
                        (item.severity === "error"
                          ? "bg-ember text-ember-ink"
                          : item.severity === "warn"
                            ? "border border-ember text-ember"
                            : "border border-line text-muted")
                      }
                    >
                      {item.severity === "error" ? "必须改" : item.severity === "warn" ? "建议" : "提示"}
                    </span>
                    <span className="text-muted">{item.message}</span>
                  </li>
                ))}
              </ul>
              {report.issues.length > shownIssues.length ? (
                <p className="mt-2 text-sm text-muted">还有 {report.issues.length - shownIssues.length} 条，改完上面这些再看。</p>
              ) : null}
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-2">
            <CopyButton
              id="ids"
              copied={copied}
              disabled={!idPaste}
              onCopy={() => void copy("ids", idPaste)}
              label="复制 ADMIN_IDS"
            />
            <CopyButton
              id="secret"
              copied={copied}
              disabled={!config.webhookSecret.trim()}
              onCopy={() => void copy("secret", config.webhookSecret.trim())}
              label="复制密钥"
            />
            <CopyButton
              id="link"
              copied={copied}
              disabled={!link}
              onCopy={() => void copy("link", link)}
              label="复制安装链接"
            />
          </div>
          {link ? (
            <p className="mt-3 flex items-start gap-2 break-all font-mono text-sm text-muted">
              <Link className="mt-0.5 size-4 shrink-0" />
              {link}
            </p>
          ) : null}

          <ol className="mt-6 list-decimal space-y-3 pl-5 text-sm leading-relaxed text-paper">
            <li>Telegram 打开 @BotFather，发送 /newbot，起名，用户名要以 bot 结尾。复制它发你的令牌。</li>
            <li>再发送 /setprivacy，选中这个机器人，点 Disable。否则它在群里是睁眼瞎。</li>
            <li>打开 Cloudflare 控制台，Workers 和 Pages，创建应用，选从 Hello World 开始。名字随意。</li>
            <li>用下面的代码整段替换编辑器里的内容，部署。</li>
            <li>
              进入这个 Worker 的设置 → 变量和机密。BOT_TOKEN 和 WEBHOOK_SECRET 选「机密」。ADMIN_IDS 填{" "}
              {idPaste || "你的数字 ID"}。
            </li>
            <li>
              浏览器打开{link ? "上面的安装链接" : " https://你的地址.workers.dev/install"}
              。看到「已经接上 Telegram」就成了。
            </li>
            <li>把机器人拉进群。如果群还是老式普通群，先在群设置里升级成超级群。把机器人设为管理员，勾选删除消息、封禁用户、置顶消息。用另一个号进群试一次验证。</li>
          </ol>
        </section>

        <section className="mt-4 rounded-3xl border border-line bg-panel-2 p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-display text-2xl">这份机器人会做的事</h2>
              <p className="mt-1 text-sm text-muted">{ready ? "上面改一项，这里的代码跟着变。" : "正在读这台浏览器里上次的配置。"}</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void copy("worker", worker)}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-ember px-4 text-sm font-medium text-ember-ink"
              >
                {copied === "worker" ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied === "worker" ? "已复制" : "复制 Worker"}
              </button>
              <button
                type="button"
                onClick={download}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line px-4 text-sm"
              >
                <Download className="size-4" />
                下载
              </button>
            </div>
          </div>
          <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            {rules.map((rule) => (
              <li key={rule} className="rounded-xl border border-line bg-ink px-3 py-3">
                {rule}
              </li>
            ))}
          </ul>
          <pre className="mt-4 max-h-96 overflow-auto rounded-2xl border border-line bg-ink p-4 font-mono text-sm leading-relaxed text-muted">
            {worker}
          </pre>
        </section>
      </main>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium">{label}</span>
      {hint ? <span className="mt-1 block text-sm text-muted">{hint}</span> : null}
      <div className="mt-2">{children}</div>
    </label>
  );
}

function Toggle({
  on,
  label,
  hint,
  onToggle,
}: {
  on: boolean;
  label: string;
  hint: string;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-4">
      <span>
        <span className="block text-base font-medium">{label}</span>
        <span className="mt-1 block text-sm text-muted">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onToggle}
        className={"relative mt-1 h-7 w-12 shrink-0 rounded-full transition-colors " + (on ? "bg-ember" : "bg-line")}
      >
        <span
          className={
            "absolute top-0.5 left-0.5 size-6 rounded-full bg-paper transition-transform " +
            (on ? "translate-x-5" : "translate-x-0")
          }
        />
      </button>
    </div>
  );
}

function CopyButton({
  id,
  copied,
  disabled,
  onCopy,
  label,
}: {
  id: string;
  copied: string;
  disabled?: boolean;
  onCopy: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onCopy}
      disabled={disabled}
      className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line px-3 text-sm disabled:opacity-40"
    >
      {copied === id ? <Check className="size-4 text-ember" /> : <Copy className="size-4" />}
      {copied === id ? "已复制" : label}
    </button>
  );
}

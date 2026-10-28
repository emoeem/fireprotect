/**
 * Acceptance matrix: every command × five input classes.
 *
 * Table-driven from `COMMAND_SPEC`, so a command that exists in the switch but
 * not in the table fails the drift guard at the bottom instead of quietly never
 * being tested. The five classes are the ones that actually break in production:
 * normal use, a stranger reaching for it, nonsense arguments, extreme values,
 * and the same update delivered twice.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { COMMAND_SPEC, type CommandSpec } from "../src/handlers/commands.ts";
import { handleUpdate } from "../src/bot.ts";
import { command, makeRuntime, message, nextUpdate, user } from "./harness.ts";
import type { TgMessage } from "../src/types.ts";

const ADMIN = 9001;
const STRANGER = 500;
const VICTIM = 8888;

/** Calls that change state; a stranger must never cause one. */
const MUTATING = new Set([
  "banChatMember",
  "restrictChatMember",
  "deleteMessage",
  "deleteMessages",
  "setChatPermissions",
  "pinChatMessage",
  "unpinChatMessage",
  "sendDocument",
  "approveChatJoinRequest",
  "copyMessage",
]);

type Run = {
  calls: { method: string; body: Record<string, any> }[];
  texts: string[];
  methods: string[];
};

async function run(
  spec: CommandSpec,
  text: string,
  options: { admin?: boolean; updateId?: number; twice?: boolean; reply?: boolean } = {},
): Promise<Run> {
  const h = await makeRuntime({ env: { ADMIN_IDS: String(ADMIN) } });
  const from = user(options.admin ? ADMIN : STRANGER, options.admin ? "群主" : "路人");
  const patch: Partial<TgMessage> = { from };
  // `reply` defaults to what the command needs; the invalid class passes false on
  // purpose, because "no target" is the failure people actually hit.
  const withReply = options.reply ?? spec.needsReply === true;
  if (withReply) patch.reply_to_message = message({ from: user(VICTIM, "广告号"), text: "买粉吗" });

  const update = { update_id: options.updateId ?? nextUpdate(), message: command(text, patch) };
  await handleUpdate(h.rt, update);
  if (options.twice) await handleUpdate(h.rt, update);

  return {
    calls: h.fake.calls,
    texts: h.fake.all("sendMessage").map((call) => String(call.body.text ?? "")),
    methods: h.fake.methods(),
  };
}

for (const spec of COMMAND_SPEC) {
  // 1 ─ normal input
  test(`${spec.name}: runs on normal input`, async () => {
    const result = await run(spec, spec.sample, { admin: true });
    assert.ok(result.calls.length > 0, "a command that does nothing is indistinguishable from a broken one");
    assert.ok(
      result.texts.length > 0 || result.methods.length > 0,
      "either it answers or it acts",
    );
  });

  // 2 ─ insufficient permission
  test(`${spec.name}: a stranger cannot make it change anything`, async () => {
    const result = await run(spec, spec.sample, { admin: false });
    const mutated = result.methods.filter((method) => MUTATING.has(method));
    assert.deepEqual(mutated, [], `stranger reached ${mutated.join(",")}`);
    if (!spec.public) {
      const answered = result.texts.some((text) => /没有这个权限|匿名管理员/.test(text));
      // Read-only commands stay silent on purpose (no oracle for strangers).
      assert.ok(answered || spec.readOnly, "an admin command must say why it refused");
    }
  });

  // 3 ─ invalid arguments
  test(`${spec.name}: invalid arguments are explained, not crashed on`, async () => {
    const result = await run(spec, spec.invalid, { admin: true, reply: false });
    const said = result.texts.join("\n");
    assert.match(said, spec.invalidExpect, `unexpected answer: ${said.slice(0, 200)}`);
    assert.deepEqual(
      result.methods.filter((method) => method === "banChatMember"),
      [],
      "garbage input must not ban anybody",
    );
  });

  // 4 ─ boundary values
  test(`${spec.name}: boundary values are clamped, not passed through`, async () => {
    const result = await run(spec, spec.boundary, { admin: true, reply: spec.needsReply === true });
    assert.ok(result.calls.length > 0);

    if (spec.name === "ban" || spec.name === "mute") {
      const call = result.calls.filter((item) => item.method === "restrictChatMember" || item.method === "banChatMember").at(-1);
      const until = Number(call?.body.until_date ?? 0);
      assert.ok(until > 0);
      const seconds = until - Math.floor(Date.now() / 1000);
      assert.ok(seconds <= 525_600 * 60 + 5, `until_date overflowed: ${seconds}s`);
    }
    if (spec.name === "purge") {
      const ids = result.calls.filter((item) => item.method === "deleteMessages").at(-1)?.body.message_ids as number[] | undefined;
      assert.ok(!ids || ids.length <= 100, "purge must stay inside Telegram's 100-per-call limit");
    }
    if (spec.name === "stats") {
      assert.match(result.texts.join("\n"), /最近 90 天/, "days are clamped to 90");
    }
    if (spec.name === "set") {
      assert.match(result.texts.join("\n"), /没成功/, "an out-of-range value is rejected, not stored");
    }
  });

  // 5 ─ the same update twice
  test(`${spec.name}: a redelivered update is applied once`, async () => {
    const updateId = nextUpdate();
    const once = await run(spec, spec.sample, { admin: true, updateId });
    const twice = await run(spec, spec.sample, { admin: true, updateId, twice: true });
    assert.equal(twice.calls.length, once.calls.length, "the second delivery must be dropped by update_id");
  });
}

test("COMMAND_SPEC and the dispatcher cannot drift apart", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "handlers", "commands.ts"), "utf8");
  // Three dispatch forms: the switch, the early `name === "x"` checks (public
  // commands and /panel, which run before the permission gate), and the tool
  // router, which is a separate function.
  const cases = new Set([
    ...[...source.matchAll(/case "([a-z]+)":/g)].map((match) => match[1] as string),
    ...[...source.matchAll(/name === "([a-z]+)"/g)].map((match) => match[1] as string),
  ]);
  for (const tool of ["splitpdf", "slice"]) cases.add(tool);

  const spec = new Set(COMMAND_SPEC.map((entry) => entry.name));
  const missingFromSpec = [...cases].filter((name) => !spec.has(name));
  const missingFromSwitch = [...spec].filter((name) => !cases.has(name));
  assert.deepEqual(missingFromSpec, [], "dispatched but not in COMMAND_SPEC (so never tested)");
  assert.deepEqual(missingFromSwitch, [], "in COMMAND_SPEC but not dispatched (dead entry)");
});

test("every spec documents what a rejected call looks like", () => {
  for (const spec of COMMAND_SPEC) {
    assert.ok(spec.sample.startsWith("/"), `${spec.name}: sample must be a command`);
    assert.ok(spec.invalid.startsWith("/"), `${spec.name}: invalid must be a command`);
    assert.ok(spec.boundary.startsWith("/"), `${spec.name}: boundary must be a command`);
    assert.notEqual(spec.invalid, spec.sample, `${spec.name}: invalid must differ from sample`);
  }
});

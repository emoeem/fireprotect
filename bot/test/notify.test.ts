import assert from "node:assert/strict";
import { test } from "node:test";
import { notifyOperators } from "../src/notify.ts";
import { makeRuntime } from "./harness.ts";

test("notifyOperators reaches every configured admin once per reason per day", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: "9001, 9002" } });

  await notifyOperators(h.rt, "cron-sweep", "清理失败");
  const sent = h.fake.all("sendMessage");
  assert.deepEqual(sent.map((call) => call.body.chat_id).sort(), [9001, 9002]);
  assert.match(String(sent[0]?.body.text ?? ""), /焰卫告警：清理失败/);

  await notifyOperators(h.rt, "cron-sweep", "清理失败");
  assert.equal(h.fake.count("sendMessage"), 2, "the same reason stays quiet for a day");

  await notifyOperators(h.rt, "update-failed", "另一个原因");
  assert.equal(h.fake.count("sendMessage"), 4, "a different reason goes out immediately");
});

test("with no admins configured it sends nothing", async () => {
  // The harness's default env carries a demo ADMIN_IDS; clear it explicitly.
  const h = await makeRuntime({ env: { ADMIN_IDS: "" } });
  await notifyOperators(h.rt, "cron", "boom");
  assert.equal(h.fake.count("sendMessage"), 0);
});

test("a failing Telegram call is swallowed, not propagated", async () => {
  const h = await makeRuntime({ env: { ADMIN_IDS: "9001" } });
  h.fake.fail("sendMessage", "throw");
  await assert.doesNotReject(() => notifyOperators(h.rt, "cron", "boom"));
});

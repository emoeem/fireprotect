import assert from "node:assert/strict";
import test from "node:test";
import { memoryStore } from "../src/store.ts";

test("memory store round-trips a value", async () => {
  const store = memoryStore();
  await store.put("a", "1");
  assert.equal(await store.get("a"), "1");
  await store.del("a");
  assert.equal(await store.get("a"), null);
});

test("memory store honours a ttl", async () => {
  const store = memoryStore();
  await store.put("temp", "x", 0.01);
  assert.equal(await store.get("temp"), "x");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await store.get("temp"), null);
});

test("keys() only returns live entries under the prefix", async () => {
  const store = memoryStore();
  await store.put("rules:-1", "a");
  await store.put("rules:-2", "b");
  await store.put("captcha:-1:5", "c", 0.01);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual((await store.keys("rules:")).sort(), ["rules:-1", "rules:-2"]);
  assert.deepEqual(await store.keys("captcha:"), []);
});

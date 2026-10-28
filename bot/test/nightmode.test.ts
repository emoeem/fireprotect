import assert from "node:assert/strict";
import { test } from "node:test";
import { inNightWindow, minutesOfDay } from "../src/nightmode.ts";

// 2026-10-28T15:30:00Z is 23:30 in UTC+8.
const at = (iso: string) => Date.parse(iso);

test("a wrapping window is detected on both sides of midnight", () => {
  assert.equal(inNightWindow(at("2026-10-28T15:30:00Z"), "23:00", "07:00", 480), true); // 23:30 local
  assert.equal(inNightWindow(at("2026-10-28T20:00:00Z"), "23:00", "07:00", 480), true); // 04:00 local
  assert.equal(inNightWindow(at("2026-10-28T04:00:00Z"), "23:00", "07:00", 480), false); // 12:00 local
});

test("a plain window works too", () => {
  assert.equal(inNightWindow(at("2026-10-28T15:30:00Z"), "08:00", "18:00", 480), false); // 23:30 local
  assert.equal(inNightWindow(at("2026-10-28T02:00:00Z"), "08:00", "18:00", 480), true); // 10:00 local
});

test("start equal to end is treated as off, not all day", () => {
  assert.equal(inNightWindow(at("2026-10-28T15:30:00Z"), "23:00", "23:00", 480), false);
});

test("the timezone offset actually shifts the boundary", () => {
  const oneAmUtc = at("2026-10-28T01:00:00Z");
  assert.equal(inNightWindow(oneAmUtc, "23:00", "07:00", 0), true); // 01:00 UTC
  assert.equal(inNightWindow(oneAmUtc, "23:00", "07:00", 480), false); // 09:00 local
});

test("minutesOfDay parses and wraps", () => {
  assert.equal(minutesOfDay("00:00"), 0);
  assert.equal(minutesOfDay("23:59"), 1439);
  assert.equal(minutesOfDay("25:00"), 60);
});

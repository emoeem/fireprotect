/**
 * Coverage gate.
 *
 * Node can enforce one global line threshold; the acceptance protocol wants a
 * second, per-module one ("new modules ≥ 90"). So this runs the suite once,
 * lets Node enforce the global number, then reads the printed table and fails
 * the whole command if any listed module is under its own bar.
 *
 *   node scripts/coverage-gate.mjs
 */
import { spawnSync } from "node:child_process";

/** Module → minimum line coverage. Everything the recent rounds introduced. */
const NEW_MODULES = {
  "block.ts": 90,
  "sync.ts": 90,
  "preset.ts": 90,
  "store-preset.ts": 90,
  "panel.ts": 90,
  "scheduler.ts": 85,
  "pdf.ts": 90,
  "index.ts": 90,
  "expand.ts": 90,
  "timestamp.ts": 90,
  "rules.ts": 90,
  "captcha.ts": 90,
  "filters.ts": 90,
  // R6–R8
  "keywords.ts": 90,
  "vision.ts": 90,
  "pipeline.ts": 90,
  "words.ts": 90,
  "sites.ts": 90,
  "preview.ts": 90,
  "service.ts": 90,
  // R9: Mini App identity
  "tginit.ts": 90,
  // R10: console field table + the page it fills
  "fields.ts": 95,
  "page.ts": 95,
};

// Node-only modules whose interesting paths are a spawned binary or a native
// library: `sliceLongImage` is covered indirectly, `yt-dlp` cannot be.
const EXCLUDE = ["src/node.ts", "src/tools/slice.node.ts", "src/db/node-sqlite.ts", "src/parse/ytdlp.node.ts"];

const args = [
  "--experimental-strip-types",
  "--test",
  "--experimental-test-coverage",
  "--test-coverage-include=src/**",
  ...EXCLUDE.map((file) => `--test-coverage-exclude=${file}`),
  "--test-coverage-lines=85",
  ...process.argv.slice(2).length ? process.argv.slice(2) : ["test/*.test.ts"],
];

const run = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
process.stdout.write(output);

if (run.status !== 0) {
  console.error(`\n✖ 测试或总行覆盖率未达标（exit ${run.status}）`);
  process.exit(1);
}

// The table is prefixed with "ℹ" and grouped by directory, so match the row
// shape rather than a line anchor: "  block.ts  | 100.00 | 100.00 | 83.33 |"
const row = /([\w-]+\.ts)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/g;
const seen = new Map();
for (const match of output.matchAll(row)) seen.set(match[1], Number(match[2]));

const failures = [];
for (const [module, minimum] of Object.entries(NEW_MODULES)) {
  const value = seen.get(module);
  if (value === undefined) failures.push(`${module}: 没有出现在报告里（是否被排除？）`);
  else if (value < minimum) failures.push(`${module}: ${value}% < ${minimum}%`);
}

if (failures.length) {
  console.error(`\n✖ 模块级覆盖率未达标：\n  ${failures.join("\n  ")}`);
  process.exit(1);
}

console.log(`\n✔ 覆盖率门禁通过（总行 ≥85%，${Object.keys(NEW_MODULES).length} 个模块各自达标）`);

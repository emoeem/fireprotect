/**
 * Workers compatibility guard.
 *
 * The Worker bundle is built from `src/worker.ts`. Anything reachable from that
 * file is shipped to Cloudflare, where `node:` builtins and native modules do
 * not exist — a single stray import is not a warning, it is a deploy that fails
 * after the code is already uploaded, or worse, one that ships and throws on
 * the first request that touches the module.
 *
 * The codebase keeps those dependencies behind an explicit boundary: files named
 * `*.node.ts` (plus the sqlite driver) are the only places allowed to use them,
 * and only the Node entry (`src/node.ts`) may import those. This test walks the
 * real import graph instead of trusting that convention, because "I only
 * imported it in the node entry" is exactly the claim that rots.
 *
 * Added in R9 alongside `rss-parser`: that package is pure JS but assumes Node
 * globals, and it must stay behind the boundary just like `sharp` and `yt-dlp`.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const SRC = join(import.meta.dirname, "..", "src");
const WORKER_ENTRY = join(SRC, "worker.ts");
const NODE_ENTRY = join(SRC, "node.ts");

/** Packages and prefixes that only exist under Node. */
const NODE_ONLY = ["node:", "sharp", "rss-parser", "tesseract.js", "ffmpeg-static", "better-sqlite3"];

/**
 * Files allowed to import node-only modules. Every entry is checked for
 * existence below, so deleting a file cannot silently widen the boundary.
 */
const ALLOWED_NODE_FILES = ["src/node.ts", "src/db/node-sqlite.ts", "src/parse/ytdlp.node.ts", "src/tools/slice.node.ts"];

/**
 * The boundary rule, as opposed to the list above: a `*.node.ts` file is by
 * definition the adapter for one node-only capability, so new adapters do not
 * have to be registered here. Anything else must be named explicitly, which
 * makes an accidental import in a portable module a loud failure.
 */
const inBoundary = (rel: string) =>
  ALLOWED_NODE_FILES.includes(rel) || rel.endsWith(".node.ts");

function allSources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return allSources(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Every static import/export-from specifier in a file, with line numbers. */
function specifiers(file: string): { spec: string; line: number }[] {
  const text = readFileSync(file, "utf8");
  const out: { spec: string; line: number }[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const spec = match[1] ?? match[2];
    if (!spec) continue;
    const line = text.slice(0, match.index).split("\n").length;
    out.push({ spec, line });
  }
  return out;
}

const relative = (file: string) => file.slice(SRC.length + 1);
const isNodeOnly = (spec: string) =>
  spec.startsWith("node:") || NODE_ONLY.some((p) => p !== "node:" && (spec === p || spec.startsWith(`${p}/`)));

test("the allowlist does not point at files that no longer exist", () => {
  const present = new Set(allSources().map(relative));
  for (const entry of ALLOWED_NODE_FILES) {
    const rel = entry.replace(/^src\//, "");
    assert.ok(present.has(rel), `${entry} is in the allowlist but does not exist — remove it instead of leaving a hole`);
  }
});

test("no source file outside the boundary imports a node-only module", () => {
  const offenders: string[] = [];
  for (const file of allSources()) {
    const rel = `src/${relative(file)}`;
    if (inBoundary(rel)) continue;
    for (const { spec, line } of specifiers(file)) {
      if (!isNodeOnly(spec)) continue;
      offenders.push(`${rel}:${line} imports ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], "these files would break the Worker build");
});

test("the Worker entry cannot reach a node-only file", () => {
  const all = allSources();
  const known = new Set(all);

  /** Resolve a relative specifier the way Node does for this project (`.ts`, `index.ts`). */
  function resolve(from: string, spec: string): string | null {
    const base = join(from, "..", spec);
    for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
      if (known.has(candidate)) return candidate;
    }
    return null;
  }

  const seen = new Set<string>();
  const queue = [WORKER_ENTRY];

  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const rel = `src/${relative(file)}`;
    assert.ok(
      !inBoundary(rel),
      `${rel} is reachable from worker.ts; the Worker has no business loading it`,
    );

    for (const { spec } of specifiers(file)) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      const target = resolve(file, spec);
      if (target) queue.push(target);
    }
  }

  assert.ok(seen.size > 5, `the graph walk only found ${seen.size} files — the resolver is broken, not the code`);
  assert.ok(seen.has(join(SRC, "context.ts")), "worker.ts must reach context.ts; if it does not, the entry moved");
});

test("the Node entry is the only place that pulls in node-only modules", () => {
  const importers = allSources()
    .filter((file) => specifiers(file).some(({ spec }) => isNodeOnly(spec)))
    .map(relative);
  for (const file of importers) {
    assert.ok(
      file === "node.ts" || file.endsWith(".node.ts") || file === "db/node-sqlite.ts",
      `${file} imports a node-only module but is not part of the documented boundary`,
    );
  }
});

test("rss-parser is imported by at most one file, and that file is the node adapter", () => {
  const importers = allSources()
    .filter((file) => specifiers(file).some(({ spec }) => spec === "rss-parser"))
    .map(relative);
  assert.ok(importers.length <= 1, `rss-parser is imported in ${importers.join(", ")}; keep it to the node adapter`);
  if (importers.length === 1) {
    assert.equal(importers[0], "rss.node.ts", "the only rss-parser importer must be src/rss.node.ts");
  }
});

test("the Node entry exists and is where injection happens", () => {
  const text = readFileSync(NODE_ENTRY, "utf8");
  assert.match(text, /sliceImage/, "node.ts is the injection point; if this changed, the boundary moved");
});

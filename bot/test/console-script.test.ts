/**
 * The console is one big string containing CSS and JavaScript. `tsc` checks the
 * string, not what is inside it — so a broken regex, a stray quote or an
 * unescaped newline compiles cleanly and ships a blank page.
 *
 * That is not hypothetical: a `split(/[,，、\n]+/)` written inside the template
 * literal emitted a real newline into the regex and produced
 * `SyntaxError: Invalid regular expression` in the browser. Every string
 * assertion in the other console tests passed while the page rendered nothing.
 *
 * So: compile the emitted script for real, and prove the guard reacts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { renderConsole } from "../src/admin/page.ts";

function pageScript(html: string): string {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
  const main = blocks.find((block) => block.includes("renderRules"));
  assert.ok(main, "the page has no script containing renderRules");
  return main;
}

test("the emitted page script is valid JavaScript", () => {
  const code = pageScript(renderConsole());
  assert.doesNotThrow(() => new vm.Script(code, { filename: "console.js" }), "the console page would not run");
});

test("the comma split keeps its newline as an escape, not a real line break", () => {
  // The specific shape that broke it: writing \n inside the TS template literal
  // emits a literal line break, which terminates the regex and kills the page.
  // Asserting on the emitted text is the point — a raw newline cannot match this.
  const code = pageScript(renderConsole());
  assert.ok(
    code.includes("split(/[,，、\\n]+/)"),
    `the list split lost its escape: ${code.split("\n").find((line) => line.includes("split(")) ?? "not found"}`,
  );
});

test("the guard itself catches a broken page", () => {
  const broken = renderConsole().replace("var parts = listInp.value.split(", "var parts = listInp.value.split(/[,\n");
  assert.throws(() => new vm.Script(pageScript(broken)), /SyntaxError|Invalid/);
});

test("the page keeps its structural anchors", () => {
  const html = renderConsole();
  for (const anchor of ["<style>", "id=\"app\"", "function renderRules", "function renderStats", "api/overview"]) {
    assert.ok(html.includes(anchor), `missing ${anchor}`);
  }
});

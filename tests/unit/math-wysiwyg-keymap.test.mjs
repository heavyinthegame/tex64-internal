import assert from "node:assert/strict";
import test from "node:test";

import {
  extractCommand,
  getKeyByLatex,
  normalizeLatexKey,
} from "../../Resources/web/math/wysiwyg/math-wysiwyg-keymap.js";

test("normalizeLatexKey trims whitespace", () => {
  assert.equal(normalizeLatexKey("  \\sqrt{#?}  "), "\\sqrt{#?}");
  assert.equal(normalizeLatexKey(null), "");
});

test("extractCommand returns null for excluded commands", () => {
  assert.equal(extractCommand("\\left("), null);
  assert.equal(extractCommand("\\text{abc}"), null);
});

test("extractCommand returns command name for supported entries", () => {
  assert.equal(extractCommand("\\sqrt{#?}"), "sqrt");
  assert.equal(extractCommand("\\lim_{x \\to 0}"), "lim");
});

test("getKeyByLatex returns existing keyboard mapping when available", () => {
  const key = getKeyByLatex("\\sqrt{#?}", "fallback");

  assert.equal(key.latex, "\\sqrt{#?}");
  assert.notEqual(key.label, "fallback");
});

test("getKeyByLatex builds a fallback key when mapping is unknown", () => {
  const key = getKeyByLatex("\\tex64_nonexistent_cmd", "manual");

  assert.deepEqual(key, {
    label: "manual",
    latex: "\\tex64_nonexistent_cmd",
    displayLatex: "\\tex64_nonexistent_cmd",
  });
});

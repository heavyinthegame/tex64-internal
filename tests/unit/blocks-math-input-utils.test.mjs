import assert from "node:assert/strict";
import test from "node:test";

import {
  PLACEHOLDER_LATEX,
  applyScriptToText,
  applyTemplateToText,
  indexToOffset,
  offsetToIndex,
} from "../../Resources/web/app/blocks/math-input-utils.js";

test("applyScriptToText inserts a superscript placeholder for a token", () => {
  const result = applyScriptToText(
    "x",
    { start: 1, end: 1 },
    "sup",
    { placeholder: PLACEHOLDER_LATEX }
  );

  assert.equal(result.text, "x^{\\placeholder{}}");
  assert.equal(
    result.text.slice(result.selectionStart, result.selectionEnd),
    PLACEHOLDER_LATEX
  );
});

test("applyScriptToText inserts subscript before existing superscript", () => {
  const result = applyScriptToText(
    "x^{2}",
    { start: 5, end: 5 },
    "sub",
    { placeholder: PLACEHOLDER_LATEX }
  );

  assert.equal(result.text, "x_{\\placeholder{}}^{2}");
  assert.equal(
    result.text.slice(result.selectionStart, result.selectionEnd),
    PLACEHOLDER_LATEX
  );
});

test("applyTemplateToText wraps selection with base placeholder targeting", () => {
  const result = applyTemplateToText(
    "x+y",
    { start: 0, end: 1 },
    "\\frac{#?}{#?}",
    { placeholder: PLACEHOLDER_LATEX, baseMode: "wrap", baseIndex: 0 }
  );

  assert.equal(result.text, "\\frac{x}{\\placeholder{}}+y");
  assert.equal(
    result.text.slice(result.selectionStart, result.selectionEnd),
    PLACEHOLDER_LATEX
  );
});

test("applyTemplateToText appends atom as base in after mode", () => {
  const result = applyTemplateToText(
    "x",
    { start: 1, end: 1 },
    "\\sqrt{#?}",
    {
      placeholder: PLACEHOLDER_LATEX,
      baseMode: "after",
      baseScope: "selection-or-atom",
    }
  );

  assert.equal(result.text, "\\sqrt{\\placeholder{}}x");
  assert.equal(
    result.text.slice(result.selectionStart, result.selectionEnd),
    PLACEHOLDER_LATEX
  );
});

test("offsetToIndex and indexToOffset stay consistent with offset-length mapping", () => {
  const lengthsByOffset = [0, 1, 1, 2, 4, 5];
  const mathField = {
    lastOffset: 5,
    getValue: (...args) => {
      if (args.length === 1 && args[0] === "latex") {
        return "x".repeat(5);
      }
      if (args.length === 3 && args[2] === "latex") {
        const offset = Number(args[1]);
        return "x".repeat(lengthsByOffset[offset] ?? 5);
      }
      return "";
    },
  };

  assert.equal(offsetToIndex(mathField, 4), 4);
  assert.equal(indexToOffset(mathField, 0), 0);
  assert.equal(indexToOffset(mathField, 1), 1);
  assert.equal(indexToOffset(mathField, 2), 3);
  assert.equal(indexToOffset(mathField, 4), 4);
  assert.equal(indexToOffset(mathField, 5), 5);
});

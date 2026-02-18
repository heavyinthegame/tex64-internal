import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeMatrixSyntax,
  shouldWrapAligned,
  stripEmptyAlignedRows,
  unwrapAligned,
  wrapAligned,
} from "../../Resources/web/app/blocks/input-ui-latex-format.js";

test("shouldWrapAligned detects unescaped ampersand and line break", () => {
  assert.equal(shouldWrapAligned("a&b"), true);
  assert.equal(shouldWrapAligned("a\\&b"), false);
  assert.equal(shouldWrapAligned("a\\\\b"), true);
});

test("shouldWrapAligned skips already wrapped environments", () => {
  assert.equal(shouldWrapAligned("\\begin{aligned}a&b\\end{aligned}"), false);
});

test("wrapAligned and unwrapAligned round-trip plain aligned content", () => {
  const wrapped = wrapAligned("a&b");

  assert.equal(wrapped, "\\begin{aligned}\na&b\n\\end{aligned}");
  assert.deepEqual(unwrapAligned(wrapped), { value: "a&b", didUnwrap: true });
  assert.deepEqual(unwrapAligned(`x${wrapped}`), {
    value: `x${wrapped}`,
    didUnwrap: false,
  });
});

test("stripEmptyAlignedRows removes all-placeholder rows", () => {
  assert.equal(stripEmptyAlignedRows("\\placeholder{}\\\\&"), "");
  assert.equal(stripEmptyAlignedRows("x\\\\&"), "x\\\\&");
});

test("normalizeMatrixSyntax converts flat matrix bodies into rows and columns", () => {
  assert.equal(
    normalizeMatrixSyntax("\\begin{matrix}{a}{b}{c}{d}\\end{matrix}"),
    "\\begin{matrix}a&b\\\\c&d\\end{matrix}"
  );
  assert.equal(
    normalizeMatrixSyntax("\\begin{matrix}{a}{b}{c}\\end{matrix}"),
    "\\begin{matrix}{a}{b}{c}\\end{matrix}"
  );
});

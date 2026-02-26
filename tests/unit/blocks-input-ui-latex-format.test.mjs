import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeLegacyEnvMarkers,
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
    normalizeMatrixSyntax("\\begin{smallmatrix}{a}{b}{c}{d}\\end{smallmatrix}"),
    "\\begin{smallmatrix}a&b\\\\c&d\\end{smallmatrix}"
  );
  assert.equal(
    normalizeMatrixSyntax("\\begin{bmatrix}{a}{b}{c}{d}{e}{f}\\end{bmatrix}"),
    "\\begin{bmatrix}a&b&c\\\\d&e&f\\end{bmatrix}"
  );
  assert.equal(
    normalizeMatrixSyntax("\\begin{matrix}{a}{b}{c}\\end{matrix}"),
    "\\begin{matrix}{a}{b}{c}\\end{matrix}"
  );
  assert.equal(
    normalizeMatrixSyntax("\\begin{|matrix}{a}{b}{c}{d}\\end{|matrix}"),
    "\\begin{|matrix}{a}{b}{c}{d}\\end{|matrix}"
  );
});

test("normalizeMatrixSyntax skips mixed/non-cell matrix bodies to avoid structural corruption", () => {
  const mixed = "\\begin{matrix}{a}\\label{eq:mx}{c}{d}\\end{matrix}";
  assert.equal(normalizeMatrixSyntax(mixed), mixed);

  const unbraced = "\\begin{matrix}\\operatorname{Var}(X)\\end{matrix}";
  assert.equal(normalizeMatrixSyntax(unbraced), unbraced);
});

test("normalizeLegacyEnvMarkers migrates legacy tx proxy env markers", () => {
  assert.equal(
    normalizeLegacyEnvMarkers("\\begin{aligned}\\txalnat a&=b\\quad c&=d\\end{aligned}"),
    "\\begin{alignat*}{2}a&=b\\quad c&=d\\end{alignat*}"
  );
  assert.equal(
    normalizeLegacyEnvMarkers("\\begin{aligned}\\txflaln a&=b\\end{aligned}"),
    "\\begin{flalign*}a&=b\\end{flalign*}"
  );
  assert.equal(
    normalizeLegacyEnvMarkers("\\begin{aligned}\\txarrcf a&b&c\\\\d&e&f\\end{aligned}"),
    "\\begin{array}{@{}>r<{}c@{|}l<{}@{}}a&b&c\\\\d&e&f\\end{array}"
  );
  assert.equal(
    normalizeLegacyEnvMarkers("\\txarrayc{@{}>r<{}c@{|}l<{}@{}}{a&b&c\\\\d&e&f}"),
    "\\begin{array}{@{}>r<{}c@{|}l<{}@{}}a&b&c\\\\d&e&f\\end{array}"
  );
  assert.equal(
    normalizeLegacyEnvMarkers("{2}a&=b\\quad c&=d\\end{alignat*}"),
    "{2}a&=b\\quad c&=d\\end{alignat*}"
  );
  assert.equal(
    normalizeLegacyEnvMarkers("a&=b\\end{flalign*}\\tag{A1}"),
    "a&=b\\end{flalign*}\\tag{A1}"
  );
  assert.equal(
    normalizeLegacyEnvMarkers("\\txlbl{eq:newton}+\\txtgs{A-1}+\\txintr{text}"),
    "\\label{eq:newton}+\\tag*{A-1}+\\intertext{text}"
  );
  assert.equal(
    normalizeLegacyEnvMarkers("\\label{\\lbrace sec/intro+alpha@v1\\rbrace}"),
    "\\label{sec/intro+alpha@v1}"
  );
});

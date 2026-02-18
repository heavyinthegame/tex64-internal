import assert from "node:assert/strict";
import test from "node:test";

import {
  PLACEHOLDER_LATEX,
  applyScriptToText,
  applyTemplateToText,
} from "../../Resources/web/app/blocks/math-input-utils.js";
import { normalizeMatrixSyntax } from "../../Resources/web/app/blocks/input-ui-latex-format.js";

const createRng = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const pickInt = (rng, min, max) =>
  Math.floor(rng() * (max - min + 1)) + min;

const randomText = (rng, maxLength = 80) => {
  const chars = "abcxyz01239_^{ }\\&[]()=+-*/,.";
  const length = pickInt(rng, 0, maxLength);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[pickInt(rng, 0, chars.length - 1)];
  }
  return out;
};

const assertSelectionWithin = (result) => {
  assert.equal(typeof result.text, "string");
  assert.equal(Number.isInteger(result.selectionStart), true);
  assert.equal(Number.isInteger(result.selectionEnd), true);
  assert.equal(result.selectionStart >= 0, true);
  assert.equal(result.selectionEnd >= result.selectionStart, true);
  assert.equal(result.selectionEnd <= result.text.length, true);
};

test("fuzz: script/template transforms and matrix normalization stay stable", () => {
  const rng = createRng(0x64_74_65_78);
  const rounds = Number.parseInt(process.env.TEX64_FUZZ_ROUNDS ?? "500", 10);
  const templates = [
    "\\frac{#?}{#?}",
    "\\sqrt{#?}",
    "\\left(#?\\right)",
    "\\sum_{#?}^{#?}",
  ];
  const kinds = ["sub", "sup", "subsup"];

  for (let i = 0; i < rounds; i += 1) {
    const source = randomText(rng);
    const s = pickInt(rng, 0, source.length);
    const e = pickInt(rng, 0, source.length);

    const scriptResult = applyScriptToText(
      source,
      { start: s, end: e },
      kinds[pickInt(rng, 0, kinds.length - 1)],
      {
        placeholder: PLACEHOLDER_LATEX,
        subValue: rng() < 0.2 ? "i" : null,
        supValue: rng() < 0.2 ? "2" : null,
      }
    );
    assertSelectionWithin(scriptResult);

    const templateResult = applyTemplateToText(
      source,
      { start: s, end: e },
      templates[pickInt(rng, 0, templates.length - 1)],
      {
        placeholder: PLACEHOLDER_LATEX,
        baseMode: rng() < 0.5 ? "wrap" : "after",
        baseIndex: pickInt(rng, 0, 1),
        baseScope: rng() < 0.5 ? "selection" : "selection-or-atom",
      }
    );
    assertSelectionWithin(templateResult);

    const normalized = normalizeMatrixSyntax(source);
    const normalizedTwice = normalizeMatrixSyntax(normalized);
    assert.equal(typeof normalized, "string");
    assert.equal(normalizedTwice, normalized);
  }
});

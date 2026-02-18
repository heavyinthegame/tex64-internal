import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  PLACEHOLDER_LATEX,
  applyScriptToText,
  applyTemplateToText,
} from "../../Resources/web/app/blocks/math-input-utils.js";
import {
  normalizeMatrixSyntax,
  wrapAligned,
} from "../../Resources/web/app/blocks/input-ui-latex-format.js";

test("perf: input transform pipeline stays within nightly budget", () => {
  const iterations = Number.parseInt(process.env.TEX64_PERF_ITERS ?? "12000", 10);
  const maxMs = Number.parseFloat(process.env.TEX64_PERF_MAX_MS ?? "1800");

  let text = "x";
  const startedAt = performance.now();

  for (let i = 0; i < iterations; i += 1) {
    const scriptResult = applyScriptToText(text, { start: text.length, end: text.length }, "sup", {
      placeholder: PLACEHOLDER_LATEX,
      supValue: i % 5 === 0 ? "2" : null,
    });
    const templateResult = applyTemplateToText(
      scriptResult.text,
      { start: scriptResult.selectionStart, end: scriptResult.selectionEnd },
      "\\frac{#?}{#?}",
      {
        placeholder: PLACEHOLDER_LATEX,
        baseMode: "wrap",
        baseIndex: 0,
      }
    );
    const normalized = normalizeMatrixSyntax(templateResult.text);
    text = wrapAligned(normalized).slice(-256);
  }

  const elapsedMs = performance.now() - startedAt;
  assert.equal(Number.isFinite(elapsedMs), true);
  assert.equal(
    elapsedMs <= maxMs,
    true,
    `input transform pipeline exceeded budget: ${elapsedMs.toFixed(1)}ms > ${maxMs}ms`
  );
});

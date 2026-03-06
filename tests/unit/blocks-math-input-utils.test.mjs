import assert from "node:assert/strict";
import test from "node:test";

import {
  PLACEHOLDER_LATEX,
  applyScriptToText,
  applyTemplateToText,
  getMathFieldSelectionRange,
  indexToOffset,
  offsetToIndex,
} from "../../Resources/web/app/blocks/math-input-utils.js";

const PH = PLACEHOLDER_LATEX;

// ─── applyScriptToText: superscript ─────────────────────────────────

test("applyScriptToText: sup on single char → x^{placeholder}", () => {
  const r = applyScriptToText("x", { start: 1, end: 1 }, "sup", { placeholder: PH });
  assert.equal(r.text, `x^{${PH}}`);
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), PH);
});

test("applyScriptToText: sup on command → \\alpha^{placeholder}", () => {
  const r = applyScriptToText("\\alpha", { start: 6, end: 6 }, "sup", { placeholder: PH });
  assert.equal(r.text, `\\alpha^{${PH}}`);
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), PH);
});

test("applyScriptToText: sup on multi-digit number → 123^{placeholder}", () => {
  const r = applyScriptToText("abc123", { start: 6, end: 6 }, "sup", { placeholder: PH });
  assert.equal(r.text, `abc123^{${PH}}`);
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), PH);
});

test("applyScriptToText: sup with existing sup → cursor moves to end of existing", () => {
  const r = applyScriptToText("x^{2}", { start: 5, end: 5 }, "sup", { placeholder: PH });
  assert.equal(r.text, "x^{2}");
  assert.equal(r.selectionStart, 4); // inside the existing ^{2}, at content end
  assert.equal(r.selectionEnd, 4);
});

test("applyScriptToText: sup with concrete value → x^{n}", () => {
  const r = applyScriptToText("x", { start: 1, end: 1 }, "sup", { placeholder: PH, supValue: "n" });
  assert.equal(r.text, "x^{n}");
});

// ─── applyScriptToText: subscript ───────────────────────────────────

test("applyScriptToText: sub on single char → x_{placeholder}", () => {
  const r = applyScriptToText("x", { start: 1, end: 1 }, "sub", { placeholder: PH });
  assert.equal(r.text, `x_{${PH}}`);
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), PH);
});

test("applyScriptToText: sub before existing sup → x_{placeholder}^{2}", () => {
  const r = applyScriptToText("x^{2}", { start: 5, end: 5 }, "sub", { placeholder: PH });
  assert.equal(r.text, `x_{${PH}}^{2}`);
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), PH);
});

test("applyScriptToText: sub with existing sub → cursor at content end", () => {
  const r = applyScriptToText("x_{i}", { start: 5, end: 5 }, "sub", { placeholder: PH });
  assert.equal(r.text, "x_{i}");
  assert.equal(r.selectionStart, 4);
});

// ─── applyScriptToText: subsup ──────────────────────────────────────

test("applyScriptToText: subsup on bare atom → x_{ph}^{ph}", () => {
  const r = applyScriptToText("x", { start: 1, end: 1 }, "subsup", { placeholder: PH });
  assert.equal(r.text, `x_{${PH}}^{${PH}}`);
  // Selection should be on the first placeholder (sub)
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), PH);
});

test("applyScriptToText: subsup with existing sub → adds sup", () => {
  const r = applyScriptToText("x_{i}", { start: 5, end: 5 }, "subsup", { placeholder: PH });
  assert.equal(r.text, `x_{i}^{${PH}}`);
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), PH);
});

test("applyScriptToText: subsup with existing sup → adds sub before sup", () => {
  const r = applyScriptToText("x^{2}", { start: 5, end: 5 }, "subsup", { placeholder: PH });
  assert.equal(r.text, `x_{${PH}}^{2}`);
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), PH);
});

test("applyScriptToText: subsup with both existing → cursor to sub end", () => {
  const r = applyScriptToText("x_{i}^{2}", { start: 9, end: 9 }, "subsup", { placeholder: PH });
  assert.equal(r.text, "x_{i}^{2}");
  assert.equal(r.selectionStart, 4);
});

// ─── applyScriptToText: selection wrapping ──────────────────────────

test("applyScriptToText: wraps selection in braces before adding script", () => {
  const r = applyScriptToText("x+y", { start: 0, end: 3 }, "sup", { placeholder: PH });
  assert.equal(r.text, `{x+y}^{${PH}}`);
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), PH);
});

test("applyScriptToText: reversed selection (start > end) is normalized", () => {
  const r = applyScriptToText("x+y", { start: 3, end: 0 }, "sup", { placeholder: PH });
  assert.equal(r.text, `{x+y}^{${PH}}`);
});

// ─── applyScriptToText: no atom left of cursor ─────────────────────

test("applyScriptToText: no atom → inserts placeholder base + script", () => {
  const r = applyScriptToText("", { start: 0, end: 0 }, "sup", { placeholder: PH });
  assert.ok(r.text.includes("^{"));
  assert.ok(r.text.includes(PH));
});

test("applyScriptToText: with base option → inserts specified base", () => {
  const r = applyScriptToText("= ", { start: 2, end: 2 }, "sup", { placeholder: PH, base: "x" });
  assert.ok(r.text.includes("x^{"));
});

// ─── applyScriptToText: braced group and command bases ──────────────

test("applyScriptToText: braced group base → {abc}^{ph}", () => {
  const r = applyScriptToText("{abc}", { start: 5, end: 5 }, "sup", { placeholder: PH });
  assert.equal(r.text, `{abc}^{${PH}}`);
});

test("applyScriptToText: \\frac{a}{b} base recognized as multi-arg command", () => {
  const r = applyScriptToText("\\frac{a}{b}", { start: 11, end: 11 }, "sup", { placeholder: PH });
  assert.equal(r.text, `\\frac{a}{b}^{${PH}}`);
});

test("applyScriptToText: \\sqrt[3]{8} base recognized", () => {
  const r = applyScriptToText("\\sqrt[3]{8}", { start: 11, end: 11 }, "sup", { placeholder: PH });
  assert.equal(r.text, `\\sqrt[3]{8}^{${PH}}`);
});

// ─── applyTemplateToText: wrap mode ─────────────────────────────────

test("applyTemplateToText: wrap selection into \\frac{sel}{ph}", () => {
  const r = applyTemplateToText(
    "x+y",
    { start: 0, end: 1 },
    "\\frac{#?}{#?}",
    { placeholder: PH, baseMode: "wrap", baseIndex: 0 }
  );
  assert.equal(r.text, `\\frac{x}{${PH}}+y`);
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), PH);
});

test("applyTemplateToText: wrap with baseIndex=1 → ph in numerator, sel in denominator", () => {
  const r = applyTemplateToText(
    "x+y",
    { start: 0, end: 1 },
    "\\frac{#?}{#?}",
    { placeholder: PH, baseMode: "wrap", baseIndex: 1 }
  );
  assert.equal(r.text, `\\frac{${PH}}{x}+y`);
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), PH);
});

test("applyTemplateToText: wrap with no selection → all placeholders", () => {
  const r = applyTemplateToText(
    "x+y",
    { start: 1, end: 1 },
    "\\frac{#?}{#?}",
    { placeholder: PH, baseMode: "wrap", baseIndex: 0 }
  );
  // No selection → no base text to wrap, both slots get placeholder
  assert.ok(r.text.includes("\\frac{"));
});

test("applyTemplateToText: wrap single-placeholder template \\sqrt{#?}", () => {
  const r = applyTemplateToText(
    "x+y",
    { start: 0, end: 1 },
    "\\sqrt{#?}",
    { placeholder: PH, baseMode: "wrap", baseIndex: 0 }
  );
  assert.equal(r.text, "\\sqrt{x}+y");
});

// ─── applyTemplateToText: after mode ────────────────────────────────

test("applyTemplateToText: after mode appends atom base", () => {
  const r = applyTemplateToText(
    "x",
    { start: 1, end: 1 },
    "\\sqrt{#?}",
    { placeholder: PH, baseMode: "after", baseScope: "selection-or-atom" }
  );
  assert.equal(r.text, `\\sqrt{${PH}}x`);
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), PH);
});

test("applyTemplateToText: after mode with no atom → cursor insertion", () => {
  const r = applyTemplateToText(
    "",
    { start: 0, end: 0 },
    "\\sqrt{#?}",
    { placeholder: PH, baseMode: "after" }
  );
  assert.equal(r.text, `\\sqrt{${PH}}`);
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), PH);
});

test("applyTemplateToText: after mode with selection → selection-only scope", () => {
  const r = applyTemplateToText(
    "abc",
    { start: 0, end: 3 },
    "\\hat{#?}",
    { placeholder: PH, baseMode: "after", baseScope: "selection" }
  );
  assert.equal(r.text, `\\hat{${PH}}abc`);
});

// ─── applyTemplateToText: reversed selection ────────────────────────

test("applyTemplateToText: reversed selection is normalized", () => {
  const r = applyTemplateToText(
    "x+y",
    { start: 3, end: 0 },
    "\\frac{#?}{#?}",
    { placeholder: PH, baseMode: "wrap", baseIndex: 0 }
  );
  assert.equal(r.text, `\\frac{x+y}{${PH}}`);
});

// ─── getMathFieldSelectionRange ──────────────────────────────────────

test("getMathFieldSelectionRange: tuple array", () => {
  assert.deepEqual(getMathFieldSelectionRange({ selection: [2, 5] }), { start: 2, end: 5 });
});

test("getMathFieldSelectionRange: nested array", () => {
  assert.deepEqual(getMathFieldSelectionRange({ selection: [[3, 7]] }), { start: 3, end: 7 });
});

test("getMathFieldSelectionRange: ranges object", () => {
  assert.deepEqual(
    getMathFieldSelectionRange({ selection: { ranges: [[1, 4]] } }),
    { start: 1, end: 4 }
  );
});

test("getMathFieldSelectionRange: position fallback", () => {
  assert.deepEqual(getMathFieldSelectionRange({ position: 8 }), { start: 8, end: 8 });
});

test("getMathFieldSelectionRange: no selection/position → {0,0}", () => {
  assert.deepEqual(getMathFieldSelectionRange({}), { start: 0, end: 0 });
});

// ─── offsetToIndex / indexToOffset ──────────────────────────────────

test("offsetToIndex: uses getValue(0, offset, 'latex') length", () => {
  const lengthsByOffset = [0, 1, 1, 2, 4, 5];
  const mathField = {
    lastOffset: 5,
    getValue: (...args) => {
      if (args.length === 1 && args[0] === "latex") return "x".repeat(5);
      if (args.length === 3 && args[2] === "latex") {
        const offset = Number(args[1]);
        return "x".repeat(lengthsByOffset[offset] ?? 5);
      }
      return "";
    },
  };

  assert.equal(offsetToIndex(mathField, 0), 0);
  assert.equal(offsetToIndex(mathField, 4), 4);
  assert.equal(offsetToIndex(mathField, 5), 5);
});

test("offsetToIndex: no getValue → returns offset as-is", () => {
  assert.equal(offsetToIndex({}, 7), 7);
  assert.equal(offsetToIndex(null, 3), 3);
});

test("offsetToIndex: getValue throws → falls back to max(0, offset)", () => {
  const mathField = {
    getValue: () => { throw new Error("fail"); },
  };
  assert.equal(offsetToIndex(mathField, 5), 5);
  assert.equal(offsetToIndex(mathField, -1), 0);
});

test("indexToOffset: binary search finds correct offset", () => {
  const lengthsByOffset = [0, 1, 1, 2, 4, 5];
  const mathField = {
    lastOffset: 5,
    getValue: (...args) => {
      if (args.length === 1 && args[0] === "latex") return "x".repeat(5);
      if (args.length === 3 && args[2] === "latex") {
        const offset = Number(args[1]);
        return "x".repeat(lengthsByOffset[offset] ?? 5);
      }
      return "";
    },
  };

  assert.equal(indexToOffset(mathField, 0), 0);
  assert.equal(indexToOffset(mathField, 1), 1);
  assert.equal(indexToOffset(mathField, 2), 3);
  assert.equal(indexToOffset(mathField, 4), 4);
  assert.equal(indexToOffset(mathField, 5), 5);
});

test("indexToOffset: out-of-bounds index clamps", () => {
  const mathField = {
    lastOffset: 3,
    getValue: (...args) => {
      if (args.length === 1 && args[0] === "latex") return "abc";
      if (args.length === 3 && args[2] === "latex") {
        return "x".repeat(Math.min(Number(args[1]), 3));
      }
      return "";
    },
  };
  assert.equal(indexToOffset(mathField, 0), 0);
  assert.equal(indexToOffset(mathField, 99), 3); // clamps to lastOffset
});

test("indexToOffset: no getValue → returns targetIndex as-is", () => {
  assert.equal(indexToOffset({}, 5), 5);
  assert.equal(indexToOffset(null, 2), 2);
});

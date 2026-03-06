import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlaceholderNavigator,
  readMathFieldValue,
  readSelectionRange,
  setSelectionRange,
  writeMathFieldValue,
} from "../../Resources/web/app/blocks/input-ui-math-field.js";

// ─── readSelectionRange ─────────────────────────────────────────────

test("readSelectionRange: tuple [start, end]", () => {
  assert.deepEqual(readSelectionRange({ selection: [2, 5] }), { start: 2, end: 5 });
});

test("readSelectionRange: ranges object { ranges: [[s, e]] }", () => {
  assert.deepEqual(readSelectionRange({ selection: { ranges: [[7, 9]] } }), { start: 7, end: 9 });
});

test("readSelectionRange: empty object → null", () => {
  assert.equal(readSelectionRange({}), null);
});

test("readSelectionRange: undefined selection → null", () => {
  assert.equal(readSelectionRange({ selection: undefined }), null);
});

test("readSelectionRange: empty ranges array → null", () => {
  assert.equal(readSelectionRange({ selection: { ranges: [] } }), null);
});

// ─── setSelectionRange ──────────────────────────────────────────────

test("setSelectionRange: prefers setSelection API", () => {
  const calls = [];
  const api = {
    setSelection: (s, e) => calls.push([s, e]),
    selection: [0, 0],
  };
  setSelectionRange(api, 3, 6);
  assert.deepEqual(calls, [[3, 6]]);
  assert.deepEqual(api.selection, [0, 0]); // not modified
});

test("setSelectionRange: falls back to direct selection assignment", () => {
  const api = { selection: [0, 0] };
  setSelectionRange(api, 1, 4);
  assert.deepEqual(api.selection, [1, 4]);
});

test("setSelectionRange: falls back to internal model setSelection", () => {
  const calls = [];
  const api = {
    _mathfield: {
      model: {
        setSelection: (s, e) => calls.push([s, e]),
      },
    },
  };
  setSelectionRange(api, 5, 8);
  assert.deepEqual(calls, [[5, 8]]);
});

test("setSelectionRange: last resort → sets position to end", () => {
  const api = { position: 0 };
  setSelectionRange(api, 3, 7);
  assert.equal(api.position, 7);
});

// ─── readMathFieldValue ─────────────────────────────────────────────

test("readMathFieldValue: getValue('latex') success path", () => {
  assert.equal(
    readMathFieldValue({ getValue: () => "x^{2}" }),
    "x^{2}"
  );
});

test("readMathFieldValue: getValue throws → falls back to .value", () => {
  assert.equal(
    readMathFieldValue({
      getValue: () => { throw new Error("unavailable"); },
      value: "fallback",
    }),
    "fallback"
  );
});

test("readMathFieldValue: getValue returns non-string → falls back to .value", () => {
  assert.equal(
    readMathFieldValue({ getValue: () => 42, value: "str" }),
    "str"
  );
});

test("readMathFieldValue: null mathField → empty string", () => {
  assert.equal(readMathFieldValue(null), "");
});

test("readMathFieldValue: no getValue, no value → empty string", () => {
  assert.equal(readMathFieldValue({}), "");
});

test("readMathFieldValue: .value is non-string → empty string", () => {
  assert.equal(readMathFieldValue({ value: 123 }), "");
});

// ─── writeMathFieldValue ────────────────────────────────────────────

test("writeMathFieldValue: setValue success path", () => {
  let written = null;
  const mf = { setValue: (v) => { written = v; } };
  writeMathFieldValue(mf, "abc");
  assert.equal(written, "abc");
});

test("writeMathFieldValue: setValue throws → falls back to .value assignment", () => {
  const mf = {
    setValue: () => { throw new Error("blocked"); },
    value: "",
  };
  writeMathFieldValue(mf, "next");
  assert.equal(mf.value, "next");
});

test("writeMathFieldValue: null mathField → no-op", () => {
  // Should not throw
  writeMathFieldValue(null, "x");
});

test("writeMathFieldValue: no setValue, has value → assigns .value", () => {
  const mf = { value: "" };
  writeMathFieldValue(mf, "hello");
  assert.equal(mf.value, "hello");
});

// ─── createPlaceholderNavigator ─────────────────────────────────────

test("placeholder navigator: moves forward through prompt ranges", () => {
  const { moveMathFieldPlaceholder } = createPlaceholderNavigator();
  const host = {
    selection: [0, 0],
    lastOffset: 12,
    getPrompts: () => ["p1", "p2"],
    getPromptRange: (id) => (id === "p1" ? [2, 4] : [6, 8]),
    focusCalls: 0,
    focus() { this.focusCalls += 1; },
  };

  assert.equal(moveMathFieldPlaceholder(host, "forward"), true);
  assert.deepEqual(host.selection, [2, 4]);
});

test("placeholder navigator: moves backward through prompt ranges", () => {
  const { moveMathFieldPlaceholder } = createPlaceholderNavigator();
  const host = {
    selection: [12, 12],
    lastOffset: 12,
    getPrompts: () => ["p1", "p2"],
    getPromptRange: (id) => (id === "p1" ? [2, 4] : [6, 8]),
    focusCalls: 0,
    focus() { this.focusCalls += 1; },
  };

  assert.equal(moveMathFieldPlaceholder(host, "backward"), true);
  assert.deepEqual(host.selection, [6, 8]);
});

test("placeholder navigator: wraps around forward", () => {
  const { moveMathFieldPlaceholder } = createPlaceholderNavigator();
  const host = {
    selection: [6, 8], // on second prompt
    lastOffset: 12,
    getPrompts: () => ["p1", "p2"],
    getPromptRange: (id) => (id === "p1" ? [2, 4] : [6, 8]),
    focus() {},
  };

  // First move: establish current position
  moveMathFieldPlaceholder(host, "forward");
  // Should wrap to first prompt
  assert.deepEqual(host.selection, [2, 4]);
});

test("placeholder navigator: no prompts → uses moveToNextChar", () => {
  const { moveMathFieldPlaceholder } = createPlaceholderNavigator();
  const commands = [];
  const host = {
    selection: [3, 3],
    lastOffset: 10,
    position: 3,
    getPrompts: () => [],
    getPromptRange: () => null,
    executeCommand: (cmd) => {
      commands.push(cmd);
      if (cmd === "moveToNextChar") {
        host.selection = [4, 4];
        host.position = 4;
        return true;
      }
      return false;
    },
    focus() {},
  };

  const result = moveMathFieldPlaceholder(host, "forward");
  assert.equal(result, true);
  assert.ok(commands.includes("moveToNextChar"));
});

test("placeholder navigator: focus called after successful move", () => {
  const { moveMathFieldPlaceholder } = createPlaceholderNavigator();
  let focusCalled = 0;
  const host = {
    selection: [0, 0],
    lastOffset: 12,
    getPrompts: () => ["p1"],
    getPromptRange: () => [2, 4],
    focus() { focusCalled += 1; },
  };

  moveMathFieldPlaceholder(host, "forward");
  assert.ok(focusCalled >= 1);
});

test("placeholder navigator: skips full-selection prompt ranges", () => {
  const { moveMathFieldPlaceholder } = createPlaceholderNavigator();
  const host = {
    selection: [0, 0],
    lastOffset: 10,
    getPrompts: () => ["p1", "p2"],
    getPromptRange: (id) => {
      // p1 covers the full range [0, 10] (should be skipped)
      // p2 covers [3, 5]
      return id === "p1" ? [0, 10] : [3, 5];
    },
    setSelection: (s, e) => { host.selection = [s, e]; },
    focus() {},
  };

  const result = moveMathFieldPlaceholder(host, "forward");
  assert.equal(result, true);
  assert.deepEqual(host.selection, [3, 5]);
});

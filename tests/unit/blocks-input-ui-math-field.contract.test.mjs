import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlaceholderNavigator,
  readMathFieldValue,
  readSelectionRange,
  setSelectionRange,
  writeMathFieldValue,
} from "../../Resources/web/app/blocks/input-ui-math-field.js";

test("readSelectionRange handles tuple and ranges forms", () => {
  assert.deepEqual(readSelectionRange({ selection: [2, 5] }), { start: 2, end: 5 });
  assert.deepEqual(readSelectionRange({ selection: { ranges: [[7, 9]] } }), {
    start: 7,
    end: 9,
  });
  assert.equal(readSelectionRange({}), null);
});

test("setSelectionRange prefers setSelection API", () => {
  const calls = [];
  const mathfieldApi = {
    setSelection: (start, end) => calls.push([start, end]),
    selection: [0, 0],
  };

  setSelectionRange(mathfieldApi, 3, 6);

  assert.deepEqual(calls, [[3, 6]]);
  assert.deepEqual(mathfieldApi.selection, [0, 0]);
});

test("setSelectionRange falls back to direct selection and internal model", () => {
  const directSelection = { selection: [0, 0] };
  setSelectionRange(directSelection, 1, 4);
  assert.deepEqual(directSelection.selection, [1, 4]);

  const calls = [];
  const internalSelection = {
    _mathfield: {
      model: {
        setSelection: (start, end) => calls.push([start, end]),
      },
    },
  };
  setSelectionRange(internalSelection, 5, 8);
  assert.deepEqual(calls, [[5, 8]]);
});

test("readMathFieldValue and writeMathFieldValue support fallback paths", () => {
  assert.equal(
    readMathFieldValue({
      getValue: () => {
        throw new Error("unavailable");
      },
      value: "fallback",
    }),
    "fallback"
  );

  const writeTarget = {
    setValue: () => {
      throw new Error("blocked");
    },
    value: "",
  };
  writeMathFieldValue(writeTarget, "next");
  assert.equal(writeTarget.value, "next");
});

test("placeholder navigator moves by prompt ranges in both directions", () => {
  const { moveMathFieldPlaceholder } = createPlaceholderNavigator();
  const host = {
    selection: [0, 0],
    lastOffset: 12,
    getPrompts: () => ["p1", "p2"],
    getPromptRange: (id) => (id === "p1" ? [2, 4] : [6, 8]),
    focusCalls: 0,
    focus() {
      this.focusCalls += 1;
    },
  };

  assert.equal(moveMathFieldPlaceholder(host, "forward"), true);
  assert.deepEqual(host.selection, [2, 4]);

  host.selection = [12, 12];
  assert.equal(moveMathFieldPlaceholder(host, "backward"), true);
  assert.deepEqual(host.selection, [6, 8]);
  assert.equal(host.focusCalls >= 2, true);
});

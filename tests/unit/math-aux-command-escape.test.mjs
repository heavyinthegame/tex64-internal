import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeMathAuxCommands,
  encodeMathAuxCommands,
  encodeMathAuxCommandsWithCursor,
} from "../../Resources/web/app/blocks/math-aux-command-escape.js";

test("encode/decode round-trip for auxiliary math commands", () => {
  const source = [
    "\\begin{aligned}",
    "x+1 &= 4",
    "\\label{eq:row1}",
    "\\tag{A1}",
    "\\tag*{B2}",
    "\\notag",
    "\\nonumber",
    "\\eqref{eq:row1}",
    "\\ref{sec:intro}",
    "\\pageref{sec:intro}",
    "\\autoref{sec:intro}",
    "\\intertext{text}",
    "\\shortintertext{short}",
    "\\end{aligned}",
  ].join("\\\\");

  const encoded = encodeMathAuxCommands(source);

  assert.ok(encoded.includes("\\txlbl{eq:row1}"));
  assert.ok(encoded.includes("\\txtag{A1}"));
  assert.ok(encoded.includes("\\txtgs{B2}"));
  assert.ok(encoded.includes("\\txntg"));
  assert.ok(encoded.includes("\\txnnum"));
  assert.ok(encoded.includes("\\txeqr{eq:row1}"));
  assert.ok(encoded.includes("\\txref{sec:intro}"));
  assert.ok(encoded.includes("\\txpgrf{sec:intro}"));
  assert.ok(encoded.includes("\\txatrf{sec:intro}"));
  assert.ok(encoded.includes("\\txintr{text}"));
  assert.ok(encoded.includes("\\txshintr{short}"));

  assert.equal(decodeMathAuxCommands(encoded), source);
});

test("encode normalizes bare and lbrace/rbrace auxiliary arguments", () => {
  assert.equal(
    encodeMathAuxCommands("\\label eq:newton"),
    "\\txlbl{eq:newton}"
  );
  assert.equal(
    encodeMathAuxCommands("\\label sec/intro+alpha@v1"),
    "\\txlbl{sec/intro+alpha@v1}"
  );
  assert.equal(
    encodeMathAuxCommands("\\label\\lbrace eq:newton\\rbrace"),
    "\\txlbl{eq:newton}"
  );
  assert.equal(
    encodeMathAuxCommands("\\intertext long bare phrase with spaces"),
    "\\txintr{long bare phrase with spaces}"
  );
  assert.equal(
    encodeMathAuxCommands("\\tag *{A-1}"),
    "\\txtgs{A-1}"
  );
});

test("intertext bare argument keeps embedded begin/end fragments in inline prose", () => {
  assert.equal(
    encodeMathAuxCommands("\\intertext note:\\begin{cases}literal\\end{cases}"),
    "\\txintr{note:\\begin{cases}literal\\end{cases}}"
  );
});

test("intertext bare argument keeps plain ampersand prose without truncation", () => {
  assert.equal(
    encodeMathAuxCommands("\\intertext text with & symbol and more"),
    "\\txintr{text with & symbol and more}"
  );
});

test("encode with cursor defers bare-arg normalization while caret is editing", () => {
  const source = "\\label eq:newton";
  const sourceCursor = source.length;
  const result = encodeMathAuxCommandsWithCursor(source, sourceCursor);

  assert.equal(result.changed, false);
  assert.equal(result.value, source);
  assert.equal(result.cursorIndex, sourceCursor);
});

test("encode with cursor can finalize bare-arg normalization when requested", () => {
  const source = "\\label eq:newton";
  const sourceCursor = source.length;
  const result = encodeMathAuxCommandsWithCursor(source, sourceCursor, {
    finalizeBare: true,
  });

  assert.equal(result.changed, true);
  assert.equal(result.value, "\\txlbl{eq:newton}");
});

test("encode leaves unrelated commands unchanged", () => {
  const source = "\\operatorname{Var}(X)+\\unknownmacro{a}";
  assert.equal(encodeMathAuxCommands(source), source);
  assert.equal(decodeMathAuxCommands(source), source);
});

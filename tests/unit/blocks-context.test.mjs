import assert from "node:assert/strict";
import test from "node:test";

import {
  getInnerContent,
  parseBlockContext,
  reconstructionBlock,
} from "../../Resources/web/app/blocks/context.js";

test("parseBlockContext keeps optional+required args on array wrappers", () => {
  const snippet = "\\begin{array}[t]{@{}rcl@{}}a&=&b\\\\c&=&d\\end{array}";
  const context = parseBlockContext(snippet);

  assert.equal(context.prefix, "\\begin{array}[t]{@{}rcl@{}}");
  assert.equal(context.suffix, "\\end{array}");
  assert.equal(getInnerContent(context, { trim: false }), "a&=&b\\\\c&=&d");
});

test("parseBlockContext keeps optional+required args on IEEE wrappers", () => {
  const eqnarray = parseBlockContext(
    "\\begin{IEEEeqnarray}[c]{rCl}x&=&y\\\\u&=&v\\end{IEEEeqnarray}"
  );
  assert.equal(eqnarray.prefix, "\\begin{IEEEeqnarray}[c]{rCl}");
  assert.equal(eqnarray.suffix, "\\end{IEEEeqnarray}");
  assert.equal(getInnerContent(eqnarray, { trim: false }), "x&=&y\\\\u&=&v");

  const eqnarraybox = parseBlockContext(
    "\\begin{IEEEeqnarraybox}[c][s]{rCl}a&=&b\\end{IEEEeqnarraybox}"
  );
  assert.equal(eqnarraybox.prefix, "\\begin{IEEEeqnarraybox}[c][s]{rCl}");
  assert.equal(eqnarraybox.suffix, "\\end{IEEEeqnarraybox}");
  assert.equal(getInnerContent(eqnarraybox, { trim: false }), "a&=&b");
});

test("reconstructionBlock preserves optional wrapper args after inner edit", () => {
  const snippet = "\\begin{array}[b]{cc}p&q\\\\r&s\\end{array}";
  const context = parseBlockContext(snippet);
  const rebuilt = reconstructionBlock(context, "Z&p\\\\r&s");

  assert.equal(rebuilt, "\\begin{array}[b]{cc}Z&p\\\\r&s\\end{array}");
});

test("parseBlockContext keeps starred matrix optional arg wrappers", () => {
  const snippet = "\\begin{pmatrix*}[r]a&b\\\\c&d\\end{pmatrix*}";
  const context = parseBlockContext(snippet);

  assert.equal(context.prefix, "\\begin{pmatrix*}[r]");
  assert.equal(context.suffix, "\\end{pmatrix*}");
  assert.equal(getInnerContent(context, { trim: false }), "a&b\\\\c&d");
});

test("parseBlockContext consumes registered env args without leaking into body", () => {
  const cases = [
    ["\\begin{alignat}{2}", "\\end{alignat}"],
    ["\\begin{xalignat}{2}", "\\end{xalignat}"],
    ["\\begin{xxalignat}{2}", "\\end{xxalignat}"],
    ["\\begin{alignedat}[t]{2}", "\\end{alignedat}"],
    ["\\begin{numcases}{f(x)=}", "\\end{numcases}"],
    ["\\begin{subnumcases}{g(x)=}", "\\end{subnumcases}"],
    ["\\begin{subarray}[t]{l}", "\\end{subarray}"],
    ["\\begin{darray}{rcl}", "\\end{darray}"],
    ["\\begin{IEEEeqnarray}[c]{rCl}", "\\end{IEEEeqnarray}"],
    ["\\begin{IEEEeqnarraybox}[c][s]{rCl}", "\\end{IEEEeqnarraybox}"],
    ["\\begin{mathparpagebreakable}[allowdisplaybreaks]", "\\end{mathparpagebreakable}"],
    ["\\begin{empheq}[left=\\\\empheqlbrace]{align}", "\\end{empheq}"],
  ];

  cases.forEach(([prefix, suffix]) => {
    const snippet = `${prefix}A${suffix}`;
    const context = parseBlockContext(snippet);
    assert.equal(context.prefix, prefix);
    assert.equal(context.suffix, suffix);
    assert.equal(getInnerContent(context, { trim: false }), "A");
  });
});

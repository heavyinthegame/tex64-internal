import assert from "node:assert/strict";
import test from "node:test";

import { createLatexBlockDetector } from "../../Resources/web/app/blocks/detect.js";

const createDetector = () =>
  createLatexBlockDetector({
    isEnvDisabled: () => false,
    isMathEnvName: () => true,
  });

test("detectLatexBlockAtOffset prefers innermost environment for nested math", () => {
  const detector = createDetector();
  const text =
    "\\begin{equation}x+\\begin{aligned}a&=b\\\\c&=d\\end{aligned}+y\\end{equation}";
  const offset = text.indexOf("a&=b") + 1;
  const detected = detector.detectLatexBlockAtOffset(text, offset);

  assert.ok(detected);
  assert.equal(detected?.envName, "aligned");
});

test("detectLatexBlockInRange prefers innermost containing block", () => {
  const detector = createDetector();
  const text =
    "\\begin{equation}x+\\begin{aligned}a&=b\\\\c&=d\\end{aligned}+y\\end{equation}";
  const start = text.indexOf("a&=b");
  const end = start + 2;
  const detected = detector.detectLatexBlockInRange(text, start, end);

  assert.ok(detected);
  assert.equal(detected?.envName, "aligned");
});

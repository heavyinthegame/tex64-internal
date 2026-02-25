import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { BuildService } = require("../../electron/services/build.cjs");

test("BuildService parses Package ... Error as error severity", () => {
  const service = new BuildService();
  const output = [
    "(./main.tex",
    "Class revtex4-2 Warning: No type size specified, using default 10.",
    "Package xypdf Error: pdfTeX version 1.40.0 or higher is needed for the xypdf",
    "package with PDF output.",
  ].join("\n");

  const issues = service.parseIssues(output, "/tmp/workspace");
  assert.ok(issues.length >= 2);
  assert.equal(issues[0].severity, "error");

  const packageError = issues.find((issue) => /package\s+xypdf\s+error:/i.test(issue.message));
  assert.ok(packageError, "package error should be captured");
  assert.equal(packageError.severity, "error");
  assert.equal(packageError.path, "main.tex");

  const warning = issues.find((issue) => /no type size specified/i.test(issue.message));
  assert.ok(warning, "warning line should still be captured");
  assert.equal(warning.severity, "warning");
});

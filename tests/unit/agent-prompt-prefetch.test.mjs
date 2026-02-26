import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  buildSystemPrompt,
  extractMentionedPaths,
  extractTextFromParts,
  resolvePrefetchMaxChars,
} = require("../../electron/services/agent.cjs");

test("extractMentionedPaths finds .tex in Japanese text without spaces", () => {
  assert.deepEqual(extractMentionedPaths("main.texです"), ["main.tex"]);
});

test("extractMentionedPaths returns unique normalized paths", () => {
  assert.deepEqual(
    extractMentionedPaths("main.tex と chapters/intro.tex と main.tex"),
    ["main.tex", "chapters/intro.tex"]
  );
});

test("extractTextFromParts joins only text parts", () => {
  assert.equal(
    extractTextFromParts([
      { text: "a" },
      { inlineData: { mimeType: "image/png", data: "abc" } },
      { text: "b" },
    ]),
    "a\nb"
  );
});

test("resolvePrefetchMaxChars clamps values safely", () => {
  assert.equal(resolvePrefetchMaxChars({}), 12_000);
  assert.equal(resolvePrefetchMaxChars({ openFileMaxChars: 1000 }), 2_000);
  assert.equal(resolvePrefetchMaxChars({ openFileMaxChars: 30_000 }), 30_000);
  assert.equal(resolvePrefetchMaxChars({ openFileMaxChars: 0 }), 50_000);
  assert.equal(resolvePrefetchMaxChars({ openFileMaxChars: 60_000 }), 50_000);
});

test("buildSystemPrompt includes referenced file snapshots and root main tex", () => {
  const prompt = buildSystemPrompt(
    {
      activeFilePath: "",
      openFiles: [],
      contextControls: { includeSelection: false, includeOpenFiles: true, includeIssues: true },
    },
    "/workspace",
    {
      maxFileBytes: Number.POSITIVE_INFINITY,
      maxReadFiles: 16,
      blockedTopLevel: new Set(),
      allowedTopLevel: new Set(),
      textExtensions: null,
    },
    { allowRunCommand: false },
    {
      rootFileInfo: { path: "main.tex", source: "auto" },
      referencedFileSnapshots: [
        {
          path: "main.tex",
          content: "\\\\documentclass{article}",
          partial: true,
          contentLength: 20_000,
          source: "disk",
        },
      ],
      referencedFileErrors: [{ path: "missing.tex", error: "ファイルが見つかりません。" }],
    }
  );

  assert.match(prompt, /Root main tex: main\.tex/);
  assert.match(prompt, /## Referenced files \(unavailable\)/);
  assert.match(prompt, /missing\.tex: ファイルが見つかりません。/);
  assert.match(prompt, /## Referenced file snapshots/);
  assert.match(prompt, /### main\.tex/);
  assert.match(prompt, /documentclass\{article\}/);
});

test("buildSystemPrompt includes empty active file snapshot when provided", () => {
  const prompt = buildSystemPrompt(
    {
      activeFilePath: "empty.tex",
      activeFileContent: "",
      activeFileIsDirty: false,
      activeFileContentTruncated: false,
      openFiles: [],
      contextControls: { includeSelection: false, includeOpenFiles: true, includeIssues: true },
    },
    "/workspace",
    {
      maxFileBytes: Number.POSITIVE_INFINITY,
      maxReadFiles: 16,
      blockedTopLevel: new Set(),
      allowedTopLevel: new Set(),
      textExtensions: null,
    },
    { allowRunCommand: false },
    {}
  );

  assert.match(prompt, /## Active file snapshot/);
  assert.match(prompt, /- Active file: empty\.tex/);
});

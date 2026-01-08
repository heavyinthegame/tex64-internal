import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  launchApp,
  createTempDir,
  writeWorkspaceFile,
  removeDir,
} from "./helpers.js";

const BASE_MAIN = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Line1",
  "Line2",
  "Line3",
  "Line4",
  "Line5",
  "Line6",
  "Line7",
  "\\end{document}",
  "",
].join("\n");

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("#file-tree");
  await page.waitForSelector('button.file-item[data-path="main.tex"]');
  await page.waitForFunction(() => !!window.__tex180Editor);
  await page.waitForSelector('.editor-tab.is-active[data-path="main.tex"]');
};

const createWorkspace = async ({ files = {}, folders = [] } = {}) => {
  const root = await createTempDir("diff-");
  const mergedFiles = { "main.tex": BASE_MAIN, ...files };
  for (const folder of folders) {
    await fs.mkdir(path.join(root, folder), { recursive: true });
  }
  await Promise.all(
    Object.entries(mergedFiles).map(([relativePath, content]) =>
      writeWorkspaceFile(root, relativePath, content)
    )
  );
  return root;
};

const withWorkspaceApp = async (setup, run, { env } = {}) => {
  const root = await createWorkspace(setup);
  const { electronApp, page } = await launchApp({ workspacePath: root, env });
  await waitForWorkspaceReady(page);
  try {
    return await run({ electronApp, page, root });
  } finally {
    await electronApp.close();
    await removeDir(root);
  }
};

const openBlocksTab = async (page) => {
  await page.click('.tab[data-tab="blocks"]');
  await expect(page.locator('.panel[data-panel="blocks"]')).toHaveClass(/is-active/);
};

const setEditorValue = async (page, value) => {
  await page.evaluate((content) => {
    window.__tex180Editor?.setValue?.(content);
  }, value);
};

const getEditorValue = async (page) =>
  page.evaluate(() => window.__tex180Editor?.getValue?.() ?? "");

const setEditorCursor = async (page, lineNumber, column) => {
  await page.evaluate(
    ({ lineNumber: line, column: col }) => {
      const editor = window.__tex180Editor;
      editor?.setPosition?.({ lineNumber: line, column: col });
      editor?.revealLine?.(line);
      editor?.focus?.();
    },
    { lineNumber, column }
  );
};

const stubMathField = async (page) => {
  await page.waitForSelector("#block-math-input");
  await page.evaluate(() => {
    const field = document.querySelector("#block-math-input");
    if (!field) {
      return;
    }
    if (typeof field.value !== "string") {
      field.value = "";
    }
    field.getValue = () => field.value;
    field.setValue = (value) => {
      field.value = value;
    };
    field.executeCommand = (command, value) => {
      if (command !== "insert") {
        return false;
      }
      const next = typeof value === "string" ? value : "";
      field.value = `${field.value ?? ""}${next}`;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };
    field.insert = undefined;
  });
};

const setMathInputValue = async (page, value) => {
  await page.evaluate((nextValue) => {
    const field = document.querySelector("#block-math-input");
    if (!field) {
      return;
    }
    if (typeof field.setValue === "function") {
      field.setValue(nextValue);
    } else {
      field.value = nextValue;
    }
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
};

const waitForLastDiff = async (page) =>
  expect
    .poll(() => page.evaluate(() => (window.__tex180LastDiff ? 1 : 0)))
    .toBe(1);

const getLastDiff = async (page) =>
  page.evaluate(() => window.__tex180LastDiff ?? null);

const waitForAutoDetect = async (page) =>
  expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .querySelector(".blocks-panel")
            ?.classList.contains("is-auto-detected") ?? false
      )
    )
    .toBe(true);

const openDiff = async (page, formula) => {
  await openBlocksTab(page);
  await stubMathField(page);
  await page.evaluate(() => {
    window.__tex180LastDiff = null;
  });
  await setMathInputValue(page, formula);
  await page.click("#block-insert-button");
  await waitForLastDiff(page);
  return getLastDiff(page);
};

const setFormatOption = async (page, format) => {
  await page.click("#block-format-button");
  await page.click(`#block-format-menu .block-format-option[data-format="${format}"]`);
};

const setDiffEditorModels = async (page, { original, modified }) =>
  page.evaluate(
    ({ left, right }) => {
      const diffEditor = window.__tex180DiffEditor;
      const monaco = window.monaco;
      if (!diffEditor || !monaco?.editor?.createModel) {
        return 0;
      }
      const originalModel = monaco.editor.createModel(left, "latex");
      const modifiedModel = monaco.editor.createModel(right, "latex");
      diffEditor.setModel({ original: originalModel, modified: modifiedModel });
      window.__tex180LastDiff = { original: left, modified: right, lineOffset: 0 };
      return diffEditor.getLineChanges?.()?.length ?? 0;
    },
    { left: original, right: modified }
  );

test("T10-01 diff modal opens", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openDiff(page, "x+y");
    await expect(page.locator("#diff-modal")).toHaveClass(/is-open/);
  });
});

test("T10-02 diff header shows file and summary", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openDiff(page, "x+y");
    await expect(page.locator("#diff-file-name")).toHaveText("main.tex");
    await expect(page.locator("#diff-summary")).toContainText("+");
    await expect(page.locator("#diff-summary")).toContainText("-");
  });
});

test("T10-03 diff summary shows no changes", async () => {
  const content = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Text $a$ end.",
    "\\end{document}",
    "",
  ].join("\n");
  await withWorkspaceApp({ files: { "main.tex": content } }, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setEditorCursor(page, 3, 8);
    await waitForAutoDetect(page);
    await openDiff(page, "a");
    await expect(page.locator("#diff-summary")).toHaveText("\u5909\u66f4\u306a\u3057");
  });
});

test("T10-04 cancel keeps content unchanged", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    const before = await getEditorValue(page);
    await openDiff(page, "x+y");
    await page.click("#diff-modal-cancel");
    await expect(page.locator("#diff-modal")).not.toHaveClass(/is-open/);
    expect(await getEditorValue(page)).toBe(before);
  });
});

test("T10-05 submit applies changes", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openDiff(page, "x+y");
    await page.click("#diff-modal-submit");
    await expect.poll(() => getEditorValue(page)).toContain("$x+y$");
  });
});

test("T10-06 diff context shows 3 lines before/after", async () => {
  const lines = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Line1",
    "Line2",
    "Line3",
    "Line4",
    "Line5",
    "Line6",
    "Line7",
    "\\end{document}",
    "",
  ];
  const content = lines.join("\n");
  await withWorkspaceApp({ files: { "main.tex": content } }, async ({ page }) => {
    await setEditorValue(page, content);
    await setEditorCursor(page, 5, 1);
    const diff = await openDiff(page, "x+y");
    const expected = lines.slice(1, 8).join("\n");
    expect(diff.original).toBe(expected);
    expect(diff.lineOffset).toBe(1);
  });
});

test("T10-07 inline math change keeps line numbers", async () => {
  const content = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Inline $\\alpha$ text.",
    "\\end{document}",
    "",
  ].join("\n");
  await withWorkspaceApp({ files: { "main.tex": content } }, async ({ page }) => {
    await setEditorValue(page, content);
    await setEditorCursor(page, 3, 12);
    await waitForAutoDetect(page);
    const diff = await openDiff(page, "\\beta");
    expect(diff.original).toContain("\\alpha");
    expect(diff.modified).toContain("\\beta");
  });
});

test("T10-08 multiline env change preserves context", async () => {
  const content = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\begin{align}",
    "a &= b",
    "c &= d",
    "\\end{align}",
    "\\end{document}",
    "",
  ].join("\n");
  await withWorkspaceApp({ files: { "main.tex": content } }, async ({ page }) => {
    await setEditorValue(page, content);
    await setEditorCursor(page, 4, 3);
    await waitForAutoDetect(page);
    const diff = await openDiff(page, "x &= y");
    expect(diff.original).toContain("a &= b");
    expect(diff.modified).toContain("x &= y");
  });
});

test("T10-09 diff context handles file start/end", async () => {
  const content = ["First line", "Middle", "Last line", ""].join("\n");
  await withWorkspaceApp({ files: { "main.tex": content } }, async ({ page }) => {
    await setEditorValue(page, content);
    await setEditorCursor(page, 1, 1);
    const startDiff = await openDiff(page, "x");
    expect(startDiff.lineOffset).toBe(0);
    await page.click("#diff-modal-cancel");
    await setEditorCursor(page, 3, 1);
    const endDiff = await openDiff(page, "y");
    expect(endDiff.original).toContain("Last line");
  });
});

test("T10-10 display math insertion shows brackets", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setFormatOption(page, "display-bracket");
    await page.evaluate(() => {
      window.__tex180LastDiff = null;
    });
    await setMathInputValue(page, "x+y");
    await page.click("#block-insert-button");
    await waitForLastDiff(page);
    const diff = await getLastDiff(page);
    expect(diff.modified).toContain("\\[");
    expect(diff.modified).toContain("\\]");
  });
});

test("T10-11 diff shows deletions when block shrinks", async () => {
  const content = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\[",
    "a+b",
    "c+d",
    "\\]",
    "\\end{document}",
    "",
  ].join("\n");
  await withWorkspaceApp({ files: { "main.tex": content } }, async ({ page }) => {
    await setEditorValue(page, content);
    await setEditorCursor(page, 4, 2);
    await waitForAutoDetect(page);
    const diff = await openDiff(page, "a+b");
    expect(diff.original).toContain("c+d");
    expect(diff.modified).not.toContain("c+d");
  });
});

test("T10-12 diff shows multiple change hunks", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openDiff(page, "x+y");
    const original = ["Line1", "Line2", "Line3", "Line4", ""].join("\n");
    const modified = ["Line1", "Line2x", "Line3", "Line4y", ""].join("\n");
    const changeCount = await setDiffEditorModels(page, { original, modified });
    expect(changeCount).toBe(2);
  });
});

test("T10-13 diff includes comment lines", async () => {
  const content = [
    "% before",
    "$a$",
    "% after",
    "",
  ].join("\n");
  await withWorkspaceApp({ files: { "main.tex": content } }, async ({ page }) => {
    await setEditorValue(page, content);
    await setEditorCursor(page, 2, 2);
    await waitForAutoDetect(page);
    const diff = await openDiff(page, "b");
    expect(diff.original).toContain("% before");
    expect(diff.original).toContain("% after");
  });
});

test("T10-14 diff highlights indentation changes", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openDiff(page, "x+y");
    const original = ["  $a$", ""].join("\n");
    const modified = ["    $a$", ""].join("\n");
    await setDiffEditorModels(page, { original, modified });
    const diff = await getLastDiff(page);
    expect(diff.original).toContain("  $a$");
    expect(diff.modified).toContain("    $a$");
  });
});

test("T10-15 diff shows env name changes", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openDiff(page, "x+y");
    const original = ["\\begin{align}", "a &= b", "\\end{align}", ""].join("\n");
    const modified = [
      "\\begin{aligned}",
      "a &= b",
      "\\end{aligned}",
      "",
    ].join("\n");
    await setDiffEditorModels(page, { original, modified });
    const diff = await getLastDiff(page);
    expect(diff.original).toContain("\\begin{align}");
    expect(diff.modified).toContain("\\begin{aligned}");
  });
});

test("T10-16 long line stays single-line", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openDiff(page, "x+y");
    const longLine = "a".repeat(200);
    const original = `${longLine}\n`;
    const modified = `${longLine}b\n`;
    await setDiffEditorModels(page, { original, modified });
    const diff = await getLastDiff(page);
    expect(diff.modified.trimEnd()).toBe(modified.trimEnd());
  });
});

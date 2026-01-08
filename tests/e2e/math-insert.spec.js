import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  launchApp,
  createTempDir,
  writeWorkspaceFile,
  removeDir,
  removeTempRoot,
} from "./helpers.js";

const BASE_MAIN = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Hello",
  "",
  "\\end{document}",
  "",
].join("\n");

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("#file-tree");
  await page.waitForSelector('button.file-item[data-path="main.tex"]');
  await page.waitForFunction(() => !!window.__tex64Editor);
  await page.waitForSelector('.editor-tab.is-active[data-path="main.tex"]');
};

const createWorkspace = async ({ files = {} } = {}) => {
  const root = await createTempDir("math-insert-");
  const mergedFiles = { "main.tex": BASE_MAIN, ...files };
  await Promise.all(
    Object.entries(mergedFiles).map(([relativePath, content]) =>
      writeWorkspaceFile(root, relativePath, content)
    )
  );
  return root;
};

const withWorkspaceApp = async (run) => {
  const root = await createWorkspace();
  const { electronApp, page } = await launchApp({ workspacePath: root });
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

const stubMathField = async (page) => {
  await page.waitForSelector("#block-math-input");
  await page.evaluate(() => {
    const field = document.querySelector("#block-math-input");
    if (!field) {
      return;
    }
    const isMathField = field.tagName?.toLowerCase() === "math-field";
    const hasNativeApi =
      typeof field.getValue === "function" ||
      typeof field.setValue === "function" ||
      typeof field.executeCommand === "function";
    if (isMathField && hasNativeApi) {
      return;
    }
    if (typeof field.__e2eValue !== "string") {
      field.__e2eValue = "";
    }
    if (typeof field.getValue !== "function") {
      field.getValue = () => field.__e2eValue;
    }
    if (typeof field.setValue !== "function") {
      field.setValue = (value) => {
        field.__e2eValue = typeof value === "string" ? value : "";
      };
    }
    if (typeof field.executeCommand !== "function") {
      field.executeCommand = (command, value) => {
        if (command !== "insert") {
          return false;
        }
        const next = typeof value === "string" ? value : "";
        field.__e2eValue = `${field.__e2eValue ?? ""}${next}`;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      };
    }
    if (field.insert) {
      field.insert = undefined;
    }
  });
};

const setMathInputFallback = async (page, value) => {
  await page.evaluate((nextValue) => {
    window.__tex64SetMathInputFallback?.(nextValue);
  }, value);
};

const setMathInputValue = async (page, value) => {
  await page.evaluate((nextValue) => {
    const field = document.querySelector("#block-math-input");
    if (!field) {
      return;
    }
    if (typeof field.setValue === "function") {
      try {
        field.setValue(nextValue);
      } catch {
        if (typeof field.__e2eValue === "string") {
          field.__e2eValue = nextValue;
        } else if (typeof field.value === "string") {
          field.value = nextValue;
        }
      }
    } else if (typeof field.__e2eValue === "string") {
      field.__e2eValue = nextValue;
    } else if (typeof field.value === "string") {
      field.value = nextValue;
    }
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
};

const getMathInputValue = async (page) =>
  page.evaluate(() => window.__tex64GetMathInputValue?.() ?? "");

const setMathInputValueForInsert = async (page, value) => {
  await setMathInputFallback(page, value);
  await setMathInputValue(page, value);
  await expect.poll(() => getMathInputValue(page)).toBe(value);
};

const setInsertMode = async (page, mode) => {
  await page.click("#block-format-button");
  await page.click(`.block-format-option[data-format="${mode}"]`);
};

const setInsertSettings = async (
  page,
  { inlineWrap, displayWrap } = { inlineWrap: null, displayWrap: null }
) => {
  if (!inlineWrap && !displayWrap) {
    return;
  }
  await page.click("#block-settings-button");
  await expect(page.locator("#block-settings-modal")).toHaveClass(/is-open/);
  await page.click('.block-settings-item[data-block-settings-target="insert-format"]');
  if (inlineWrap) {
    await page.click(`.block-settings-option[data-inline-format="${inlineWrap}"]`);
  }
  if (displayWrap) {
    await page.click(`.block-settings-option[data-display-format="${displayWrap}"]`);
  }
  await page.click("#block-settings-close");
  await expect(page.locator("#block-settings-modal")).not.toHaveClass(/is-open/);
};

const setEditorValue = async (page, value) => {
  await page.evaluate((content) => {
    window.__tex64Editor?.setValue?.(content);
  }, value);
};

const setEditorCursor = async (page, lineNumber, column) => {
  await page.evaluate(
    ({ lineNumber: line, column: col }) => {
      const editor = window.__tex64Editor;
      editor?.setPosition?.({ lineNumber: line, column: col });
      editor?.revealLine?.(line);
      editor?.focus?.();
    },
    { lineNumber, column }
  );
};

const resetEditorForInsert = async (page) => {
  await setEditorValue(page, BASE_MAIN);
  await setEditorCursor(page, 4, 1);
};

const getEditorValue = async (page) =>
  page.evaluate(() => window.__tex64Editor?.getValue?.() ?? "");

const applyInsert = async (page) => {
  await page.click("#block-insert-button");
  await expect(page.locator("#diff-modal")).toHaveClass(/is-open/);
  await page.click("#diff-modal-submit");
  await expect(page.locator("#diff-modal")).not.toHaveClass(/is-open/);
};

test.beforeAll(async () => {
  await removeTempRoot();
});

test.afterAll(async () => {
  await removeTempRoot();
});

test("math insert inline paren uses single backslashes", async () => {
  await withWorkspaceApp(async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setInsertSettings(page, { inlineWrap: "inline-paren" });
    await setInsertMode(page, "inline");
    await resetEditorForInsert(page);
    await setMathInputValueForInsert(page, "x+y");
    await applyInsert(page);
    const value = await getEditorValue(page);
    expect(value).toContain("\\(x+y\\)");
    expect(value).not.toContain("\\\\(x+y\\\\)");
  });
});

test("math insert display bracket uses single backslashes", async () => {
  await withWorkspaceApp(async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setInsertSettings(page, { displayWrap: "display-bracket" });
    await setInsertMode(page, "display");
    await resetEditorForInsert(page);
    await setMathInputValueForInsert(page, "a=b+c");
    await applyInsert(page);
    const value = await getEditorValue(page);
    expect(value).toContain("\\[");
    expect(value).toContain("\\]");
    expect(value).not.toContain("\\\\[");
  });
});

test("math insert align wraps in align* environment", async () => {
  await withWorkspaceApp(async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setInsertMode(page, "align");
    await resetEditorForInsert(page);
    await setMathInputValueForInsert(page, "a &= b");
    await applyInsert(page);
    const value = await getEditorValue(page);
    expect(value).toContain("\\begin{align*}");
    expect(value).toContain("\\end{align*}");
    expect(value).not.toContain("\\\\begin{align*}");
  });
});

test("math insert gather wraps in gather* environment", async () => {
  await withWorkspaceApp(async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setInsertMode(page, "gather");
    await resetEditorForInsert(page);
    await setMathInputValueForInsert(page, "a=b+c");
    await applyInsert(page);
    const value = await getEditorValue(page);
    expect(value).toContain("\\begin{gather*}");
    expect(value).toContain("\\end{gather*}");
    expect(value).not.toContain("\\\\begin{gather*}");
  });
});

test("math insert none keeps raw formula", async () => {
  await withWorkspaceApp(async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setInsertMode(page, "none");
    await resetEditorForInsert(page);
    await setMathInputValueForInsert(page, "raw+value");
    await applyInsert(page);
    const value = await getEditorValue(page);
    expect(value).toContain("raw+value");
    expect(value).not.toContain("$raw+value$");
    expect(value).not.toContain("\\(raw+value\\)");
    expect(value).not.toContain("\\[");
    expect(value).not.toContain("\\]");
  });
});

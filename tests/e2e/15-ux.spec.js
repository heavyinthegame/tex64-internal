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
  "Main",
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
  const root = await createTempDir("ux-");
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

const openFileFromTree = async (page, filePath) => {
  const selector = `button.file-item[data-path="${filePath}"]`;
  await page.waitForSelector(selector);
  await page.click(selector);
  await page.waitForSelector(`${selector}.is-active`);
  await page.waitForSelector(`.editor-tab.is-active[data-path="${filePath}"]`);
};

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

const getEditorValue = async (page) =>
  page.evaluate(() => window.__tex180Editor?.getValue?.() ?? "");

const simulateComposition = async (page, text) => {
  await page.evaluate((value) => {
    const editor = window.__tex180Editor;
    const selection = editor?.getSelection?.();
    if (selection && editor?.executeEdits) {
      editor.executeEdits("ime-test", [
        { range: selection, text: value, forceMoveMarkers: true },
      ]);
    }
    const host = document.getElementById("editor");
    if (!host) {
      return;
    }
    host.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    host.dispatchEvent(new CompositionEvent("compositionupdate", { data: value }));
    host.dispatchEvent(new CompositionEvent("compositionend", { data: "" }));
  }, text);
};

const openBlocksTab = async (page) => {
  await page.click('.tab[data-tab="blocks"]');
  await expect(page.locator('.panel[data-panel="blocks"]')).toHaveClass(/is-active/);
};

test("T15-01 IME composition survives tab switch", async () => {
  await withWorkspaceApp({ files: { "notes.tex": "Notes" } }, async ({ page }) => {
    await openFileFromTree(page, "notes.tex");
    await openFileFromTree(page, "main.tex");
    await setEditorCursor(page, 3, 1);
    await simulateComposition(page, "IME");
    await openFileFromTree(page, "notes.tex");
    await openFileFromTree(page, "main.tex");
    expect(await getEditorValue(page)).toContain("IME");
  });
});

test("T15-02 IME composition survives folder toggle", async () => {
  await withWorkspaceApp(
    { files: { "sections/intro.tex": "Intro" }, folders: ["sections"] },
    async ({ page }) => {
      await setEditorCursor(page, 3, 1);
      await simulateComposition(page, "IME");
      await page.click('details.file-folder[data-path="sections"] > summary');
      expect(await getEditorValue(page)).toContain("IME");
    }
  );
});

test("T15-03 context menu opens on right click", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await page.click('button.file-item[data-path="main.tex"]', { button: "right" });
    await expect(page.locator("#context-menu")).toHaveClass(/is-open/);
    await expect(page.locator("#context-menu")).toHaveAttribute("aria-hidden", "false");
  });
});

test("T15-04 context menu closes on outside/scroll/resize", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await page.click('button.file-item[data-path="main.tex"]', { button: "right" });
    await expect(page.locator("#context-menu")).toHaveClass(/is-open/);
    await page.click("#editor");
    await expect(page.locator("#context-menu")).not.toHaveClass(/is-open/);

    await page.click('button.file-item[data-path="main.tex"]', { button: "right" });
    await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
    await expect(page.locator("#context-menu")).not.toHaveClass(/is-open/);

    await page.click('button.file-item[data-path="main.tex"]', { button: "right" });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await expect(page.locator("#context-menu")).not.toHaveClass(/is-open/);
  });
});

test("T15-05 context menu closes on Escape", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await page.click('button.file-item[data-path="main.tex"]', { button: "right" });
    await expect(page.locator("#context-menu")).toHaveClass(/is-open/);
    await page.keyboard.press("Escape");
    await expect(page.locator("#context-menu")).not.toHaveClass(/is-open/);
  });
});

test("T15-06 math input stops editor keydown", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await page.waitForSelector("#block-math-input");
    await page.evaluate(() => {
      window.__e2eEditorKeydownCount = 0;
      const host = document.getElementById("editor");
      host?.addEventListener("keydown", () => {
        window.__e2eEditorKeydownCount += 1;
      });
    });
    await page.click("#block-math-input");
    await page.keyboard.type("a");
    await expect
      .poll(() => page.evaluate(() => window.__e2eEditorKeydownCount))
      .toBe(0);
  });
});

test("T15-07 resizer disables editor pointer events", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await page.hover("#resizer");
    await page.mouse.down();
    await expect(page.locator("#editor")).toHaveCSS("pointer-events", "none");
    await page.mouse.up();
    await expect(page.locator("#editor")).not.toHaveCSS("pointer-events", "none");
  });
});

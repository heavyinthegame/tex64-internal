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

const TEXT = {
  bullet: "\u25cf",
  errors: {
    noSelection: "\u4fdd\u5b58\u3059\u308b\u30d5\u30a1\u30a4\u30eb\u304c\u9078\u629e\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002",
    nonText: "\u3053\u306e\u30d5\u30a1\u30a4\u30eb\u5f62\u5f0f\u306f\u7de8\u96c6\u3067\u304d\u307e\u305b\u3093\u3002",
    latexindentMissing: "\u006c\u0061\u0074\u0065\u0078\u0069\u006e\u0064\u0065\u006e\u0074\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3002",
    invalidEncoding: "\u0055\u0054\u0046\u002d\u0038\u4ee5\u5916\u306e\u6587\u5b57\u30b3\u30fc\u30c9\u3067\u3059\u3002",
  },
  miniOutlinePrefix: "\u30df\u30cb\u30a2\u30a6\u30c8\u30e9\u30a4\u30f3: ",
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("#file-tree");
  await page.waitForSelector('button.file-item[data-path="main.tex"]');
  await page.waitForFunction(() => !!window.__tex180Editor);
  await page.waitForSelector('.editor-tab.is-active[data-path="main.tex"]');
};

const createWorkspace = async ({ files = {}, folders = [] } = {}) => {
  const root = await createTempDir("workspace-");
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

const clickFileInTree = async (page, filePath) => {
  const selector = `button.file-item[data-path="${filePath}"]`;
  await page.waitForSelector(selector);
  await page.click(selector);
};

const ensureFolderOpen = async (page, folderPath) => {
  const selector = `details.file-folder[data-path="${folderPath}"]`;
  await page.waitForSelector(selector);
  const isOpen = await page.evaluate((sel) => {
    const target = document.querySelector(sel);
    return Boolean(target && target.open);
  }, selector);
  if (!isOpen) {
    await page.click(`${selector} > summary`);
  }
};

const setEditorValue = async (page, value) => {
  await page.evaluate((content) => {
    window.__tex180Editor?.setValue?.(content);
  }, value);
};

const getEditorValue = async (page) =>
  page.evaluate(() => window.__tex180Editor?.getValue?.() ?? "");

const focusEditor = async (page) => {
  await page.evaluate(() => {
    window.__tex180Editor?.focus?.();
  });
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

const triggerSuggest = async (page) => {
  await page.evaluate(() => {
    window.__tex180Editor?.trigger?.("keyboard", "editor.action.triggerSuggest", null);
  });
};

const sendBridgeMessage = async (electronApp, type, payload) => {
  await electronApp.evaluate(
    ({ messageType, messagePayload }) => {
      const { BrowserWindow } = require("electron");
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.send("tex180:message", {
        type: messageType,
        payload: messagePayload,
      });
    },
    { messageType: type, messagePayload: payload }
  );
};

const readClipboard = async (electronApp) =>
  electronApp.evaluate(() => require("electron").clipboard.readText());

const blockSaveFile = async (page) => {
  await page.evaluate(() => {
    const bridge = window.tex180Bridge;
    if (!bridge?.postMessage || bridge.__e2eBlockSave) {
      return;
    }
    const original = bridge.postMessage.bind(bridge);
    bridge.__e2eBlockSave = original;
    bridge.postMessage = (payload) => {
      if (payload && payload.type === "saveFile") {
        window.__e2eBlockedSave = payload;
        return;
      }
      return original(payload);
    };
  });
};

const interceptFormatRequest = async (page) => {
  await page.evaluate(() => {
    const bridge = window.tex180Bridge;
    if (!bridge?.postMessage || bridge.__e2eFormatIntercept) {
      return;
    }
    const original = bridge.postMessage.bind(bridge);
    bridge.__e2eFormatIntercept = original;
    bridge.postMessage = (payload) => {
      if (payload && payload.type === "formatFile") {
        window.__e2eFormatRequest = payload;
        return;
      }
      return original(payload);
    };
  });
};

const interceptOpenFileError = async (page, targetPath) => {
  await page.evaluate((pathToBlock) => {
    const bridge = window.tex180Bridge;
    if (!bridge?.postMessage || bridge.__e2eOpenIntercept) {
      bridge.__e2eOpenInterceptPath = pathToBlock;
      return;
    }
    const original = bridge.postMessage.bind(bridge);
    bridge.__e2eOpenIntercept = original;
    bridge.__e2eOpenInterceptPath = pathToBlock;
    bridge.postMessage = (payload) => {
      if (
        payload &&
        payload.type === "openFile" &&
        payload.path === bridge.__e2eOpenInterceptPath
      ) {
        window.__e2eBlockedOpen = payload;
        return;
      }
      return original(payload);
    };
  }, targetPath);
};

test("T4-01 open tex file", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "Alpha" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "notes");
      await openFileFromTree(page, "notes/alpha.tex");
      await expect(page.locator('.editor-tab.is-active[data-path="notes/alpha.tex"]')).toHaveCount(
        1
      );
      expect(await getEditorValue(page)).toContain("Alpha");
    }
  );
});

test("T4-02 open bib file as text", async () => {
  const bib = ["@article{smith2020,", "  title={Sample}", "}", ""].join("\n");
  await withWorkspaceApp({ files: { "refs.bib": bib } }, async ({ page }) => {
    await openFileFromTree(page, "refs.bib");
    await expect(page.locator('.editor-tab.is-active[data-path="refs.bib"]')).toHaveCount(1);
    expect(await getEditorValue(page)).toContain("@article{smith2020");
  });
});

test("T4-03 dirty indicators appear after edit", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await blockSaveFile(page);
    await setEditorValue(page, `${BASE_MAIN}\nDirty`);
    await expect(page.locator('.editor-tab[data-path="main.tex"]')).toHaveClass(/is-dirty/);
    await expect(page.locator('button.file-item[data-path="main.tex"]')).toHaveClass(
      /is-dirty/
    );
    await expect(page.locator("#breadcrumbs")).toHaveText(
      `main.tex ${TEXT.bullet}`
    );
  });
});

test("T4-04 auto save clears dirty state", async () => {
  await withWorkspaceApp({}, async ({ page, root }) => {
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    const updated = `${BASE_MAIN}\nAutoSave`;
    await setEditorValue(page, updated);
    await expect(page.locator('.editor-tab[data-path="main.tex"]')).toHaveClass(/is-dirty/);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window.__tex180PostMessages || []).some(
            (message) => message.type === "saveFile" && message.path === "main.tex"
          )
        )
      )
      .toBe(true);
    await expect
      .poll(() => fs.readFile(path.join(root, "main.tex"), "utf8"))
      .toBe(updated);
    await expect(page.locator('.editor-tab[data-path="main.tex"]')).not.toHaveClass(
      /is-dirty/
    );
    await expect(page.locator("#breadcrumbs")).toHaveText("main.tex");
  });
});

test("T4-05 manual save triggers request", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await setEditorValue(page, `${BASE_MAIN}\nManualSave`);
    await expect(page.locator('.editor-tab[data-path="main.tex"]')).toHaveClass(/is-dirty/);
    await expect(page.locator('.editor-tab[data-path="main.tex"]')).not.toHaveClass(
      /is-dirty/,
      { timeout: 5000 }
    );
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await focusEditor(page);
    await page.keyboard.press("Meta+S");
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window.__tex180PostMessages || []).some(
            (message) => message.type === "saveFile" && message.path === "main.tex"
          )
        )
      )
      .toBe(true);
  });
});

test("T4-06 save fails with no selection", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await page.click('.editor-tab[data-path="main.tex"] .editor-tab-close');
    await expect(page.locator('#editor-tabs-list.is-empty')).toHaveCount(1);
    await page.keyboard.press("Meta+S");
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.noSelection);
  });
});

test("T4-07 save fails for non-text file", async () => {
  await withWorkspaceApp(
    { files: { "sample.pdf": "%PDF-1.4\n%Test\n" } },
    async ({ page }) => {
      await openFileFromTree(page, "sample.pdf");
      await expect(page.locator('.editor-tab.is-active[data-path="sample.pdf"]')).toHaveCount(1);
      await page.keyboard.press("Meta+S");
      await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.nonText);
    }
  );
});

test("T4-08 multiple tabs open and switch", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "Alpha", "notes/beta.tex": "Beta" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "notes");
      await openFileFromTree(page, "notes/alpha.tex");
      await openFileFromTree(page, "notes/beta.tex");
      await expect(page.locator("#editor-tabs-list .editor-tab")).toHaveCount(3);
      await page.click('.editor-tab[data-path="main.tex"]');
      await expect(page.locator('.editor-tab.is-active[data-path="main.tex"]')).toHaveCount(1);
      await page.click('.editor-tab[data-path="notes/alpha.tex"]');
      await expect(
        page.locator('.editor-tab.is-active[data-path="notes/alpha.tex"]')
      ).toHaveCount(1);
    }
  );
});

test("T4-09 switch tabs with unsaved changes", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "Alpha", "notes/beta.tex": "Beta" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "notes");
      await openFileFromTree(page, "notes/alpha.tex");
      await openFileFromTree(page, "notes/beta.tex");
      await page.click('.editor-tab[data-path="notes/alpha.tex"]');
      await blockSaveFile(page);
      await setEditorValue(page, "Alpha\nDirty");
      await expect(page.locator('.editor-tab[data-path="notes/alpha.tex"]')).toHaveClass(
        /is-dirty/
      );
      await page.click('.editor-tab[data-path="notes/beta.tex"]');
      await expect(
        page.locator('.editor-tab.is-active[data-path="notes/beta.tex"]')
      ).toHaveCount(1);
      await expect(page.locator('.editor-tab[data-path="notes/alpha.tex"]')).toHaveClass(
        /is-dirty/
      );
    }
  );
});

test("T4-10 close dirty tab without confirm", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "Alpha" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "notes");
      await openFileFromTree(page, "notes/alpha.tex");
      await blockSaveFile(page);
      await setEditorValue(page, "Alpha\nDirty");
      await expect(page.locator('.editor-tab[data-path="notes/alpha.tex"]')).toHaveClass(
        /is-dirty/
      );
      await page.click('.editor-tab[data-path="notes/alpha.tex"] .editor-tab-close');
      await expect(page.locator('.editor-tab[data-path="notes/alpha.tex"]')).toHaveCount(0);
    }
  );
});

test("T4-11 reopen closed dirty file keeps content", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "Alpha" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "notes");
      await openFileFromTree(page, "notes/alpha.tex");
      await blockSaveFile(page);
      await setEditorValue(page, "Alpha\nUnsaved");
      await expect(page.locator('.editor-tab[data-path="notes/alpha.tex"]')).toHaveClass(
        /is-dirty/
      );
      await page.click('.editor-tab[data-path="notes/alpha.tex"] .editor-tab-close');
      await expect(page.locator('.editor-tab[data-path="notes/alpha.tex"]')).toHaveCount(0);
      await openFileFromTree(page, "notes/alpha.tex");
      expect(await getEditorValue(page)).toContain("Unsaved");
    }
  );
});

test("T4-12 close last tab empties editor", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await page.click('.editor-tab[data-path="main.tex"] .editor-tab-close');
    await expect(page.locator('#editor-tabs-list.is-empty')).toHaveCount(1);
    await expect(
      page.locator('.editor-group[data-editor-group="primary"]')
    ).toHaveClass(/is-empty/);
    await expect(page.locator("#breadcrumbs")).toHaveText("\u672a\u9078\u629e");
  });
});

test("T4-13 undo works after tab switch", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "Alpha", "notes/beta.tex": "Beta" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "notes");
      await openFileFromTree(page, "notes/alpha.tex");
      await setEditorValue(page, "Alpha");
      await setEditorCursor(page, 1, 6);
      await focusEditor(page);
      await page.keyboard.type("X");
      await openFileFromTree(page, "notes/beta.tex");
      await page.click('.editor-tab[data-path="notes/alpha.tex"]');
      await focusEditor(page);
      await page.keyboard.press("Meta+Z");
      await expect
        .poll(() => getEditorValue(page))
        .toBe("Alpha");
    }
  );
});

test("T4-14 format success updates content", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await interceptFormatRequest(page);
    await setEditorValue(page, "Line1\nLine2");
    await page.click("#format-button");
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__e2eFormatRequest)))
      .toBe(true);
    await sendBridgeMessage(electronApp, "formatResult", {
      path: "main.tex",
      ok: true,
      content: "Line1\n\nLine2",
      source: "manual",
    });
    await expect
      .poll(() => getEditorValue(page))
      .toBe("Line1\n\nLine2");
  });
});

test("T4-15 format missing shows warning", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await interceptFormatRequest(page);
    await page.click("#format-button");
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__e2eFormatRequest)))
      .toBe(true);
    await sendBridgeMessage(electronApp, "formatResult", {
      path: "main.tex",
      ok: false,
      error: TEXT.errors.latexindentMissing,
      source: "manual",
    });
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.latexindentMissing);
  });
});

test("T4-16 format ignored for non-tex file", async () => {
  await withWorkspaceApp({ files: { "notes.txt": "Plain" } }, async ({ page }) => {
    await openFileFromTree(page, "notes.txt");
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await page.click("#format-button");
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window.__tex180PostMessages || []).some((message) => message.type === "formatFile")
        )
      )
      .toBe(false);
  });
});

test("T4-17 ref completion", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await setEditorValue(page, "\\label{sec:intro}\\n\\ref{");
    await sendBridgeMessage(electronApp, "updateIndex", {
      labels: [{ key: "sec:intro", path: "main.tex", line: 1 }],
      citations: [],
    });
    await setEditorCursor(page, 2, "\\ref{".length + 1);
    await triggerSuggest(page);
    await expect(
      page.locator(".suggest-widget .monaco-list-row", { hasText: "sec:intro" })
    ).toHaveCount(1);
  });
});

test("T4-18 cite completion", async () => {
  await withWorkspaceApp(
    { files: { "refs.bib": "@article{smith2020,\\n}\\n" } },
    async ({ electronApp, page }) => {
      await setEditorValue(page, "\\cite{");
      await sendBridgeMessage(electronApp, "updateIndex", {
        labels: [],
        citations: [{ key: "smith2020", path: "refs.bib", line: 1 }],
      });
      await setEditorCursor(page, 1, "\\cite{".length + 1);
      await triggerSuggest(page);
      await expect(
        page.locator(".suggest-widget .monaco-list-row", { hasText: "smith2020" })
      ).toHaveCount(1);
    }
  );
});

test("T4-19 non-utf8 file shows error", async () => {
  await withWorkspaceApp({ files: { "bad.txt": "binary" } }, async ({ electronApp, page }) => {
    await interceptOpenFileError(page, "bad.txt");
    await clickFileInTree(page, "bad.txt");
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__e2eBlockedOpen)))
      .toBe(true);
    await sendBridgeMessage(electronApp, "openFileResult", {
      path: "bad.txt",
      error: TEXT.errors.invalidEncoding,
    });
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.invalidEncoding);
  });
});

test("T4-20 editor copy/paste shortcuts", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await setEditorValue(page, "Alpha Beta");
    await page.evaluate(() => {
      const editor = window.__tex180Editor;
      const monaco = window.monaco;
      if (!editor || !monaco?.Range) {
        return;
      }
      editor.setSelection(new monaco.Range(1, 1, 1, 6));
      editor.focus();
    });
    await page.keyboard.press("Meta+C");
    await expect.poll(async () => readClipboard(electronApp)).toBe("Alpha");
    await setEditorCursor(page, 1, 11);
    await page.keyboard.press("Meta+V");
    await expect.poll(() => getEditorValue(page)).toBe("Alpha BetaAlpha");
  });
});

test("T4-21 meta+K does not trigger global actions", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await setEditorValue(page, "Alpha");
    await focusEditor(page);
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await page.keyboard.press("Meta+K");
    const messages = await page.evaluate(() => window.__tex180PostMessages || []);
    expect(messages).toEqual([]);
    await expect(page.locator("#context-menu")).toHaveAttribute("aria-hidden", "true");
    await expect.poll(() => getEditorValue(page)).toBe("Alpha");
  });
});

test("T4-22 undo works after closing and reopening tab", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "Alpha" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "notes");
      await openFileFromTree(page, "notes/alpha.tex");
      await blockSaveFile(page);
      await setEditorValue(page, "Alpha");
      await setEditorCursor(page, 1, 6);
      await focusEditor(page);
      await page.keyboard.type("X");
      await expect
        .poll(() => getEditorValue(page))
        .toBe("AlphaX");
      await page.click('.editor-tab[data-path="notes/alpha.tex"] .editor-tab-close');
      await openFileFromTree(page, "notes/alpha.tex");
      await focusEditor(page);
      await page.keyboard.press("Meta+Z");
      await expect
        .poll(() => getEditorValue(page))
        .toBe("Alpha");
    }
  );
});

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
  empty: {
    workspace: "\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u304c\u672a\u9078\u629e\u3067\u3059\u3002",
    file: "\u30d5\u30a1\u30a4\u30eb\u304c\u672a\u9078\u629e\u3067\u3059\u3002",
    items: "\u30a4\u30f3\u30c7\u30c3\u30af\u30b9\u9805\u76ee\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3002",
  },
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("#file-tree");
  await page.waitForSelector('button.file-item[data-path="main.tex"]');
  await page.waitForFunction(() => !!window.__tex180Editor);
  await page.waitForSelector('.editor-tab.is-active[data-path="main.tex"]');
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

const createWorkspace = async ({ files = {}, folders = [] } = {}) => {
  const root = await createTempDir("outline-");
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

const withWorkspaceApp = async (setup, run) => {
  const root = await createWorkspace(setup);
  const { electronApp, page } = await launchApp({ workspacePath: root });
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

const openOutlineTab = async (page) => {
  await page.click('.tab[data-tab="outline"]');
  await expect(page.locator('.panel[data-panel="outline"]')).toHaveClass(/is-active/);
};

const setEditorValue = async (page, value) => {
  await page.evaluate((content) => {
    window.__tex180Editor?.setValue?.(content);
  }, value);
};

const getEditorLine = async (page) =>
  page.evaluate(() => window.__tex180Editor?.getPosition?.()?.lineNumber ?? 0);

const expectDetailsOpen = async (page, selector, expected) => {
  await expect
    .poll(() =>
      page.evaluate((sel) => Boolean(document.querySelector(sel)?.open), selector)
    )
    .toBe(expected);
};

test("T6-01 outline empty with no workspace", async () => {
  const { electronApp, page } = await launchApp({ workspacePath: null });
  try {
    await sendBridgeMessage(electronApp, "updateIndex", {
      labels: [],
      citations: [],
      sections: [],
      todos: [],
    });
    await openOutlineTab(page);
    await expect(page.locator("#outline-empty")).toHaveText(TEXT.empty.workspace);
  } finally {
    await electronApp.close();
  }
});

test("T6-02 outline empty with no file selected", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await page.click('.editor-tab[data-path="main.tex"] .editor-tab-close');
    await sendBridgeMessage(electronApp, "updateIndex", {
      labels: [],
      citations: [],
      sections: [],
      todos: [],
    });
    await openOutlineTab(page);
    await expect(page.locator("#outline-empty")).toHaveText(TEXT.empty.file);
  });
});

test("T6-03 outline empty with no items", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openFileFromTree(page, "main.tex");
    await sendBridgeMessage(electronApp, "updateIndex", {
      labels: [],
      citations: [],
      sections: [],
      todos: [],
    });
    await openOutlineTab(page);
    await expect(page.locator("#outline-empty")).toHaveText(TEXT.empty.items);
  });
});

test("T6-04 section entries appear", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "updateIndex", {
      labels: [],
      citations: [],
      sections: [{ title: "Intro", path: "main.tex", line: 2, level: 3 }],
      todos: [],
    });
    await openOutlineTab(page);
    await expect(page.locator("#outline-sections .outline-item")).toHaveCount(1);
    await expect(page.locator("#outline-sections .outline-item")).toContainText("Intro");
  });
});

test("T6-05 todo entries appear", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "updateIndex", {
      labels: [],
      citations: [],
      sections: [],
      todos: [{ key: "Fix later", path: "main.tex", line: 3 }],
    });
    await openOutlineTab(page);
    await expect(page.locator("#outline-todos .outline-item")).toHaveCount(1);
    await expect(page.locator("#outline-todos .outline-item")).toContainText("Fix later");
  });
});

test("T6-06 label entries appear", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "updateIndex", {
      labels: [{ key: "sec:intro", path: "main.tex", line: 3 }],
      citations: [],
      sections: [],
      todos: [],
    });
    await openOutlineTab(page);
    await expect(page.locator("#outline-labels .outline-item")).toHaveCount(1);
    await expect(page.locator("#outline-labels .outline-item")).toContainText("sec:intro");
  });
});

test("T6-07 citation entries appear", async () => {
  await withWorkspaceApp(
    { files: { "refs.bib": "@article{smith2020,\\n}\\n" } },
    async ({ electronApp, page }) => {
      await openFileFromTree(page, "refs.bib");
      await sendBridgeMessage(electronApp, "updateIndex", {
        labels: [],
        citations: [{ key: "smith2020", path: "refs.bib", line: 1 }],
        sections: [],
        todos: [],
      });
      await openOutlineTab(page);
      await expect(page.locator("#outline-citations .outline-item")).toHaveCount(1);
      await expect(page.locator("#outline-citations .outline-item")).toContainText(
        "smith2020"
      );
    }
  );
});

test("T6-08 outline shows only active file entries", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "Alpha" }, folders: ["notes"] },
    async ({ electronApp, page }) => {
      await sendBridgeMessage(electronApp, "updateIndex", {
        labels: [
          { key: "main-label", path: "main.tex", line: 1 },
          { key: "alpha-label", path: "notes/alpha.tex", line: 1 },
        ],
        citations: [],
        sections: [],
        todos: [],
      });
      await openOutlineTab(page);
      await expect(page.locator("#outline-labels .outline-item")).toHaveCount(1);
      await expect(page.locator("#outline-labels .outline-item")).toContainText(
        "main-label"
      );
      await ensureFolderOpen(page, "notes");
      await openFileFromTree(page, "notes/alpha.tex");
      await openOutlineTab(page);
      await expect(page.locator("#outline-labels .outline-item")).toHaveCount(1);
      await expect(page.locator("#outline-labels .outline-item")).toContainText(
        "alpha-label"
      );
    }
  );
});

test("T6-09 outline jump highlights target line", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "updateIndex", {
      labels: [{ key: "sec:intro", path: "main.tex", line: 3 }],
      citations: [],
      sections: [],
      todos: [],
    });
    await openOutlineTab(page);
    await page.click('#outline-labels .outline-item:has-text("sec:intro")');
    await expect
      .poll(() => getEditorLine(page))
      .toBe(3);
    await expect(page.locator(".jump-line-highlight")).toHaveCount(1);
  });
});

test("T6-10 outline jump highlight clears after edit", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "updateIndex", {
      labels: [{ key: "sec:intro", path: "main.tex", line: 3 }],
      citations: [],
      sections: [],
      todos: [],
    });
    await openOutlineTab(page);
    await page.click('#outline-labels .outline-item:has-text("sec:intro")');
    await expect(page.locator(".jump-line-highlight")).toHaveCount(1);
    await setEditorValue(page, `${BASE_MAIN}\nUpdate`);
    await expect(page.locator(".jump-line-highlight")).toHaveCount(0);
  });
});

test("T6-11 figure/table captions are not listed", async () => {
  const withFigures = [
    "\\begin{figure}",
    "\\caption{Figure caption}",
    "\\end{figure}",
    "\\begin{table}",
    "\\caption{Table caption}",
    "\\end{table}",
    "",
  ].join("\n");
  await withWorkspaceApp(
    { files: { "main.tex": `${BASE_MAIN}\n${withFigures}` } },
    async ({ electronApp, page }) => {
      await sendBridgeMessage(electronApp, "updateIndex", {
        labels: [],
        citations: [],
        sections: [{ title: "Intro", path: "main.tex", line: 1, level: 3 }],
        todos: [],
        figures: [{ key: "Figure caption", path: "main.tex", line: 6 }],
        tables: [{ key: "Table caption", path: "main.tex", line: 9 }],
      });
      await openOutlineTab(page);
      await expect(page.locator("#outline-sections .outline-item")).toHaveCount(1);
      await expect(page.locator(".outline-item", { hasText: "Figure caption" })).toHaveCount(0);
      await expect(page.locator(".outline-item", { hasText: "Table caption" })).toHaveCount(0);
    }
  );
});

test("T6-12 outline sections can collapse", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "updateIndex", {
      labels: [],
      citations: [],
      sections: [{ title: "Intro", path: "main.tex", line: 2, level: 3 }],
      todos: [],
    });
    await openOutlineTab(page);
    const selector = 'details.outline-section[data-outline="sections"]';
    await expect
      .poll(() =>
        page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return Boolean(el && el.open);
        }, selector)
      )
      .toBe(true);
    await page.click(`${selector} > summary`);
    await expect
      .poll(() =>
        page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return Boolean(el && el.open);
        }, selector)
      )
      .toBe(false);
    await page.click(`${selector} > summary`);
    await expect
      .poll(() =>
        page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return Boolean(el && el.open);
        }, selector)
      )
      .toBe(true);
  });
});

test("T6-13 label outline item jumps to line", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await setEditorValue(page, "Line1\nLine2\nLine3\nLine4\nLine5\n");
    await sendBridgeMessage(electronApp, "updateIndex", {
      labels: [{ key: "sec:intro", path: "main.tex", line: 3 }],
      citations: [],
      sections: [],
      todos: [],
    });
    await openOutlineTab(page);
    await page.click("#outline-labels .outline-item");
    await expect.poll(() => getEditorLine(page)).toBe(3);
  });
});

test("T6-14 citation outline item jumps to line", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await setEditorValue(page, "Line1\nLine2\nLine3\nLine4\nLine5\n");
    await sendBridgeMessage(electronApp, "updateIndex", {
      labels: [],
      citations: [{ key: "smith2020", path: "main.tex", line: 5 }],
      sections: [],
      todos: [],
    });
    await openOutlineTab(page);
    await page.click("#outline-citations .outline-item");
    await expect.poll(() => getEditorLine(page)).toBe(5);
  });
});

test("T6-15 outline todos/labels/citations can collapse", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "updateIndex", {
      labels: [{ key: "sec:intro", path: "main.tex", line: 2 }],
      citations: [{ key: "smith2020", path: "main.tex", line: 3 }],
      sections: [],
      todos: [{ key: "Fix later", path: "main.tex", line: 4 }],
    });
    await openOutlineTab(page);
    for (const key of ["todos", "labels", "citations"]) {
      const selector = `details.outline-section[data-outline="${key}"]`;
      await expectDetailsOpen(page, selector, true);
      await page.click(`${selector} > summary`);
      await expectDetailsOpen(page, selector, false);
      await page.click(`${selector} > summary`);
      await expectDetailsOpen(page, selector, true);
    }
  });
});

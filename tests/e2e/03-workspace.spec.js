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
  menu: {
    open: "\u958b\u304f",
    newFile: "\u65b0\u3057\u3044\u30d5\u30a1\u30a4\u30eb...",
    newFolder: "\u65b0\u3057\u3044\u30d5\u30a9\u30eb\u30c0\u30fc...",
    reveal: "Finder\u3067\u8868\u793a",
    rename: "\u540d\u524d\u306e\u5909\u66f4...",
    delete: "\u524a\u9664",
  },
  errors: {
    emptyName: "\u540d\u524d\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
    parentDir: "\u89aa\u30c7\u30a3\u30ec\u30af\u30c8\u30ea\u3092\u542b\u3080\u540d\u524d\u306f\u4f7f\u3048\u307e\u305b\u3093\u3002",
    absolute: "\u7d76\u5bfe\u30d1\u30b9\u306f\u4f7f\u3048\u307e\u305b\u3093\u3002",
    trailingSlash: "\u30d5\u30a1\u30a4\u30eb\u540d\u306b\u672b\u5c3e\u306e / \u306f\u4f7f\u3048\u307e\u305b\u3093\u3002",
    renameSlash: "\u540d\u524d\u306b / \u306f\u4f7f\u3048\u307e\u305b\u3093\u3002",
    renameDirty:
      "\u672a\u4fdd\u5b58\u306e\u5909\u66f4\u304c\u3042\u308a\u307e\u3059\u3002\u4fdd\u5b58\u3057\u3066\u304b\u3089\u540d\u524d\u3092\u5909\u66f4\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
    moveDirty:
      "\u672a\u4fdd\u5b58\u306e\u5909\u66f4\u304c\u3042\u308a\u307e\u3059\u3002\u79fb\u52d5\u524d\u306b\u4fdd\u5b58\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
    invalidMove: "\u79fb\u52d5\u5148\u304c\u4e0d\u6b63\u3067\u3059\u3002",
    undoEmpty: "\u623b\u3059\u64cd\u4f5c\u306f\u3042\u308a\u307e\u305b\u3093\u3002",
    noWorkspace: "\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u304c\u9078\u629e\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002",
  },
  success: {
    deleted: "\u524a\u9664\u3057\u307e\u3057\u305f\u3002",
    createdFile: "\u30d5\u30a1\u30a4\u30eb\u3092\u4f5c\u6210\u3057\u307e\u3057\u305f\u3002",
    createdFolder: "\u30d5\u30a9\u30eb\u30c0\u3092\u4f5c\u6210\u3057\u307e\u3057\u305f\u3002",
    renamed: "\u540d\u524d\u3092\u5909\u66f4\u3057\u307e\u3057\u305f\u3002",
    moved: "\u79fb\u52d5\u3057\u307e\u3057\u305f\u3002",
    copied: "\u30b3\u30d4\u30fc\u3057\u307e\u3057\u305f\u3002",
    undone: "\u64cd\u4f5c\u3092\u623b\u3057\u307e\u3057\u305f\u3002",
  },
  miniOutlinePrefix: "\u30df\u30cb\u30a2\u30a6\u30c8\u30e9\u30a4\u30f3: ",
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("#file-tree");
  await page.waitForSelector('button.file-item[data-path="main.tex"]');
  await page.waitForFunction(() => !!window.__tex180Editor);
  await page.waitForSelector('.editor-tab.is-active[data-path="main.tex"]');
};

const blockBridgeTypes = async (page, blockedTypes) => {
  await page.waitForFunction(() => !!window.tex180Bridge?.postMessage);
  await page.evaluate((types) => {
    const bridge = window.tex180Bridge;
    if (!bridge?.postMessage) {
      return;
    }
    if (bridge.__e2eIntercept) {
      bridge.__e2eBlocked = types;
      return;
    }
    const original = bridge.postMessage.bind(bridge);
    bridge.__e2eBlocked = types;
    bridge.postMessage = (payload) => {
      if (payload && bridge.__e2eBlocked?.includes(payload.type)) {
        return;
      }
      return original(payload);
    };
    bridge.__e2eIntercept = true;
  }, blockedTypes);
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

const withWorkspaceApp = async (setup, run) => {
  const root = await createWorkspace(setup);
  const { electronApp, page } = await launchApp({ workspacePath: root });
  await waitForWorkspaceReady(page);
  await blockBridgeTypes(page, ["revealInFinder", "openInTerminal"]);
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
};

const openFileMenu = async (page, filePath) => {
  const selector = `button.file-item[data-path="${filePath}"]`;
  await page.waitForSelector(selector);
  await page.click(selector, { button: "right" });
  await page.waitForSelector("#context-menu.is-open");
};

const openFolderMenu = async (page, folderPath) => {
  const selector = `details.file-folder[data-path="${folderPath}"] > summary`;
  await page.waitForSelector(selector);
  await page.click(selector, { button: "right" });
  await page.waitForSelector("#context-menu.is-open");
};

const clickContextMenuItem = async (page, label) => {
  await page.click(`#context-menu-panel .context-menu-item:has-text("${label}")`);
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

const getRootEntries = async (page) =>
  page.evaluate(() => {
    const tree = document.querySelector("#file-tree");
    if (!tree) {
      return [];
    }
    return Array.from(tree.children).map((node) => {
      if (node instanceof HTMLDetailsElement) {
        return { type: "dir", name: node.querySelector("summary")?.textContent?.trim() ?? "" };
      }
      return { type: "file", name: node.textContent?.trim() ?? "" };
    });
  });

const setDirtyWithoutSaving = async (page) => {
  await blockBridgeTypes(page, ["revealInFinder", "openInTerminal", "saveFile"]);
  await page.evaluate(() => {
    window.__tex180Editor?.setValue?.("\\documentclass{article}\\n\\begin{document}\\nDirty\\n");
  });
  await page.waitForSelector('button.file-item.is-dirty[data-path="notes/alpha.tex"]');
};

test("T3-01 workspace label", async () => {
  await withWorkspaceApp({}, async ({ page, root }) => {
    await expect(page.locator("#workspace-label")).toHaveText(path.basename(root));
    await expect(page.locator('button.file-item[data-path="main.tex"]')).toHaveCount(1);
  });
});

test("T3-02 hidden folders excluded", async () => {
  await withWorkspaceApp(
    {
      files: {
        ".git/HEAD": "ref: refs/heads/main",
        ".tex180/settings.json": "{}",
        "node_modules/pkg/index.js": "",
        "visible/readme.txt": "ok",
      },
    },
    async ({ page }) => {
      await expect(page.locator('details.file-folder[data-path=".git"]')).toHaveCount(0);
      await expect(page.locator('details.file-folder[data-path=".tex180"]')).toHaveCount(0);
      await expect(page.locator('details.file-folder[data-path="node_modules"]')).toHaveCount(0);
      await expect(page.locator('details.file-folder[data-path="visible"]')).toHaveCount(1);
    }
  );
});

test("T3-03 build artifacts excluded", async () => {
  await withWorkspaceApp(
    {
      files: {
        "main.aux": "",
        "main.log": "",
        "main.fdb_latexmk": "",
        "main.synctex.gz": "",
      },
    },
    async ({ page }) => {
      await expect(page.locator('button.file-item[data-path="main.aux"]')).toHaveCount(0);
      await expect(page.locator('button.file-item[data-path="main.log"]')).toHaveCount(0);
      await expect(page.locator('button.file-item[data-path="main.fdb_latexmk"]')).toHaveCount(0);
      await expect(page.locator('button.file-item[data-path="main.synctex.gz"]')).toHaveCount(0);
    }
  );
});

test("T3-04 sort order", async () => {
  await withWorkspaceApp(
    {
      files: {
        "a.tex": "",
        "b.tex": "",
        "z.txt": "",
      },
      folders: ["b-folder", "a-folder"],
    },
    async ({ page }) => {
      const entries = await getRootEntries(page);
      expect(entries).toEqual([
        { type: "dir", name: "a-folder" },
        { type: "dir", name: "b-folder" },
        { type: "file", name: "a.tex" },
        { type: "file", name: "b.tex" },
        { type: "file", name: "main.tex" },
        { type: "file", name: "z.txt" },
      ]);
    }
  );
});

test("T3-05 folder open and close", async () => {
  await withWorkspaceApp(
    { files: { "sections/intro.tex": "" } },
    async ({ page }) => {
      const selector = 'details.file-folder[data-path="sections"]';
      await page.waitForSelector(selector);
      const isOpen = await page.evaluate((sel) => {
        const target = document.querySelector(sel);
        return Boolean(target && target.open);
      }, selector);
      expect(isOpen).toBe(true);
      await page.click(`${selector} > summary`);
      await expect
        .poll(() =>
          page.evaluate((sel) => Boolean(document.querySelector(sel)?.open), selector)
        )
        .toBe(false);
      await page.click(`${selector} > summary`);
      await expect
        .poll(() =>
          page.evaluate((sel) => Boolean(document.querySelector(sel)?.open), selector)
        )
        .toBe(true);
    }
  );
});

test("T3-06 folder open state persists", async () => {
  const root = await createWorkspace({ files: { "sections/intro.tex": "" } });
  const first = await launchApp({ workspacePath: root });
  await waitForWorkspaceReady(first.page);
  await ensureFolderOpen(first.page, "sections");
  await first.page.click('details.file-folder[data-path="sections"] > summary');
  await expect
    .poll(() =>
      first.page.evaluate(
        () => Boolean(document.querySelector('details.file-folder[data-path="sections"]')?.open)
      )
    )
    .toBe(false);
  await first.page.click('details.file-folder[data-path="sections"] > summary');
  await expect
    .poll(() =>
      first.page.evaluate(
        () => Boolean(document.querySelector('details.file-folder[data-path="sections"]')?.open)
      )
    )
    .toBe(true);
  await first.electronApp.close();

  const second = await launchApp({ workspacePath: root });
  await waitForWorkspaceReady(second.page);
  await expect
    .poll(() =>
      second.page.evaluate(
        () => Boolean(document.querySelector('details.file-folder[data-path="sections"]')?.open)
      )
    )
    .toBe(true);
  await second.electronApp.close();
  await removeDir(root);
});

test("T3-07 open file from tree", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "notes");
      await openFileFromTree(page, "notes/alpha.tex");
      await page.waitForSelector('.editor-tab.is-active[data-path="notes/alpha.tex"]');
      await expect(page.locator("#mini-outline")).toHaveText(
        `${TEXT.miniOutlinePrefix}alpha.tex`
      );
    }
  );
});

test("T3-08 folder selection", async () => {
  await withWorkspaceApp(
    { files: { "sections/intro.tex": "" } },
    async ({ page }) => {
      const summary = 'details.file-folder[data-path="sections"] > summary';
      await page.click(summary);
      await expect(page.locator(summary)).toHaveClass(/is-selected/);
    }
  );
});

test("T3-09 file context menu", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "" } },
    async ({ page }) => {
      await page.evaluate(() => {
        window.__e2eContextMenuDefaultPrevented = null;
        document.addEventListener(
          "contextmenu",
          (event) => {
            window.__e2eContextMenuDefaultPrevented = event.defaultPrevented;
          },
          { once: true }
        );
      });
      await openFileMenu(page, "notes/alpha.tex");
      await expect(page.locator("#context-menu")).toHaveClass(/is-open/);
      await expect(page.locator("#context-menu-panel .context-menu-item")).toHaveCount(6);
      await expect
        .poll(() => page.evaluate(() => window.__e2eContextMenuDefaultPrevented))
        .toBe(true);
    }
  );
});

test("T3-09b file right-click does not open file", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "", "notes/beta.tex": "" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "notes");
      await openFileFromTree(page, "notes/alpha.tex");
      await openFileMenu(page, "notes/beta.tex");
      await expect(page.locator('.editor-tab.is-active[data-path="notes/alpha.tex"]')).toHaveCount(
        1
      );
      await expect(page.locator('.editor-tab[data-path="notes/beta.tex"]')).toHaveCount(0);
    }
  );
});

test("T3-10 context menu open action", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "" } },
    async ({ page }) => {
      await openFileMenu(page, "notes/alpha.tex");
      await clickContextMenuItem(page, TEXT.menu.open);
      await page.waitForSelector('.editor-tab.is-active[data-path="notes/alpha.tex"]');
    }
  );
});

test("T3-11 context menu new file modal", async () => {
  await withWorkspaceApp(
    { files: { "sections/intro.tex": "" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "sections");
      await openFileMenu(page, "sections/intro.tex");
      await clickContextMenuItem(page, TEXT.menu.newFile);
      await expect(page.locator("#create-modal")).toHaveClass(/is-open/);
      await expect(page.locator("#create-modal-parent")).toHaveText("sections");
    }
  );
});

test("T3-12 context menu new folder modal", async () => {
  await withWorkspaceApp(
    { files: { "sections/intro.tex": "" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "sections");
      await openFileMenu(page, "sections/intro.tex");
      await clickContextMenuItem(page, TEXT.menu.newFolder);
      await expect(page.locator("#create-modal")).toHaveClass(/is-open/);
      await expect(page.locator("#create-modal-parent")).toHaveText("sections");
    }
  );
});

test("T3-13 context menu reveal in Finder", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "" } },
    async ({ page }) => {
      await page.evaluate(() => {
        window.__tex180PostMessages = [];
      });
      await openFileMenu(page, "notes/alpha.tex");
      await clickContextMenuItem(page, TEXT.menu.reveal);
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window.__tex180PostMessages || []).some(
              (message) => message.type === "revealInFinder" && message.path === "notes/alpha.tex"
            )
          )
        )
        .toBe(true);
    }
  );
});

test("T3-14 context menu rename modal", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "" } },
    async ({ page }) => {
      await openFileMenu(page, "notes/alpha.tex");
      await clickContextMenuItem(page, TEXT.menu.rename);
      await expect(page.locator("#rename-modal")).toHaveClass(/is-open/);
      await expect(page.locator("#rename-modal-input")).toHaveValue("alpha.tex");
      await page.click("#rename-modal-cancel");
      await expect(page.locator("#rename-modal")).not.toHaveClass(/is-open/);
    }
  );
});

test("T3-14b rename confirms with Enter", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "" } },
    async ({ page }) => {
      await openFileMenu(page, "notes/alpha.tex");
      await clickContextMenuItem(page, TEXT.menu.rename);
      await page.fill("#rename-modal-input", "beta.tex");
      await page.locator("#rename-modal-input").press("Enter");
      await page.waitForSelector('button.file-item[data-path="notes/beta.tex"]');
      await expect(page.locator('button.file-item[data-path="notes/alpha.tex"]')).toHaveCount(0);
      await expect(page.locator("#issues-hint")).toHaveText(TEXT.success.renamed);
    }
  );
});

test("T3-14c rename cancels with Escape", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "" } },
    async ({ page }) => {
      await openFileMenu(page, "notes/alpha.tex");
      await clickContextMenuItem(page, TEXT.menu.rename);
      await page.fill("#rename-modal-input", "beta.tex");
      await page.locator("#rename-modal-input").press("Escape");
      await expect(page.locator("#rename-modal")).not.toHaveClass(/is-open/);
      await expect(page.locator('button.file-item[data-path="notes/alpha.tex"]')).toHaveCount(1);
      await expect(page.locator('button.file-item[data-path="notes/beta.tex"]')).toHaveCount(0);
    }
  );
});

test("T3-14d rename modal closes on backdrop click", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "" } },
    async ({ page }) => {
      await openFileMenu(page, "notes/alpha.tex");
      await clickContextMenuItem(page, TEXT.menu.rename);
      await expect(page.locator("#rename-modal")).toHaveClass(/is-open/);
      await page.locator("#rename-modal").evaluate((el) => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect(page.locator("#rename-modal")).not.toHaveClass(/is-open/);
    }
  );
});

test("T3-15 delete file from menu", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "" } },
    async ({ page }) => {
      await openFileMenu(page, "notes/alpha.tex");
      await clickContextMenuItem(page, TEXT.menu.delete);
      await expect(page.locator('button.file-item[data-path="notes/alpha.tex"]')).toHaveCount(0);
      await expect(page.locator("#issues-hint")).toHaveText(TEXT.success.deleted);
    }
  );
});

test("T3-16 folder context menu", async () => {
  await withWorkspaceApp(
    { folders: ["sections"] },
    async ({ page }) => {
      await openFolderMenu(page, "sections");
      await expect(page.locator("#context-menu")).toHaveClass(/is-open/);
      await expect(page.locator("#context-menu-panel .context-menu-item")).toHaveCount(5);
    }
  );
});

test("T3-16b folder context menu reveal in Finder", async () => {
  await withWorkspaceApp(
    { folders: ["sections"] },
    async ({ page }) => {
      await page.evaluate(() => {
        window.__tex180PostMessages = [];
      });
      await openFolderMenu(page, "sections");
      await clickContextMenuItem(page, TEXT.menu.reveal);
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window.__tex180PostMessages || []).some(
              (message) => message.type === "revealInFinder" && message.path === "sections"
            )
          )
        )
        .toBe(true);
    }
  );
});

test("T3-17 folder context menu create modal", async () => {
  await withWorkspaceApp(
    { folders: ["sections"] },
    async ({ page }) => {
      await openFolderMenu(page, "sections");
      await clickContextMenuItem(page, TEXT.menu.newFile);
      await expect(page.locator("#create-modal")).toHaveClass(/is-open/);
      await expect(page.locator("#create-modal-parent")).toHaveText("sections");
      await page.click("#create-modal-cancel");
      await expect(page.locator("#create-modal")).not.toHaveClass(/is-open/);
      await openFolderMenu(page, "sections");
      await clickContextMenuItem(page, TEXT.menu.newFolder);
      await expect(page.locator("#create-modal")).toHaveClass(/is-open/);
      await expect(page.locator("#create-modal-parent")).toHaveText("sections");
    }
  );
});

test("T3-18 rename folder updates tabs", async () => {
  await withWorkspaceApp(
    { files: { "sections/intro.tex": "" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "sections");
      await openFileFromTree(page, "sections/intro.tex");
      await openFolderMenu(page, "sections");
      await clickContextMenuItem(page, TEXT.menu.rename);
      await page.fill("#rename-modal-input", "chapters");
      await page.click("#rename-modal-submit");
      await page.waitForSelector('details.file-folder[data-path="chapters"]');
      await expect(page.locator('details.file-folder[data-path="sections"]')).toHaveCount(0);
      await expect(page.locator('.editor-tab[data-path="chapters/intro.tex"]')).toHaveCount(1);
      await expect(page.locator("#issues-hint")).toHaveText(TEXT.success.renamed);
    }
  );
});

test("T3-19 delete folder closes tabs", async () => {
  await withWorkspaceApp(
    { files: { "sections/intro.tex": "" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "sections");
      await openFileFromTree(page, "sections/intro.tex");
      await openFolderMenu(page, "sections");
      await clickContextMenuItem(page, TEXT.menu.delete);
      await expect(page.locator('details.file-folder[data-path="sections"]')).toHaveCount(0);
      await expect(page.locator('.editor-tab[data-path="sections/intro.tex"]')).toHaveCount(0);
    }
  );
});

test("T3-20 create file success", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openFileMenu(page, "main.tex");
    await clickContextMenuItem(page, TEXT.menu.newFile);
    await page.fill("#create-modal-input", "sections/intro.tex");
    await page.click("#create-modal-submit");
    await page.waitForSelector('button.file-item[data-path="sections/intro.tex"]');
    await page.waitForSelector('.editor-tab.is-active[data-path="sections/intro.tex"]');
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.success.createdFile);
  });
});

test("T3-20b create file with Enter", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openFileMenu(page, "main.tex");
    await clickContextMenuItem(page, TEXT.menu.newFile);
    await page.fill("#create-modal-input", "sections/intro.tex");
    await page.keyboard.press("Enter");
    await page.waitForSelector('button.file-item[data-path="sections/intro.tex"]');
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.success.createdFile);
  });
});

test("T3-21 create folder success", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openFileMenu(page, "main.tex");
    await clickContextMenuItem(page, TEXT.menu.newFolder);
    await page.fill("#create-modal-input", "sections/figs");
    await page.click("#create-modal-submit");
    await page.waitForSelector('details.file-folder[data-path="sections"]');
    await page.waitForSelector('details.file-folder[data-path="sections/figs"]');
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.success.createdFolder);
  });
});

test("T3-21b create modal closes with Escape", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openFileMenu(page, "main.tex");
    await clickContextMenuItem(page, TEXT.menu.newFolder);
    await page.fill("#create-modal-input", "sections/figs");
    await page.keyboard.press("Escape");
    await expect(page.locator("#create-modal")).not.toHaveClass(/is-open/);
    await expect(page.locator('details.file-folder[data-path="sections"]')).toHaveCount(0);
  });
});

test("T3-21c create modal closes on backdrop click", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openFileMenu(page, "main.tex");
    await clickContextMenuItem(page, TEXT.menu.newFile);
    await expect(page.locator("#create-modal")).toHaveClass(/is-open/);
    await page.locator("#create-modal").evaluate((el) => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await expect(page.locator("#create-modal")).not.toHaveClass(/is-open/);
  });
});

test("T3-22 create empty input", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openFileMenu(page, "main.tex");
    await clickContextMenuItem(page, TEXT.menu.newFile);
    await page.click("#create-modal-submit");
    await expect(page.locator("#create-modal-help")).toHaveText(TEXT.errors.emptyName);
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.emptyName);
  });
});

test("T3-23 create with parent directory path", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openFileMenu(page, "main.tex");
    await clickContextMenuItem(page, TEXT.menu.newFile);
    await page.fill("#create-modal-input", "../bad.tex");
    await page.click("#create-modal-submit");
    await expect(page.locator("#create-modal-help")).toHaveText(TEXT.errors.parentDir);
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.parentDir);
  });
});

test("T3-24 create with absolute path", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openFileMenu(page, "main.tex");
    await clickContextMenuItem(page, TEXT.menu.newFile);
    await page.fill("#create-modal-input", "/tmp/a.tex");
    await page.click("#create-modal-submit");
    await expect(page.locator("#create-modal-help")).toHaveText(TEXT.errors.absolute);
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.absolute);
  });
});

test("T3-25 create with trailing slash", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openFileMenu(page, "main.tex");
    await clickContextMenuItem(page, TEXT.menu.newFile);
    await page.fill("#create-modal-input", "foo/");
    await page.click("#create-modal-submit");
    await expect(page.locator("#create-modal-help")).toHaveText(TEXT.errors.trailingSlash);
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.trailingSlash);
  });
});

test("T3-26 rename empty input", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "" } },
    async ({ page }) => {
      await openFileMenu(page, "notes/alpha.tex");
      await clickContextMenuItem(page, TEXT.menu.rename);
      await page.fill("#rename-modal-input", "");
      await page.click("#rename-modal-submit");
      await expect(page.locator("#rename-modal-help")).toHaveText(TEXT.errors.emptyName);
    }
  );
});

test("T3-27 rename with slash", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "" } },
    async ({ page }) => {
      await openFileMenu(page, "notes/alpha.tex");
      await clickContextMenuItem(page, TEXT.menu.rename);
      await page.fill("#rename-modal-input", "a/b");
      await page.click("#rename-modal-submit");
      await expect(page.locator("#rename-modal-help")).toHaveText(TEXT.errors.renameSlash);
    }
  );
});

test("T3-28 rename blocked by unsaved changes", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "" } },
    async ({ page }) => {
      await openFileFromTree(page, "notes/alpha.tex");
      await setDirtyWithoutSaving(page);
      await openFileMenu(page, "notes/alpha.tex");
      await clickContextMenuItem(page, TEXT.menu.rename);
      await page.click("#rename-modal-submit");
      await expect(page.locator("#rename-modal-help")).toHaveText(TEXT.errors.renameDirty);
      await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.renameDirty);
    }
  );
});

test("T3-29 drag file to folder", async () => {
  await withWorkspaceApp(
    { files: { "sections/intro.tex": "", "notes.tex": "" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "sections");
      await openFileFromTree(page, "notes.tex");
      await page.dragAndDrop(
        'button.file-item[data-path="notes.tex"]',
        'details.file-folder[data-path="sections"] > summary'
      );
      await page.waitForSelector('button.file-item[data-path="sections/notes.tex"]');
      await expect(page.locator('.editor-tab[data-path="sections/notes.tex"]')).toHaveCount(1);
      await expect(page.locator('.editor-tab[data-path="notes.tex"]')).toHaveCount(0);
      await expect(page.locator('button.file-item[data-path="notes.tex"]')).toHaveCount(0);
    }
  );
});

test("T3-29b drag blocked when file has unsaved changes", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "" }, folders: ["sections"] },
    async ({ page }) => {
      await ensureFolderOpen(page, "notes");
      await openFileFromTree(page, "notes/alpha.tex");
      await setDirtyWithoutSaving(page);
      await page.dragAndDrop(
        'button.file-item[data-path="notes/alpha.tex"]',
        'details.file-folder[data-path="sections"] > summary'
      );
      await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.moveDirty);
      await expect(page.locator('button.file-item[data-path="notes/alpha.tex"]')).toHaveCount(1);
      await expect(page.locator('button.file-item[data-path="sections/alpha.tex"]')).toHaveCount(0);
    }
  );
});

test("T3-30 drag folder to folder", async () => {
  await withWorkspaceApp(
    { files: { "alpha/file.tex": "", "beta/keep.tex": "" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "alpha");
      await ensureFolderOpen(page, "beta");
      await page.dragAndDrop(
        'details.file-folder[data-path="alpha"] > summary',
        'details.file-folder[data-path="beta"] > summary'
      );
      await page.waitForSelector('details.file-folder[data-path="beta/alpha"]');
      await expect(page.locator('details.file-folder[data-path="alpha"]')).toHaveCount(0);
    }
  );
});

test("T3-31 drag folder into itself", async () => {
  await withWorkspaceApp(
    { folders: ["parent/child"] },
    async ({ page }) => {
      await ensureFolderOpen(page, "parent");
      await page.dragAndDrop(
        'details.file-folder[data-path="parent"] > summary',
        'details.file-folder[data-path="parent/child"] > summary'
      );
      await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.invalidMove);
    }
  );
});

test("T3-32 drag file onto file", async () => {
  await withWorkspaceApp(
    { files: { "source.tex": "", "target/target.tex": "" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "target");
      await page.dragAndDrop(
        'button.file-item[data-path="source.tex"]',
        'button.file-item[data-path="target/target.tex"]'
      );
      await page.waitForSelector('button.file-item[data-path="target/source.tex"]');
      await expect(page.locator('button.file-item[data-path="source.tex"]')).toHaveCount(0);
    }
  );
});

test("T3-32b dragover highlights file target and container", async () => {
  await withWorkspaceApp(
    { files: { "source.tex": "", "target/target.tex": "" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "target");
      const result = await page.evaluate(() => {
        const source = document.querySelector('button.file-item[data-path="source.tex"]');
        const target = document.querySelector(
          'button.file-item[data-path="target/target.tex"]'
        );
        if (!source || !target) {
          return { ok: false };
        }
        const dataTransfer = new DataTransfer();
        dataTransfer.setData(
          "application/x-tex180-item",
          JSON.stringify({ path: "source.tex", kind: "file" })
        );
        source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
        target.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer }));
        const container = target.parentElement;
        return {
          ok: true,
          targetHighlighted: target.classList.contains("is-drop-target"),
          containerHighlighted: container?.classList.contains("is-drop-target") ?? false,
        };
      });
      expect(result.ok).toBe(true);
      expect(result.targetHighlighted).toBe(true);
      expect(result.containerHighlighted).toBe(true);
    }
  );
});

test("T3-33 drag file to root", async () => {
  await withWorkspaceApp(
    { files: { "sections/inside.tex": "" } },
    async ({ page }) => {
      await ensureFolderOpen(page, "sections");
      const source = page.locator('button.file-item[data-path="sections/inside.tex"]');
      const tree = page.locator("#file-tree");
      const sourceBox = await source.boundingBox();
      const treeBox = await tree.boundingBox();
      if (!sourceBox || !treeBox) {
        throw new Error("missing drag target");
      }
      await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(treeBox.x + 10, treeBox.y + treeBox.height - 5);
      await page.mouse.up();
      await page.waitForSelector('button.file-item[data-path="inside.tex"]');
      await expect(page.locator('button.file-item[data-path="sections/inside.tex"]')).toHaveCount(0);
    }
  );
});

test("T3-34 tree shortcut copy", async () => {
  await withWorkspaceApp(
    { files: { "notes.tex": "" }, folders: ["sections"] },
    async ({ page }) => {
      await openFileFromTree(page, "notes.tex");
      await page.click("#file-tree");
      await page.keyboard.press("Meta+C");
      await page.click('details.file-folder[data-path="sections"] > summary');
      await page.keyboard.press("Meta+V");
      await page.waitForSelector('button.file-item[data-path="sections/notes.tex"]');
      await expect(page.locator("#issues-hint")).toHaveText(TEXT.success.copied);
    }
  );
});

test("T3-35 tree shortcut cut", async () => {
  await withWorkspaceApp(
    { files: { "notes.tex": "" }, folders: ["sections"] },
    async ({ page }) => {
      await openFileFromTree(page, "notes.tex");
      await page.click("#file-tree");
      await page.keyboard.press("Meta+X");
      await page.click('details.file-folder[data-path="sections"] > summary');
      await page.keyboard.press("Meta+V");
      await page.waitForSelector('button.file-item[data-path="sections/notes.tex"]');
      await expect(page.locator('button.file-item[data-path="notes.tex"]')).toHaveCount(0);
      await expect(page.locator("#issues-hint")).toHaveText(TEXT.success.moved);
    }
  );
});

test("T3-36 undo file operation", async () => {
  await withWorkspaceApp(
    { files: { "notes.tex": "" } },
    async ({ page }) => {
      await openFileMenu(page, "notes.tex");
      await clickContextMenuItem(page, TEXT.menu.delete);
      await expect(page.locator('button.file-item[data-path="notes.tex"]')).toHaveCount(0);
      await page.click("#file-tree");
      await page.keyboard.press("Meta+Z");
      await page.waitForSelector('button.file-item[data-path="notes.tex"]');
      await expect(page.locator("#issues-hint")).toHaveText(TEXT.success.undone);
    }
  );
});

test("T3-37 undo with no history", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await page.click("#file-tree");
    await page.keyboard.press("Meta+Z");
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.undoEmpty);
  });
});

test("T3-38 actions without workspace", async () => {
  const { electronApp, page } = await launchApp({ workspacePath: null });
  try {
    await page.waitForFunction(() => !!window.tex180Bridge?.postMessage);
    await page.evaluate(() => {
      window.tex180Bridge.postMessage({ type: "createFile", path: "a.tex" });
    });
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.noWorkspace);
    await page.evaluate(() => {
      window.tex180Bridge.postMessage({ type: "moveItem", path: "a.tex", destination: "" });
    });
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.noWorkspace);
    await page.evaluate(() => {
      window.tex180Bridge.postMessage({ type: "deleteItem", path: "a.tex" });
    });
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.noWorkspace);
  } finally {
    await electronApp.close();
  }
});

test("T3-39 delete moves item to internal trash", async () => {
  await withWorkspaceApp(
    { files: { "notes/alpha.tex": "" } },
    async ({ page, root }) => {
      await openFileMenu(page, "notes/alpha.tex");
      await clickContextMenuItem(page, TEXT.menu.delete);
      await expect(page.locator('button.file-item[data-path="notes/alpha.tex"]')).toHaveCount(0);
      const trashDir = path.join(root, ".tex180", ".trash");
      await expect
        .poll(async () => {
          const entries = await fs.readdir(trashDir).catch(() => []);
          return entries.find((entry) => entry.endsWith("-alpha.tex")) ?? null;
        })
        .not.toBeNull();
    }
  );
});

test("T3-40 dragover highlights drop target", async () => {
  await withWorkspaceApp(
    { files: { "notes.tex": "" }, folders: ["sections"] },
    async ({ page }) => {
      const result = await page.evaluate(() => {
        const source = document.querySelector('button.file-item[data-path="notes.tex"]');
        const target = document.querySelector(
          'details.file-folder[data-path="sections"] > summary'
        );
        if (!source || !target) {
          return { ok: false };
        }
        const dataTransfer = new DataTransfer();
        dataTransfer.setData(
          "application/x-tex180-item",
          JSON.stringify({ path: "notes.tex", kind: "file" })
        );
        source.dispatchEvent(
          new DragEvent("dragstart", { bubbles: true, dataTransfer })
        );
        target.dispatchEvent(
          new DragEvent("dragover", { bubbles: true, dataTransfer })
        );
        return {
          ok: true,
          sourceDragging: source.classList.contains("is-dragging"),
          targetHighlighted: target.classList.contains("is-drop-target"),
        };
      });
      expect(result.ok).toBe(true);
      expect(result.sourceDragging).toBe(true);
      expect(result.targetHighlighted).toBe(true);
    }
  );
});

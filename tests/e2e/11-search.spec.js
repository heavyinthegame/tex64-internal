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
  "Alpha beta gamma",
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
  const root = await createTempDir("search-");
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

const openSearchTab = async (page) => {
  await page.click('.tab[data-tab="search"]');
  await expect(page.locator('.panel[data-panel="search"]')).toHaveClass(/is-active/);
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

test("T11-01 search request fires", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSearchTab(page);
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await page.fill("#search-input", "alpha");
    await page.click("#search-button");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__tex180PostMessages || []).some(
              (message) => message.type === "search" && message.query === "alpha"
            )
        )
      )
      .toBe(true);
  });
});

test("T11-01b search request fires on Enter", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSearchTab(page);
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await page.fill("#search-input", "beta");
    await page.keyboard.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__tex180PostMessages || []).some(
              (message) => message.type === "search" && message.query === "beta"
            )
        )
      )
      .toBe(true);
  });
});

test("T11-02 results group by file", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openSearchTab(page);
    await sendBridgeMessage(electronApp, "updateSearch", {
      query: "alpha",
      results: [
        { path: "main.tex", line: 3, preview: "alpha beta" },
        { path: "sections/intro.tex", line: 5, preview: "alpha" },
        { path: "sections/intro.tex", line: 8, preview: "alpha again" },
      ],
    });
    await expect(page.locator(".search-file-group")).toHaveCount(2);
    const mainGroup = page.locator(".search-file-group", { hasText: "main.tex" });
    await expect(mainGroup).toHaveCount(1);
    await expect(mainGroup.locator(".search-match-line").first()).toHaveText("行 3");
  });
});

test("T11-03 clicking result opens file", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openSearchTab(page);
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await sendBridgeMessage(electronApp, "updateSearch", {
      query: "alpha",
      results: [{ path: "main.tex", line: 3, preview: "alpha" }],
    });
    await page.click(".search-match-item");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__tex180PostMessages || []).some(
              (message) =>
                message.type === "openFile" &&
                message.path === "main.tex" &&
                message.line === 3
            )
        )
      )
      .toBe(true);
  });
});

test("T11-04 empty query shows message", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSearchTab(page);
    await page.fill("#search-input", "");
    await page.click("#search-button");
    await expect(page.locator(".search-empty")).toHaveText(
      "\u691c\u7d22\u8a9e\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002"
    );
  });
});

test("T11-05 search with no workspace shows warning", async () => {
  const { electronApp, page } = await launchApp({ workspacePath: null });
  try {
    await page.waitForSelector("#search-input");
    await openSearchTab(page);
    await page.click("#search-button");
    await expect(page.locator(".search-empty")).toHaveText(
      "\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u304c\u672a\u9078\u629e\u3067\u3059\u3002"
    );
  } finally {
    await electronApp.close();
  }
});

test("T11-06 no matches shows empty state", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openSearchTab(page);
    await sendBridgeMessage(electronApp, "updateSearch", {
      query: "none",
      results: [],
    });
    await expect(page.locator(".search-empty")).toHaveText(
      "\u4e00\u81f4\u3059\u308b\u7d50\u679c\u304c\u3042\u308a\u307e\u305b\u3093\u3002"
    );
  });
});

test("T11-07 search result limit respects payload", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openSearchTab(page);
    const results = Array.from({ length: 25 }, (_, i) => ({
      path: "main.tex",
      line: i + 1,
      preview: `hit ${i + 1}`,
    }));
    await sendBridgeMessage(electronApp, "updateSearch", {
      query: "hit",
      results,
    });
    await expect(page.locator(".search-match-item")).toHaveCount(25);
  });
});

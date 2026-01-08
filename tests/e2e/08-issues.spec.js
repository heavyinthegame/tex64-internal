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
  "\\end{document}",
  "",
].join("\n");

const TEXT = {
  errorSummary: "\u30a8\u30e9\u30fc\u304c\u3042\u308a\u307e\u3059\u3002",
  successSummary: "\u30d3\u30eb\u30c9\u6210\u529f",
  opsSummary: "\u64cd\u4f5c\u30a8\u30e9\u30fc\u304c\u767a\u751f\u3057\u307e\u3057\u305f\u3002",
  logLine: "Log line 1\nLog line 2",
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
  const root = await createTempDir("issues-");
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

const openIssuesTab = async (page) => {
  await page.click('.tab[data-tab="issues"]');
  await expect(page.locator('.panel[data-panel="issues"]')).toHaveClass(/is-active/);
};

const getEditorLine = async (page) =>
  page.evaluate(() => window.__tex180Editor?.getPosition?.()?.lineNumber ?? 0);

test("T8-01 issues bar updates count and summary", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "updateIssues", {
      count: 2,
      summary: TEXT.errorSummary,
      status: "error",
      issues: [
        { severity: "error", message: "Error 1" },
        { severity: "error", message: "Error 2" },
      ],
    });
    await expect(page.locator("#issues-count")).toHaveText("2");
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.errorSummary);
  });
});

test("T8-02 issues tab alerts on error", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "updateIssues", {
      count: 1,
      summary: TEXT.errorSummary,
      status: "error",
      issues: [{ severity: "error", message: "Error" }],
    });
    await expect(page.locator("#issues-tab")).toHaveClass(/is-alert/);
  });
});

test("T8-03 issues clear on success", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "updateIssues", {
      count: 0,
      summary: TEXT.successSummary,
      status: "success",
      issues: [],
    });
    await expect(page.locator("#issues-count")).toHaveText("0");
    await expect(page.locator("#issues-tab")).not.toHaveClass(/is-alert/);
  });
});

test("T8-04 issue item click jumps to line", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "updateIssues", {
      count: 1,
      summary: TEXT.errorSummary,
      status: "error",
      issues: [
        {
          severity: "error",
          message: "main.tex:3: error",
          path: "main.tex",
          line: 3,
        },
      ],
    });
    await openIssuesTab(page);
    await page.click("#issues-list .issue-item");
    await expect
      .poll(() => getEditorLine(page))
      .toBe(3);
    await expect(page.locator(".issue-line-highlight")).toHaveCount(1);
  });
});

test("T8-05 build log detail shows content", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "buildLog", { log: TEXT.logLine });
    await expect(page.locator("#issues-log")).not.toHaveClass(/is-hidden/);
    await page.click("#issues-log summary");
    await expect(page.locator("#issues-log-content")).toHaveText(TEXT.logLine);
  });
});

test("T8-06 build log hidden when absent", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "buildLog", { log: null });
    await expect(page.locator("#issues-log")).toHaveClass(/is-hidden/);
  });
});

test("T8-07 issues show aggregated errors", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "updateIssues", {
      count: 3,
      summary: TEXT.opsSummary,
      status: "error",
      issues: [
        { severity: "error", message: "Save failed" },
        { severity: "error", message: "Format failed" },
        { severity: "error", message: "Create failed" },
      ],
    });
    await expect(page.locator("#issues-count")).toHaveText("3");
    await expect(page.locator("#issues-list .issue-item")).toHaveCount(3);
  });
});

test("T8-08 issues bar aria-expanded toggles", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await page.click('.tab[data-tab="issues"]');
    await expect(page.locator("#issues-bar")).toHaveAttribute("aria-expanded", "true");
    await page.click('.tab[data-tab="files"]');
    await expect(page.locator("#issues-bar")).toHaveAttribute("aria-expanded", "false");
  });
});

test("T8-09 build errors focus issues tab", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await page.click('.tab[data-tab="outline"]');
    await expect(page.locator('.panel[data-panel="outline"]')).toHaveClass(/is-active/);
    await expect(page.locator('.panel[data-panel="issues"]')).not.toHaveClass(/is-active/);
    await sendBridgeMessage(electronApp, "setBuildState", { state: "failed" });
    await sendBridgeMessage(electronApp, "updateIssues", {
      count: 1,
      summary: TEXT.errorSummary,
      status: "error",
      issues: [{ severity: "error", message: "Build failed" }],
    });
    await expect(page.locator('.panel[data-panel="issues"]')).toHaveClass(/is-active/);
  });
});

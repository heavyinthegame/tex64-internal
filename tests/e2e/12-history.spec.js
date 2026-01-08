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
  const root = await createTempDir("history-");
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

const openHistoryTab = async (page) => {
  await page.click('.tab[data-tab="git"]');
  await expect(page.locator('.panel[data-panel="git"]')).toHaveClass(/is-active/);
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

const buildGitPayload = (overrides = {}) => {
  const repo = { ok: true, ...(overrides.repo || {}) };
  const remote = { exists: false, ...(overrides.remote || {}) };
  const branch = { detached: false, ahead: 0, behind: 0, ...(overrides.branch || {}) };
  return {
    entries: [],
    history: [],
    repo,
    remote,
    branch,
    message: overrides.message,
    historyMessage: overrides.historyMessage,
  };
};

const updateGit = async (electronApp, overrides) =>
  sendBridgeMessage(electronApp, "updateGit", buildGitPayload(overrides));

test("T12-01 refresh triggers status request", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await page.click("#git-refresh");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__tex180PostMessages || []).some(
              (message) => message.type === "gitStatus"
            )
        )
      )
      .toBe(true);
    await updateGit(electronApp, {
      entries: [{ path: "main.tex", status: "M" }],
    });
    await expect(page.locator("#git-status .git-item")).toHaveCount(1);
  });
});

test("T12-02 shows no changes", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await updateGit(electronApp, {});
    await expect(page.locator("#git-status .panel-placeholder")).toHaveText(
      "\u5909\u66f4\u306f\u3042\u308a\u307e\u305b\u3093\u3002"
    );
  });
});

test("T12-03 init button appears when disabled", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await updateGit(electronApp, { repo: { ok: false } });
    await expect(page.locator("#git-init-row")).toBeVisible();
    await expect(page.locator("#git-init")).toBeVisible();
  });
});

test("T12-16 non-repo summary message", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await updateGit(electronApp, { repo: { ok: false } });
    await expect(page.locator("#git-summary-text")).toHaveText(
      "\u5c65\u6b74\u7ba1\u7406\u304c\u307e\u3060\u6709\u52b9\u3067\u306f\u3042\u308a\u307e\u305b\u3093\u3002"
    );
  });
});

test("T12-04 init sends gitInit", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await updateGit(electronApp, { repo: { ok: false } });
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await page.click("#git-init");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__tex180PostMessages || []).some(
              (message) => message.type === "gitInit"
            )
        )
      )
      .toBe(true);
  });
});

test("T12-05 save clears changes", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await updateGit(electronApp, {
      entries: [{ path: "main.tex", status: "M" }],
    });
    await page.fill("#git-commit-message", "save");
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await page.click("#git-commit-button");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__tex180PostMessages || []).some(
              (message) => message.type === "gitDiff" && message.mode === "commit"
            )
        )
      )
      .toBe(true);
    await sendBridgeMessage(electronApp, "updateGitDiff", {
      ok: true,
      mode: "commit",
      patch: "diff --git a/main.tex b/main.tex\n+New line\n",
    });
    await expect(page.locator("#diff-modal")).toHaveClass(/is-open/);
    await page.click("#diff-modal-submit");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__tex180PostMessages || []).some(
              (message) => message.type === "gitCommit"
            )
        )
      )
      .toBe(true);
    await updateGit(electronApp, { entries: [] });
    await expect(page.locator("#git-status .panel-placeholder")).toHaveText(
      "\u5909\u66f4\u306f\u3042\u308a\u307e\u305b\u3093\u3002"
    );
  });
});

test("T12-06 sync target missing disables pull/push", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await updateGit(electronApp, { remote: { exists: false } });
    await expect(page.locator("#git-remote-url")).toBeVisible();
    await expect(page.locator("#git-pull")).toBeDisabled();
    await expect(page.locator("#git-push")).toBeDisabled();
  });
});

test("T12-07 remote save sends gitSetRemote", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await updateGit(electronApp, {});
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await page.fill("#git-remote-url", "https://example.com/repo.git");
    await page.click("#git-remote-save");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__tex180PostMessages || []).some(
              (message) =>
                message.type === "gitSetRemote" &&
                message.url === "https://example.com/repo.git"
            )
        )
      )
      .toBe(true);
  });
});

test("T12-08 pull sends gitPull", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await updateGit(electronApp, { remote: { exists: true } });
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await page.click("#git-pull");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__tex180PostMessages || []).some(
              (message) => message.type === "gitPull"
            )
        )
      )
      .toBe(true);
  });
});

test("T12-09 push sends gitPush", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await updateGit(electronApp, { remote: { exists: true } });
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await page.click("#git-push");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__tex180PostMessages || []).some(
              (message) => message.type === "gitPush"
            )
        )
      )
      .toBe(true);
  });
});

test("T12-10 sync disabled with changes", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await updateGit(electronApp, {
      remote: { exists: true },
      entries: [{ path: "main.tex", status: "M" }],
    });
    await expect(page.locator("#git-pull")).toBeDisabled();
    await expect(page.locator("#git-push")).toBeDisabled();
    await expect(page.locator("#git-sync-text")).toHaveText(
      "\u9001\u53d7\u4fe1\u306e\u524d\u306b\u5c65\u6b74\u306b\u4fdd\u5b58\u3057\u3066\u304f\u3060\u3055\u3044\u3002"
    );
  });
});

test("T12-11 history list shows latest first", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await updateGit(electronApp, {
      history: [
        {
          hash: "aaaa",
          shortHash: "aaaa",
          message: "latest",
          date: "2024-01-01",
        },
        {
          hash: "bbbb",
          shortHash: "bbbb",
          message: "older",
          date: "2023-12-31",
        },
      ],
    });
    const first = page.locator(".git-history-item").first();
    await expect(first).toHaveAttribute("data-current", "true");
    await expect(first).toContainText("\u73fe\u5728");
  });
});

test("T12-12 restore preview sends gitDiff", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await updateGit(electronApp, {
      history: [
        { hash: "aaaa", shortHash: "aaaa", message: "latest", date: "2024-01-01" },
        { hash: "bbbb", shortHash: "bbbb", message: "older", date: "2023-12-31" },
      ],
    });
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await page.locator('.git-history-item:nth-child(2) button[data-git-action="restore"]').click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__tex180PostMessages || []).some(
              (message) => message.type === "gitDiff" && message.mode === "restore"
            )
        )
      )
      .toBe(true);
  });
});

test("T12-13 commit preview opens diff modal", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await updateGit(electronApp, {
      entries: [{ path: "main.tex", status: "M" }],
    });
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await page.click("#git-commit-button");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__tex180PostMessages || []).some(
              (message) => message.type === "gitDiff" && message.mode === "commit"
            )
        )
      )
      .toBe(true);
    await sendBridgeMessage(electronApp, "updateGitDiff", {
      ok: true,
      mode: "commit",
      patch: "diff --git a/main.tex b/main.tex\n+New line\n",
    });
    await expect(page.locator("#diff-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#diff-modal-title")).toHaveText(
      "\u5c65\u6b74\u306b\u4fdd\u5b58\u306e\u78ba\u8a8d"
    );
  });
});

test("T12-14 restore preview opens diff modal", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await updateGit(electronApp, {
      history: [
        { hash: "aaaa", shortHash: "aaaa", message: "latest", date: "2024-01-01" },
        { hash: "bbbb", shortHash: "bbbb", message: "older", date: "2023-12-31" },
      ],
    });
    await page.locator('.git-history-item:nth-child(2) button[data-git-action="restore"]').click();
    await sendBridgeMessage(electronApp, "updateGitDiff", {
      ok: true,
      mode: "restore",
      hash: "bbbb",
      patch: "diff --git a/main.tex b/main.tex\n-Old\n+New\n",
    });
    await expect(page.locator("#diff-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#diff-modal-title")).toHaveText(
      "\u5c65\u6b74\u3092\u623b\u3059\u78ba\u8a8d"
    );
  });
});

test("T12-15 sync guide shows hint", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openHistoryTab(page);
    await updateGit(electronApp, { remote: { exists: true } });
    await sendBridgeMessage(electronApp, "gitActionResult", {
      action: "pull",
      ok: false,
      hint: "Auth required",
    });
    await expect(page.locator("#git-guide")).toBeVisible();
    await expect(page.locator("#git-guide-text")).toHaveText("Auth required");
  });
});

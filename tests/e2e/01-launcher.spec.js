import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  launchApp,
  workspaceRoot,
  installDialogStub,
  queueDialogResult,
  resolveDialog,
  getDialogCalls,
  createTempDir,
  writeWorkspaceFile,
  removeDir,
} from "./helpers.js";

const TEXT = {
  cancel: "\u30ad\u30e3\u30f3\u30bb\u30eb\u3057\u307e\u3057\u305f\u3002",
  cancelIssues: "\u30d5\u30a9\u30eb\u30c0\u9078\u629e\u3092\u30ad\u30e3\u30f3\u30bb\u30eb\u3057\u307e\u3057\u305f\u3002",
  notEmpty: "\u30d5\u30a9\u30eb\u30c0\u304c\u7a7a\u3067\u306f\u3042\u308a\u307e\u305b\u3093\u3002",
  busy: "\u6e96\u5099\u4e2d...",
  lectureTitle: "\u8b1b\u7fa9\u30ce\u30fc\u30c8",
  lectureSections: ["\u76ee\u7684", "\u5185\u5bb9", "\u307e\u3068\u3081"],
};

const withApp = async (options, run) => {
  const { electronApp, page } = await launchApp(options);
  try {
    return await run({ electronApp, page });
  } finally {
    await electronApp.close();
  }
};

const withTempWorkspace = async (prefix, run) => {
  const dir = await createTempDir(prefix);
  try {
    return await run(dir);
  } finally {
    await removeDir(dir);
  }
};

const waitForLauncher = async (page) => {
  await page.waitForSelector("#launcher.is-visible");
};

const waitForActiveTab = async (page, filePath) => {
  await page.waitForSelector(`.editor-tab.is-active[data-path="${filePath}"]`);
};

const waitForEditorReady = async (page) => {
  await page.waitForFunction(() => !!window.__tex180Editor?.getValue);
};

const getEditorValue = async (page) => {
  await waitForEditorReady(page);
  return page.evaluate(() => window.__tex180Editor.getValue());
};

test("T1-01 launcher only on startup", async () => {
  await withApp({ workspacePath: null }, async ({ page }) => {
    await waitForLauncher(page);
    await expect(page.locator("#launcher")).toBeVisible();
    await expect(page.locator("#editor-groups")).not.toBeVisible();
    await expect(page.locator(".sidebar")).not.toBeVisible();
  });
});

test("T1-02 template toggle", async () => {
  await withApp({ workspacePath: null }, async ({ page }) => {
    await waitForLauncher(page);
    const paper = page.locator('.launcher-template-button[data-template="paper"]');
    const lecture = page.locator('.launcher-template-button[data-template="lecture"]');
    await expect(paper).toHaveClass(/is-active/);
    await lecture.click();
    await expect(lecture).toHaveClass(/is-active/);
    await expect(paper).not.toHaveClass(/is-active/);
    await paper.click();
    await expect(paper).toHaveClass(/is-active/);
  });
});

test("T1-03 open existing folder dialog", async () => {
  await withApp({ workspacePath: null }, async ({ electronApp, page }) => {
    await waitForLauncher(page);
    await installDialogStub(electronApp);
    await queueDialogResult(electronApp, { canceled: true, filePaths: [] });
    await page.click("#launcher-open");
    await expect
      .poll(async () => (await getDialogCalls(electronApp)).length)
      .toBe(1);
    const [call] = await getDialogCalls(electronApp);
    expect(call.hasWindow).toBe(true);
    expect(call.options.properties).toContain("openDirectory");
  });
});

test("T1-04 open existing folder cancel", async () => {
  await withApp({ workspacePath: null }, async ({ electronApp, page }) => {
    await waitForLauncher(page);
    await installDialogStub(electronApp);
    await queueDialogResult(electronApp, { canceled: true, filePaths: [] });
    await page.click("#launcher-open");
    await expect(page.locator("#launcher")).toBeVisible();
    await expect(page.locator("#launcher-status-text")).toHaveText(TEXT.cancel);
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.cancelIssues);
    await expect(page.locator("#file-tree")).not.toBeVisible();
  });
});

test("T1-05 open existing folder selection", async () => {
  await withApp({ workspacePath: null }, async ({ electronApp, page }) => {
    await waitForLauncher(page);
    await installDialogStub(electronApp);
    await queueDialogResult(electronApp, { canceled: false, filePaths: [workspaceRoot] });
    await page.click("#launcher-open");
    await page.waitForSelector("#file-tree");
    await expect(page.locator("#launcher")).not.toBeVisible();
    await expect(page.locator("#workspace-label")).toHaveText(path.basename(workspaceRoot));
    await expect(page.locator('button.file-item[data-path="main.tex"]')).toBeVisible();
  });
});

test("T1-06 create project dialog", async () => {
  await withApp({ workspacePath: null }, async ({ electronApp, page }) => {
    await waitForLauncher(page);
    await installDialogStub(electronApp);
    await queueDialogResult(electronApp, { canceled: true, filePaths: [] });
    await page.click("#launcher-create");
    await expect
      .poll(async () => (await getDialogCalls(electronApp)).length)
      .toBe(1);
    const [call] = await getDialogCalls(electronApp);
    expect(call.hasWindow).toBe(true);
    expect(call.options.properties).toContain("openDirectory");
    expect(call.options.properties).toContain("createDirectory");
  });
});

test("T1-07 create project cancel", async () => {
  await withApp({ workspacePath: null }, async ({ electronApp, page }) => {
    await waitForLauncher(page);
    await installDialogStub(electronApp);
    await queueDialogResult(electronApp, { canceled: true, filePaths: [] });
    await page.click("#launcher-create");
    await expect(page.locator("#launcher")).toBeVisible();
    await expect(page.locator("#file-tree")).not.toBeVisible();
  });
});

test("T1-08 create project non-empty folder", async () => {
  await withTempWorkspace("non-empty-", async (workspacePath) => {
    await writeWorkspaceFile(workspacePath, "keep.txt", "seed");
    await withApp({ workspacePath: null }, async ({ electronApp, page }) => {
      await waitForLauncher(page);
      await installDialogStub(electronApp);
      await queueDialogResult(electronApp, { canceled: false, filePaths: [workspacePath] });
      await page.click("#launcher-create");
      await expect(page.locator("#launcher")).toBeVisible();
      await expect(page.locator("#launcher-status-text")).toHaveText(TEXT.notEmpty);
      await expect(page.locator("#file-tree")).not.toBeVisible();
    });
  });
});

test("T1-09 create project paper template", async () => {
  await withTempWorkspace("paper-", async (workspacePath) => {
    await withApp({ workspacePath: null }, async ({ electronApp, page }) => {
      await waitForLauncher(page);
      await installDialogStub(electronApp);
      await queueDialogResult(electronApp, { canceled: false, filePaths: [workspacePath] });
      await page.click("#launcher-create");
      await page.waitForSelector("#file-tree");
      await expect(page.locator("#launcher")).not.toBeVisible();
      await expect(page.locator('button.file-item[data-path="main.tex"]')).toBeVisible();
      const stat = await fs.stat(path.join(workspacePath, "main.tex"));
      expect(stat.isFile()).toBe(true);
      const tex180Exists = await fs
        .stat(path.join(workspacePath, ".tex180"))
        .then(() => true)
        .catch(() => false);
      expect(tex180Exists).toBe(false);
    });
  });
});

test("T1-10 paper template content", async () => {
  await withTempWorkspace("paper-content-", async (workspacePath) => {
    await withApp({ workspacePath: null }, async ({ electronApp, page }) => {
      await waitForLauncher(page);
      await installDialogStub(electronApp);
      await queueDialogResult(electronApp, { canceled: false, filePaths: [workspacePath] });
      await page.click("#launcher-create");
      await page.waitForSelector("#file-tree");
      await waitForActiveTab(page, "main.tex");
      const content = await getEditorValue(page);
      expect(content).toContain("\\title");
      expect(content).toContain("\\author");
      expect(content).toContain("\\begin{abstract}");
      expect(content).toContain("\\section");
    });
  });
});

test("T1-11 lecture template content", async () => {
  await withTempWorkspace("lecture-", async (workspacePath) => {
    await withApp({ workspacePath: null }, async ({ electronApp, page }) => {
      await waitForLauncher(page);
      await installDialogStub(electronApp);
      await page.click('.launcher-template-button[data-template="lecture"]');
      await queueDialogResult(electronApp, { canceled: false, filePaths: [workspacePath] });
      await page.click("#launcher-create");
      await page.waitForSelector("#file-tree");
      await waitForActiveTab(page, "main.tex");
      const content = await getEditorValue(page);
      expect(content).toContain(`\\title{${TEXT.lectureTitle}}`);
      for (const section of TEXT.lectureSections) {
        expect(content).toContain(`\\section{${section}}`);
      }
      expect(content).toContain("\\subsection{");
    });
  });
});

test("T1-12 launcher status busy and clears", async () => {
  await withApp({ workspacePath: null }, async ({ electronApp, page }) => {
    await waitForLauncher(page);
    await installDialogStub(electronApp);
    await page.click("#launcher-open");
    await expect(page.locator("#launcher-status")).toHaveClass(/is-visible/);
    await expect(page.locator("#launcher-status")).toHaveClass(/is-busy/);
    await expect(page.locator("#launcher-status-text")).toHaveText(TEXT.busy);
    await expect(page.locator("#launcher-status-spinner")).toBeVisible();
    await resolveDialog(electronApp, { canceled: false, filePaths: [workspaceRoot] });
    await page.waitForSelector("#file-tree");
    await expect(page.locator("#launcher-status")).not.toHaveClass(/is-busy/);
    await expect(page.locator("#launcher-status")).not.toHaveClass(/is-visible/);
  });
});

test("T1-13 auto open root file from settings", async () => {
  await withTempWorkspace("root-file-", async (workspacePath) => {
    await writeWorkspaceFile(workspacePath, "main.tex", "\\documentclass{article}\\n");
    await writeWorkspaceFile(workspacePath, "sections/intro.tex", "intro");
    await writeWorkspaceFile(
      workspacePath,
      ".tex180/settings.json",
      JSON.stringify({ rootFile: "sections/intro.tex" }, null, 2)
    );
    await withApp({ workspacePath }, async ({ page }) => {
      await waitForActiveTab(page, "sections/intro.tex");
    });
  });
});

test("T1-14 auto open main.tex", async () => {
  await withTempWorkspace("auto-main-", async (workspacePath) => {
    await writeWorkspaceFile(
      workspacePath,
      "main.tex",
      "\\documentclass{article}\\n\\begin{document}\\nBody\\n\\end{document}\\n"
    );
    await writeWorkspaceFile(workspacePath, "notes.tex", "draft");
    await withApp({ workspacePath }, async ({ page }) => {
      await waitForActiveTab(page, "main.tex");
    });
  });
});

test("T1-15 auto open first tex by name", async () => {
  await withTempWorkspace("auto-tex-", async (workspacePath) => {
    await writeWorkspaceFile(workspacePath, "b.tex", "draft b");
    await writeWorkspaceFile(workspacePath, "a.tex", "draft a");
    await withApp({ workspacePath }, async ({ page }) => {
      await waitForActiveTab(page, "a.tex");
    });
  });
});

test("T1-16 auto open first non-tex file", async () => {
  await withTempWorkspace("auto-non-tex-", async (workspacePath) => {
    const pngData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=",
      "base64"
    );
    await writeWorkspaceFile(workspacePath, "image.png", pngData);
    await withApp({ workspacePath }, async ({ page }) => {
      await waitForActiveTab(page, "image.png");
    });
  });
});

test("T1-17 e2e auto open via env", async () => {
  await withApp({ workspacePath: workspaceRoot }, async ({ page }) => {
    await page.waitForSelector("#file-tree");
    await expect(page.locator("#launcher")).not.toBeVisible();
    await expect(page.locator("#workspace-label")).toHaveText(path.basename(workspaceRoot));
  });
});

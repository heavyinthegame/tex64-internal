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
  const root = await createTempDir("persist-");
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

const launchWorkspace = async (root) => {
  const { electronApp, page } = await launchApp({ workspacePath: root });
  await waitForWorkspaceReady(page);
  return { electronApp, page };
};

const resetLocalStorage = async (page) => {
  await page.evaluate(() => {
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith("tex180.")) {
        localStorage.removeItem(key);
      }
    });
  });
};

const openSettingsPage = async (page, target) => {
  await page.click('.tab[data-tab="settings"]');
  await page.click(`.settings-nav-item[data-settings-target="${target}"]`);
  await expect(page.locator(`.settings-page[data-settings-page="${target}"]`)).toHaveClass(
    /is-active/
  );
};

const openProjectTab = async (page) => {
  await page.click('.tab[data-tab="project"]');
  await expect(page.locator('.panel[data-panel="project"]')).toHaveClass(/is-active/);
};

const openFileFromTree = async (page, filePath) => {
  const selector = `button.file-item[data-path="${filePath}"]`;
  await page.waitForSelector(selector);
  await page.click(selector);
  await page.waitForSelector(`${selector}.is-active`);
  await page.waitForSelector(`.editor-tab.is-active[data-path="${filePath}"]`);
};

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

test("T14-01 tab visibility persists", async () => {
  const root = await createWorkspace({});
  let electronApp;
  let page;
  try {
    ({ electronApp, page } = await launchWorkspace(root));
    await resetLocalStorage(page);
    await page.reload();
    await waitForWorkspaceReady(page);
    await page.click(".sidebar", { button: "right" });
    await page.getByRole("button", { name: /\u30a2\u30a6\u30c8\u30e9\u30a4\u30f3/ }).click();
    await expect(page.locator('.tab[data-tab="outline"]')).toHaveClass(/is-hidden/);
    await electronApp.close();

    ({ electronApp, page } = await launchWorkspace(root));
    await expect(page.locator('.tab[data-tab="outline"]')).toHaveClass(/is-hidden/);
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    await removeDir(root);
  }
});

test("T14-02 folder open state persists", async () => {
  const root = await createWorkspace({
    files: { "sections/intro.tex": "Intro" },
    folders: ["sections"],
  });
  let electronApp;
  let page;
  try {
    ({ electronApp, page } = await launchWorkspace(root));
    await resetLocalStorage(page);
    await page.reload();
    await waitForWorkspaceReady(page);
    await page.click('details.file-folder[data-path="sections"] > summary');
    await expect(page.locator('details.file-folder[data-path="sections"]')).toHaveAttribute(
      "open",
      ""
    );
    await electronApp.close();

    ({ electronApp, page } = await launchWorkspace(root));
    await expect(page.locator('details.file-folder[data-path="sections"]')).toHaveAttribute(
      "open",
      ""
    );
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    await removeDir(root);
  }
});

test("T14-03 editor settings persist", async () => {
  const root = await createWorkspace({});
  let electronApp;
  let page;
  try {
    ({ electronApp, page } = await launchWorkspace(root));
    await resetLocalStorage(page);
    await page.reload();
    await waitForWorkspaceReady(page);
    await openSettingsPage(page, "editor");
    const synctex = page.locator("#editor-auto-synctex-build");
    const pdfWindow = page.locator("#editor-pdf-window");
    const nextSynctex = !(await synctex.isChecked());
    const nextPdf = !(await pdfWindow.isChecked());
    await synctex.click();
    await pdfWindow.click();
    await electronApp.close();

    ({ electronApp, page } = await launchWorkspace(root));
    await openSettingsPage(page, "editor");
    const synctexAfter = page.locator("#editor-auto-synctex-build");
    const pdfAfter = page.locator("#editor-pdf-window");
    await expect(synctexAfter).toHaveJSProperty("checked", nextSynctex);
    await expect(pdfAfter).toHaveJSProperty("checked", nextPdf);
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    await removeDir(root);
  }
});

test("T14-04 format settings persist", async () => {
  const root = await createWorkspace({});
  let electronApp;
  let page;
  try {
    ({ electronApp, page } = await launchWorkspace(root));
    await resetLocalStorage(page);
    await page.reload();
    await waitForWorkspaceReady(page);
    await openSettingsPage(page, "format");
    await page.selectOption("#editor-format-indent", "tab");
    await page.selectOption("#editor-format-blank-lines", "remove");
    await page.click("#editor-format-begin-end");
    await electronApp.close();

    ({ electronApp, page } = await launchWorkspace(root));
    await openSettingsPage(page, "format");
    await expect(page.locator("#editor-format-indent")).toHaveValue("tab");
    await expect(page.locator("#editor-format-blank-lines")).toHaveValue("remove");
    await expect(page.locator("#editor-format-begin-end")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    await removeDir(root);
  }
});

test("T14-05 verbatim settings persist", async () => {
  const root = await createWorkspace({});
  let electronApp;
  let page;
  try {
    ({ electronApp, page } = await launchWorkspace(root));
    await resetLocalStorage(page);
    await page.reload();
    await waitForWorkspaceReady(page);
    await openSettingsPage(page, "format");
    await page.fill("#editor-format-verbatim-input", "myverb");
    await page.click("#editor-format-verbatim-add");
    await electronApp.close();

    ({ electronApp, page } = await launchWorkspace(root));
    await openSettingsPage(page, "format");
    await expect(page.locator('#editor-format-verbatim-list [data-verbatim-name="myverb"]')).toHaveCount(1);
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    await removeDir(root);
  }
});

test("T14-06 env registry settings persist", async () => {
  const root = await createWorkspace({});
  let electronApp;
  let page;
  try {
    ({ electronApp, page } = await launchWorkspace(root));
    await resetLocalStorage(page);
    await page.reload();
    await waitForWorkspaceReady(page);
    await openSettingsPage(page, "env");
    await page.fill("#env-registry-input", "myenv");
    await page.click("#env-registry-add");
    const toggle = page.locator('#env-registry-math [data-env-name="myenv"] [data-env-action="toggle"]');
    await toggle.click();
    await electronApp.close();

    ({ electronApp, page } = await launchWorkspace(root));
    await openSettingsPage(page, "env");
    await expect(page.locator('#env-registry-math [data-env-name="myenv"]')).toHaveCount(1);
    const toggleAfter = page.locator(
      '#env-registry-math [data-env-name="myenv"] [data-env-action="toggle"]'
    );
    await expect(toggleAfter).toHaveAttribute("aria-pressed", "false");
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    await removeDir(root);
  }
});

test("T14-07 build engine persists", async () => {
  const root = await createWorkspace({});
  let electronApp;
  let page;
  try {
    ({ electronApp, page } = await launchWorkspace(root));
    await resetLocalStorage(page);
    await page.reload();
    await waitForWorkspaceReady(page);
    await openSettingsPage(page, "build");
    await page.selectOption("#settings-compile-engine", "xelatex");
    await electronApp.close();

    ({ electronApp, page } = await launchWorkspace(root));
    await openSettingsPage(page, "build");
    await expect(page.locator("#settings-compile-engine")).toHaveValue("xelatex");
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    await removeDir(root);
  }
});

test("T14-08 pdf viewer mode persists", async () => {
  const root = await createWorkspace({});
  let electronApp;
  let page;
  try {
    ({ electronApp, page } = await launchWorkspace(root));
    await resetLocalStorage(page);
    await page.reload();
    await waitForWorkspaceReady(page);
    await openSettingsPage(page, "editor");
    const toggle = page.locator("#editor-pdf-window");
    const nextValue = !(await toggle.isChecked());
    await toggle.click();
    await electronApp.close();

    ({ electronApp, page } = await launchWorkspace(root));
    await openSettingsPage(page, "editor");
    const toggleAfter = page.locator("#editor-pdf-window");
    await expect(toggleAfter).toHaveJSProperty("checked", nextValue);
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    await removeDir(root);
  }
});

test("T14-09 main TeX selection persists", async () => {
  const root = await createWorkspace({
    files: { "chapters/intro.tex": "Intro" },
    folders: ["chapters"],
  });
  let electronApp;
  let page;
  try {
    ({ electronApp, page } = await launchWorkspace(root));
    await resetLocalStorage(page);
    await page.reload();
    await waitForWorkspaceReady(page);
    await openProjectTab(page);
    await page.selectOption("#settings-root-select", "chapters/intro.tex");
    await electronApp.close();

    ({ electronApp, page } = await launchWorkspace(root));
    await openProjectTab(page);
    await expect(page.locator("#settings-root-select")).toHaveValue("chapters/intro.tex");
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    await removeDir(root);
  }
});

test("T14-10 open tabs are not persisted", async () => {
  const root = await createWorkspace({ files: { "notes.tex": "Notes" } });
  let electronApp;
  let page;
  try {
    ({ electronApp, page } = await launchWorkspace(root));
    await openFileFromTree(page, "notes.tex");
    await expect(page.locator(".editor-tab")).toHaveCount(2);
    await electronApp.close();

    ({ electronApp, page } = await launchWorkspace(root));
    await expect(page.locator('.editor-tab[data-path="notes.tex"]')).toHaveCount(0);
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    await removeDir(root);
  }
});

test("T14-11 unsaved content is not persisted", async () => {
  const root = await createWorkspace({});
  let electronApp;
  let page;
  try {
    ({ electronApp, page } = await launchWorkspace(root));
    await blockSaveFile(page);
    await page.evaluate(() => {
      window.__tex180Editor?.setValue?.("Unsaved");
    });
    await electronApp.close();

    const saved = await fs.readFile(path.join(root, "main.tex"), "utf8");
    expect(saved).not.toContain("Unsaved");

    ({ electronApp, page } = await launchWorkspace(root));
    const value = await page.evaluate(() => window.__tex180Editor?.getValue?.() ?? "");
    expect(value).not.toContain("Unsaved");
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    await removeDir(root);
  }
});

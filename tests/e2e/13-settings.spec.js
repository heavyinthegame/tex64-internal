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
  const root = await createTempDir("settings-");
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

const openSettingsTab = async (page) => {
  await page.click('.tab[data-tab="settings"]');
  await expect(page.locator('.panel[data-panel="settings"]')).toHaveClass(/is-active/);
};

const openProjectTab = async (page) => {
  await page.click('.tab[data-tab="project"]');
  await expect(page.locator('.panel[data-panel="project"]')).toHaveClass(/is-active/);
};

const openSettingsPage = async (page, target) => {
  await openSettingsTab(page);
  await page.click(`.settings-nav-item[data-settings-target="${target}"]`);
  await expect(page.locator(`.settings-page[data-settings-page="${target}"]`)).toHaveClass(
    /is-active/
  );
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

test("T13-01 settings nav shows categories", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsTab(page);
    await expect(page.locator("#settings-nav")).not.toHaveClass(/is-hidden/);
    await expect(page.locator(".settings-nav-item")).toHaveCount(5);
  });
});

test("T13-02 settings page transition", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "format");
    await expect(page.locator("#settings-pages")).not.toHaveClass(/is-hidden/);
  });
});

test("T13-03 settings back returns to nav", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "format");
    await page.click('.settings-back[data-settings-back]');
    await expect(page.locator("#settings-nav")).not.toHaveClass(/is-hidden/);
  });
});

test("T13-04 SyncTeX toggle updates", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "editor");
    const toggle = page.locator("#editor-auto-synctex-build");
    const initial = await toggle.isChecked();
    await toggle.click();
    await expect(toggle).toHaveJSProperty("checked", !initial);
  });
});

test("T13-05 PDF window toggle updates", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "editor");
    const toggle = page.locator("#editor-pdf-window");
    const initial = await toggle.isChecked();
    await toggle.click();
    await expect(toggle).toHaveJSProperty("checked", !initial);
  });
});

test("T13-06 format indent selection updates", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "format");
    await page.selectOption("#editor-format-indent", "spaces-4");
    await expect(page.locator("#editor-format-indent")).toHaveValue("spaces-4");
  });
});

test("T13-07 format begin/end toggle updates", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "format");
    const toggle = page.locator("#editor-format-begin-end");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  });
});

test("T13-08 format document noindent toggle updates", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "format");
    const toggle = page.locator("#editor-format-document-noindent");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  });
});

test("T13-09 format math align toggle updates", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "format");
    const toggle = page.locator("#editor-format-align-math");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  });
});

test("T13-10 format table align toggle updates", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "format");
    const toggle = page.locator("#editor-format-align-table");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  });
});

test("T13-11 blank lines selection updates", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "format");
    await page.selectOption("#editor-format-blank-lines", "remove");
    await expect(page.locator("#editor-format-blank-lines")).toHaveValue("remove");
  });
});

test("T13-12 verbatim add", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "format");
    await page.fill("#editor-format-verbatim-input", "myverb");
    await page.click("#editor-format-verbatim-add");
    await expect(page.locator('#editor-format-verbatim-list [data-verbatim-name="myverb"]')).toHaveCount(1);
  });
});

test("T13-13 verbatim delete", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "format");
    await page.fill("#editor-format-verbatim-input", "myverb");
    await page.click("#editor-format-verbatim-add");
    await page.click('#editor-format-verbatim-list [data-verbatim-name="myverb"] .env-registry-remove');
    await expect(page.locator('#editor-format-verbatim-list [data-verbatim-name="myverb"]')).toHaveCount(0);
  });
});

test("T13-14 env registry add", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "env");
    await page.fill("#env-registry-input", "myenv");
    await page.selectOption("#env-registry-kind", "math");
    await page.click("#env-registry-add");
    await expect(page.locator('#env-registry-math [data-env-name="myenv"]')).toHaveCount(1);
    await page.fill("#env-registry-input", "mytable");
    await page.selectOption("#env-registry-kind", "table");
    await page.click("#env-registry-add");
    await expect(page.locator('#env-registry-table [data-env-name="mytable"]')).toHaveCount(1);
  });
});

test("T13-15 env registry toggle disables entry", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "env");
    await page.fill("#env-registry-input", "myenv");
    await page.click("#env-registry-add");
    const toggle = page.locator('#env-registry-math [data-env-name="myenv"] [data-env-action="toggle"]');
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  });
});

test("T13-16 env registry delete", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "env");
    await page.fill("#env-registry-input", "myenv");
    await page.click("#env-registry-add");
    await page.click('#env-registry-math [data-env-name="myenv"] [data-env-action="remove"]');
    await expect(page.locator('#env-registry-math [data-env-name="myenv"]')).toHaveCount(0);
  });
});

test("T13-17 build engine selection updates", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openSettingsPage(page, "build");
    await page.selectOption("#settings-compile-engine", "xelatex");
    await expect(page.locator("#settings-compile-engine")).toHaveValue("xelatex");
  });
});

test("T13-18 main TeX selection posts setRoot", async () => {
  await withWorkspaceApp(
    { files: { "chapters/intro.tex": "Intro" }, folders: ["chapters"] },
    async ({ page }) => {
      await openProjectTab(page);
      await page.evaluate(() => {
        window.__tex180PostMessages = [];
      });
      await page.selectOption("#settings-root-select", "chapters/intro.tex");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window.__tex180PostMessages || []).some(
                (message) =>
                  message.type === "setRoot" && message.path === "chapters/intro.tex"
              )
          )
        )
        .toBe(true);
    }
  );
});

test("T13-19 auto detect main TeX sends detectRoot", async () => {
  await withWorkspaceApp(
    { files: { "chapters/intro.tex": "Intro" }, folders: ["chapters"] },
    async ({ page }) => {
      await openProjectTab(page);
      await page.evaluate(() => {
        window.__tex180PostMessages = [];
      });
      await page.click("#settings-root-auto");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window.__tex180PostMessages || []).some(
                (message) => message.type === "detectRoot"
              )
          )
        )
        .toBe(true);
    }
  );
});

test("T13-23 main TeX auto-detect populates select", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openProjectTab(page);
    await expect(page.locator("#settings-root-select")).toHaveValue("main.tex");
  });
});

test("T13-24 root selection writes settings.json", async () => {
  await withWorkspaceApp(
    { files: { "chapters/intro.tex": "Intro" }, folders: ["chapters"] },
    async ({ page, root }) => {
      await openProjectTab(page);
      await page.selectOption("#settings-root-select", "chapters/intro.tex");
      const settingsPath = path.join(root, ".tex180", "settings.json");
      await expect
        .poll(async () => fs.readFile(settingsPath, "utf8").catch(() => null))
        .not.toBeNull();
      const payload = JSON.parse(await fs.readFile(settingsPath, "utf8"));
      expect(payload.rootFile).toBe("chapters/intro.tex");
    }
  );
});

test("T13-20 project path shows workspace", async () => {
  await withWorkspaceApp({}, async ({ page, root }) => {
    await openProjectTab(page);
    await expect(page.locator("#settings-workspace")).toHaveText(root);
  });
});

test("T13-21 env check status updates", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openSettingsPage(page, "runtime");
    await sendBridgeMessage(electronApp, "openFileResult", {
      type: "env:checkResult",
      command: "latexmk",
      available: true,
    });
    const badge = page.locator('.env-item[data-env="latexmk"] .env-badge');
    await expect(badge).toHaveText("\u5229\u7528\u53ef\u80fd");
    await expect(badge).toHaveClass(/ok/);
  });
});

test("T13-22 env install button updates in E2E", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await openSettingsPage(page, "runtime");
    await sendBridgeMessage(electronApp, "openFileResult", {
      type: "env:checkResult",
      command: "latexmk",
      available: false,
    });
    const button = page.locator('.env-item[data-env="latexmk"] .env-btn');
    await expect(button).toBeVisible();
    await button.click();
    await expect(button).toHaveText("\u30a4\u30f3\u30b9\u30c8\u30fc\u30eb (\u30c6\u30b9\u30c8)");
  });
});

test("T13-25 root auto button label reflects root source", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page, root }) => {
    const payload = {
      rootName: path.basename(root),
      rootPath: root,
      files: ["main.tex"],
      folders: [],
      rootFile: "main.tex",
    };
    await sendBridgeMessage(electronApp, "updateWorkspace", {
      ...payload,
      rootSource: "manual",
    });
    await openProjectTab(page);
    await expect(page.locator("#settings-root-auto")).toHaveText("\u81ea\u52d5\u306b\u623b\u3059");
    await sendBridgeMessage(electronApp, "updateWorkspace", {
      ...payload,
      rootSource: "auto",
    });
    await expect(page.locator("#settings-root-auto")).toHaveText("\u518d\u691c\u51fa");
  });
});

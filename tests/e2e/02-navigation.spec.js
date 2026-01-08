import { test, expect } from "@playwright/test";
import { launchApp, workspaceRoot } from "./helpers.js";

const TEXT = {
  labels: {
    files: "\u30d5\u30a1\u30a4\u30eb",
    outline: "\u30a2\u30a6\u30c8\u30e9\u30a4\u30f3",
    blocks: "\u30d6\u30ed\u30c3\u30af",
    issues: "\u30a8\u30e9\u30fc",
    git: "\u5c65\u6b74",
    project: "\u30d7\u30ed\u30b8\u30a7\u30af\u30c8",
    search: "\u691c\u7d22",
    settings: "\u8a2d\u5b9a",
  },
  outlines: {
    files: "\u30df\u30cb\u30a2\u30a6\u30c8\u30e9\u30a4\u30f3: main.tex",
    outline: "\u7ae0\u7bc0 / \u56f3\u8868 / TODO",
    blocks: "\u30d6\u30ed\u30c3\u30af\u4e00\u89a7",
    issues: "\u30d3\u30eb\u30c9\u30a8\u30e9\u30fc",
    git: "\u5909\u66f4 / \u5c65\u6b74 / \u540c\u671f",
    project: "\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u8a2d\u5b9a",
    search: "\u691c\u7d22\u7d50\u679c",
    settings: "\u8a2d\u5b9a",
  },
  hints: {
    files: "\u30d5\u30a1\u30a4\u30eb\u30bf\u30d6\u304c\u9078\u629e\u3055\u308c\u3066\u3044\u307e\u3059\u3002",
    outline: "\u30af\u30ea\u30c3\u30af\u3067\u5b9a\u7fa9\u306b\u79fb\u52d5\u3057\u307e\u3059\u3002",
    blocks: "\u30d7\u30ec\u30d3\u30e5\u30fc\u5f8c\u306b\u78ba\u5b9a\u3057\u307e\u3059\u3002",
    git: "\u4fdd\u5b58\u3084\u540c\u671f\u306e\u64cd\u4f5c\u304c\u3067\u304d\u307e\u3059\u3002",
    project: "\u30e1\u30a4\u30f3TeX\u3084\u74b0\u5883\u767b\u9332\u3092\u7ba1\u7406\u3057\u307e\u3059\u3002",
    search: "Enter\u3067\u691c\u7d22\u3067\u304d\u307e\u3059\u3002",
    issues: "\u30af\u30ea\u30c3\u30af\u3067\u8a72\u5f53\u7b87\u6240\u3078\u79fb\u52d5\u3057\u307e\u3059\u3002",
    settings: "\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u8a2d\u5b9a\u306f\u5225\u30bf\u30d6\u306b\u3042\u308a\u307e\u3059\u3002",
  },
  miniOutlinePrefix: "\u30df\u30cb\u30a2\u30a6\u30c8\u30e9\u30a4\u30f3: ",
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("#file-tree");
  await page.waitForSelector('button.file-item[data-path="main.tex"]');
  await page.waitForFunction(() => !!window.__tex180Editor);
  await page.waitForSelector('.editor-tab.is-active[data-path="main.tex"]');
};

const resetSidebarVisibility = async (page) => {
  await page.evaluate(() => {
    localStorage.removeItem("tex180.sidebar.primaryTabs");
  });
  await page.reload();
  await waitForWorkspaceReady(page);
};

const openWorkspaceApp = async () => {
  const { electronApp, page } = await launchApp({ workspacePath: workspaceRoot });
  await waitForWorkspaceReady(page);
  await resetSidebarVisibility(page);
  return { electronApp, page };
};

const withWorkspaceApp = async (run) => {
  const { electronApp, page } = await openWorkspaceApp();
  try {
    return await run({ electronApp, page });
  } finally {
    await electronApp.close();
  }
};

const openSidebarContextMenu = async (page) => {
  await page.locator(".tab-group:not(.secondary)").click({ button: "right" });
  await expect(page.locator("#context-menu")).toHaveClass(/is-open/);
};

const clickContextMenuItem = async (page, label) => {
  const item = page.locator("#context-menu-panel .context-menu-item", {
    hasText: label,
  });
  await item.click();
};

const ensureFolderOpen = async (page, folderPath) => {
  const selector = `details.file-folder[data-path="${folderPath}"]`;
  const isOpen = await page.evaluate((sel) => {
    const target = document.querySelector(sel);
    return Boolean(target && target.open);
  }, selector);
  if (!isOpen) {
    await page.click(`${selector} > summary`);
  }
};

const getActiveTabKey = async (page) =>
  page.evaluate(() => document.body.dataset.activeTab);

const getSidebarPanelWidth = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".sidebar-panel");
    return panel ? panel.getBoundingClientRect().width : 0;
  });

test("T2-01 tab display", async () => {
  await withWorkspaceApp(async ({ page }) => {
    await expect(
      page.locator('.tab-group:not(.secondary) .tab:not(.is-hidden)')
    ).toHaveCount(6);
    await expect(page.locator(".tab-group.secondary .tab")).toHaveCount(2);
    await expect(page.locator('.tab[data-tab="files"]')).toHaveClass(/is-active/);
    await expect(page.locator('.tab[data-tab="files"]')).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });
});

test("T2-02 tab switching updates panel and hints", async () => {
  await withWorkspaceApp(async ({ page }) => {
    const tabChecks = [
      { key: "files", outline: TEXT.outlines.files, hint: TEXT.hints.files },
      { key: "outline", outline: TEXT.outlines.outline, hint: TEXT.hints.outline },
      { key: "blocks", outline: TEXT.outlines.blocks, hint: TEXT.hints.blocks },
      { key: "issues", outline: TEXT.outlines.issues, hint: TEXT.hints.issues },
      { key: "git", outline: TEXT.outlines.git, hint: TEXT.hints.git },
      { key: "project", outline: TEXT.outlines.project, hint: TEXT.hints.project },
      { key: "search", outline: TEXT.outlines.search, hint: TEXT.hints.search },
      { key: "settings", outline: TEXT.outlines.settings, hint: TEXT.hints.settings },
    ];

    for (const check of tabChecks) {
      await page.click(`.tab[data-tab="${check.key}"]`);
      await expect(page.locator(`.panel[data-panel="${check.key}"]`)).toHaveClass(
        /is-active/
      );
      await expect(page.locator("#editor-hint")).toHaveText(check.hint);
      await expect(page.locator("#mini-outline")).toHaveText(check.outline);
    }
  });
});

test("T2-03 context menu opens on primary tab group", async () => {
  await withWorkspaceApp(async ({ page }) => {
    await openSidebarContextMenu(page);
    await expect(page.locator("#context-menu-panel .context-menu-item")).toHaveCount(6);
    await expect(page.locator("#context-menu")).toHaveAttribute("aria-hidden", "false");
  });
});

test("T2-04 context menu stays closed on secondary tab group", async () => {
  await withWorkspaceApp(async ({ page }) => {
    await expect(page.locator("#context-menu")).toHaveAttribute("aria-hidden", "true");
    await page.locator(".tab-group.secondary").click({ button: "right" });
    await expect(page.locator("#context-menu")).toHaveAttribute("aria-hidden", "true");
  });
});

test("T2-05 tab can be hidden", async () => {
  await withWorkspaceApp(async ({ page }) => {
    await openSidebarContextMenu(page);
    await clickContextMenuItem(page, TEXT.labels.blocks);
    await expect(page.locator('.tab[data-tab="blocks"]')).toHaveClass(/is-hidden/);
    await expect(page.locator('.panel[data-panel="blocks"]')).toHaveClass(/is-hidden/);
  });
});

test("T2-06 last visible tab cannot be hidden", async () => {
  await withWorkspaceApp(async ({ page }) => {
    const toHide = ["outline", "blocks", "issues", "git", "project"];
    for (const key of toHide) {
      await openSidebarContextMenu(page);
      await clickContextMenuItem(page, TEXT.labels[key]);
      await expect(page.locator(`.tab[data-tab="${key}"]`)).toHaveClass(/is-hidden/);
    }
    await openSidebarContextMenu(page);
    const filesItem = page.locator("#context-menu-panel .context-menu-item", {
      hasText: TEXT.labels.files,
    });
    await expect(filesItem).toBeDisabled();
    await expect(page.locator('.tab[data-tab="files"]')).not.toHaveClass(/is-hidden/);
  });
});

test("T2-07 hidden tab can be restored", async () => {
  await withWorkspaceApp(async ({ page }) => {
    await openSidebarContextMenu(page);
    await clickContextMenuItem(page, TEXT.labels.blocks);
    await expect(page.locator('.tab[data-tab="blocks"]')).toHaveClass(/is-hidden/);
    await openSidebarContextMenu(page);
    await clickContextMenuItem(page, TEXT.labels.blocks);
    await expect(page.locator('.tab[data-tab="blocks"]')).not.toHaveClass(/is-hidden/);
  });
});

test("T2-08..T2-10 resizer drag behavior", async () => {
  await withWorkspaceApp(async ({ page }) => {
    const resizer = page.locator("#resizer");
    const box = await resizer.boundingBox();
    if (!box) {
      throw new Error("resizer not found");
    }
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const initialWidth = await getSidebarPanelWidth(page);

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await expect
      .poll(() => page.evaluate(() => document.body.style.cursor))
      .toBe("col-resize");
    await expect
      .poll(() => page.evaluate(() => document.getElementById("editor")?.style.pointerEvents))
      .toBe("none");

    await page.mouse.move(startX + 120, startY);
    const widened = await getSidebarPanelWidth(page);
    expect(Math.abs(widened - initialWidth)).toBeGreaterThan(5);

    await page.mouse.move(0, startY);
    const minWidth = await getSidebarPanelWidth(page);
    expect(minWidth).toBeGreaterThanOrEqual(240);

    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => document.body.style.cursor))
      .toBe("");
    await expect
      .poll(() => page.evaluate(() => document.getElementById("editor")?.style.pointerEvents))
      .toBe("");
  });
});

test("T2-11 issues bar does nothing with zero issues", async () => {
  await withWorkspaceApp(async ({ page }) => {
    await page.click('.tab[data-tab="files"]');
    await page.click("#issues-bar");
    expect(await getActiveTabKey(page)).toBe("files");
    await expect(page.locator("#issues-bar")).toHaveAttribute("aria-expanded", "false");
  });
});

test("T2-12 issues bar opens issues tab with click and keys", async () => {
  await withWorkspaceApp(async ({ page }) => {
    await page.waitForFunction(() => typeof window.tex180UpdateIssues === "function");
    await page.evaluate(() => {
      window.tex180UpdateIssues({
        count: 1,
        summary: "e2e",
        status: "error",
        issues: [{ severity: "error", message: "main.tex:1:1: e2e" }],
      });
    });
    await expect(page.locator("#issues-count")).toHaveText("1");

    await page.click("#issues-bar");
    expect(await getActiveTabKey(page)).toBe("issues");
    await expect(page.locator("#issues-bar")).toHaveAttribute("aria-expanded", "true");

    await page.click('.tab[data-tab="files"]');
    await page.locator("#issues-bar").focus();
    await page.keyboard.press("Enter");
    expect(await getActiveTabKey(page)).toBe("issues");

    await page.click('.tab[data-tab="files"]');
    await page.locator("#issues-bar").focus();
    await page.keyboard.press("Space");
    expect(await getActiveTabKey(page)).toBe("issues");
  });
});

test("T2-13 git tab triggers status refresh", async () => {
  await withWorkspaceApp(async ({ page }) => {
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await page.click('.tab[data-tab="git"]');
    await expect.poll(async () => {
      const messages = await page.evaluate(() => window.__tex180PostMessages || []);
      return messages.map((message) => message.type);
    }).toContain("gitStatus");
  });
});

test("T2-14 settings tab triggers environment checks", async () => {
  await withWorkspaceApp(async ({ page }) => {
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await page.click('.tab[data-tab="settings"]');
    await expect.poll(async () => {
      const messages = await page.evaluate(() => window.__tex180PostMessages || []);
      return messages
        .filter((message) => message.type === "env:check")
        .map((message) => message.command);
    }).toEqual(expect.arrayContaining(["lualatex", "latexmk"]));
  });
});

test("T2-15 files tab mini outline shows active file name", async () => {
  await withWorkspaceApp(async ({ page }) => {
    await ensureFolderOpen(page, "sections");
    await page.click('button.file-item[data-path="sections/intro.tex"]');
    await page.waitForSelector('.editor-tab.is-active[data-path="sections/intro.tex"]');
    await page.click('.tab[data-tab="outline"]');
    await page.click('.tab[data-tab="files"]');
    await expect(page.locator("#mini-outline")).toHaveText(
      `${TEXT.miniOutlinePrefix}intro.tex`
    );
  });
});

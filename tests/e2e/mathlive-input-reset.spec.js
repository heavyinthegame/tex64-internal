import { test, expect, _electron as electron } from "@playwright/test";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs/promises";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const templateWorkspace = path.join(repoRoot, "test-workspace");

test.describe.configure({ mode: "serial" });

const copyWorkspace = async (targetPath) => {
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.mkdir(targetPath, { recursive: true });
  await fs.cp(templateWorkspace, targetPath, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes("__e2e__"),
  });
};

const launchApp = async (testInfo) => {
  const workspacePath = testInfo.outputPath("workspace");
  const userDataPath = testInfo.outputPath("userdata");
  await copyWorkspace(workspacePath);
  await fs.mkdir(userDataPath, { recursive: true });

  const env = {
    ...process.env,
    TEX180_E2E: "1",
    TEX180_E2E_WORKSPACE: workspacePath,
    TEX180_E2E_USERDATA: userDataPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot],
    cwd: repoRoot,
    env,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.tab[data-tab="files"]', { state: "attached" });
  await page.evaluate(() => {
    document.querySelector('.tab[data-tab="files"]')?.click();
  });
  await page.waitForSelector("#file-tree .file-item", {
    state: "attached",
    timeout: 120000,
  });
  return { app, page };
};

const openFile = async (page, filePath) => {
  await page.evaluate((pathValue) => {
    document.querySelector(`.file-item[data-path="${pathValue}"]`)?.click();
  }, filePath);
  await page.waitForFunction((pathValue) => {
    const active = document.querySelector(".editor-tab.is-active");
    return active?.getAttribute("data-path") === pathValue;
  }, filePath);
};

const ensureMathField = async (page) => {
  await page.click('.tab[data-tab="blocks"]');
  await expect(page.locator('.panel[data-panel="blocks"]')).toBeVisible();

  await page.evaluate(() => {
    const mathForm = document.querySelector('.block-form[data-form="math"]');
    if (mathForm) {
      mathForm.classList.add("is-active");
      mathForm.style.display = "flex";
    }
    const blocksPanel = document.querySelector(".blocks-panel");
    if (blocksPanel) {
      blocksPanel.style.display = "flex";
    }
  });

  const selector = "math-field.block-math-field";
  await page.waitForSelector(selector, { timeout: 10000 });
};

const ensureInsertMode = async (page) => {
  const isInsert = await page.evaluate(() => {
    const toggle = document.getElementById("block-mode-toggle");
    return toggle?.getAttribute("data-block-mode") === "insert";
  });
  if (!isInsert) {
    await page.click("#block-mode-toggle");
  }
};

const clearMathField = async (page) => {
  await page.click("math-field.block-math-field");
  await page.waitForSelector("#math-keyboard-dock.is-open");
  await page.evaluate(() => {
    const mathField = document.querySelector("math-field.block-math-field");
    if (!mathField) return;
    if (typeof mathField.setValue === "function") {
      mathField.setValue("");
    } else {
      mathField.value = "";
    }
    mathField.focus?.();
    mathField.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const insertMatrixFromMenu = async (page) => {
  await page.click(".block-math-menu-toggle");
  await page.waitForSelector("menu.ui-menu-container", { state: "visible" });

  const result = await page.evaluate(() => {
    const mathField = document.querySelector("math-field.block-math-field");
    const menu = mathField?._mathfield?.menu;
    if (!mathField || !menu) return { ok: false, id: null };
    const findById = (items, id) =>
      Array.isArray(items)
        ? items.find(
            (item) => item?.menuItem?.id === id || item?._declaration?.id === id
          ) ?? null
        : null;
    if (typeof menu.updateIfDirty === "function") {
      menu.updateIfDirty();
    }
    const menuItems = Array.isArray(menu.children) ? menu.children : menu._menuItems;
    const matrixMenu = findById(menuItems, "insert-matrix");
    if (!matrixMenu) return { ok: false, id: null };
    if (typeof matrixMenu.openSubmenu === "function") {
      matrixMenu.openSubmenu();
    }
    const submenu = matrixMenu.submenu;
    if (!submenu) return { ok: false, id: null };
    if (typeof submenu.updateIfDirty === "function") {
      submenu.updateIfDirty();
    }
    const submenuItems = Array.isArray(submenu.children)
      ? submenu.children
      : submenu._menuItems;
    const target =
      findById(submenuItems, "insert-matrix-2x2") ??
      submenuItems?.find((item) => {
        const menuId = item?.menuItem?.id ?? item?._declaration?.id;
        return typeof menuId === "string" && menuId.startsWith("insert-matrix-");
      }) ??
      null;
    const id = target?.menuItem?.id ?? target?._declaration?.id ?? null;
    if (!id) return { ok: false, id: null };
    if (typeof target.select === "function") {
      target.select();
      return { ok: true, id };
    }
    if (target.element && typeof target.element.click === "function") {
      target.element.click();
      return { ok: true, id };
    }
    return { ok: false, id };
  });

  expect(result.ok).toBe(true);
  await page.waitForFunction(() => {
    const mathField = document.querySelector("math-field.block-math-field");
    if (!mathField) return false;
    if (typeof mathField.getValue === "function") {
      const value = mathField.getValue("latex");
      return typeof value === "string" && value.length > 0;
    }
    return typeof mathField.value === "string" && mathField.value.length > 0;
  });
};

const getMathFieldLatex = async (page) =>
  page.evaluate(() => {
    const mathField = document.querySelector("math-field.block-math-field");
    if (!mathField) return "";
    if (typeof mathField.getValue === "function") {
      const value = mathField.getValue("latex");
      return typeof value === "string" ? value : "";
    }
    return typeof mathField.value === "string" ? mathField.value : "";
  });

const waitForSuggestions = async (page) => {
  const panel = page.locator('.math-wysiwyg-panel[aria-hidden="false"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator(".math-wysiwyg-item").first()).toBeVisible();
};

const getSuggestionLabels = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector('.math-wysiwyg-panel[aria-hidden="false"]');
    if (!panel) return [];
    return Array.from(panel.querySelectorAll(".math-wysiwyg-label"))
      .map((el) => el.textContent?.trim() ?? "")
      .filter(Boolean);
  });

const countCommand = (latex, command) =>
  (latex.match(new RegExp(`\\\\${command}`, "g")) ?? []).length;

const applyTokenSuggestion = async (page, token, command) => {
  await page.click("math-field.block-math-field");
  await page.waitForSelector("#math-keyboard-dock.is-open");
  await page.focus("math-field.block-math-field");
  await page.keyboard.type(token);
  await waitForSuggestions(page);
  await page.keyboard.press("Enter");
  await page.waitForFunction((expected) => {
    const mathField = document.querySelector("math-field.block-math-field");
    if (!mathField) return false;
    const value =
      typeof mathField.getValue === "function"
        ? mathField.getValue("latex")
        : mathField.value;
    return typeof value === "string" && value.includes(`\\${expected}`);
  }, command);
};

test("suggestion inserts reset between entries", async ({}, testInfo) => {
  test.setTimeout(180000);
  const { app, page } = await launchApp(testInfo);
  try {
    await openFile(page, "diff-preview.tex");
    await ensureMathField(page);
    await ensureInsertMode(page);
    await clearMathField(page);

    await applyTokenSuggestion(page, "sum", "sum");
    await page.focus("math-field.block-math-field");
    await page.keyboard.type("int");
    await waitForSuggestions(page);
    await page.keyboard.press("Enter");

    const latex = await getMathFieldLatex(page);
    expect(countCommand(latex, "sum")).toBe(1);
    expect(countCommand(latex, "int")).toBe(1);
    expect(/(^|[^\\])sum/.test(latex)).toBe(false);
    expect(/(^|[^\\])int/.test(latex)).toBe(false);
  } finally {
    await app.close();
  }
});

test("single-letter input does not auto-suggest", async ({}, testInfo) => {
  test.setTimeout(180000);
  const { app, page } = await launchApp(testInfo);
  try {
    await openFile(page, "diff-preview.tex");
    await ensureMathField(page);
    await ensureInsertMode(page);
    await clearMathField(page);

    await page.click("math-field.block-math-field");
    await page.waitForSelector("#math-keyboard-dock.is-open");
    await page.focus("math-field.block-math-field");
    await page.keyboard.type("a");
    await page.waitForTimeout(150);
    const isVisible = await page.evaluate(() => {
      const panel = document.querySelector('.math-wysiwyg-panel[aria-hidden="false"]');
      return !!panel;
    });
    expect(isVisible).toBe(false);
  } finally {
    await app.close();
  }
});

test("explicit suggestions allow single-letter input", async ({}, testInfo) => {
  test.setTimeout(180000);
  const { app, page } = await launchApp(testInfo);
  try {
    await openFile(page, "diff-preview.tex");
    await ensureMathField(page);
    await ensureInsertMode(page);
    await clearMathField(page);

    await page.click("math-field.block-math-field");
    await page.waitForSelector("#math-keyboard-dock.is-open");
    await page.focus("math-field.block-math-field");
    await page.keyboard.type("a");
    await page.keyboard.press("Control+.");
    await waitForSuggestions(page);

    const labels = await getSuggestionLabels(page);
    const prefixLabels = [
      "alpha",
      "abs",
      "angle",
      "argmin",
      "argmax",
      "arcsin",
      "arccos",
      "arctan",
    ];
    const hasPrefixHit = labels.some((label) => prefixLabels.includes(label));
    const firstLabel = labels[0];
    expect(hasPrefixHit).toBe(true);
    expect(prefixLabels).toContain(firstLabel);
  } finally {
    await app.close();
  }
});

test("backspace works after tab navigation in prompts", async ({}, testInfo) => {
  test.setTimeout(180000);
  const { app, page } = await launchApp(testInfo);
  try {
    await openFile(page, "diff-preview.tex");
    await ensureMathField(page);
    await ensureInsertMode(page);
    await clearMathField(page);
    await insertMatrixFromMenu(page);

    const baseline = await getMathFieldLatex(page);

    await page.click("math-field.block-math-field");
    await page.waitForSelector("#math-keyboard-dock.is-open");
    await page.keyboard.press("Tab");
    await page.keyboard.type("x");

    const withChar = await getMathFieldLatex(page);
    expect(withChar).not.toBe(baseline);

    await page.keyboard.press("Backspace");

    const after = await getMathFieldLatex(page);
    expect(after).toBe(baseline);
  } finally {
    await app.close();
  }
});

test("backspace works after suggestion insert", async ({}, testInfo) => {
  test.setTimeout(180000);
  const { app, page } = await launchApp(testInfo);
  try {
    await openFile(page, "diff-preview.tex");
    await ensureMathField(page);
    await ensureInsertMode(page);
    await clearMathField(page);

    await applyTokenSuggestion(page, "sum", "sum");

    const baseline = await getMathFieldLatex(page);

    await page.keyboard.type("x");
    const withChar = await getMathFieldLatex(page);
    expect(withChar).not.toBe(baseline);

    await page.keyboard.press("Backspace");
    const after = await getMathFieldLatex(page);
    expect(after).toBe(baseline);
  } finally {
    await app.close();
  }
});

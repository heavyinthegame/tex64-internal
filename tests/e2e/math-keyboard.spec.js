import { test, expect } from "@playwright/test";
import {
  openEditor,
  setEditorContent,
  moveCursorTo,
  waitForAutoDetected,
  setMathFieldValue,
} from "./helpers.js";

const getMathValue = async (page) =>
  page.evaluate(() => window.__tex180GetMathInputValue?.() ?? "");

const waitForMathValueChange = async (page, previous) => {
  await page.waitForFunction(
    (before) => (window.__tex180GetMathInputValue?.() ?? "") !== before,
    previous
  );
  return getMathValue(page);
};

const exerciseKeys = async (page, selector) => {
  const keys = page.locator(selector);
  const count = await keys.count();
  for (let i = 0; i < count; i += 1) {
    await setMathFieldValue(page, "");
    const before = await getMathValue(page);
    await keys.nth(i).click();
    await waitForMathValueChange(page, before);
  }
};

const exerciseAllTabs = async (page) => {
  const tabs = await page.$$eval(".math-keyboard-tab", (nodes) =>
    nodes.map((node) => node.dataset.mathTab).filter(Boolean)
  );
  for (const tab of tabs) {
    await page.click(`.math-keyboard-tab[data-math-tab="${tab}"]`);
    await page.waitForSelector(`.math-keyboard-tab[data-math-tab="${tab}"].is-active`);
    await exerciseKeys(page, "#math-keyboard-grid .math-keyboard-key");
  }
  await exerciseKeys(page, "#math-keyboard-fixed-grid .math-keyboard-key");
};

test("math keyboard inserts all keys (normal + shift)", async () => {
  test.setTimeout(180000);
  const { electronApp, page } = await openEditor();
  try {
    await page.waitForSelector("#math-keyboard-dock.is-open");

    await exerciseAllTabs(page);

    const shiftButton = page.locator("#math-keyboard-shift");
    if ((await shiftButton.count()) > 0) {
      await shiftButton.click();
      await expect(shiftButton).toHaveClass(/is-active/);
      await exerciseAllTabs(page);

      await shiftButton.click();
      await expect(shiftButton).not.toHaveClass(/is-active/);
    }
  } finally {
    await electronApp.close();
  }
});

test("math keyboard input reaches diff preview and insertion", async () => {
  test.setTimeout(90000);
  const { electronApp, page } = await openEditor();
  try {
    await setEditorContent(page, "Inline $x$ test.\n");
    await moveCursorTo(page, "x");
    await waitForAutoDetected(page, true, "keyboard diff");

    await setMathFieldValue(page, "");
    const before = await getMathValue(page);
    await page.locator("#math-keyboard-fixed-grid .math-keyboard-key").first().click();
    const inserted = await waitForMathValueChange(page, before);
    const expected = inserted.trim();
    expect(expected.length).toBeGreaterThan(0);

    await page.click("#block-insert-button");
    await page.waitForSelector("#diff-modal.is-open");
    await page.waitForFunction(
      (value) => (window.__tex180LastDiff?.modified ?? "").includes(value),
      expected,
      { timeout: 8000 }
    );
    await page.click("#diff-modal-submit");
    await page.waitForFunction(
      () => !document.getElementById("diff-modal")?.classList.contains("is-open")
    );
    const updated = await page.evaluate(() => window.__tex180Editor.getValue());
    expect(updated).toContain(expected);
  } finally {
    await electronApp.close();
  }
});

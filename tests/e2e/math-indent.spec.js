import { test, expect } from "@playwright/test";
import {
  openEditor,
  setEditorContent,
  waitForAutoDetected,
  setMathFieldValue,
} from "./helpers.js";

test("block insert aligns begin/end indentation in environments", async () => {
  test.setTimeout(90000);
  const { electronApp, page } = await openEditor();
  try {
    const content = [
      "\\begin{itemize}",
      "  \\item Before",
      "  ",
      "\\end{itemize}",
      "",
    ].join("\n");
    await setEditorContent(page, content);

    await page.click('.tab[data-tab="project"]');
    await page.waitForSelector('.panel[data-panel="project"].is-active');
    const alignOn = await page.$eval("#project-align-env", (node) =>
      node.classList.contains("is-on")
    );
    if (!alignOn) {
      await page.click("#project-align-env");
    }
    await page.click('.tab[data-tab="blocks"]');
    await page.waitForSelector('.panel[data-panel="blocks"].is-active');

    await page.evaluate(() => {
      const editor = window.__tex180Editor;
      editor.setPosition({ lineNumber: 3, column: 3 });
      editor.focus();
    });
    await waitForAutoDetected(page, false, "no detection");

    await setMathFieldValue(
      page,
      "\\begin{equation}\n  a + b\n\\end{equation}"
    );
    await page.click("#block-insert-button");
    await page.waitForSelector("#diff-modal.is-open");
    await page.click("#diff-modal-submit");
    await page.waitForFunction(
      () => !document.getElementById("diff-modal")?.classList.contains("is-open")
    );

    const updated = await page.evaluate(() => window.__tex180Editor.getValue());
    expect(updated).toContain("  \\begin{equation}");
    expect(updated).toContain("    a + b");
    expect(updated).toContain("  \\end{equation}");
  } finally {
    await electronApp.close();
  }
});

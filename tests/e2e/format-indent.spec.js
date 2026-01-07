import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { openWorkspaceApp, workspaceRoot } from "./helpers.js";

const relativePath = "format-settings.tex";
const filePath = path.join(workspaceRoot, relativePath);

const baseFormatSettings = {
  indentStyle: "spaces-2",
  blankLines: "condense",
  beginEndOnOwnLine: true,
  documentNoIndent: true,
  alignMathDelims: true,
  alignTableDelims: true,
  customVerbatim: [],
};

const waitForBridgeMessage = (page, type, timeoutMs = 40000) =>
  page.evaluate(
    ({ messageType, timeout }) =>
      new Promise((resolve) => {
        const bridge = window.tex180Bridge;
        if (!bridge?.onMessage) {
          resolve(null);
          return;
        }
        const off = bridge.onMessage((message) => {
          if (message?.type === messageType) {
            clearTimeout(timer);
            off();
            resolve(message.payload);
          }
        });
        const timer = setTimeout(() => {
          off();
          resolve(null);
        }, timeout);
      }),
    { messageType: type, timeout: timeoutMs }
  );

const openTargetFile = async (page) => {
  await page.click('.tab[data-tab="files"]');
  await page.waitForSelector(`button.file-item[data-path="${relativePath}"]`);
  await page.click(`button.file-item[data-path="${relativePath}"]`);
  await page.waitForSelector(`button.file-item[data-path="${relativePath}"].is-active`);
};

const openSettingsPage = async (page, target) => {
  await page.click('.tab[data-tab="settings"]');
  const pageSelector = `.settings-page[data-settings-page="${target}"]`;
  const isActive = await page
    .locator(pageSelector)
    .evaluate((el) => el.classList.contains("is-active"))
    .catch(() => false);
  if (isActive) {
    return;
  }
  const navVisible = await page.locator("#settings-nav").isVisible();
  if (!navVisible) {
    const backButton = page.locator(".settings-back");
    if ((await backButton.count()) > 0) {
      await backButton.first().click();
    }
  }
  await page.click(`.settings-nav-item[data-settings-target="${target}"]`);
  await page.waitForSelector(`${pageSelector}.is-active`);
};

const setToggle = async (page, selector, enabled) => {
  const locator = page.locator(selector);
  await locator.waitFor();
  const isOn = await locator.evaluate((el) => el.classList.contains("is-on"));
  if (isOn !== enabled) {
    await locator.click();
  }
};

const setSelect = async (page, selector, value) => {
  const locator = page.locator(selector);
  await locator.waitFor();
  const current = await locator.inputValue();
  if (current !== value) {
    await locator.selectOption(value);
  }
};

const clearVerbatimList = async (page) => {
  const removeButtons = page.locator(
    "#editor-format-verbatim-list .env-registry-remove"
  );
  while ((await removeButtons.count()) > 0) {
    await removeButtons.first().click();
  }
};

const setFormatSettings = async (page, overrides) => {
  const settings = { ...baseFormatSettings, ...overrides };
  await openSettingsPage(page, "format");
  await setSelect(page, "#editor-format-indent", settings.indentStyle);
  await setSelect(page, "#editor-format-blank-lines", settings.blankLines);
  await setToggle(page, "#editor-format-begin-end", settings.beginEndOnOwnLine);
  await setToggle(
    page,
    "#editor-format-document-noindent",
    settings.documentNoIndent
  );
  await setToggle(page, "#editor-format-align-math", settings.alignMathDelims);
  await setToggle(page, "#editor-format-align-table", settings.alignTableDelims);
  await clearVerbatimList(page);
  for (const name of settings.customVerbatim) {
    await page.fill("#editor-format-verbatim-input", name);
    await page.click("#editor-format-verbatim-add");
  }
  const backButton = page.locator(
    ".settings-page.is-active .settings-back"
  );
  if ((await backButton.count()) > 0 && (await backButton.first().isVisible())) {
    await backButton.first().click();
  }
  await page.click('.tab[data-tab="files"]');
};

const setEditorContent = async (page, content) => {
  await page.evaluate((value) => {
    const editor = window.__tex180Editor;
    editor?.setValue?.(value);
  }, content);
};

const formatCurrentFile = async (page) => {
  const formatPromise = waitForBridgeMessage(page, "formatResult", 60000);
  await page.click("#format-button");
  const formatResult = await formatPromise;
  if (!formatResult?.ok) {
    throw new Error(formatResult?.error || "format failed");
  }
  expect(typeof formatResult?.content).toBe("string");
  return formatResult.content;
};

const splitLines = (content) => content.split(/\r?\n/);

const findLine = (content, matcher) =>
  splitLines(content).find((line) => matcher(line));

const findAlignColumns = (content) => {
  const lines = splitLines(content).filter(
    (line) => line.includes("&") && line.includes("\\\\")
  );
  if (lines.length < 2) {
    throw new Error("Alignment rows not found.");
  }
  return lines.slice(0, 2).map((line) => line.indexOf("&"));
};

test.describe.serial("format settings (indentation)", () => {
  let electronApp;
  let page;

  test.beforeAll(async () => {
    fs.writeFileSync(filePath, "% format settings test\n", "utf8");
    const result = await openWorkspaceApp();
    electronApp = result.electronApp;
    page = result.page;
    await openTargetFile(page);
  });

  test.beforeEach(async () => {
    await openTargetFile(page);
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test("indent width uses 2 spaces", async () => {
    await setFormatSettings(page, { indentStyle: "spaces-2" });
    await setEditorContent(
      page,
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\begin{itemize}",
        "\\item First",
        "\\end{itemize}",
        "\\end{document}",
        "",
      ].join("\n")
    );
    const content = await formatCurrentFile(page);
    const itemLine = findLine(content, (line) => line.includes("\\item First"));
    expect(itemLine?.startsWith("  \\item")).toBe(true);
  });

  test("indent width uses 4 spaces", async () => {
    await setFormatSettings(page, { indentStyle: "spaces-4" });
    await setEditorContent(
      page,
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\begin{itemize}",
        "\\item First",
        "\\end{itemize}",
        "\\end{document}",
        "",
      ].join("\n")
    );
    const content = await formatCurrentFile(page);
    const itemLine = findLine(content, (line) => line.includes("\\item First"));
    expect(itemLine?.startsWith("    \\item")).toBe(true);
  });

  test("begin/end on own line ON", async () => {
    await setFormatSettings(page, { beginEndOnOwnLine: true });
    await setEditorContent(
      page,
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\begin{equation} a=b \\end{equation}",
        "\\end{document}",
        "",
      ].join("\n")
    );
    const content = await formatCurrentFile(page);
    const lines = splitLines(content);
    const hasInline = lines.some(
      (line) => line.includes("\\begin{equation}") && line.includes("\\end{equation}")
    );
    const hasBegin = lines.some((line) => line.trim() === "\\begin{equation}");
    const hasEnd = lines.some((line) => line.trim() === "\\end{equation}");
    expect(hasInline).toBe(false);
    expect(hasBegin).toBe(true);
    expect(hasEnd).toBe(true);
  });

  test("begin/end on own line OFF", async () => {
    await setFormatSettings(page, { beginEndOnOwnLine: false });
    await setEditorContent(
      page,
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\begin{equation} a=b \\end{equation}",
        "\\end{document}",
        "",
      ].join("\n")
    );
    const content = await formatCurrentFile(page);
    const lines = splitLines(content);
    const hasInline = lines.some(
      (line) => line.includes("\\begin{equation}") && line.includes("\\end{equation}")
    );
    expect(hasInline).toBe(true);
  });

  test("document not indented when toggle ON", async () => {
    await setFormatSettings(page, { documentNoIndent: true, beginEndOnOwnLine: true });
    await setEditorContent(
      page,
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Title}",
        "\\begin{itemize}",
        "\\item One",
        "\\end{itemize}",
        "\\end{document}",
        "",
      ].join("\n")
    );
    const content = await formatCurrentFile(page);
    const sectionLine = findLine(content, (line) =>
      line.trimStart().startsWith("\\section{Title}")
    );
    expect(sectionLine?.startsWith("\\section{Title}")).toBe(true);
  });

  test("document indented when toggle OFF", async () => {
    await setFormatSettings(page, { documentNoIndent: false, beginEndOnOwnLine: true });
    await setEditorContent(
      page,
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Title}",
        "\\begin{itemize}",
        "\\item One",
        "\\end{itemize}",
        "\\end{document}",
        "",
      ].join("\n")
    );
    const content = await formatCurrentFile(page);
    const sectionLine = findLine(content, (line) =>
      line.trimStart().startsWith("\\section{Title}")
    );
    expect(sectionLine?.startsWith("  \\section{Title}")).toBe(true);
  });

  test("math alignment ON aligns & columns", async () => {
    await setFormatSettings(page, { alignMathDelims: true, beginEndOnOwnLine: true });
    await setEditorContent(
      page,
      [
        "\\documentclass{article}",
        "\\usepackage{amsmath}",
        "\\begin{document}",
        "\\begin{align}",
        "a&=b\\\\",
        "longer&=c\\\\",
        "\\end{align}",
        "\\end{document}",
        "",
      ].join("\n")
    );
    const content = await formatCurrentFile(page);
    const [first, second] = findAlignColumns(content);
    expect(first).toBe(second);
  });

  test("math alignment OFF keeps & columns uneven", async () => {
    await setFormatSettings(page, { alignMathDelims: false, beginEndOnOwnLine: true });
    await setEditorContent(
      page,
      [
        "\\documentclass{article}",
        "\\usepackage{amsmath}",
        "\\begin{document}",
        "\\begin{align}",
        "a&=b\\\\",
        "longer&=c\\\\",
        "\\end{align}",
        "\\end{document}",
        "",
      ].join("\n")
    );
    const content = await formatCurrentFile(page);
    const [first, second] = findAlignColumns(content);
    expect(first).not.toBe(second);
  });

  test("table alignment ON aligns & columns", async () => {
    await setFormatSettings(page, { alignTableDelims: true, beginEndOnOwnLine: true });
    await setEditorContent(
      page,
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\begin{tabular}{ll}",
        "a&b\\\\",
        "longer&c\\\\",
        "\\end{tabular}",
        "\\end{document}",
        "",
      ].join("\n")
    );
    const content = await formatCurrentFile(page);
    const [first, second] = findAlignColumns(content);
    expect(first).toBe(second);
  });

  test("table alignment OFF keeps & columns uneven", async () => {
    await setFormatSettings(page, { alignTableDelims: false, beginEndOnOwnLine: true });
    await setEditorContent(
      page,
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\begin{tabular}{ll}",
        "a&b\\\\",
        "longer&c\\\\",
        "\\end{tabular}",
        "\\end{document}",
        "",
      ].join("\n")
    );
    const content = await formatCurrentFile(page);
    const [first, second] = findAlignColumns(content);
    expect(first).not.toBe(second);
  });

  test("custom verbatim OFF indents inner lines", async () => {
    await setFormatSettings(page, { customVerbatim: [] });
    await setEditorContent(
      page,
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\begin{myverbatim}",
        "\\begin{itemize}",
        "\\item A",
        "\\end{itemize}",
        "\\end{myverbatim}",
        "\\end{document}",
        "",
      ].join("\n")
    );
    const content = await formatCurrentFile(page);
    const innerLine = findLine(content, (line) =>
      line.trimStart().startsWith("\\begin{itemize}")
    );
    expect(innerLine?.startsWith("  \\begin{itemize}")).toBe(true);
  });

  test("custom verbatim ON keeps inner lines unchanged", async () => {
    await setFormatSettings(page, { customVerbatim: ["myverbatim"] });
    await setEditorContent(
      page,
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\begin{myverbatim}",
        "\\begin{itemize}",
        "\\item A",
        "\\end{itemize}",
        "\\end{myverbatim}",
        "\\end{document}",
        "",
      ].join("\n")
    );
    const content = await formatCurrentFile(page);
    const innerLine = findLine(content, (line) =>
      line.trimStart().startsWith("\\begin{itemize}")
    );
    expect(innerLine?.startsWith("\\begin{itemize}")).toBe(true);
  });
});

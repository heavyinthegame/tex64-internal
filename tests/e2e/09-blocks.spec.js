import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  launchApp,
  createTempDir,
  writeWorkspaceFile,
  removeDir,
} from "./helpers.js";
import {
  mathKeyboardFixedKeys,
  mathKeyboardSets,
} from "../../Resources/web/app/math-keyboard.js";

const BASE_MAIN = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Hello",
  "\\end{document}",
  "",
].join("\n");

const TEXT = {
  mathLiveError: "MathLive\u306e\u8aad\u307f\u8fbc\u307f\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002",
  changeTargetError:
    "\u5bfe\u8c61\u304c\u5909\u66f4\u3055\u308c\u3066\u3044\u307e\u3059\u3002\u30ab\u30fc\u30bd\u30eb\u3092\u7f6e\u304d\u76f4\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
  nonTexError: "\u30d6\u30ed\u30c3\u30af\u306f .tex \u30d5\u30a1\u30a4\u30eb\u3067\u306e\u307f\u633f\u5165\u3067\u304d\u307e\u3059\u3002",
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("#file-tree");
  await page.waitForSelector('button.file-item[data-path="main.tex"]');
  await page.waitForFunction(() => !!window.__tex180Editor);
  await page.waitForSelector('.editor-tab.is-active[data-path="main.tex"]');
};

const createWorkspace = async ({ files = {}, folders = [] } = {}) => {
  const root = await createTempDir("blocks-");
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

const openBlocksTab = async (page) => {
  await page.click('.tab[data-tab="blocks"]');
  await expect(page.locator('.panel[data-panel="blocks"]')).toHaveClass(/is-active/);
};

const openFilesTab = async (page) => {
  await page.click('.tab[data-tab="files"]');
  await expect(page.locator('.panel[data-panel="files"]')).toHaveClass(/is-active/);
};

const openFileFromTree = async (page, filePath) => {
  const selector = `button.file-item[data-path="${filePath}"]`;
  await page.waitForSelector(selector);
  await page.click(selector);
  await page.waitForSelector(`${selector}.is-active`);
  await page.waitForSelector(`.editor-tab.is-active[data-path="${filePath}"]`);
};

const setEditorValue = async (page, value) => {
  await page.evaluate((content) => {
    window.__tex180Editor?.setValue?.(content);
  }, value);
};

const getEditorValue = async (page) =>
  page.evaluate(() => window.__tex180Editor?.getValue?.() ?? "");

const setEditorCursor = async (page, lineNumber, column) => {
  await page.evaluate(
    ({ lineNumber: line, column: col }) => {
      const editor = window.__tex180Editor;
      editor?.setPosition?.({ lineNumber: line, column: col });
      editor?.revealLine?.(line);
      editor?.focus?.();
    },
    { lineNumber, column }
  );
};

const waitForMathKeyboardReady = async (page) => {
  await page.waitForSelector("#math-keyboard-grid button.math-keyboard-key");
  await page.waitForSelector("#math-keyboard-fixed-grid button.math-keyboard-key");
};

const stubMathField = async (page) => {
  await page.waitForSelector("#block-math-input");
  await page.evaluate(() => {
    const field = document.querySelector("#block-math-input");
    if (!field) {
      return;
    }
    const isMathField = field.tagName?.toLowerCase() === "math-field";
    const hasNativeApi =
      typeof field.getValue === "function" ||
      typeof field.setValue === "function" ||
      typeof field.executeCommand === "function";
    if (isMathField && hasNativeApi) {
      return;
    }
    if (typeof field.__e2eValue !== "string") {
      field.__e2eValue = "";
    }
    if (typeof field.getValue !== "function") {
      field.getValue = () => field.__e2eValue;
    }
    if (typeof field.setValue !== "function") {
      field.setValue = (value) => {
        field.__e2eValue = typeof value === "string" ? value : "";
      };
    }
    if (typeof field.executeCommand !== "function") {
      field.executeCommand = (command, value) => {
        if (command !== "insert") {
          return false;
        }
        const next = typeof value === "string" ? value : "";
        field.__e2eValue = `${field.__e2eValue ?? ""}${next}`;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      };
    }
    if (field.insert) {
      field.insert = undefined;
    }
  });
};

const setMathInputValue = async (page, value) => {
  await page.evaluate((nextValue) => {
    const field = document.querySelector("#block-math-input");
    if (!field) {
      return;
    }
    if (typeof field.setValue === "function") {
      try {
        field.setValue(nextValue);
      } catch {
        if (typeof field.__e2eValue === "string") {
          field.__e2eValue = nextValue;
        } else if (typeof field.value === "string") {
          field.value = nextValue;
        }
      }
    } else if (typeof field.__e2eValue === "string") {
      field.__e2eValue = nextValue;
    } else if (typeof field.value === "string") {
      field.value = nextValue;
    }
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
};

const getMathInputValue = async (page) =>
  page.evaluate(() => window.__tex180GetMathInputValue?.() ?? "");

const clearMathInput = async (page) => {
  await setMathInputValue(page, "");
};

const clickMathKey = async (page, label, { fixed = false } = {}) => {
  const selector = fixed ? "#math-keyboard-fixed-grid" : "#math-keyboard-grid";
  await page.evaluate(
    ({ targetLabel, targetSelector }) => {
      const buttons = Array.from(
        document.querySelectorAll(`${targetSelector} button.math-keyboard-key`)
      );
      const match = buttons.find((button) => {
        const aria = button.getAttribute("aria-label") || "";
        const text = button.textContent || "";
        return aria === targetLabel || text === targetLabel;
      });
      match?.click();
    },
    { targetLabel: label, targetSelector: selector }
  );
};

const waitForMathInput = async (page) => {
  await page.waitForSelector("#block-math-input");
};

const getFirstFixedKeyLabel = async (page) =>
  page.evaluate(() => {
    const button = document.querySelector(
      "#math-keyboard-fixed-grid button.math-keyboard-key"
    );
    if (!button) {
      return "";
    }
    return button.getAttribute("aria-label") || button.textContent || "";
  });

const waitForAutoDetect = async (page) =>
  expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .querySelector(".blocks-panel")
            ?.classList.contains("is-auto-detected") ?? false
      )
    )
    .toBe(true);

const waitForAutoDetectClear = async (page) =>
  expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .querySelector(".blocks-panel")
            ?.classList.contains("is-auto-detected") ?? false
      )
    )
    .toBe(false);

const freezeEditorVersionId = async (page) => {
  await page.evaluate(() => {
    const model = window.__tex180Editor?.getModel?.();
    if (!model || model.__e2eFrozenVersion) {
      return;
    }
    const frozen = typeof model.getVersionId === "function" ? model.getVersionId() : 0;
    model.getVersionId = () => frozen;
    model.__e2eFrozenVersion = true;
  });
};

const KEYSETS = {
  fixed: mathKeyboardFixedKeys,
  analysis: mathKeyboardSets.analysis,
  algebra: mathKeyboardSets.algebra,
  sets: mathKeyboardSets.sets,
  logic: mathKeyboardSets.logic,
  arrows: mathKeyboardSets.arrows,
  greek: mathKeyboardSets.greek,
};

const buildKeyCases = (prefix, keys) =>
  keys.map((key, index) => ({
    id: `${prefix}-${String(index + 1).padStart(2, "0")}`,
    key,
  }));

const FIXED_CASES = buildKeyCases("T9-KB-F", KEYSETS.fixed);
const ANALYSIS_CASES = buildKeyCases("T9-KB-A", KEYSETS.analysis);
const ALGEBRA_CASES = buildKeyCases("T9-KB-ALG", KEYSETS.algebra);
const SET_CASES = buildKeyCases("T9-KB-SET", KEYSETS.sets);
const LOGIC_CASES = buildKeyCases("T9-KB-LOG", KEYSETS.logic);
const ARROWS_CASES = buildKeyCases("T9-KB-ARR", KEYSETS.arrows);
const GREEK_CASES = buildKeyCases("T9-KB-GR", KEYSETS.greek);

const openMathKeyboard = async (page) => {
  await openBlocksTab(page);
  await waitForMathInput(page);
  await expect(page.locator("#math-keyboard-dock")).toHaveClass(/is-open/);
  await waitForMathKeyboardReady(page);
  await stubMathField(page);
  await clearMathInput(page);
};

const setMathKeyboardTab = async (page, tab) => {
  await page.click(`.math-keyboard-tab[data-math-tab="${tab}"]`);
  await expect(page.locator(`.math-keyboard-tab[data-math-tab="${tab}"]`)).toHaveClass(
    /is-active/
  );
};

const insertAndExpect = async (page, { label, latex, fallback }, { fixed = false } = {}) => {
  await clearMathInput(page);
  await clickMathKey(page, label, { fixed });
  const value = await getMathInputValue(page);
  const expected = latex ?? fallback ?? "";
  expect(value).toBe(expected);
};

const insertShiftedAndExpect = async (
  page,
  { label, shiftLabel, shiftLatex, shiftFallback },
  { fixed = false } = {}
) => {
  const targetLabel = shiftLabel ?? label;
  await clearMathInput(page);
  await page.keyboard.down("Shift");
  await clickMathKey(page, targetLabel, { fixed });
  await page.keyboard.up("Shift");
  const value = await getMathInputValue(page);
  const expected = shiftLatex ?? shiftFallback ?? "";
  expect(value).toBe(expected);
};

const setInsertMode = async (page, mode) => {
  await page.click("#block-format-button");
  await page.click(`.block-format-option[data-format="${mode}"]`);
};

const setInsertSettings = async (
  page,
  { inlineWrap, displayWrap } = { inlineWrap: null, displayWrap: null }
) => {
  if (!inlineWrap && !displayWrap) {
    return;
  }
  await page.click("#block-settings-button");
  await page.click('.block-settings-item[data-block-settings-target="insert-format"]');
  if (inlineWrap) {
    await page.click(`.block-settings-option[data-inline-format="${inlineWrap}"]`);
  }
  if (displayWrap) {
    await page.click(`.block-settings-option[data-display-format="${displayWrap}"]`);
  }
  await page.click("#block-settings-close");
};

const resetEditorForInsert = async (page) => {
  await setEditorValue(page, BASE_MAIN);
  await setEditorCursor(page, 5, 1);
};

test("T9-01 block tab shows math form and insert button", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await expect(page.locator("#block-math-input-container")).toBeVisible();
    await expect(page.locator("#block-insert-button")).toBeVisible();
  });
});

test("T9-02 MathLive success shows math-field", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await expect(page.locator("#block-math-input-container math-field")).toHaveCount(1);
  });
});

test("T9-03 MathLive failure shows error", async () => {
  const root = await createWorkspace({});
  const { electronApp, page } = await launchApp({ workspacePath: root });
  try {
    await page.route("**/mathlive.min.js", (route) => route.abort());
    await page.reload();
    await waitForWorkspaceReady(page);
    await openBlocksTab(page);
    await expect(page.locator("#block-math-input-container")).toContainText(
      TEXT.mathLiveError
    );
    await expect(page.locator("#block-math-input-container math-field")).toHaveCount(0);
  } finally {
    await electronApp.close();
    await removeDir(root);
  }
});

test("T9-04 math input fallback hook", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await page.evaluate(() => {
      window.__tex180SetMathInputFallback?.("x+y");
    });
    expect(await getMathInputValue(page)).toBe("x+y");
    await page.evaluate(() => {
      window.__tex180SetMathInputFallback?.(null);
    });
  });
});

test("T9-05 math keyboard shows in blocks tab", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await expect(page.locator("#math-keyboard-dock")).toHaveClass(/is-open/);
    await expect(page.locator("#math-keyboard-dock")).toHaveAttribute("aria-hidden", "false");
  });
});

test("T9-06 math keyboard hides outside blocks tab", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await openFilesTab(page);
    await expect(page.locator("#math-keyboard-dock")).not.toHaveClass(/is-open/);
    await expect(page.locator("#math-keyboard-dock")).toHaveAttribute("aria-hidden", "true");
  });
});

test("T9-07 shift lock button toggles", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openMathKeyboard(page);
    const shift = page.locator("#math-keyboard-shift");
    await expect(shift).toHaveCount(1);
    await shift.click();
    await expect(shift).toHaveAttribute("aria-pressed", "true");
    await shift.click();
    await expect(shift).toHaveAttribute("aria-pressed", "false");
  });
});

test("T9-08 shift key enables temporary state", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openMathKeyboard(page);
    const baseLabel = await getFirstFixedKeyLabel(page);
    const baseKey = KEYSETS.fixed[0];
    expect(baseLabel).toBe(baseKey.label);
    await insertAndExpect(page, baseKey, { fixed: true });
    await insertShiftedAndExpect(page, baseKey, { fixed: true });
    await insertAndExpect(page, baseKey, { fixed: true });
  });
});

test("T9-09 math auto-detection highlights active block", async () => {
  const content = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Text $a+b$ end.",
    "\\end{document}",
    "",
  ].join("\n");
  await withWorkspaceApp({ files: { "main.tex": content } }, async ({ page }) => {
    await openFilesTab(page);
    await setEditorCursor(page, 3, 8);
    await waitForAutoDetect(page);
    await expect(page.locator(".detected-block-highlight")).toHaveCount(1);
    expect(await getMathInputValue(page)).toBe("a+b");
  });
});

test("T9-10 table auto-detection remains off when disabled", async () => {
  const content = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\begin{tabular}{|c|c|}",
    "a & b \\\\",
    "\\end{tabular}",
    "\\end{document}",
    "",
  ].join("\n");
  await withWorkspaceApp({ files: { "main.tex": content } }, async ({ page }) => {
    await openFilesTab(page);
    await setEditorCursor(page, 3, 5);
    await waitForAutoDetectClear(page);
    await expect(page.locator(".detected-block-glyph")).toHaveCount(0);
  });
});

test("T9-11 auto-detect ignores verbatim", async () => {
  const content = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\begin{verbatim}",
    "$ignored$",
    "\\end{verbatim}",
    "\\end{document}",
    "",
  ].join("\n");
  await withWorkspaceApp({ files: { "main.tex": content } }, async ({ page }) => {
    await openFilesTab(page);
    await setEditorCursor(page, 4, 3);
    await waitForAutoDetectClear(page);
    await expect(page.locator(".detected-block-highlight")).toHaveCount(0);
  });
});

test("T9-12 auto-detect clears on exit", async () => {
  const content = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Text $a+b$ end.",
    "Outside.",
    "\\end{document}",
    "",
  ].join("\n");
  await withWorkspaceApp({ files: { "main.tex": content } }, async ({ page }) => {
    await setEditorCursor(page, 3, 10);
    await waitForAutoDetect(page);
    await setEditorCursor(page, 4, 2);
    await waitForAutoDetectClear(page);
    await expect(page.locator(".detected-block-highlight")).toHaveCount(0);
  });
});

test("T9-13 insert opens diff modal", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setMathInputValue(page, "x+y");
    await page.click("#block-insert-button");
    await expect(page.locator("#diff-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#diff-modal")).toHaveAttribute("aria-hidden", "false");
  });
});

test("T9-14 detects changed target", async () => {
  const content = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\[",
    "a+b",
    "\\]",
    "\\end{document}",
    "",
  ].join("\n");
  await withWorkspaceApp({ files: { "main.tex": content } }, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await freezeEditorVersionId(page);
    await setEditorCursor(page, 4, 2);
    await waitForAutoDetect(page);
    await setEditorValue(page, content.replace("a+b", "a+c"));
    await setMathInputValue(page, "a+d");
    await page.click("#block-insert-button");
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.changeTargetError);
  });
});

test("T9-15 insert rejects non-tex files", async () => {
  await withWorkspaceApp({ files: { "notes.txt": "Plain" } }, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await openFileFromTree(page, "notes.txt");
    await setMathInputValue(page, "x");
    await page.click("#block-insert-button");
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.nonTexError);
  });
});

test("T9-16 undo removes inserted block", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setMathInputValue(page, "x+y");
    await page.click("#block-insert-button");
    await page.click("#diff-modal-submit");
    await expect
      .poll(() => getEditorValue(page))
      .toContain("$x+y$");
    await page.evaluate(() => {
      window.__tex180Editor?.trigger?.("keyboard", "undo", null);
    });
    await expect
      .poll(() => getEditorValue(page))
      .not.toContain("$x+y$");
  });
});

test("T9-17 table insert controls are unavailable when disabled", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await expect(page.locator('.block-toggle-button[data-block="table"]')).toHaveCount(0);
    await expect(page.locator("#block-table-rows")).toHaveCount(0);
    await expect(page.locator("#block-table-cols")).toHaveCount(0);
  });
});

test("T9-18 table auto-detect remains off when disabled", async () => {
  const content = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\begin{tabular}{|c|}",
    "a \\\\",
    "\\end{tabular}",
    "\\end{document}",
    "",
  ].join("\n");
  await withWorkspaceApp({ files: { "main.tex": content } }, async ({ page }) => {
    await openBlocksTab(page);
    await setEditorCursor(page, 3, 5);
    await waitForAutoDetectClear(page);
    await expect(page.locator(".detected-block-glyph")).toHaveCount(0);
  });
});

test("T9-19 block settings modal navigation", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await page.click("#block-settings-button");
    await expect(page.locator("#block-settings-modal")).toHaveClass(/is-open/);
    await expect(page.locator("#block-settings-modal")).toHaveAttribute("aria-hidden", "false");
    await page.click('.block-settings-item[data-block-settings-target="insert-format"]');
    await expect(
      page.locator('.block-settings-page[data-block-settings-page="insert-format"]')
    ).toHaveClass(/is-active/);
    await page.click("#block-settings-back");
    await expect(
      page.locator('.block-settings-page[data-block-settings-page="menu"]')
    ).toHaveClass(/is-active/);
    await page.click("#block-settings-close");
    await expect(page.locator("#block-settings-modal")).not.toHaveClass(/is-open/);
  });
});

test("T9-20 inline wrap setting affects insert", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await page.click("#block-settings-button");
    await page.click('.block-settings-item[data-block-settings-target="insert-format"]');
    await page.click('.block-settings-option[data-inline-format="inline-paren"]');
    await page.click("#block-settings-close");
    await page.click("#block-format-button");
    await page.click('.block-format-option[data-format="inline"]');
    await setMathInputValue(page, "x+y");
    await page.click("#block-insert-button");
    await page.click("#diff-modal-submit");
    await expect
      .poll(() => getEditorValue(page))
      .toContain("\\\\(x+y\\\\)");
  });
});

test("T9-21 display wrap setting affects insert", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await page.click("#block-settings-button");
    await page.click('.block-settings-item[data-block-settings-target="insert-format"]');
    await page.click('.block-settings-option[data-display-format="display-dollar"]');
    await page.click("#block-settings-close");
    await page.click("#block-format-button");
    await page.click('.block-format-option[data-format="display"]');
    await setMathInputValue(page, "a+b");
    await page.click("#block-insert-button");
    await page.click("#diff-modal-submit");
    await expect
      .poll(() => getEditorValue(page))
      .toContain("$$\na+b\n$$");
  });
});

test("T9-22 insert mode none keeps raw formula", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await page.click("#block-format-button");
    await page.click('.block-format-option[data-format="none"]');
    await setMathInputValue(page, "raw+value");
    await page.click("#block-insert-button");
    await page.click("#diff-modal-submit");
    const value = await getEditorValue(page);
    expect(value).toContain("raw+value");
    expect(value).not.toContain("$raw+value$");
    expect(value).not.toContain("\\\\(raw+value\\\\)");
    expect(value).not.toContain("\\\\[");
  });
});

test("T9-23 blocks.json is created after insert", async () => {
  await withWorkspaceApp({}, async ({ page, root }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setMathInputValue(page, "x+y");
    await page.click("#block-insert-button");
    await page.click("#diff-modal-submit");
    const blocksPath = path.join(root, ".tex180", "blocks.json");
    await expect
      .poll(async () => fs.readFile(blocksPath, "utf8").catch(() => null))
      .not.toBeNull();
  });
});

test("T9-24 meta+Enter triggers insert flow", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await page.waitForSelector("#block-math-input");
    await stubMathField(page);
    await setMathInputValue(page, "x+y");
    await page.evaluate(() => {
      const field = document.querySelector("#block-math-input");
      if (!field) {
        return;
      }
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await expect(page.locator("#diff-modal")).toHaveClass(/is-open/);
  });
});

test("T9-25 insert confirm triggers format request", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setMathInputValue(page, "x+y");
    await page.evaluate(() => {
      window.__tex180PostMessages = [];
    });
    await page.click("#block-insert-button");
    await page.click("#diff-modal-submit");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__tex180PostMessages || []).some(
              (message) =>
                message.type === "formatFile" && message.source === "blockInsert"
            )
        )
      )
      .toBe(true);
  });
});

test("T9-26 inline insert supports many formula patterns", async () => {
  const cases = [
    "x+y",
    "x^2 + y^2",
    "a_{n+1}",
    "\\frac{a+b}{c+d}",
    "\\sqrt{a^2+b^2}",
    "\\sqrt[n]{x}",
    "\\sum_{i=1}^n i",
    "\\sum_{i=1}^{n} \\frac{1}{i!}",
    "\\int_0^1 x^2 \\, dx",
    "\\int_{-\\infty}^{\\infty} e^{-x^2} \\, \\mathrm{d}x",
    "\\alpha+\\beta=\\gamma",
    "\\sin(x) + \\cos(x)",
    "\\log_{a} b",
    "\\lim_{x \\to 0} \\frac{\\sin x}{x}",
    "\\vec{v} \\cdot \\vec{w}",
    "\\hat{\\theta} + \\tilde{x}",
    "\\overline{AB} + \\underline{xyz}",
    "\\binom{n}{k}",
    "\\operatorname{sgn}(x)",
    "\\text{if } x>0",
    "\\left( \\frac{a}{b} \\right)",
    "\\left\\{ x \\in \\mathbb{R} \\mid x > 0 \\right\\}",
    "\\left.\\frac{d}{dx}f(x)\\right|_{x=0}",
    "\\frac{\\partial f}{\\partial x}",
    "\\frac{d}{dx} x^2",
  ];
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setInsertSettings(page, { inlineWrap: "inline-dollar" });
    await setInsertMode(page, "inline");
    for (const formula of cases) {
      await resetEditorForInsert(page);
      await setMathInputValue(page, formula);
      await page.click("#block-insert-button");
      await page.click("#diff-modal-submit");
      const value = await getEditorValue(page);
      expect(value).toContain(`$${formula.trim()}$`);
    }
  });
});

test("T9-27 display insert handles multi-line formulas", async () => {
  const cases = [
    { formula: "\\frac{a}{b}", parts: ["\\frac{a}{b}"] },
    { formula: "\\int_0^1 x^2 \\, dx", parts: ["\\int_0^1 x^2 \\, dx"] },
    { formula: "a=b+c \\\\\n d=e+f", parts: ["a=b+c", "d=e+f"] },
  ];
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setInsertSettings(page, { displayWrap: "display-bracket" });
    await setInsertMode(page, "display");
    for (const { formula, parts } of cases) {
      await resetEditorForInsert(page);
      await setMathInputValue(page, formula);
      await page.click("#block-insert-button");
      await page.click("#diff-modal-submit");
      const value = await getEditorValue(page);
      expect(value).toContain("\\[");
      expect(value).toContain("\\]");
      for (const part of parts) {
        expect(value).toContain(part);
      }
    }
  });
});

test("T9-28 already wrapped formulas are not double-wrapped", async () => {
  const cases = [
    { formula: "$x+y$", parts: ["$x+y$"] },
    { formula: "\\(x+y\\)", parts: ["\\(x+y\\)"] },
    { formula: "\\[x+y\\]", parts: ["\\[x+y\\]"] },
    { formula: "$$x+y$$", parts: ["$$x+y$$"] },
    {
      formula: ["\\begin{equation}", "x+y", "\\end{equation}"].join("\n"),
      parts: ["\\begin{equation}", "x+y", "\\end{equation}"],
    },
  ];
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setInsertMode(page, "inline");
    for (const { formula, parts } of cases) {
      await resetEditorForInsert(page);
      await setMathInputValue(page, formula);
      await page.click("#block-insert-button");
      await page.click("#diff-modal-submit");
      const value = await getEditorValue(page);
      for (const part of parts) {
        expect(value).toContain(part);
      }
    }
  });
});

test("T9-29 repeated cancel keeps content stable", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setInsertSettings(page, { inlineWrap: "inline-dollar" });
    await setInsertMode(page, "inline");
    await resetEditorForInsert(page);
    await setMathInputValue(page, "x+y");
    const baseline = await getEditorValue(page);
    for (let i = 0; i < 3; i += 1) {
      await page.click("#block-insert-button");
      await page.click("#diff-modal-cancel");
      await expect(page.locator("#diff-modal")).not.toHaveClass(/is-open/);
      expect(await getEditorValue(page)).toBe(baseline);
    }
    await page.click("#block-insert-button");
    await page.click("#diff-modal-submit");
    await expect
      .poll(() => getEditorValue(page))
      .toContain("$x+y$");
  });
});

test("T9-30 display insert preserves environment blocks without extra wraps", async () => {
  const cases = [
    {
      name: "aligned",
      snippet: ["\\begin{aligned}", "a &= b + c \\\\", "d &= e + f", "\\end{aligned}"].join("\n"),
    },
    {
      name: "cases",
      snippet: [
        "\\begin{cases}",
        "x & x > 0 \\\\",
        "0 & x = 0 \\\\",
        "-x & x < 0",
        "\\end{cases}",
      ].join("\n"),
    },
    {
      name: "array",
      snippet: ["\\begin{array}{cc}", "a & b \\\\", "c & d", "\\end{array}"].join("\n"),
    },
    {
      name: "matrix",
      snippet: ["\\begin{matrix}", "a & b \\\\", "c & d", "\\end{matrix}"].join("\n"),
    },
    {
      name: "pmatrix",
      snippet: ["\\begin{pmatrix}", "a & b \\\\", "c & d", "\\end{pmatrix}"].join("\n"),
    },
    {
      name: "bmatrix",
      snippet: ["\\begin{bmatrix}", "a & b \\\\", "c & d", "\\end{bmatrix}"].join("\n"),
    },
    {
      name: "vmatrix",
      snippet: ["\\begin{vmatrix}", "a & b \\\\", "c & d", "\\end{vmatrix}"].join("\n"),
    },
    {
      name: "Vmatrix",
      snippet: ["\\begin{Vmatrix}", "a & b \\\\", "c & d", "\\end{Vmatrix}"].join("\n"),
    },
    {
      name: "split",
      snippet: ["\\begin{split}", "a &= b + c \\\\", "d &= e + f", "\\end{split}"].join("\n"),
    },
    {
      name: "gather",
      snippet: ["\\begin{gather}", "a=b+c \\\\", "d=e+f", "\\end{gather}"].join("\n"),
    },
    {
      name: "align",
      snippet: ["\\begin{align}", "a &= b + c \\\\", "d &= e + f", "\\end{align}"].join("\n"),
    },
    {
      name: "multline",
      snippet: [
        "\\begin{multline}",
        "a+b+c+d+e+f+g+h \\\\",
        "i+j+k+l+m+n",
        "\\end{multline}",
      ].join("\n"),
    },
    {
      name: "equation",
      snippet: ["\\begin{equation}", "E=mc^2", "\\end{equation}"].join("\n"),
    },
    {
      name: "equation*",
      snippet: ["\\begin{equation*}", "E=mc^2", "\\end{equation*}"].join("\n"),
    },
  ];
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setInsertSettings(page, { displayWrap: "display-bracket" });
    await setInsertMode(page, "display");
    for (const { snippet } of cases) {
      await resetEditorForInsert(page);
      await setMathInputValue(page, snippet);
      await page.click("#block-insert-button");
      await page.click("#diff-modal-submit");
      const value = await getEditorValue(page);
      snippet
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .forEach((line) => {
          expect(value).toContain(line);
        });
      expect(value).not.toContain("$$");
      expect(value).not.toContain("\\[");
      expect(value).not.toContain("\\]");
    }
  });
});

test("T9-31 inline paren insert handles complex formulas", async () => {
  const cases = [
    "\\left( \\frac{a}{b} \\right)",
    "\\left\\{ x \\in \\mathbb{R} \\mid x > 0 \\right\\}",
    "\\sum_{i=1}^n i^2",
    "\\int_0^1 x^2 \\, dx",
    "\\text{if } x>0",
    "\\operatorname{rank}(A)",
    "\\left.\\frac{d}{dx}f(x)\\right|_{x=0}",
    "\\binom{n}{k}",
    "\\nabla \\cdot \\vec{F}",
  ];
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setInsertSettings(page, { inlineWrap: "inline-paren" });
    await setInsertMode(page, "inline");
    for (const formula of cases) {
      await resetEditorForInsert(page);
      await setMathInputValue(page, formula);
      await page.click("#block-insert-button");
      await page.click("#diff-modal-submit");
      const value = await getEditorValue(page);
      expect(value).toContain(`\\\\(${formula.trim()}\\\\)`);
    }
  });
});

test("T9-32 display dollar wraps multi-line formulas", async () => {
  const formula = "a=b+c \\\\\n d=e+f";
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setInsertSettings(page, { displayWrap: "display-dollar" });
    await setInsertMode(page, "display");
    await resetEditorForInsert(page);
    await setMathInputValue(page, formula);
    await page.click("#block-insert-button");
    await page.click("#diff-modal-submit");
    const value = await getEditorValue(page);
    expect(value).toContain("$$");
    expect(value).toContain("a=b+c");
    expect(value).toContain("d=e+f");
    expect(value).not.toContain("\\[");
    expect(value).not.toContain("\\]");
  });
});

test("T9-33 inline insert supports symbols and relations", async () => {
  const cases = [
    "\\forall x \\in \\mathbb{R}",
    "\\exists y \\ge 0",
    "x \\le y \\le z",
    "x \\approx y \\neq z",
    "A \\subseteq B \\subset C",
    "x \\in \\mathbb{N} \\cup \\mathbb{Z}",
    "\\neg P \\lor Q \\land R",
    "P \\Rightarrow Q \\Leftrightarrow R",
    "\\partial_x f(x,t)",
    "\\nabla \\times \\vec{F}",
    "\\mathbf{A} \\cdot \\mathbf{B}",
    "\\det(A) = 0",
    "\\left|x\\right|",
    "\\langle u, v \\rangle",
  ];
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setInsertSettings(page, { inlineWrap: "inline-dollar" });
    await setInsertMode(page, "inline");
    for (const formula of cases) {
      await resetEditorForInsert(page);
      await setMathInputValue(page, formula);
      await page.click("#block-insert-button");
      await page.click("#diff-modal-submit");
      const value = await getEditorValue(page);
      expect(value).toContain(`$${formula.trim()}$`);
    }
  });
});

test("T9-34 display insert wraps left/right arrays", async () => {
  const cases = [
    {
      snippet: [
        "\\left\\{",
        "\\begin{array}{ll}",
        "x & x>0 \\\\",
        "0 & x=0",
        "\\end{array}",
        "\\right.",
      ].join("\n"),
      parts: ["\\left\\{", "\\begin{array}{ll}", "x & x>0", "0 & x=0", "\\end{array}", "\\right."],
    },
    {
      snippet: [
        "\\left[",
        "\\begin{array}{cc}",
        "a & b \\\\",
        "c & d",
        "\\end{array}",
        "\\right]",
      ].join("\n"),
      parts: ["\\left[", "\\begin{array}{cc}", "a & b", "c & d", "\\end{array}", "\\right]"],
    },
  ];
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setInsertSettings(page, { displayWrap: "display-bracket" });
    await setInsertMode(page, "display");
    for (const { snippet, parts } of cases) {
      await resetEditorForInsert(page);
      await setMathInputValue(page, snippet);
      await page.click("#block-insert-button");
      await page.click("#diff-modal-submit");
      const value = await getEditorValue(page);
      expect(value).toContain("\\[");
      expect(value).toContain("\\]");
      for (const part of parts) {
        expect(value).toContain(part);
      }
    }
  });
});

test("T9-35 insert mode none trims but does not wrap", async () => {
  const cases = [
    "   x+y   ",
    "  \\frac{a}{b}  ",
    "  a=b+c \\\\\n d=e+f  ",
    "  \\left( \\frac{a}{b} \\right)  ",
  ];
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await setInsertMode(page, "none");
    for (const formula of cases) {
      await resetEditorForInsert(page);
      await setMathInputValue(page, formula);
      await page.click("#block-insert-button");
      await page.click("#diff-modal-submit");
      const value = await getEditorValue(page);
      expect(value).toContain(formula.trim());
      expect(value).not.toContain("$$");
      expect(value).not.toContain("\\(");
      expect(value).not.toContain("\\)");
      expect(value).not.toContain("\\[");
      expect(value).not.toContain("\\]");
    }
  });
});

test("T9-36 repeated cancel across modes keeps content stable", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openBlocksTab(page);
    await stubMathField(page);
    await resetEditorForInsert(page);
    const baseline = await getEditorValue(page);

    await setInsertSettings(page, { inlineWrap: "inline-dollar" });
    await setInsertMode(page, "inline");
    await setMathInputValue(page, "x+y");
    await page.click("#block-insert-button");
    await page.click("#diff-modal-cancel");
    expect(await getEditorValue(page)).toBe(baseline);

    await setInsertSettings(page, { displayWrap: "display-dollar" });
    await setInsertMode(page, "display");
    await setMathInputValue(page, "a=b+c");
    await page.click("#block-insert-button");
    await page.click("#diff-modal-cancel");
    expect(await getEditorValue(page)).toBe(baseline);

    await setInsertSettings(page, { inlineWrap: "inline-paren" });
    await setInsertMode(page, "inline");
    await setMathInputValue(page, "\\frac{a}{b}");
    await page.click("#block-insert-button");
    await page.click("#diff-modal-cancel");
    expect(await getEditorValue(page)).toBe(baseline);

    await setInsertMode(page, "inline");
    await setMathInputValue(page, "x+y");
    await page.click("#block-insert-button");
    await page.click("#diff-modal-submit");
    await expect
      .poll(() => getEditorValue(page))
      .toContain("\\\\(x+y\\\\)");
  });
});

test("T9-KB-00 keyboard tab switching", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openMathKeyboard(page);
    const tabs = ["analysis", "algebra", "sets", "logic", "arrows", "greek"];
    for (const tab of tabs) {
      await setMathKeyboardTab(page, tab);
      await expect(page.locator(`.math-keyboard-tab[data-math-tab="${tab}"]`)).toHaveAttribute(
        "aria-selected",
        "true"
      );
    }
  });
});

test("T9-KB-01 key inserts latex", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openMathKeyboard(page);
    await insertAndExpect(page, KEYSETS.fixed[0], { fixed: true });
  });
});

test("T9-KB-02 shift label toggles", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await openMathKeyboard(page);
    const baseLabel = await getFirstFixedKeyLabel(page);
    await page.keyboard.down("Shift");
    const shiftedLabel = await getFirstFixedKeyLabel(page);
    await page.keyboard.up("Shift");
    expect(baseLabel).toBe(KEYSETS.fixed[0].label);
    expect(shiftedLabel).toBe(KEYSETS.fixed[0].shiftLabel);
  });
});

for (const { id, key } of FIXED_CASES) {
  test(`${id} ${key.label}`, async () => {
    await withWorkspaceApp({}, async ({ page }) => {
      await openMathKeyboard(page);
      await insertAndExpect(page, key, { fixed: true });
      if (key.shiftLatex || key.shiftFallback) {
        await insertShiftedAndExpect(page, key, { fixed: true });
      }
    });
  });
}

const TAB_CASES = [
  { tab: "analysis", cases: ANALYSIS_CASES },
  { tab: "algebra", cases: ALGEBRA_CASES },
  { tab: "sets", cases: SET_CASES },
  { tab: "logic", cases: LOGIC_CASES },
  { tab: "arrows", cases: ARROWS_CASES },
  { tab: "greek", cases: GREEK_CASES },
];

for (const group of TAB_CASES) {
  for (const { id, key } of group.cases) {
    test(`${id} ${key.label}`, async () => {
      await withWorkspaceApp({}, async ({ page }) => {
        await openMathKeyboard(page);
        await setMathKeyboardTab(page, group.tab);
        await insertAndExpect(page, key);
        if (key.shiftLatex || key.shiftFallback) {
          await insertShiftedAndExpect(page, key);
        }
      });
    });
  }
}

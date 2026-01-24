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
    timeout: 60000,
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

const moveCursorToInsertAnchor = async (page) => {
  const offset = await page.evaluate((anchorText) => {
    const editor = window.__tex64Editor;
    if (!editor || typeof editor.getModel !== "function") {
      return null;
    }
    const model = editor.getModel();
    if (!model || typeof model.getValue !== "function") {
      return null;
    }
    if (typeof model.getPositionAt !== "function") {
      return null;
    }
    if (typeof model.getOffsetAt !== "function") {
      return null;
    }
    const content = model.getValue();
    if (typeof content !== "string") {
      return null;
    }
    const index = content.indexOf(anchorText);
    if (index < 0) {
      return null;
    }
    const position = model.getPositionAt(index + anchorText.length);
    editor.setPosition?.(position);
    editor.revealPositionInCenter?.(position);
    editor.focus?.();
    return model.getOffsetAt(position);
  }, "alpha 1");
  expect(typeof offset).toBe("number");
  return offset;
};

const INPUT_DELAY_MS = 140;
const TYPE_DELAY_MS = 120;

const focusMathField = async (page) => {
  await page.click("math-field.block-math-field");
  await page.waitForSelector("#math-keyboard-dock.is-open");
};

const setMathKeyboardTab = async (page, tab) => {
  const clicked = await page.evaluate((target) => {
    const button = document.querySelector(`.math-keyboard-tab[data-math-tab="${target}"]`);
    if (!(button instanceof HTMLElement)) {
      return false;
    }
    button.click();
    return true;
  }, tab);
  expect(clicked).toBe(true);
  await page.waitForFunction((target) => {
    const button = document.querySelector(`.math-keyboard-tab[data-math-tab="${target}"]`);
    return button?.classList.contains("is-active");
  }, tab);
};

const clearMathField = async (page) => {
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

const clickMathKey = async (page, label) => {
  const clicked = await page.evaluate((target) => {
    const keys = Array.from(document.querySelectorAll(".math-keyboard-key"));
    const match = keys.find((button) => {
      if (!(button instanceof HTMLElement)) return false;
      const aria = button.getAttribute("aria-label");
      const text = button.textContent?.trim();
      return aria === target || text === target;
    });
    if (!match) return false;
    match.click();
    return true;
  }, label);
  expect(clicked).toBe(true);
};

const ensureMathFieldFocus = async (page) => {
  await page.evaluate(() => {
    const mathField = document.querySelector("math-field.block-math-field");
    mathField?.focus?.();
  });
};

const runMathSteps = async (page, steps) => {
  for (const step of steps) {
    if (!step) continue;
    if (step.type === "key") {
      await clickMathKey(page, step.label);
    } else if (step.type === "text") {
      await ensureMathFieldFocus(page);
      await page.keyboard.type(step.value, { delay: TYPE_DELAY_MS });
    } else if (step.type === "press") {
      await ensureMathFieldFocus(page);
      await page.keyboard.press(step.key);
    } else if (step.type === "pause") {
      await page.waitForTimeout(step.ms);
    }
    await page.waitForTimeout(INPUT_DELAY_MS);
  }
};

const waitForDiffModalOpen = async (page) => {
  await page.waitForFunction(() => {
    const modal = document.getElementById("diff-modal");
    return modal?.classList.contains("is-open");
  });
};

const waitForDiffModalClosed = async (page) => {
  await page.waitForFunction(() => {
    const modal = document.getElementById("diff-modal");
    return modal && !modal.classList.contains("is-open");
  });
};

const normalizeLatex = (value) => {
  if (!value) return "";
  let result = value.replace(/\s+/g, "");
  result = result.replace(/\\left\(/g, "(");
  result = result.replace(/\\right\)/g, ")");
  result = result.replace(/\\mathrm\{d\}/g, "d");
  result = result.replace(/\\differentialD([A-Za-z])/g, "d$1");
  result = result.replace(/\\differentialD/g, "d");
  result = result.replace(/\^\{\s*([0-9]+)\s*\}/g, "^$1");
  result = result.replace(/_\{\s*([0-9]+)\s*\}/g, "_$1");
  result = result.replace(/\^\{\s*([A-Za-z])\s*\}/g, "^$1");
  result = result.replace(/_\{\s*([A-Za-z])\s*\}/g, "_$1");
  result = result.replace(/\\frac\{\s*([^}]*)\s*\}\{\s*([^}]*)\s*\}/g, "\\frac$1$2");
  return result;
};

const setupFormatPreviewDelay = async (page, delays) => {
  await page.waitForFunction(() => typeof window.tex64FormatResult === "function");
  await page.evaluate((queue) => {
    const originalPost = window.tex64Bridge?.postMessage;
    if (typeof originalPost !== "function") {
      return;
    }
    const delayQueue = Array.isArray(queue) ? queue.slice() : [];
    window.tex64Bridge.postMessage = (payload) => {
      if (
        payload?.type === "formatFile" &&
        typeof payload.source === "string" &&
        payload.source.startsWith("blockInsertPreview")
      ) {
        const delay = delayQueue.shift() ?? 0;
        window.setTimeout(() => {
          window.tex64FormatResult?.({
            path: payload.path,
            ok: true,
            content: payload.content,
            source: payload.source,
          });
        }, delay);
        return;
      }
      originalPost(payload);
    };
  }, delays);
};

const waitForEditorContains = async (page, snippet) => {
  const expected = normalizeLatex(snippet);
  await page.waitForFunction((expectedValue) => {
    const normalize = (value) => {
      if (!value) return "";
      let result = value.replace(/\s+/g, "");
      result = result.replace(/\\left\(/g, "(");
      result = result.replace(/\\right\)/g, ")");
      result = result.replace(/\\mathrm\{d\}/g, "d");
      result = result.replace(/\\differentialD([A-Za-z])/g, "d$1");
      result = result.replace(/\\differentialD/g, "d");
      result = result.replace(/\^\{\s*([0-9]+)\s*\}/g, "^$1");
      result = result.replace(/_\{\s*([0-9]+)\s*\}/g, "_$1");
      result = result.replace(/\^\{\s*([A-Za-z])\s*\}/g, "^$1");
      result = result.replace(/_\{\s*([A-Za-z])\s*\}/g, "_$1");
      result = result.replace(/\\frac\{\s*([^}]*)\s*\}\{\s*([^}]*)\s*\}/g, "\\frac$1$2");
      return result;
    };
    const editor = window.__tex64Editor;
    if (!editor || typeof editor.getValue !== "function") {
      return false;
    }
    const content = editor.getValue();
    if (typeof content !== "string") {
      return false;
    }
    return normalize(content).includes(expectedValue);
  }, expected);
};

const waitForEditorEquals = async (page, expected) => {
  await page.waitForFunction((expectedValue) => {
    const editor = window.__tex64Editor;
    if (!editor || typeof editor.getValue !== "function") {
      return false;
    }
    const content = editor.getValue();
    if (typeof content !== "string") {
      return false;
    }
    return content === expectedValue;
  }, expected);
};

const resetEditorToBaseline = async (page, expected) => {
  const reset = await page.evaluate((expectedValue) => {
    const editor = window.__tex64Editor;
    if (!editor || typeof editor.getModel !== "function") {
      return false;
    }
    const model = editor.getModel();
    if (!model || typeof editor.executeEdits !== "function") {
      return false;
    }
    let range = null;
    if (typeof model.getFullModelRange === "function") {
      range = model.getFullModelRange();
    } else if (
      typeof model.getLineCount === "function" &&
      typeof model.getLineContent === "function"
    ) {
      const lastLineNumber = model.getLineCount();
      const lastLine = model.getLineContent(lastLineNumber);
      range = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: lastLineNumber,
        endColumn: lastLine.length + 1,
      };
    }
    if (!range) {
      return false;
    }
    editor.executeEdits("e2e-reset", [
      {
        range,
        text: expectedValue,
        forceMoveMarkers: true,
      },
    ]);
    return true;
  }, expected);
  expect(reset).toBe(true);
};


const key = (label) => ({ type: "key", label });
const text = (value) => ({ type: "text", value });
const press = (keyName) => ({ type: "press", key: keyName });
const pow = (value) => [key("pow"), text(value), press("ArrowRight")];
const sub = (value) => [key("sub"), text(value), press("ArrowRight")];
const subsup = (lower, upper) => [
  key("subsup"),
  text(lower),
  press("Tab"),
  text(upper),
  press("ArrowRight"),
];
const frac = (num, den) => [key("frac"), text(num), press("Tab"), text(den), press("ArrowRight")];
const sqrt = (value) => [key("sqrt"), text(value), press("ArrowRight")];

const enterFormula = async (page, steps) => {
  await focusMathField(page);
  await clearMathField(page);
  await focusMathField(page);
  await page.waitForTimeout(INPUT_DELAY_MS);
  await runMathSteps(page, steps);
};

const formulas = [
  {
    id: "einstein",
    latex: "E=mc^2",
    steps: [text("E"), key("="), text("m"), text("c"), ...pow("2")],
  },
  {
    id: "newton",
    latex: "F=ma",
    steps: [text("F"), key("="), text("m"), text("a")],
  },
  {
    id: "pythagoras",
    latex: "a^2+b^2=c^2",
    steps: [
      text("a"),
      ...pow("2"),
      key("+"),
      text("b"),
      ...pow("2"),
      key("="),
      text("c"),
      ...pow("2"),
    ],
  },
  {
    id: "trig-identity",
    latex: "\\sin^2x+\\cos^2x=1",
    steps: [
      key("sin"),
      ...pow("2"),
      text("x"),
      key("+"),
      key("cos"),
      ...pow("2"),
      text("x"),
      key("="),
      text("1"),
    ],
  },
  {
    id: "euler",
    latex: "e^{i\\pi}+1=0",
    steps: [
      text("e"),
      key("pow"),
      text("i"),
      key("π"),
      press("ArrowRight"),
      key("+"),
      text("1"),
      key("="),
      text("0"),
    ],
  },
  {
    id: "integral-basic",
    latex: "\\int_{0}^{1}x^2dx=\\frac{1}{3}",
    steps: [
      key("int"),
      ...subsup("0", "1"),
      text("x"),
      ...pow("2"),
      text("dx"),
      key("="),
      ...frac("1", "3"),
    ],
  },
  {
    id: "sum-integers",
    latex: "\\sum_{k=1}^{n}k=\\frac{n(n+1)}{2}",
    steps: [
      key("sum"),
      ...subsup("k=1", "n"),
      text("k"),
      key("="),
      ...frac("n(n+1)", "2"),
    ],
  },
  {
    id: "limit-sin",
    latex: "\\lim_{x\\to0}\\frac{\\sin x}{x}=1",
    steps: [
      key("lim"),
      key("sub"),
      text("x"),
      key("→"),
      text("0"),
      press("ArrowRight"),
      key("frac"),
      key("sin"),
      text("x"),
      press("Tab"),
      text("x"),
      press("ArrowRight"),
      key("="),
      text("1"),
    ],
  },
  {
    id: "derivative-sin",
    latex: "\\frac{d}{dx}\\sin x=\\cos x",
    steps: [
      ...frac("d", "dx"),
      key("sin"),
      text("x"),
      key("="),
      key("cos"),
      text("x"),
    ],
  },
  {
    id: "derivative-ln",
    latex: "\\frac{d}{dx}\\ln x=\\frac{1}{x}",
    steps: [
      ...frac("d", "dx"),
      key("ln"),
      text("x"),
      key("="),
      ...frac("1", "x"),
    ],
  },
  {
    id: "gaussian-integral",
    latex: "\\int_{-\\infty}^{\\infty}e^{-x^2}dx=\\sqrt{\\pi}",
    steps: [
      key("int"),
      key("subsup"),
      key("−"),
      key("∞"),
      press("Tab"),
      key("∞"),
      press("ArrowRight"),
      text("e"),
      key("pow"),
      key("−"),
      text("x"),
      ...pow("2"),
      press("ArrowRight"),
      text("dx"),
      key("="),
      key("sqrt"),
      key("π"),
      press("ArrowRight"),
    ],
  },
  {
    id: "circle-area",
    latex: "A=\\pi r^2",
    steps: [text("A"), key("="), key("π"), text("r"), ...pow("2")],
  },
  {
    id: "wave",
    latex: "c=\\lambda\\nu",
    steps: [text("c"), key("="), key("λ"), key("ν")],
  },
  {
    id: "ideal-gas",
    latex: "PV=nRT",
    steps: [text("P"), text("V"), key("="), text("n"), text("R"), text("T")],
  },
  {
    id: "ohm",
    latex: "V=IR",
    steps: [text("V"), key("="), text("I"), text("R")],
  },
  {
    id: "recurrence",
    latex: "x_{n+1}=x_n+x_{n-1}",
    steps: [
      text("x"),
      ...sub("n+1"),
      key("="),
      text("x"),
      ...sub("n"),
      key("+"),
      text("x"),
      ...sub("n-1"),
    ],
  },
  {
    id: "log-product",
    latex: "\\log(ab)=\\log a+\\log b",
    steps: [
      key("log"),
      text("("),
      text("a"),
      text("b"),
      text(")"),
      key("="),
      key("log"),
      text("a"),
      key("+"),
      key("log"),
      text("b"),
    ],
  },
  {
    id: "ln-exp",
    latex: "\\ln(e^x)=x",
    steps: [
      key("ln"),
      text("("),
      text("e"),
      ...pow("x"),
      text(")"),
      key("="),
      text("x"),
    ],
  },
  {
    id: "geometric-series",
    latex: "\\sum_{n=0}^{\\infty}x^n=\\frac{1}{1-x}",
    steps: [
      key("sum"),
      key("subsup"),
      text("n"),
      key("="),
      text("0"),
      press("Tab"),
      key("∞"),
      press("ArrowRight"),
      text("x"),
      ...pow("n"),
      key("="),
      key("frac"),
      text("1"),
      press("Tab"),
      text("1"),
      key("−"),
      text("x"),
      press("ArrowRight"),
    ],
  },
  {
    id: "kinetic-energy",
    latex: "H=\\frac{1}{2}mv^2",
    steps: [text("H"), key("="), ...frac("1", "2"), text("m"), text("v"), ...pow("2")],
  },
];

test("math input inserts 20 famous formulas", async ({}, testInfo) => {
  test.setTimeout(240000);
  const { app, page } = await launchApp(testInfo);
  try {
    await openFile(page, "diff-preview.tex");
    await ensureMathField(page);
    await ensureInsertMode(page);
    await focusMathField(page);
    await setMathKeyboardTab(page, "greek");
    const baselineContent = await page.evaluate(() => window.__tex64Editor?.getValue?.() ?? "");
    expect(baselineContent).toBeTruthy();

    for (const formula of formulas) {
      await enterFormula(page, formula.steps);
      await moveCursorToInsertAnchor(page);
      await page.click("#block-insert-button");
      await waitForDiffModalOpen(page);
      const lastDraft = await page.evaluate(() => window.__tex64LastDraft ?? null);
      const lastDiff = await page.evaluate(() => window.__tex64LastDiff ?? null);
      const draftFormula = lastDraft?.formula ?? "";
      expect(draftFormula).toBeTruthy();
      const normalizedFormula = normalizeLatex(draftFormula);
      expect(normalizedFormula).toBe(normalizeLatex(formula.latex));
      expect(normalizeLatex(lastDiff?.modified ?? "")).toContain(
        normalizedFormula
      );
      await page.click("#diff-modal-submit");
      await waitForDiffModalClosed(page);
      await waitForEditorContains(page, draftFormula);
      await resetEditorToBaseline(page, baselineContent);
      await waitForEditorEquals(page, baselineContent);
    }
  } finally {
    await app.close();
  }
});

test("diff modal reflects latest insert when previews overlap", async ({}, testInfo) => {
  test.setTimeout(90000);
  const { app, page } = await launchApp(testInfo);
  try {
    await openFile(page, "diff-preview.tex");
    await ensureMathField(page);
    await ensureInsertMode(page);
    await focusMathField(page);
    await setMathKeyboardTab(page, "greek");
    await setupFormatPreviewDelay(page, [2000, 0]);

    const firstFormula = formulas.find((formula) => formula.id === "einstein");
    const secondFormula = formulas.find((formula) => formula.id === "newton");
    expect(firstFormula).toBeTruthy();
    expect(secondFormula).toBeTruthy();

    await enterFormula(page, firstFormula.steps);
    await page.evaluate(() => {
      document.getElementById("block-insert-button")?.click();
    });
    await enterFormula(page, secondFormula.steps);
    await page.evaluate(() => {
      document.getElementById("block-insert-button")?.click();
    });

    await waitForDiffModalOpen(page);
    await page.waitForTimeout(2300);
    const lastDiff = await page.evaluate(() => window.__tex64LastDiff ?? null);
    expect(normalizeLatex(lastDiff?.modified ?? "")).toContain(normalizeLatex("$F=ma$"));
  } finally {
    await app.close();
  }
});

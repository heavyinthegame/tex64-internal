import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const sourceWorkspace = path.join(repoRoot, "test-workspace");
const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "40", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "6", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);
const fixturePath = "sections/edit-diff-fixture.tex";
const dumpLatex = process.env.E2E_EDIT_DIFF_DUMP_LATEX === "1";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-edit-diff-integrity-30 ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const normalizeLatex = (value) => String(value ?? "").replace(/\s+/g, "");

const EDIT_CASES = [
  {
    name: "alignat",
    anchor: "E01AN",
    marker: "Z01M",
    snippet:
      "\\begin{alignat}{2}E01AN&=\\sum_{k=1}^{n}\\frac{\\alpha_k}{1+k^2}&&+\\int_0^1x^2\\,dx\\\\E01BN&=\\prod_{j=1}^{m}\\left(1+\\frac{\\beta}{j}\\right)&&+\\nabla\\cdot F\\end{alignat}",
    editorChecks: [["\\begin{alignat}{2}"], ["\\end{alignat}"]],
  },
  {
    name: "xalignat",
    anchor: "E02AN",
    marker: "Z02M",
    snippet:
      "\\begin{xalignat}{2}E02AN&=\\frac{d}{dt}(\\rho u)&&+\\Delta u\\\\E02BN&=\\arg\\min_\\theta J(\\theta)&&+\\lambda R(\\theta)\\end{xalignat}",
    editorChecks: [["\\begin{xalignat}{2}"], ["\\end{xalignat}"]],
  },
  {
    name: "xxalignat",
    anchor: "E03AN",
    marker: "Z03M",
    snippet:
      "\\begin{xxalignat}{2}E03AN&=\\mathbb{E}[X]&&+\\mathbb{P}(A|B)\\\\E03BN&=\\operatorname{Var}(X)&&+\\operatorname{Cov}(X,Y)\\end{xxalignat}",
    editorChecks: [["\\begin{xxalignat}{2}"], ["\\end{xxalignat}"]],
  },
  {
    name: "flalign",
    anchor: "E04AN",
    marker: "Z04M",
    snippet:
      "\\begin{flalign}E04AN&=\\det(I+A^\\top A)-\\operatorname{tr}(A^3)&&\\end{flalign}",
    editorChecks: [["\\begin{flalign}"], ["\\end{flalign}"]],
  },
  {
    name: "alignedat",
    anchor: "E05AN",
    marker: "Z05M",
    snippet:
      "\\begin{alignedat}{2}E05AN&=\\lVert u\\rVert_2&&+\\lVert v\\rVert_2\\\\E05BN&=\\sum_{k=0}^{\\infty}\\frac{1}{2^k}&&+\\log(1+x)\\end{alignedat}",
    editorChecks: [["\\begin{alignedat}{2}"], ["\\end{alignedat}"]],
  },
  {
    name: "gathered",
    anchor: "E06AN",
    marker: "Z06M",
    snippet:
      "\\begin{gathered}E06AN=\\int_0^\\infty e^{-t}\\,dt\\\\E06BN=\\sum_{k=1}^{n}k^2\\end{gathered}",
    editorChecks: [["\\begin{gathered}"], ["\\end{gathered}"]],
  },
  {
    name: "multlined",
    anchor: "E07AN",
    marker: "Z07M",
    snippet:
      "\\begin{multlined}[t]E07AN=(a+b+c+d)^3\\\\\\quad-(a-b)^3+\\log(1+x)+\\sqrt{1+y^2}\\end{multlined}",
    editorChecks: [["\\begin{multlined}[t]"], ["\\end{multlined}"]],
  },
  {
    name: "numcases",
    anchor: "E08AN",
    marker: "Z08M",
    snippet:
      "\\begin{numcases}{f(x)=}E08AN+\\frac{1}{1+x^2},&x\\ge0\\\\-\\frac{1}{1+x^2},&x<0\\end{numcases}",
    editorChecks: [["\\begin{numcases}{f(x)=}"], ["\\end{numcases}"]],
  },
  {
    name: "subnumcases",
    anchor: "E09AN",
    marker: "Z09M",
    snippet:
      "\\begin{subnumcases}{g(x)=}E09AN+\\sin x,&x\\in[0,\\pi]\\\\\\cos x,&x\\in(\\pi,2\\pi]\\end{subnumcases}",
    editorChecks: [["\\begin{subnumcases}{g(x)=}"], ["\\end{subnumcases}"]],
  },
  {
    name: "subarray",
    anchor: "E10AN",
    marker: "Z10M",
    snippet: "\\begin{subarray}{l}i<j\\\\i,j\\in S\\\\E10AN\\end{subarray}",
    editorChecks: [["\\begin{subarray}{l}"], ["\\end{subarray}"]],
  },
  {
    name: "darray",
    anchor: "E11AN",
    marker: "Z11M",
    snippet:
      "\\begin{darray}{rcl}E11AN&=&\\Gamma(\\alpha+\\beta)\\\\E11BN&=&\\int_0^\\infty t^{\\alpha+\\beta-1}e^{-t}\\,dt\\end{darray}",
    editorChecks: [["\\begin{darray}{rcl}"], ["\\end{darray}"]],
  },
  {
    name: "IEEEeqnarray",
    anchor: "E12AN",
    marker: "Z12M",
    snippet:
      "\\begin{IEEEeqnarray}{rCl}E12AN&=&\\mathbb{E}[X]\\\\E12BN&=&\\mathbb{P}(A|B)\\end{IEEEeqnarray}",
    editorChecks: [["\\begin{IEEEeqnarray}{rCl}"], ["\\end{IEEEeqnarray}"]],
  },
  {
    name: "IEEEeqnarraybox",
    anchor: "E13AN",
    marker: "Z13M",
    snippet:
      "\\begin{IEEEeqnarraybox}{rCl}E13AN&=&\\operatorname{rank}(A)\\\\E13BN&=&\\operatorname{ker}(A)\\end{IEEEeqnarraybox}",
    editorChecks: [["\\begin{IEEEeqnarraybox}{rCl}"], ["\\end{IEEEeqnarraybox}"]],
  },
  {
    name: "mathpar",
    anchor: "E14AN",
    marker: "Z14M",
    snippet: "\\begin{mathpar}E14AN:\\;A\\vdash B,\\;E14BN:\\;C\\vdash D\\end{mathpar}",
    editorChecks: [["\\begin{mathpar}"], ["\\end{mathpar}"]],
  },
  {
    name: "mathparpagebreakable",
    anchor: "E15AN",
    marker: "Z15M",
    snippet:
      "\\begin{mathparpagebreakable}[allowdisplaybreaks]E15AN:\\;P\\Rightarrow Q,\\;E15BN:\\;Q\\Rightarrow R\\end{mathparpagebreakable}",
    editorChecks: [["\\begin{mathparpagebreakable}[allowdisplaybreaks]"], ["\\end{mathparpagebreakable}"]],
  },
  {
    name: "empheq",
    anchor: "E16AN",
    marker: "Z16M",
    snippet:
      "\\begin{empheq}[left=\\empheqlbrace]{align}E16AN&=\\partial_t\\rho+\\nabla\\cdot(\\rho u)\\\\E16BN&=\\Delta u-\\nabla p\\end{empheq}",
    editorChecks: [["\\begin{empheq}[left=\\empheqlbrace]{align}"], ["\\end{empheq}"]],
  },
  {
    name: "matrix nested array cell",
    anchor: "E17AN",
    marker: "Z17M",
    snippet:
      "\\begin{matrix}E17AN+\\frac{1}{1+x^2}&\\int_0^1e^{-t^2}\\,dt\\\\\\sum_{k=1}^{n}k^{-1}&\\left(\\frac{\\Gamma(\\alpha+\\beta)}{\\Gamma(\\alpha)\\Gamma(\\beta)}+\\log(1+y^2)\\right)\\end{matrix}",
    editorChecks: [["\\begin{matrix}"], ["\\end{matrix}"], ["\\Gamma("], ["\\log(1+y^2)"]],
  },
  {
    name: "pmatrix with aligned cell",
    anchor: "E18AN",
    marker: "Z18M",
    snippet:
      "\\begin{pmatrix}E18AN+\\sum_{k=1}^{n}k&\\int_0^1x^2dx\\\\\\nabla\\cdot u&\\partial_tu+\\Delta u+\\frac{1}{1+|u|^2}\\end{pmatrix}",
    editorChecks: [["\\begin{pmatrix}"], ["\\end{pmatrix}"], ["\\partial_tu"], ["\\Deltau"]],
  },
  {
    name: "bmatrix with cases cell",
    anchor: "E19AN",
    marker: "Z19M",
    snippet:
      "\\begin{bmatrix}E19AN+\\sqrt{1+x^2}&\\Gamma(\\alpha+\\beta)\\\\\\operatorname{Var}(X)&\\int_0^1t^2dt+\\sum_{k=1}^{n}k^{-1}\\end{bmatrix}",
    editorChecks: [["\\begin{bmatrix}"], ["\\end{bmatrix}"], ["\\Gamma("], ["\\operatorname{Var}(X)"]],
  },
  {
    name: "Bmatrix with array cell",
    anchor: "E20AN",
    marker: "Z20M",
    snippet:
      "\\begin{Bmatrix}E20AN+\\det(A)&\\operatorname{tr}(A^2)\\\\\\int_0^\\infty e^{-t}\\,dt&\\sum_{j=1}^{m}\\frac{1}{j}+\\log(1+u^2)\\end{Bmatrix}",
    editorChecks: [["\\begin{Bmatrix}", "\\begin{bmatrix}"], ["\\end{Bmatrix}", "\\end{bmatrix}"], ["\\operatorname{tr}(A^2)"]],
  },
  {
    name: "vmatrix differential operators",
    anchor: "E21AN",
    marker: "Z21M",
    snippet: "\\begin{vmatrix}E21AN&\\partial_xu\\\\\\partial_yu&\\Delta u\\end{vmatrix}",
    editorChecks: [["\\begin{vmatrix}"], ["\\end{vmatrix}"]],
  },
  {
    name: "Vmatrix vector calculus",
    anchor: "E22AN",
    marker: "Z22M",
    snippet: "\\begin{Vmatrix}E22AN&\\nabla\\cdot F\\\\\\nabla\\times F&\\omega^2\\end{Vmatrix}",
    editorChecks: [["\\begin{Vmatrix}", "\\begin{vmatrix}"], ["\\end{Vmatrix}", "\\end{vmatrix}"]],
  },
  {
    name: "smallmatrix probabilities",
    anchor: "E23AN",
    marker: "Z23M",
    snippet: "\\begin{smallmatrix}E23AN&P(A|B)\\\\\\mathbb{E}[X]&\\mathbb{P}(C)\\end{smallmatrix}",
    editorChecks: [["\\begin{smallmatrix}"], ["\\end{smallmatrix}"]],
  },
  {
    name: "cases piecewise long",
    anchor: "E24AN",
    marker: "Z24M",
    snippet:
      "\\begin{cases}E24AN+\\frac{1}{1+x^2},&x\\ge0\\\\-\\int_x^0t^2dt,&x<0\\end{cases}",
    editorChecks: [["\\begin{cases}"], ["\\end{cases}"]],
  },
  {
    name: "dcases piecewise long",
    anchor: "E25AN",
    marker: "Z25M",
    snippet:
      "\\begin{dcases}E25AN+\\sum_{k=1}^{n}k,&x\\in[0,1]\\\\\\prod_{j=1}^{m}\\left(1+\\frac{1}{j}\\right),&x\\notin[0,1]\\end{dcases}",
    editorChecks: [["\\begin{dcases}", "\\begin{cases}"], ["\\end{dcases}", "\\end{cases}"]],
  },
  {
    name: "rcases piecewise long",
    anchor: "E26AN",
    marker: "Z26M",
    snippet:
      "\\begin{rcases}E26AN+\\log(1+x),&x>0\\\\\\sqrt{1+x^2},&x\\le0\\end{rcases}",
    editorChecks: [["\\begin{rcases}", "\\begin{cases}"], ["\\end{rcases}", "\\end{cases}"]],
  },
  {
    name: "array custom colspec",
    anchor: "E27AN",
    marker: "Z27M",
    snippet:
      "\\begin{array}{@{}>{\\displaystyle}r<{}c@{|}l<{}@{}}E27AN&=&\\int_0^1x^2dx\\\\\\sum_{k=1}^{n}k&=&\\frac{n(n+1)}{2}\\end{array}",
    editorChecks: [["\\begin{array}{@{}>{\\displaystyle}r<{}c@{|}l<{}@{}}"], ["\\end{array}"]],
  },
  {
    name: "subequations nested align",
    anchor: "E28AN",
    marker: "Z28M",
    snippet:
      "\\begin{subequations}\\begin{align}E28AN&=\\nabla\\cdot u\\\\E28BN&=\\partial_tu+\\Delta u\\end{align}\\end{subequations}",
    editorChecks: [["\\begin{subequations}"], ["\\end{subequations}"], ["\\begin{align}"], ["\\end{align}"]],
  },
  {
    name: "align with intertext and label",
    anchor: "E29AN",
    marker: "Z29M",
    snippet:
      "\\begin{align}E29AN&=\\sum_{k=1}^{n}k\\\\\\intertext{anchor E29TXT / + @ . - _ : \\label{eq:e29txt}}E29BN&=\\int_0^1x^2dx\\end{align}",
    editorChecks: [["\\begin{align}"], ["\\end{align}"], ["\\intertext{", "\\txintr{"]],
  },
  {
    name: "equation split with label",
    anchor: "E30AN",
    marker: "Z30M",
    snippet:
      "\\begin{equation}\\label{eq:e30}\\begin{split}E30AN&=\\left(\\sum_{k=1}^{n}k\\right)^2\\\\&=\\frac{n^2(n+1)^2}{4}+\\operatorname{Var}(X)\\end{split}\\end{equation}",
    editorChecks: [["\\begin{equation}"], ["\\end{equation}"], ["\\begin{split}"], ["\\end{split}"]],
  },
  {
    name: "array optional position + custom colspec",
    anchor: "E31AN",
    marker: "Z31M",
    snippet:
      "\\begin{array}[t]{@{}rcl@{}}E31AN&=&\\int_0^1x^2\\,dx\\\\E31BN&=&\\sum_{k=1}^{n}\\frac{1}{k}\\end{array}",
    editorChecks: [["\\begin{array}[t]{@{}rcl@{}}"], ["\\end{array}"]],
  },
  {
    name: "IEEEeqnarray optional arg",
    anchor: "E32AN",
    marker: "Z32M",
    snippet:
      "\\begin{IEEEeqnarray}[c]{rCl}E32AN&=&\\mathbb{E}[X]\\\\E32BN&=&\\mathbb{P}(A|B)\\end{IEEEeqnarray}",
    editorChecks: [["\\begin{IEEEeqnarray}[c]{rCl}"], ["\\end{IEEEeqnarray}"]],
  },
  {
    name: "IEEEeqnarraybox double optional args",
    anchor: "E33AN",
    marker: "Z33M",
    snippet:
      "\\begin{IEEEeqnarraybox}[c][s]{rCl}E33AN&=&\\operatorname{rank}(A)\\\\E33BN&=&\\operatorname{ker}(A)\\end{IEEEeqnarraybox}",
    editorChecks: [["\\begin{IEEEeqnarraybox}[c][s]{rCl}"], ["\\end{IEEEeqnarraybox}"]],
  },
];

const fixtureContent = () => {
  const lines = ["\\section{Edit + Diff Integrity Fixture}", ""];
  EDIT_CASES.forEach((entry, index) => {
    lines.push(`% CASE ${index + 1}: ${entry.name}`);
    lines.push(entry.snippet);
    lines.push("");
  });
  return `${lines.join("\n")}\n`;
};

const cleanupStaleElectron = () => {
  try {
    execSync(
      `pkill -f "${path.join(repoRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")}"`,
      { stdio: "ignore" }
    );
  } catch {
    // ignore
  }
};

const errorMessageIncludes = (error, needle) => {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(needle)) return true;
  const cause = error?.cause;
  if (cause && cause !== error) {
    return errorMessageIncludes(cause, needle);
  }
  return false;
};

const isTransientElectronError = (error) =>
  [
    "Target page, context or browser has been closed",
    "Target closed",
    "Process failed to launch",
    "Browser has been closed",
  ].some((needle) => errorMessageIncludes(error, needle));

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-edit-diff-integrity-30-")
  );
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  await fs.writeFile(path.join(workspacePath, fixturePath), fixtureContent(), "utf8");
  return { tempDir, workspacePath };
};

const postToBridge = async (page, payload) => {
  await page.evaluate((value) => {
    window.tex64Bridge.postMessage(value);
  }, payload);
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 15000 });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 20000,
  });
};

const openSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 12000,
  });
  await pause(50);
};

const openFile = async (page, filePath) => {
  await postToBridge(page, { type: "openFile", path: filePath });
  await page.waitForSelector(`#editor-tabs-list .editor-tab.is-active[data-path="${filePath}"]`, {
    timeout: 20000,
  });
};

const waitForMathFieldReady = async (page) => {
  await page.waitForFunction(
    () => {
      const field = document.getElementById("block-math-input");
      return Boolean(
        field &&
          field.tagName.toLowerCase() === "math-field" &&
          typeof field.getValue === "function" &&
          field.shadowRoot
      );
    },
    undefined,
    { timeout: 20000 }
  );
};

const focusMathField = async (page) => {
  const field = page.locator("#block-math-input");
  await field.waitFor({ state: "visible", timeout: 10000 });
  await field.click({ timeout: 4000 });
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return active?.id === "block-math-input" || active?.closest?.("#block-math-input");
  });
  await pause(30);
};

const collapseMathSelection = async (page) => {
  await page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!field) return;
    const mathfieldApi = field;
    let position =
      typeof mathfieldApi.position === "number" && Number.isFinite(mathfieldApi.position)
        ? mathfieldApi.position
        : null;
    if (Array.isArray(mathfieldApi.selection) && mathfieldApi.selection.length >= 2) {
      const end = Number(mathfieldApi.selection[1]);
      if (Number.isFinite(end)) {
        position = end;
      }
    }
    if (position === null) return;
    try {
      if (typeof mathfieldApi.setSelectionRange === "function") {
        mathfieldApi.setSelectionRange(position, position);
        return;
      }
      if (typeof mathfieldApi.setSelection === "function") {
        mathfieldApi.setSelection(position, position);
        return;
      }
      mathfieldApi.selection = [position, position];
    } catch {
      // ignore selection collapse failures
    }
  });
};

const getMathFieldLatex = async (page) =>
  page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (field && typeof field.getValue === "function") {
      try {
        return String(field.getValue("latex") ?? "");
      } catch {
        return "";
      }
    }
    return "";
  });

const waitForMathFieldContains = async (page, needle, timeout = 6000) => {
  await page.waitForFunction(
    (targetNeedle) => {
      const field = document.getElementById("block-math-input");
      if (!field || typeof field.getValue !== "function") return false;
      let latex = "";
      try {
        latex = String(field.getValue("latex") ?? "");
      } catch {
        return false;
      }
      const normalized = latex.replace(/\s+/g, "");
      const target = String(targetNeedle ?? "").replace(/\s+/g, "");
      return normalized.length > 0 && normalized.includes(target);
    },
    needle,
    { timeout }
  );
};

const waitForDiffModalState = async (page, open) => {
  await page.waitForFunction(
    (shouldOpen) => {
      const modal = document.getElementById("diff-modal");
      if (!(modal instanceof HTMLElement)) return false;
      return modal.classList.contains("is-open") === shouldOpen;
    },
    open,
    { timeout: 10000 }
  );
};

const openDiffModalWithRetry = async (page, label) => {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.click("#block-insert-button");
      await waitForDiffModalState(page, true);
      return;
    } catch (error) {
      lastError = error;
      await pause(120);
    }
  }
  throw new Error(`${label}: failed to open diff modal`, { cause: lastError });
};

const waitForBlockMode = async (page, mode) => {
  await page.waitForFunction(
    (expectedMode) => {
      const toggle = document.getElementById("block-mode-toggle");
      if (!(toggle instanceof HTMLButtonElement)) return false;
      return toggle.dataset.blockMode === expectedMode;
    },
    mode,
    { timeout: 10000 }
  );
};

const clickDiffModalSubmit = async (page) => {
  const clicked = await page.evaluate(() => {
    const button = document.querySelector("#diff-modal-submit");
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  });
  assert.equal(clicked, true, "failed to click #diff-modal-submit");
};

const setBlockMode = async (page, mode) => {
  const current = await page.evaluate(() => {
    const toggle = document.getElementById("block-mode-toggle");
    if (!(toggle instanceof HTMLButtonElement)) return null;
    return toggle.dataset.blockMode ?? null;
  });
  if (current !== mode) {
    await page.click("#block-mode-toggle");
  }
  await waitForBlockMode(page, mode);
};

const setAutoSuggestOff = async (page) => {
  const offButton = page.locator('[data-wysiwyg-auto="off"]');
  if ((await offButton.count()) <= 0) return;
  const visible = await offButton.first().isVisible().catch(() => false);
  if (!visible) return;
  await offButton.first().click();
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-wysiwyg-auto="off"]');
    return (
      button instanceof HTMLButtonElement &&
      button.getAttribute("aria-pressed") === "true" &&
      button.classList.contains("is-active")
    );
  });
};

const setEditorCursorByNeedle = async (page, needle) => {
  const result = await page.evaluate((targetNeedle) => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    if (!active) return null;
    const model = active.getModel?.();
    const text = String(model?.getValue?.() ?? "");
    const index = text.indexOf(String(targetNeedle ?? ""));
    if (index < 0) return null;
    let lineNumber = 1;
    let lineStart = 0;
    for (let i = 0; i < index; i += 1) {
      if (text[i] === "\n") {
        lineNumber += 1;
        lineStart = i + 1;
      }
    }
    const column = index - lineStart + 1;
    active.setPosition?.({ lineNumber, column });
    active.revealPositionInCenterIfOutsideViewport?.({ lineNumber, column });
    active.focus?.();
    const uri = model?.uri?.toString?.() ?? null;
    return { lineNumber, column, uri };
  }, needle);
  assert.ok(result, `needle not found in editor: ${needle}`);
  await pause(80);
  return result;
};

const readActiveEditorValue = async (page) =>
  page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    return String(active?.getModel?.()?.getValue?.() ?? "");
  });

const waitForEditorValueChange = async (page, previousValue, timeout = 4000) => {
  try {
    await page.waitForFunction(
      (before) => {
        const editors = window.monaco?.editor?.getEditors?.() ?? [];
        const active =
          editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
          editors[0];
        const current = String(active?.getModel?.()?.getValue?.() ?? "");
        return current !== String(before ?? "");
      },
      previousValue,
      { timeout }
    );
  } catch {
    // deterministic assertions below
  }
};

const countOccurrences = (text, needle) => {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index >= 0) {
    index = text.indexOf(needle, index);
    if (index < 0) break;
    count += 1;
    index += needle.length;
  }
  return count;
};

const assertRenderStable = async (page, label) => {
  const snapshot = await page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!(field instanceof HTMLElement) || field.tagName.toLowerCase() !== "math-field") {
      return null;
    }
    const root = field.shadowRoot;
    if (!(root instanceof ShadowRoot)) return null;
    const visibleRoot = root.querySelector(".ML__latex") ?? root;
    const rawText = (visibleRoot.textContent ?? "").replace(/\s+/g, " ").trim();
    const placeholderCount = root.querySelectorAll(
      ".ML__placeholder, .ML__prompt, .ML__editablePromptBox"
    ).length;
    const errorCount = root.querySelectorAll(".ML__error").length;
    return { rawText, placeholderCount, errorCount };
  });
  assert.ok(snapshot, `${label}: render snapshot unavailable`);
  assert.equal(snapshot.errorCount, 0, `${label}: render has MathLive error node(s)`);
  assert.equal(snapshot.placeholderCount, 0, `${label}: unresolved placeholder in render`);
  assert.ok(!snapshot.rawText.includes("\\"), `${label}: render still shows raw latex slash`);
};

const assertTokenGroups = (actual, groups, label) => {
  const normalized = normalizeLatex(actual);
  groups.forEach((group, index) => {
    const candidates = (Array.isArray(group) ? group : [group])
      .map((value) => normalizeLatex(value))
      .filter(Boolean);
    const matched = candidates.some((candidate) => normalized.includes(candidate));
    assert.ok(
      matched,
      `${label}: token check ${index + 1} failed [${candidates.join(" | ")}]\nactual=${normalized}`
    );
  });
};

const buildLineDiff = (beforeLines, afterLines) => {
  const rows = beforeLines.length;
  const cols = afterLines.length;
  const table = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(0));
  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= cols; j += 1) {
      if (beforeLines[i - 1] === afterLines[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1;
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
  }
  const diff = [];
  let i = rows;
  let j = cols;
  while (i > 0 && j > 0) {
    if (beforeLines[i - 1] === afterLines[j - 1]) {
      diff.push({ type: "same", line: beforeLines[i - 1] });
      i -= 1;
      j -= 1;
    } else if (table[i - 1][j] >= table[i][j - 1]) {
      diff.push({ type: "del", line: beforeLines[i - 1] });
      i -= 1;
    } else {
      diff.push({ type: "add", line: afterLines[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    diff.push({ type: "del", line: beforeLines[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    diff.push({ type: "add", line: afterLines[j - 1] });
    j -= 1;
  }
  return diff.reverse();
};

const parseDiffSummaryValue = (text) => {
  const match = String(text ?? "").match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
};

const getDiffModalSnapshot = async (page, mainModelUri) =>
  page.evaluate((mainUri) => {
    const title = document.getElementById("diff-modal-title")?.textContent ?? "";
    const fileName = document.getElementById("diff-file-name")?.textContent ?? "";
    const summary = document.getElementById("diff-summary");
    const summaryText = summary?.textContent ?? "";
    const addText = summary?.querySelector(".diff-summary-item.is-add")?.textContent ?? "";
    const delText = summary?.querySelector(".diff-summary-item.is-del")?.textContent ?? "";
    const models = (window.monaco?.editor?.getModels?.() ?? [])
      .map((model, index) => ({
        uri: model?.uri?.toString?.() ?? `model://${index}`,
        value: String(model?.getValue?.() ?? ""),
      }))
      .filter((model) => {
        if (!mainUri) return true;
        return model.uri !== String(mainUri);
      });
    return { title, fileName, summaryText, addText, delText, models };
  }, mainModelUri);

const assertDiffModalIntegrity = (snapshot, testCase, label) => {
  assert.ok(snapshot, `${label}: diff snapshot unavailable`);
  assert.ok(
    String(snapshot.title).includes("変更内容の確認"),
    `${label}: unexpected diff title "${snapshot.title}"`
  );
  assert.equal(
    String(snapshot.fileName).trim(),
    path.basename(fixturePath),
    `${label}: unexpected diff file name`
  );

  const models = Array.isArray(snapshot.models) ? snapshot.models : [];
  assert.ok(models.length >= 2, `${label}: diff models missing (count=${models.length})`);

  const modified =
    models.find((entry) => entry.value.includes(testCase.marker)) ??
    models.find((entry) => normalizeLatex(entry.value).includes(normalizeLatex(testCase.marker)));
  assert.ok(modified, `${label}: modified diff model missing marker ${testCase.marker}`);

  const original =
    models.find((entry) => entry !== modified && entry.value.includes(testCase.anchor)) ??
    models.find(
      (entry) =>
        entry !== modified &&
        normalizeLatex(entry.value).includes(normalizeLatex(testCase.anchor))
    );
  assert.ok(original, `${label}: original diff model missing anchor ${testCase.anchor}`);
  assert.ok(
    !normalizeLatex(original.value).includes(normalizeLatex(testCase.marker)),
    `${label}: original diff model already contains marker`
  );
  assert.ok(
    normalizeLatex(modified.value).includes(normalizeLatex(testCase.marker)),
    `${label}: modified diff model marker check failed`
  );

  const beforeText = String(original.value ?? "").trimEnd();
  const afterText = String(modified.value ?? "").trimEnd();
  const beforeLines = beforeText.length ? beforeText.split(/\r?\n/) : [""];
  const afterLines = afterText.length ? afterText.split(/\r?\n/) : [""];
  const lineDiff = buildLineDiff(beforeLines, afterLines);
  let adds = 0;
  let dels = 0;
  lineDiff.forEach((entry) => {
    if (entry.type === "add") adds += 1;
    if (entry.type === "del") dels += 1;
  });

  const summaryText = String(snapshot.summaryText ?? "").trim();
  if (adds === 0 && dels === 0) {
    assert.equal(summaryText, "変更なし", `${label}: summary should be 変更なし`);
    return;
  }
  const addValue = parseDiffSummaryValue(snapshot.addText);
  const delValue = parseDiffSummaryValue(snapshot.delText);
  assert.equal(addValue, adds, `${label}: diff summary add count mismatch`);
  assert.equal(delValue, dels, `${label}: diff summary del count mismatch`);
};

const runSingleCase = async (testCase, seq) => {
  const label = `[${seq}/${EDIT_CASES.length}] ${testCase.name}`;
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  let electronApp;

  try {
    log(`${label}: workspace copy ${workspacePath}`);
    await fs.mkdir(userDataPath, { recursive: true });
    cleanupStaleElectron();
    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: {
        ...process.env,
        TEX64_E2E: "1",
        TEX64_E2E_HEADLESS: "1",
        TEX64_E2E_USERDATA: userDataPath,
      },
    });

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });
    page.on("dialog", async (dialog) => {
      log(`${label}: dialog intercepted: ${dialog.type()} ${dialog.message()}`);
      try {
        await dialog.dismiss();
      } catch {
        // ignore
      }
    });

    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await page.waitForFunction(() => Boolean(window.MathLive?.convertLatexToMarkup), undefined, {
      timeout: 20000,
    });

    await openFile(page, fixturePath);
    await openSideTab(page, "blocks");
    await waitForMathFieldReady(page);
    await setBlockMode(page, "edit");
    await setAutoSuggestOff(page);

    await setBlockMode(page, "edit");
    log(`${label}: locating anchor`);
    const cursorInfo = await setEditorCursorByNeedle(page, testCase.anchor);
    await waitForMathFieldContains(page, testCase.anchor);

    const beforeLatex = normalizeLatex(await getMathFieldLatex(page));
    assert.ok(beforeLatex.length > 0, `${label}: mathfield is empty`);
    assert.ok(
      beforeLatex.includes(normalizeLatex(testCase.anchor)),
      `${label}: anchor missing before edit\nactual=${beforeLatex}`
    );
    assert.ok(!beforeLatex.includes("#?"), `${label}: unresolved #? remains before edit`);
    assert.ok(
      !beforeLatex.includes("\\placeholder"),
      `${label}: unresolved placeholder remains before edit`
    );
    if (dumpLatex) {
      log(`${label}: before=${beforeLatex}`);
    }
    await assertRenderStable(page, label);

    await focusMathField(page);
    await collapseMathSelection(page);
    await page.keyboard.insertText(testCase.marker);
    if (typeDelayMs > 0) {
      await pause(typeDelayMs);
    }
    await pause(50);

    const editedLatex = normalizeLatex(await getMathFieldLatex(page));
    assert.ok(
      editedLatex.includes(normalizeLatex(testCase.marker)),
      `${label}: marker not reflected in mathfield\nactual=${editedLatex}`
    );
    await assertRenderStable(page, label);

    const beforeContent = await readActiveEditorValue(page);
    const beforeMarkerCount = countOccurrences(beforeContent, testCase.marker);
    await openDiffModalWithRetry(page, label);
    const diffSnapshot = await getDiffModalSnapshot(page, cursorInfo?.uri ?? null);
    assertDiffModalIntegrity(diffSnapshot, testCase, label);

    await clickDiffModalSubmit(page);
    await waitForDiffModalState(page, false);
    await waitForEditorValueChange(page, beforeContent);
    await pause(40);
    const afterContent = await readActiveEditorValue(page);

    assert.notEqual(afterContent, beforeContent, `${label}: editor content did not change`);
    assert.equal(
      countOccurrences(afterContent, testCase.marker),
      beforeMarkerCount + 1,
      `${label}: marker occurrence mismatch after submit`
    );
    assertTokenGroups(afterContent, testCase.editorChecks ?? [], label);
    assert.ok(
      normalizeLatex(afterContent).includes(normalizeLatex(testCase.anchor)),
      `${label}: anchor lost after submit`
    );
    log(`${label}: passed`);
  } finally {
    if (electronApp) {
      try {
        await Promise.race([
          electronApp.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("electronApp.close timeout")), 5000)
          ),
        ]);
      } catch (closeError) {
        log(
          `${label}: close fallback: ${closeError instanceof Error ? closeError.message : String(closeError)}`
        );
        try {
          electronApp.process()?.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    cleanupStaleElectron();
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log(`${label}: workspace copy removed`);
    } else {
      log(`${label}: workspace copy kept ${tempDir}`);
    }
  }
};

const runOnce = async () => {
  const from = Math.max(1, Number.parseInt(process.env.E2E_EDIT_DIFF_FROM ?? "1", 10) || 1);
  const toInput =
    Number.parseInt(process.env.E2E_EDIT_DIFF_TO ?? String(EDIT_CASES.length), 10) ||
    EDIT_CASES.length;
  const to = Math.min(EDIT_CASES.length, Math.max(from, toInput));
  const cases = EDIT_CASES.slice(from - 1, to);
  assert.equal(EDIT_CASES.length, 33, "edit-diff dataset must contain 33 entries");
  log(`case range ${from}-${to} / total ${EDIT_CASES.length}`);

  for (const [index, testCase] of cases.entries()) {
    const seq = from + index;
    let completed = false;
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await runSingleCase(testCase, seq);
        completed = true;
        break;
      } catch (error) {
        lastError = error;
        if (attempt >= 2 || !isTransientElectronError(error)) {
          break;
        }
        log(
          `[${seq}/${EDIT_CASES.length}] ${testCase.name}: transient electron error, retrying (${attempt}/2)`
        );
        await pause(300);
      }
    }
    if (!completed && lastError) {
      throw lastError;
    }
  }

  log("math-wysiwyg edit + diff integrity e2e passed");
};

const run = async () => {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (attempt > 1) {
        log(`retry attempt ${attempt}/3 after transient failure`);
      }
      await runOnce();
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= 3 || !isTransientElectronError(error)) {
        throw error;
      }
      log(
        `transient electron failure detected; retrying (${attempt}/3): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      await pause(300);
    }
  }
  throw lastError ?? new Error("math-wysiwyg edit + diff integrity e2e failed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-edit-diff-integrity-30] FAILED");
  console.error(error);
  process.exitCode = 1;
});

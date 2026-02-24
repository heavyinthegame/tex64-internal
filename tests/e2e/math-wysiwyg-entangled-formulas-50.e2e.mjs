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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "50", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "8", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);
const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";
const dumpLatex = process.env.E2E_FAMOUS_DUMP_LATEX === "1";
const editAfterInsert = process.env.E2E_EDIT_AFTER_INSERT === "1";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-entangled-formulas-50-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const normalizeLatex = (value) => String(value ?? "").replace(/\s+/g, "");

const CANONICAL_SYMBOL_MAP = [
  ["π", "\\pi"],
  ["θ", "\\theta"],
  ["α", "\\alpha"],
  ["β", "\\beta"],
  ["γ", "\\gamma"],
  ["δ", "\\delta"],
  ["λ", "\\lambda"],
  ["μ", "\\mu"],
  ["ρ", "\\rho"],
  ["σ", "\\sigma"],
  ["ω", "\\omega"],
  ["κ", "\\kappa"],
  ["ε", "\\varepsilon"],
  ["η", "\\eta"],
  ["ν", "\\nu"],
  ["φ", "\\phi"],
  ["ϕ", "\\phi"],
  ["ψ", "\\psi"],
  ["ℏ", "\\hbar"],
  ["∇", "\\nabla"],
  ["∂", "\\partial"],
  ["Δ", "\\Delta"],
  ["Λ", "\\Lambda"],
  ["∞", "\\infty"],
  ["Σ", "\\Sigma"],
  ["∫", "\\int"],
  ["∮", "\\oint"],
  ["⋯", "\\cdots"],
  ["√", "\\sqrt"],
  ["→", "\\to"],
  ["×", "\\times"],
  ["·", "\\cdot"],
  ["≤", "\\le"],
  ["≥", "\\ge"],
  ["±", "\\pm"],
  ["≈", "\\approx"],
  ["ℱ", "\\mathcalF"],
];

const canonicalizeFormula = (value) => {
  let text = String(value ?? "");
  CANONICAL_SYMBOL_MAP.forEach(([from, to]) => {
    text = text.split(from).join(to);
  });
  text = text
    .replace(/\s+/g, "")
    .replace(/\\left|\\right/g, "")
    .replace(/\\leq/g, "\\le")
    .replace(/\\geq/g, "\\ge")
    .replace(/\\varphi/g, "\\phi")
    .replace(/\\surd/g, "\\sqrt")
    .replace(/\\thickapprox/g, "\\approx")
    .replace(/\\lbrace/g, "{")
    .replace(/\\rbrace/g, "}")
    .replace(/\\\&/g, "&")
    .replace(/\\prime/g, "'")
    .replace(/\^\{'\}/g, "'")
    .replace(/\^'/g, "'")
    .replace(/\\cos/g, "cos")
    .replace(/\\sin/g, "sin")
    .replace(/\\tan/g, "tan")
    .replace(/\\log/g, "log")
    .replace(/\\ln/g, "ln")
    .replace(/\\exp/g, "exp")
    .replace(/\^\{([A-Za-z0-9]+)\}/g, "^$1")
    .replace(/_\{([A-Za-z0-9]+)\}/g, "_$1")
    .replace(/\^\{\\([A-Za-z]+)\}/g, "^\\$1")
    .replace(/_\{\\([A-Za-z]+)\}/g, "_\\$1")
    .replace(/\^\{\(([^{}]*)\)\}/g, "^($1)");
  return text;
};

const expectedFormulaCandidates = (formula) => {
  const expected = formula.expected ?? formula.input;
  const source = Array.isArray(expected) ? expected : [expected];
  return source.map((value) => canonicalizeFormula(value));
};

const evaluateFormulaMatch = (formula, actualLatex) => {
  const actual = canonicalizeFormula(actualLatex);
  const expected = expectedFormulaCandidates(formula);
  const matched = expected.includes(actual);
  return { matched, actual, expected };
};

const cleanupStaleElectron = () => {
  try {
    execSync(
      `pkill -9 -f "${path.join(
        repoRoot,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
      )}"`,
      { stdio: "ignore" }
    );
  } catch {
    // no stale process
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
    path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-entangled-formulas-50-")
  );
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
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

const clearMathField = async (page) => {
  await page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!field || typeof field.setValue !== "function") {
      return;
    }
    try {
      field.setValue("");
    } catch {
      // ignore and fallback to keyboard clear
    }
  });
  if (!normalizeLatex(await getMathFieldLatex(page))) {
    return;
  }
  await focusMathField(page);
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press(selectAllShortcut);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    await pause(20);
    if (!normalizeLatex(await getMathFieldLatex(page))) {
      return;
    }
  }
  assert.equal(normalizeLatex(await getMathFieldLatex(page)), "", "failed to clear math-field");
};

const typeIntoMathField = async (page, formula) => {
  const actions = Array.isArray(formula?.actions)
    ? formula.actions
    : [String(formula?.input ?? formula ?? "")];
  await focusMathField(page);
  for (const action of actions) {
    if (typeof action === "string") {
      for (const char of action) {
        await page.keyboard.insertText(char);
        if (typeDelayMs > 0) {
          await pause(typeDelayMs);
        }
      }
      continue;
    }
    if (action && typeof action.key === "string") {
      await page.keyboard.press(action.key);
      await pause(Math.max(20, typeDelayMs));
    }
  }
  await pause(80);
  if (normalizeLatex(await getMathFieldLatex(page)).length > 0) {
    return;
  }
  const field = page.locator("#block-math-input");
  await field.click({ timeout: 4000 });
  const fallbackText = actions.filter((action) => typeof action === "string").join("");
  await field.pressSequentially(fallbackText, { delay: typeDelayMs });
  await pause(80);
};

const setAutoSuggestOff = async (page) => {
  const offButton = page.locator('[data-wysiwyg-auto="off"]');
  if ((await offButton.count()) <= 0) {
    return;
  }
  const visible = await offButton.first().isVisible().catch(() => false);
  if (!visible) {
    return;
  }
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

const getRenderSnapshot = async (page) =>
  page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!(field instanceof HTMLElement) || field.tagName.toLowerCase() !== "math-field") {
      return null;
    }
    const root = field.shadowRoot;
    if (!(root instanceof ShadowRoot)) {
      return null;
    }
    const visibleRoot = root.querySelector(".ML__latex") ?? root;
    const rawText = (visibleRoot.textContent ?? "").replace(/\s+/g, " ").trim();
    const placeholderCount = root.querySelectorAll(
      ".ML__placeholder, .ML__prompt, .ML__editablePromptBox"
    ).length;
    const errorCount = root.querySelectorAll(".ML__error").length;
    return { rawText, placeholderCount, errorCount };
  });

const assertRenderStable = async (page, label) => {
  const snapshot = await getRenderSnapshot(page);
  assert.ok(snapshot, `${label}: render snapshot is unavailable`);
  assert.equal(snapshot.errorCount, 0, `${label}: render has MathLive error node(s)`);
  assert.equal(snapshot.placeholderCount, 0, `${label}: unresolved placeholder remains`);
  assert.ok(!snapshot.rawText.includes("\\"), `${label}: render still shows raw LaTeX slash`);
};

const assertSemanticTokens = (actualLatex, checks, label) => {
  assert.ok(Array.isArray(checks) && checks.length > 0, `${label}: semantic checks are not configured`);
  checks.forEach((group, index) => {
    const alternatives = Array.isArray(group) ? group : [group];
    const matched = alternatives.some((token) => actualLatex.includes(normalizeLatex(token)));
    assert.ok(
      matched,
      `${label}: semantic token check ${index + 1} failed [${alternatives.join(" | ")}]\nactual=${actualLatex}`
    );
  });
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

const setInsertMode = async (page, mode) => {
  await page.click("#block-format-button");
  await page.waitForFunction(() => {
    const menu = document.getElementById("block-format-menu");
    return Boolean(menu instanceof HTMLElement && menu.classList.contains("is-open"));
  });
  await page.click(`.block-format-option[data-format="${mode}"]`);
  await page.waitForFunction(
    (expected) => {
      const option = document.querySelector(`.block-format-option[data-format="${expected}"]`);
      return Boolean(option instanceof HTMLElement && option.classList.contains("is-active"));
    },
    mode,
    { timeout: 5000 }
  );
  await pause(30);
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

const firstDiffOffset = (beforeContent, afterContent) => {
  const before = String(beforeContent ?? "");
  const after = String(afterContent ?? "");
  const limit = Math.min(before.length, after.length);
  let index = 0;
  while (index < limit && before[index] === after[index]) {
    index += 1;
  }
  return index;
};

const setEditorCursor = async (page, lineNumber, column) => {
  const ok = await page.evaluate(
    ({ targetLine, targetColumn }) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      if (!active) return false;
      active.setPosition?.({ lineNumber: targetLine, column: targetColumn });
      active.revealPositionInCenterIfOutsideViewport?.({ lineNumber: targetLine, column: targetColumn });
      active.focus?.();
      return true;
    },
    { targetLine: lineNumber, targetColumn: column }
  );
  assert.equal(ok, true, `failed to set cursor at ${lineNumber}:${column}`);
};

const setEditorCursorByOffset = async (page, offset) => {
  const ok = await page.evaluate((targetOffset) => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    if (!active) return false;
    const model = active.getModel?.();
    if (!model || typeof model.getPositionAt !== "function") return false;
    const content = String(model.getValue?.() ?? "");
    const parsed = Number.isFinite(targetOffset) ? targetOffset : Number.parseInt(String(targetOffset), 10);
    const clamped = Math.max(0, Math.min(content.length, Number.isFinite(parsed) ? parsed : 0));
    const position = model.getPositionAt(clamped);
    if (!position) return false;
    active.setPosition?.(position);
    active.revealPositionInCenterIfOutsideViewport?.(position);
    active.focus?.();
    return true;
  }, offset);
  assert.equal(ok, true, `failed to set cursor at offset ${offset}`);
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
    // keep deterministic assertion on token insertion below
  }
};

const runEditRoundtrip = async (page, label, seq, formula, mode, editCursorOffset) => {
  if (!editAfterInsert) {
    return;
  }
  if (Number.isFinite(editCursorOffset)) {
    await setEditorCursorByOffset(page, editCursorOffset);
  }
  await setBlockMode(page, "edit");
  await focusMathField(page);
  await collapseMathSelection(page);
  const marker = `ED${String(seq).padStart(3, "0")}`;
  await page.keyboard.insertText(marker);
  await pause(Math.max(20, typeDelayMs));
  const editedLatex = normalizeLatex(await getMathFieldLatex(page));
  assert.ok(
    editedLatex.includes(normalizeLatex(marker)),
    `${label}: edit marker not reflected in mathfield\nactual=${editedLatex}`
  );
  await assertRenderStable(page, `${label} [edit]`, {
    allowRawSlash: formula.allowRawSlash === true,
  });
  const beforeEditContent = await readActiveEditorValue(page);
  await page.click("#block-insert-button");
  await waitForDiffModalState(page, true);
  await clickDiffModalSubmit(page);
  await waitForDiffModalState(page, false);
  await waitForEditorValueChange(page, beforeEditContent);
  await pause(30);
  const afterEditContent = await readActiveEditorValue(page);
  const normalizedAfterEdit = normalizeLatex(afterEditContent);
  assert.ok(
    normalizedAfterEdit.includes(normalizeLatex(marker)),
    `${label}: editor content missing edit marker\nactual=${normalizedAfterEdit}`
  );
  await setBlockMode(page, "insert");
  await setInsertMode(page, mode);
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

const assertSnippetTokensInserted = (beforeContent, afterContent, tokens, label) => {
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  tokens.forEach((tokenGroup) => {
    const alternatives = (Array.isArray(tokenGroup) ? tokenGroup : [tokenGroup])
      .map((token) => String(token ?? ""))
      .filter(Boolean);
    assert.ok(alternatives.length > 0, `${label}: invalid snippet token alternatives`);
    const inserted = alternatives.some((token) => {
      const beforeCount = countOccurrences(beforeContent, token);
      const afterCount = countOccurrences(afterContent, token);
      return afterCount > beforeCount;
    });
    assert.ok(
      inserted,
      `${label}: snippet token insertion check failed token=${alternatives.join(" | ")}`
    );
  });
};

const ENTANGLED_50_FORMULAS = [
  {
    name: "Damped oscillatory limit sum",
    input: "lim(n→∞)Σ(k=1→n)e^(-λk)cos(ωk+φ)",
    checks: [["lim"], ["\\Sigma", "Σ"], ["\\lambda", "λ"], ["\\omega", "ω"], ["cos"]],
  },
  {
    name: "Euclidean path integral action density",
    input: "Z=∫Dφexp(-∫(0→β)∫Ω((∂τφ)^2+|∇φ|^2+m^2φ^2+gφ^4)dxdτ)",
    checks: [["Z="], ["\\int", "∫"], ["\\partial", "∂"], ["\\nabla", "∇"], ["m^2"], ["g"]],
  },
  {
    name: "Singular system with pseudoinverse",
    input: "A=Σ(j=1→r)σjujvj^T,A+=Σ(j=1→r)σj^(-1)vjuj^T",
    actions: ["A=Σ(j=1→r)σjujvj^T,A+=Σ(j=1→r)σj^(-1)", { key: "ArrowRight" }, "vjuj^T"],
    checks: [["A="], ["\\Sigma", "Σ"], ["\\sigma", "σ"], ["^(-1)", "^{(-1)}"], ["vj"]],
  },
  {
    name: "Zeta reflection relation",
    input: "π^(-0.5s)Γ(0.5s)ζ(s)=π^(-0.5(1-s))Γ(0.5(1-s))ζ(1-s)",
    checks: [["\\pi", "π"], ["\\Gamma", "Γ"], ["\\zeta", "ζ"], ["(1-s)"]],
  },
  {
    name: "Nonlinear Schrodinger blend",
    input: "i∂tu+Δu+|u|^(p-1)u=0,u(0,x)=u0(x)",
    checks: [["i"], ["\\partial", "∂"], ["\\Delta", "Δ"], ["(p-1)"], ["u0"]],
  },
  {
    name: "Einstein field compact form",
    input: "Rμν-0.5gμνR+Λgμν=8πGTμν",
    checks: [["R\\mu\\nu", "Rμν"], ["\\Lambda", "Λ"], ["8"], ["\\pi", "π"], ["T\\mu\\nu", "Tμν"]],
  },
  {
    name: "Yang-Mills curvature identity",
    input: "DμFμν=Jν,Fμν=∂μAν-∂νAμ+[Aμ,Aν]",
    checks: [["D\\muF\\mu\\nu", "DμFμν"], ["J\\nu", "Jν"], ["\\partial\\muA\\nu", "∂μAν"], ["[A"]],
  },
  {
    name: "Hamiltonian control envelope",
    input: "H(x,p,t)=sup(u∈U){p·f(x,u)-L(x,u,t)}",
    checks: [["H(x,p,t)"], ["sup"], ["\\cdot", "·"], ["f(x,u)"], ["L(x,u,t)"]],
  },
  {
    name: "Hamilton-Jacobi-Bellman full term",
    input: "0=∂tV+sup(u∈U){L+∇V·f+0.5Tr(σσ^T∇^2V)}",
    checks: [["\\partialtV", "∂tV"], ["sup"], ["\\nabla", "∇"], ["Tr"], ["\\nabla^2V", "∇^2V"]],
  },
  {
    name: "Matrix Riccati equation",
    input: "Pdot=A^TP+PA-PBR^(-1)B^TP+Q",
    actions: [
      "Pdot=A^T",
      { key: "ArrowRight" },
      "P+PA-PBR^(-1)",
      { key: "ArrowRight" },
      "B^T",
      { key: "ArrowRight" },
      "P+Q",
    ],
    checks: [["Pdot"], ["A^T", "A^{T}"], ["PBR"], ["^(-1)", "^{(-1)}"], ["+Q"]],
  },
  {
    name: "Kalman gain recurrence",
    input: "Kt=PH^T(HPH^T+R)^(-1)",
    actions: [
      "Kt=PH^T",
      { key: "ArrowRight" },
      "(HPH^T",
      { key: "ArrowRight" },
      "+R)^(-1)",
      { key: "ArrowRight" },
    ],
    checks: [["Kt="], ["PH"], ["H^T", "H^{T}"], ["+R"], ["^(-1)", "^{(-1)}"]],
  },
  {
    name: "ELBO inequality nesting",
    input: "logp(x)≥E(q(z|x))[logp(x,z)-logq(z|x)]",
    checks: [["logp(x)"], ["\\ge", "≥"], ["E(q(z|x))"], ["logq(z|x)"]],
  },
  {
    name: "Transformer attention masking",
    input: "Attn(Q,K,V)=softmax((QK^T+M)τ^(-1))V",
    actions: [
      "Attn(Q,K,V)=softmax((QK^T",
      { key: "ArrowRight" },
      "+M)τ^(-1)",
      { key: "ArrowRight" },
      ")V",
    ],
    checks: [["Attn"], ["softmax"], ["QK^T", "QK^{T}"], ["\\tau", "τ"], ["^(-1)", "^{(-1)}"]],
  },
  {
    name: "Normalizing flow density map",
    input: "logpX(x)=logpZ(f(x))+log|detJf(x)|",
    checks: [["logpX"], ["logpZ"], ["detJf"], ["|"]],
  },
  {
    name: "Weak-form PDE with boundaries",
    input: "∫Ω(∇u·∇v+cuv)dΩ=∫ΩfvdΩ+∫ΓNgvdΓ",
    checks: [["\\int", "∫"], ["\\Omega", "Ω"], ["\\nabla", "∇"], ["\\cdot", "·"], ["\\Gamma", "Γ"]],
  },
  {
    name: "Helmholtz decomposition constraint",
    input: "F=∇φ+∇×A,∇·A=0",
    checks: [["F="], ["\\nabla", "∇"], ["\\times", "×"], ["\\cdot", "·"], ["=0"]],
  },
  {
    name: "BCH nested commutators",
    input: "log(e^Xe^Y)=X+Y+0.5[X,Y]+0.0833([X,[X,Y]]+[Y,[Y,X]])",
    actions: [
      "log(e^X",
      { key: "ArrowRight" },
      "e^Y",
      { key: "ArrowRight" },
      ")=X+Y+0.5[X,Y]+0.0833([X,[X,Y]]+[Y,[Y,X]])",
    ],
    checks: [["log(e"], ["[X,Y]"], ["[X,[X,Y]]"], ["[Y,[Y,X]]"]],
  },
  {
    name: "Trotter product expansion",
    input: "e^(t(A+B))=lim(n→∞)(e^(tAn^(-1))e^(tBn^(-1)))^n",
    actions: [
      "e^(t(A+B))",
      { key: "ArrowRight" },
      "=lim(n→∞)(e^(tAn^(-1))",
      { key: "ArrowRight" },
      "e^(tBn^(-1))",
      { key: "ArrowRight" },
      ")^n",
      { key: "ArrowRight" },
    ],
    checks: [["lim"], ["\\infty", "∞"], ["e^{(tA", "e^(tA)"], ["e^{(tB", "e^(tB)"], ["^n", "^{n}"]],
  },
  {
    name: "Generating function cumulants",
    input: "G(t)=exp(Σ(k=1→∞)κkt^k)",
    actions: ["G(t)=exp(Σ(k=1→∞)κkt^k", { key: "ArrowRight" }, ")"],
    checks: [["G(t)"], ["exp"], ["\\Sigma", "Σ"], ["\\kappa", "κ"], ["t^k", "t^{k}"]],
  },
  {
    name: "Log moment generator identity",
    input: "logE(e^(tX))=Σ(k=1→∞)κkt^k",
    actions: ["logE(e^(tX))", { key: "ArrowRight" }, "=Σ(k=1→∞)κkt^k", { key: "ArrowRight" }],
    checks: [["logE"], ["\\Sigma", "Σ"], ["\\kappa", "κ"], ["tX"], ["t^k", "t^{k}"]],
  },
  {
    name: "Ito lemma multidimensional trace",
    input: "df=∂tfdt+∇f·dXt+0.5Tr(ΣΣ^T∇^2f)dt",
    checks: [["df="], ["\\partialtf", "∂tf"], ["\\nablaf", "∇f"], ["Tr"], ["\\nabla^2f", "∇^2f"]],
  },
  {
    name: "Fokker-Planck coupled diffusion",
    input: "∂tp=-∇·(bp)+0.5Σ(i,j=1→d)∂ij((σσ^T)ijp)",
    checks: [["\\partialtp", "∂tp"], ["\\nabla", "∇"], ["\\Sigma", "Σ"], ["\\partialij", "∂ij"], ["\\sigma", "σ"]],
  },
  {
    name: "Mean-field fixed point",
    input: "m=tanh(β(Jm+h))",
    checks: [["m="], ["tanh"], ["\\beta", "β"], ["Jm+h"]],
  },
  {
    name: "Variational free energy split",
    input: "F(q)=Eq[E]+β^(-1)Eq[logq]",
    actions: ["F(q)=Eq[E]+β^(-1)", { key: "ArrowRight" }, "Eq[logq]"],
    checks: [["F(q)"], ["Eq[E]"], ["\\beta", "β"], ["^(-1)", "^{(-1)}"], ["logq"]],
  },
  {
    name: "KKT stationarity and complementarity",
    input: "∇xf+Jg^Tλ+Jh^Tν=0,λ⊙g=0,g≤0,h=0",
    actions: [
      "∇xf+Jg^T",
      { key: "ArrowRight" },
      "λ+Jh^T",
      { key: "ArrowRight" },
      "ν=0,λ⊙g=0,g≤0,h=0",
    ],
    checks: [
      ["\\nabla", "∇"],
      ["Jg^T", "Jg^{T}"],
      ["\\lambda", "λ"],
      ["\\odot", "⊙"],
      ["\\le", "≤"],
      ["h=0"],
    ],
  },
  {
    name: "Lie derivative of differential form",
    input: "LXω=d(iXω)+iX(dω)",
    checks: [["LX"], ["\\omega", "ω"], ["d(iX"], ["iX(d"]],
  },
  {
    name: "General Stokes in forms",
    input: "∫∂Mω=∫Mdω",
    checks: [["\\int", "∫"], ["\\partial", "∂"], ["M"], ["d\\omega", "dω"]],
  },
  {
    name: "Lyapunov exponent map",
    input: "λL=lim(n→∞)n^(-1)Σ(k=0→n-1)log|r(1-2xk)|",
    actions: ["λL=lim(n→∞)n^(-1)", { key: "ArrowRight" }, "Σ(k=0→n-1)log|r(1-2xk)|"],
    checks: [["\\lambda", "λ"], ["lim"], ["n^(-1)", "n^{(-1)}"], ["\\Sigma", "Σ"], ["log|r"]],
  },
  {
    name: "Prime number asymptotic",
    input: "π(x)~x(logx)^(-1)",
    checks: [["\\pi", "π"], ["logx"], ["^(-1)", "^{(-1)}"]],
  },
  {
    name: "Critical line condition",
    input: "ζ(s)=0⇒Re(s)=0.5",
    checks: [["\\zeta", "ζ"], ["=0"], ["Re(s)"], ["0.5"]],
  },
  {
    name: "Time-ordered evolution",
    input: "Ψ(t)=Texp(-i∫(0→t)H(τ)dτ)Ψ(0)",
    checks: [["\\Psi", "Ψ"], ["Texp"], ["-i"], ["\\int", "∫"], ["H(\\tau)", "H(τ)"]],
  },
  {
    name: "Tensor contraction chain",
    input: "Cijkl=Σ(p,q,r,s)AipjqBqkrsDrsjl",
    checks: [["Cijkl"], ["\\Sigma", "Σ"], ["Aipjq"], ["Bqkrs"], ["Drsjl"]],
  },
  {
    name: "Sparse objective with mixed norms",
    input: "S=argmin(θ){Σ(i=1→N)||yi-fθ(xi)||^2+α||θ||1+β||θ||2^2}",
    checks: [["argmin"], ["\\theta", "θ"], ["\\Sigma", "Σ"], ["\\alpha", "α"], ["\\beta", "β"], ["||\\theta||2", "||θ||2"]],
  },
  {
    name: "Gauge partition with determinant",
    input: "Φ=Σ(G)exp(-S[G])det(Δ[G])",
    checks: [["\\Phi", "Φ"], ["\\Sigma", "Σ"], ["exp(-S[G])"], ["det"], ["\\Delta", "Δ"]],
  },
  {
    name: "Spherical harmonic synthesis",
    input: "Ylm(θ,φ)=NlmPlm(cosθ)e^(imφ)",
    checks: [["Ylm"], ["\\theta", "θ"], ["\\phi", "\\varphi", "φ"], ["cos"], ["e^(im", "e^{(im"]],
  },
  {
    name: "Align discrete spectral transform",
    input: "A(ω)&=Σ(k=0→n-1)xke^(-i2πωkn^(-1))",
    mode: "align",
    checks: [
      ["A(\\omega)", "A(ω)"],
      ["\\Sigma", "Σ"],
      ["\\pi", "π"],
      ["n^(-1)", "n^{(-1)}", "n^{(-1))}"],
      ["\\&=", "&="],
    ],
    snippetTokens: [["\\begin{align*}", "\\begin{align}"], ["\\end{align*}", "\\end{align}"]],
  },
  {
    name: "Align reaction-diffusion u-equation",
    input: "∂tu&=Δu+u(1-u)-αuv",
    mode: "align",
    checks: [["\\partialtu", "∂tu"], ["\\Delta", "Δ"], ["\\alpha", "α"], ["\\&=", "&="]],
  },
  {
    name: "Align reaction-diffusion v-equation",
    input: "∂tv&=δΔv+βuv-γv",
    mode: "align",
    checks: [["\\partialtv", "∂tv"], ["\\delta", "δ"], ["\\beta", "β"], ["\\gamma", "γ"], ["\\&=", "&="]],
  },
  {
    name: "Align Gauss law material form",
    input: "∇·E&=ρε0^(-1)",
    mode: "align",
    checks: [["\\nabla", "∇"], ["\\cdot", "·"], ["\\rho", "ρ"], ["\\varepsilon0", "ε0"], ["\\&=", "&="]],
  },
  {
    name: "Align Ampere-Maxwell closure",
    input: "∇×B&=μ0J+μ0ε0∂tE",
    mode: "align",
    checks: [["\\nabla", "∇"], ["\\times", "×"], ["\\mu0", "μ0"], ["\\partialtE", "∂tE"], ["\\&=", "&="]],
  },
  {
    name: "Align Einstein tensor equation",
    input: "Rμν-0.5gμνR+Λgμν&=8πGTμν",
    mode: "align",
    checks: [["R\\mu\\nu", "Rμν"], ["\\Lambda", "Λ"], ["8"], ["\\pi", "π"], ["\\&=", "&="]],
  },
  {
    name: "Align probabilistic chain rule",
    input: "P(At∩Bt)&=P(At|Bt)P(Bt)",
    mode: "align",
    checks: [["P(At"], ["\\cap", "∩"], ["P(At|Bt)"], ["P(Bt)"], ["\\&=", "&="]],
  },
  {
    name: "Align logistic loss decomposition",
    input: "L(θ)&=-Σ(i=1→N)yilogpθ(xi)-(1-yi)log(1-pθ(xi))",
    mode: "align",
    checks: [["L(\\theta)", "L(θ)"], ["\\Sigma", "Σ"], ["yilogp"], ["1-p"], ["\\&=", "&="]],
  },
  {
    name: "Align Bellman expectation equation",
    input: "Qπ(s,a)&=r+γE(Qπ(s',a'))",
    mode: "align",
    checks: [["Q\\pi", "Qπ"], ["\\gamma", "γ"], ["E("], ["s'", "s^{\\prime}"], ["\\&=", "&="]],
  },
  {
    name: "Align entropy aggregation",
    input: "H(p)&=-Σ(i=1→n)pilogpi",
    mode: "align",
    checks: [["H(p)"], ["\\Sigma", "Σ"], ["pilogpi"], ["\\&=", "&="]],
  },
  {
    name: "Gather nonlinear heat equation",
    input: "∂tu=κΔu+f(u)",
    mode: "gather",
    checks: [["\\partialtu", "∂tu"], ["\\kappa", "κ"], ["\\Delta", "Δ"], ["f(u)"]],
    snippetTokens: [["\\begin{gather*}", "\\begin{gather}"], ["\\end{gather*}", "\\end{gather}"]],
  },
  {
    name: "Gather damped wave dynamics",
    input: "∂ttu-c^2Δu+β∂tu=0",
    mode: "gather",
    checks: [["\\partialttu", "∂ttu"], ["c^2"], ["\\beta", "β"], ["=0"]],
  },
  {
    name: "Gather elliptic conductivity",
    input: "∇·(σ∇φ)=s",
    mode: "gather",
    checks: [["\\nabla", "∇"], ["\\sigma", "σ"], ["\\phi", "\\varphi", "φ"], ["=s"]],
  },
  {
    name: "Gather Ito diffusion process",
    input: "dXt=μ(Xt,t)dt+σ(Xt,t)dWt",
    mode: "gather",
    checks: [["dXt"], ["\\mu", "μ"], ["\\sigma", "σ"], ["dWt"]],
  },
  {
    name: "Gather relativistic dispersion",
    input: "E^2=p^2c^2+m^2c^4",
    mode: "gather",
    checks: [["E^2"], ["p^2c^2"], ["m^2c^4"]],
  },
];

const runOnce = async () => {
  const from = Math.max(1, Number.parseInt(process.env.E2E_ENTANGLED_FROM ?? "1", 10) || 1);
  const toInput =
    Number.parseInt(process.env.E2E_ENTANGLED_TO ?? String(ENTANGLED_50_FORMULAS.length), 10) ||
    ENTANGLED_50_FORMULAS.length;
  const to = Math.min(ENTANGLED_50_FORMULAS.length, Math.max(from, toInput));
  const formulas = ENTANGLED_50_FORMULAS.slice(from - 1, to);
  assert.equal(ENTANGLED_50_FORMULAS.length, 50, "entangled formula dataset must contain 50 entries");

  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  let electronApp;
  let currentInsertMode = "inline";

  try {
    log(`workspace copy ${workspacePath}`);
    log(`formula range ${from}-${to} / total ${ENTANGLED_50_FORMULAS.length}`);
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
      log(`dialog intercepted: ${dialog.type()} ${dialog.message()}`);
      try {
        await dialog.dismiss();
      } catch {
        // ignore protocol races during shutdown
      }
    });

    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await page.waitForFunction(() => Boolean(window.MathLive?.convertLatexToMarkup), undefined, {
      timeout: 20000,
    });

    await openFile(page, "sections/blocks.tex");
    await openSideTab(page, "blocks");
    await waitForMathFieldReady(page);
    await setBlockMode(page, "insert");
    await setAutoSuggestOff(page);
    await setEditorCursor(page, 34, 1);

    for (const [index, formula] of formulas.entries()) {
      const seq = from + index;
      const label = `[${seq}/${ENTANGLED_50_FORMULAS.length}] ${formula.name}`;
      const mode = formula.mode ?? "inline";
      if (mode !== currentInsertMode) {
        await setInsertMode(page, mode);
        currentInsertMode = mode;
      }
      log(`${label}: typing (${mode})`);

      await clearMathField(page);
      await typeIntoMathField(page, formula);

      const rawLatex = await getMathFieldLatex(page);
      const actualLatex = normalizeLatex(rawLatex);
      const minLength = Math.max(2, Math.floor(normalizeLatex(formula.input).length * 0.6));
      assert.ok(actualLatex.length >= minLength, `${label}: latex too short\nactual=${actualLatex}`);
      assert.ok(!actualLatex.includes("#?"), `${label}: unresolved placeholder remains\nactual=${actualLatex}`);
      assertSemanticTokens(actualLatex, formula.checks, label);
      if (dumpLatex) {
        log(`${label}: latex=${actualLatex}`);
      }
      await assertRenderStable(page, label);

      const beforeContent = await readActiveEditorValue(page);
      await page.click("#block-insert-button");
      await waitForDiffModalState(page, true);
      await clickDiffModalSubmit(page);
      await waitForDiffModalState(page, false);
      await waitForEditorValueChange(page, beforeContent);
      await pause(40);
      const afterContent = await readActiveEditorValue(page);
      assertSnippetTokensInserted(beforeContent, afterContent, formula.snippetTokens ?? [], label);
      const editCursorOffset = firstDiffOffset(beforeContent, afterContent);
      await runEditRoundtrip(page, label, seq, formula, mode, editCursorOffset);
      currentInsertMode = mode;
      log(`${label}: passed`);
    }

    log("math-wysiwyg entangled formulas 50 e2e passed");
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
        log(`close fallback: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
        try {
          electronApp.process()?.kill("SIGKILL");
        } catch {
          // ignore force kill failure
        }
      }
    }
    cleanupStaleElectron();
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log("workspace copy removed");
    } else {
      log(`workspace copy kept ${tempDir}`);
    }
  }
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
      await pause(250);
    }
  }
  throw lastError ?? new Error("math-wysiwyg entangled formulas 50 e2e failed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-entangled-formulas-50-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});

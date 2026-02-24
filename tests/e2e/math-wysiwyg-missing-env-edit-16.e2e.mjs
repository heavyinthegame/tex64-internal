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
const fixturePath = "sections/missing-env-edit-fixture.tex";
const dumpLatex = process.env.E2E_MISSING_ENV_DUMP_LATEX === "1";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-missing-env-edit-16 ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const normalizeLatex = (value) => String(value ?? "").replace(/\s+/g, "");

const ENV_CASES = [
  {
    name: "alignat",
    anchor: "T01AN",
    marker: "M01",
    snippet:
      "\\begin{alignat}{2}T01AN&=\\sum_{k=1}^{n}\\frac{\\alpha_k}{1+k^2}&&+\\int_0^1x^2\\,dx\\\\T01AN'&=\\prod_{j=1}^{m}\\left(1+\\frac{\\beta}{j}\\right)&&+\\nabla\\cdot F\\end{alignat}",
    editorChecks: [["\\begin{alignat}{2}"], ["\\end{alignat}"]],
  },
  {
    name: "xalignat",
    anchor: "T02AN",
    marker: "M02",
    snippet:
      "\\begin{xalignat}{2}T02AN&=\\frac{d}{dt}\\left(\\rho u\\right)&&+\\Delta u\\\\T02AN'&=\\arg\\min_\\theta J(\\theta)&&+\\lambda\\,R(\\theta)\\end{xalignat}",
    editorChecks: [["\\begin{xalignat}{2}"], ["\\end{xalignat}"]],
  },
  {
    name: "xxalignat",
    anchor: "T03AN",
    marker: "M03",
    snippet:
      "\\begin{xxalignat}{2}T03AN&=\\mathbb{E}[X]\\quad&&+\\mathbb{P}(A|B)\\\\T03AN'&=\\operatorname{Var}(X)&&+\\operatorname{Cov}(X,Y)\\end{xxalignat}",
    editorChecks: [["\\begin{xxalignat}{2}"], ["\\end{xxalignat}"]],
  },
  {
    name: "flalign",
    anchor: "T04AN",
    marker: "M04",
    snippet:
      "\\begin{flalign}T04AN&=\\det(I+A^\\top A)-\\operatorname{tr}(A^3)&&\\end{flalign}",
    editorChecks: [["\\begin{flalign}"], ["\\end{flalign}"]],
  },
  {
    name: "alignedat",
    anchor: "T05AN",
    marker: "M05",
    snippet:
      "\\begin{alignedat}{2}T05AN&=\\lVert u\\rVert_2&&+\\lVert v\\rVert_2\\\\T05AN'&=\\sum_{k=0}^{\\infty}\\frac{1}{2^k}&&+\\log(1+x)\\end{alignedat}",
    editorChecks: [["\\begin{alignedat}{2}"], ["\\end{alignedat}"]],
  },
  {
    name: "gathered",
    anchor: "T06AN",
    marker: "M06",
    snippet:
      "\\begin{gathered}T06AN=\\int_0^\\infty e^{-t}\\,dt\\\\T06AN'=\\sum_{k=1}^{n}k^2\\end{gathered}",
    editorChecks: [["\\begin{gathered}"], ["\\end{gathered}"]],
  },
  {
    name: "multlined",
    anchor: "T07AN",
    marker: "M07",
    snippet:
      "\\begin{multlined}[t]T07AN=(a+b+c+d)^3\\\\\\quad-(a-b)^3+\\log(1+x)+\\sqrt{1+y^2}\\end{multlined}",
    editorChecks: [["\\begin{multlined}[t]"], ["\\end{multlined}"]],
  },
  {
    name: "numcases",
    anchor: "T08AN",
    marker: "M08",
    snippet:
      "\\begin{numcases}{f(x)=}T08AN+\\frac{1}{1+x^2},&x\\ge0\\\\-\\frac{1}{1+x^2},&x<0\\end{numcases}",
    editorChecks: [["\\begin{numcases}{f(x)=}"], ["\\end{numcases}"]],
  },
  {
    name: "subnumcases",
    anchor: "T09AN",
    marker: "M09",
    snippet:
      "\\begin{subnumcases}{g(x)=}T09AN+\\sin x,&x\\in[0,\\pi]\\\\\\cos x,&x\\in(\\pi,2\\pi]\\end{subnumcases}",
    editorChecks: [["\\begin{subnumcases}{g(x)=}"], ["\\end{subnumcases}"]],
  },
  {
    name: "empheq",
    anchor: "T10AN",
    marker: "M10",
    snippet:
      "\\begin{empheq}[left=\\empheqlbrace]{align}T10AN&=\\partial_t\\rho+\\nabla\\cdot(\\rho u)\\\\T10AN'&=\\Delta u-\\nabla p\\end{empheq}",
    editorChecks: [["\\begin{empheq}[left=\\empheqlbrace]{align}"], ["\\end{empheq}"]],
  },
  {
    name: "subarray",
    anchor: "T11AN",
    marker: "M11",
    snippet:
      "\\begin{subarray}{l}i<j\\\\i,j\\in S\\\\T11AN\\end{subarray}",
    editorChecks: [["\\begin{subarray}{l}"], ["\\end{subarray}"]],
  },
  {
    name: "darray",
    anchor: "T12AN",
    marker: "M12",
    snippet:
      "\\begin{darray}{rcl}T12AN&=&\\Gamma(\\alpha+\\beta)\\\\T12AN'&=&\\int_0^\\infty t^{\\alpha+\\beta-1}e^{-t}\\,dt\\end{darray}",
    editorChecks: [["\\begin{darray}{rcl}"], ["\\end{darray}"]],
  },
  {
    name: "IEEEeqnarray",
    anchor: "T13AN",
    marker: "M13",
    snippet:
      "\\begin{IEEEeqnarray}{rCl}T13AN&=&\\mathbb{E}[X]\\\\T13AN'&=&\\mathbb{P}(A|B)\\end{IEEEeqnarray}",
    editorChecks: [["\\begin{IEEEeqnarray}{rCl}"], ["\\end{IEEEeqnarray}"]],
  },
  {
    name: "IEEEeqnarraybox",
    anchor: "T14AN",
    marker: "M14",
    snippet:
      "\\begin{IEEEeqnarraybox}{rCl}T14AN&=&\\operatorname{rank}(A)\\\\T14AN'&=&\\operatorname{ker}(A)\\end{IEEEeqnarraybox}",
    editorChecks: [["\\begin{IEEEeqnarraybox}{rCl}"], ["\\end{IEEEeqnarraybox}"]],
  },
  {
    name: "mathpar",
    anchor: "T15AN",
    marker: "M15",
    snippet:
      "\\begin{mathpar}T15AN:\\;A\\vdash B,\\;T15AN':\\;C\\vdash D\\end{mathpar}",
    editorChecks: [["\\begin{mathpar}"], ["\\end{mathpar}"]],
  },
  {
    name: "mathparpagebreakable",
    anchor: "T16AN",
    marker: "M16",
    snippet:
      "\\begin{mathparpagebreakable}[allowdisplaybreaks]T16AN:\\;P\\Rightarrow Q,\\;T16AN':\\;Q\\Rightarrow R\\end{mathparpagebreakable}",
    editorChecks: [["\\begin{mathparpagebreakable}[allowdisplaybreaks]"], ["\\end{mathparpagebreakable}"]],
  },
];

const fixtureContent = () => {
  const lines = ["\\section{Missing Environment Edit Fixture}", ""];
  ENV_CASES.forEach((entry, index) => {
    lines.push(`% CASE ${index + 1}: ${entry.name}`);
    lines.push(entry.snippet);
    lines.push("");
  });
  return `${lines.join("\n")}\n`;
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-missing-env-"));
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
  await pause(40);
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

const clickDiffModalSubmit = async (page) => {
  const clicked = await page.evaluate(() => {
    const button = document.querySelector("#diff-modal-submit");
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  });
  assert.equal(clicked, true, "failed to click #diff-modal-submit");
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
  throw new Error(`${label}: diff modal did not open`, { cause: lastError });
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
    return { lineNumber, column };
  }, needle);
  assert.ok(result, `needle not found in editor: ${needle}`);
  await pause(80);
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
    // deterministic checks below
  }
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

const assertTokenGroups = (actualLatex, groups, label) => {
  groups.forEach((group, index) => {
    const candidates = (Array.isArray(group) ? group : [group])
      .map((value) => normalizeLatex(value))
      .filter(Boolean);
    const matched = candidates.some((candidate) => actualLatex.includes(candidate));
    assert.ok(
      matched,
      `${label}: token check ${index + 1} failed [${candidates.join(" | ")}]\nactual=${actualLatex}`
    );
  });
};

const runSingleCase = async (testCase, seq) => {
  const label = `[${seq}/${ENV_CASES.length}] ${testCase.name}`;
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

    log(`${label}: locating anchor`);
    await setEditorCursorByNeedle(page, testCase.anchor);
    await pause(80);

    const beforeLatex = normalizeLatex(await getMathFieldLatex(page));
    assert.ok(beforeLatex.length > 0, `${label}: math input is empty`);
    assert.ok(!beforeLatex.includes("#?"), `${label}: unresolved #? placeholder\nactual=${beforeLatex}`);
    assert.ok(
      !beforeLatex.includes("\\placeholder"),
      `${label}: unresolved \\placeholder remains\nactual=${beforeLatex}`
    );
    assert.ok(
      beforeLatex.includes(normalizeLatex(testCase.anchor)),
      `${label}: anchor token missing in math input\nactual=${beforeLatex}`
    );
    if (dumpLatex) {
      log(`${label}: before=${beforeLatex}`);
    }
    await assertRenderStable(page, label);

    await focusMathField(page);
    for (const ch of testCase.marker) {
      await page.keyboard.insertText(ch);
      if (typeDelayMs > 0) {
        await pause(typeDelayMs);
      }
    }
    await pause(60);
    const editedLatex = normalizeLatex(await getMathFieldLatex(page));
    assert.ok(
      editedLatex.includes(normalizeLatex(testCase.marker)),
      `${label}: marker not inserted\nactual=${editedLatex}`
    );

    const beforeContent = await readActiveEditorValue(page);
    await openDiffModalWithRetry(page, label);
    await clickDiffModalSubmit(page);
    await waitForDiffModalState(page, false);
    await waitForEditorValueChange(page, beforeContent);
    const afterContent = await readActiveEditorValue(page);
    assert.notEqual(afterContent, beforeContent, `${label}: editor content did not change`);
    assert.ok(afterContent.includes(testCase.marker), `${label}: marker missing from editor content`);
    (Array.isArray(testCase.editorChecks) ? testCase.editorChecks : []).forEach((group) => {
      const options = (Array.isArray(group) ? group : [group]).map((v) => String(v ?? ""));
      const matched = options.some((token) => token && afterContent.includes(token));
      assert.ok(
        matched,
        `${label}: wrapper token missing from editor content [${options.join(" | ")}]`
      );
    });

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
  const from = Math.max(1, Number.parseInt(process.env.E2E_MISSING_ENV_FROM ?? "1", 10) || 1);
  const toInput =
    Number.parseInt(process.env.E2E_MISSING_ENV_TO ?? String(ENV_CASES.length), 10) || ENV_CASES.length;
  const to = Math.min(ENV_CASES.length, Math.max(from, toInput));
  const cases = ENV_CASES.slice(from - 1, to);
  assert.equal(ENV_CASES.length, 16, "missing-env dataset must contain 16 entries");
  log(`case range ${from}-${to} / total ${ENV_CASES.length}`);

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
          `[${seq}/${ENV_CASES.length}] ${testCase.name}: transient electron error, retrying (${attempt}/2)`
        );
        await pause(300);
      }
    }
    if (!completed && lastError) {
      throw lastError;
    }
  }

  log("math-wysiwyg missing env edit 16 e2e passed");
};

const run = async () => {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await runOnce();
      return;
    } catch (error) {
      if (attempt >= 2 || !isTransientElectronError(error)) {
        throw error;
      }
      log(
        `transient electron error, retrying (${attempt}/2): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      await pause(300);
    }
  }
};

run().catch((error) => {
  console.error("[math-wysiwyg-missing-env-edit-16] FAILED");
  console.error(error);
  process.exitCode = 1;
});

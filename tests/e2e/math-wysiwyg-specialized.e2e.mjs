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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "150", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "35", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "30", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-specialized-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const normalizeLatex = (value) => String(value ?? "").replace(/\s+/g, "");

const cleanupStaleElectron = () => {
  try {
    execSync(
      `pkill -f "${path.join(
        repoRoot,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
      )}"`,
      { stdio: "ignore" }
    );
  } catch {
    // no stale process
  }
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-specialized-"));
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
  await pause(70);
};

const clearWysiwygStorage = async (page) => {
  await page.evaluate(() => {
    const keysToDelete = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key === "tex64.math-wysiwyg.mru" || key.startsWith("tex64.math-wysiwyg.mru.")) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach((key) => localStorage.removeItem(key));
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
  await pause(60);
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

const waitForSuggestions = async (page, hint) => {
  const expected = String(hint ?? "").trim().toLowerCase();
  await page.waitForFunction(
    (needle) => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) return false;
      if (panel.getAttribute("aria-hidden") !== "false") return false;
      const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item"));
      if (items.length === 0) return false;
      return items.some((item) => {
        const label = (item.querySelector(".math-wysiwyg-label")?.textContent ?? "")
          .trim()
          .toLowerCase();
        return label === needle;
      });
    },
    expected,
    { timeout: 10000 }
  );
};

const getSuggestionSnapshot = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!(panel instanceof HTMLElement)) {
      return { visible: false, items: [] };
    }
    const visible = panel.getAttribute("aria-hidden") === "false";
    const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item")).map((item) => ({
      hint: (item.querySelector(".math-wysiwyg-label")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    }));
    return { visible, items };
  });

const applySuggestionByTyping = async (page, token, options = {}) => {
  const pickIndex = Number.isFinite(options.pickIndex) ? Math.max(0, options.pickIndex) : 0;
  await focusMathField(page);
  await page.keyboard.type(token, { delay: typeDelayMs });
  await waitForSuggestions(page, token);
  const snapshot = await getSuggestionSnapshot(page);
  assert.ok(snapshot.visible, `${token}: suggestion panel should be visible`);
  assert.ok(snapshot.items.length > 0, `${token}: no suggestion items`);
  assert.ok(
    snapshot.items.some((item) => item.hint.toLowerCase() === token.toLowerCase()),
    `${token}: token-specific suggestion was not found`
  );
  for (let i = 0; i < pickIndex; i += 1) {
    await page.keyboard.press("ArrowDown");
    await pause(40);
  }
  await page.keyboard.press("Enter");
  try {
    await page.waitForFunction(
      () => {
        const panel = document.querySelector(".math-wysiwyg-panel");
        if (!(panel instanceof HTMLElement)) return true;
        return panel.getAttribute("aria-hidden") !== "false";
      },
      undefined,
      { timeout: 1200 }
    );
  } catch {
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => {
        const panel = document.querySelector(".math-wysiwyg-panel");
        if (!(panel instanceof HTMLElement)) return true;
        return panel.getAttribute("aria-hidden") !== "false";
      },
      undefined,
      { timeout: 3000 }
    );
  }
  await pause(60);
};

const waitForExactLatex = async (page, expected, label) => {
  const expectedNormalized = normalizeLatex(expected);
  try {
    await page.waitForFunction(
      (expectedValue) => {
        const field = document.getElementById("block-math-input");
        if (!field || typeof field.getValue !== "function") return false;
        try {
          const latex = String(field.getValue("latex") ?? "").replace(/\s+/g, "");
          return latex === expectedValue;
        } catch {
          return false;
        }
      },
      expectedNormalized,
      { timeout: 10000 }
    );
  } catch (error) {
    const actualLatex = await getMathFieldLatex(page);
    throw new Error(
      `${label}: timed out waiting latex\nexpected: ${expected}\nactual:   ${actualLatex}`,
      { cause: error }
    );
  }
  const actual = await getMathFieldLatex(page);
  assert.equal(
    normalizeLatex(actual),
    expectedNormalized,
    `${label}: latex mismatch\nexpected: ${expected}\nactual:   ${actual}`
  );
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
    const compactText = rawText.replace(/\s+/g, "");
    const placeholderCount = root.querySelectorAll(
      ".ML__placeholder, .ML__prompt, .ML__editablePromptBox"
    ).length;
    const errorCount = root.querySelectorAll(".ML__error").length;
    return { rawText, compactText, placeholderCount, errorCount };
  });

const assertRenderedOutput = async (
  page,
  { label, mustContain = [], mustContainAny = [], mustNotContain = [] }
) => {
  const snapshot = await getRenderSnapshot(page);
  assert.ok(snapshot, `${label}: render snapshot is unavailable`);
  assert.equal(snapshot.errorCount, 0, `${label}: render has MathLive error node(s)`);
  assert.equal(snapshot.placeholderCount, 0, `${label}: placeholder remains in rendered output`);
  assert.ok(!snapshot.rawText.includes("\\"), `${label}: render still shows raw LaTeX slash`);

  mustContain.forEach((value) => {
    assert.ok(
      snapshot.rawText.includes(value) || snapshot.compactText.includes(value),
      `${label}: rendered text is missing "${value}"\nrender=${snapshot.rawText}`
    );
  });

  mustContainAny.forEach((group) => {
    assert.ok(
      group.some((value) => snapshot.rawText.includes(value) || snapshot.compactText.includes(value)),
      `${label}: rendered text misses any of [${group.join(", ")}]\nrender=${snapshot.rawText}`
    );
  });

  mustNotContain.forEach((value) => {
    assert.ok(
      !snapshot.rawText.includes(value) && !snapshot.compactText.includes(value),
      `${label}: rendered text should not contain "${value}"\nrender=${snapshot.rawText}`
    );
  });
};

const runCase = async (label, test) => {
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
        // ignore protocol races
      }
    });
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await page.waitForFunction(() => Boolean(window.MathLive?.convertLatexToMarkup), undefined, {
      timeout: 20000,
    });
    await openSideTab(page, "blocks");
    await waitForMathFieldReady(page);
    await clearWysiwygStorage(page);
    await test(page);
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
          // ignore force-kill failure
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

const run = async () => {
  await runCase("[1/15] argmin operator", async (page) => {
    await applySuggestionByTyping(page, "argmin");
    await waitForExactLatex(page, "\\operatorname*{arg\\,min}", "argmin");
    await assertRenderedOutput(page, {
      label: "argmin",
      mustContainAny: [["arg", "min", "argmin"]],
    });
  });

  await runCase("[2/15] xrightarrow template", async (page) => {
    await applySuggestionByTyping(page, "xrightarrow");
    await page.keyboard.type("f", { delay: typeDelayMs });
    await waitForExactLatex(page, "\\xrightarrow{f}", "xrightarrow");
    await assertRenderedOutput(page, {
      label: "xrightarrow",
      mustContainAny: [["f", "→"]],
      mustNotContain: ["placeholder"],
    });
  });

  await runCase("[3/15] ddx derivative template", async (page) => {
    await applySuggestionByTyping(page, "ddx");
    await page.keyboard.type("y", { delay: typeDelayMs });
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.type("x", { delay: typeDelayMs });
    await waitForExactLatex(page, "\\frac{\\mathrm{dy}}{\\mathrm{dx}}", "ddx");
    await assertRenderedOutput(page, {
      label: "ddx",
      mustContain: ["y", "x"],
      mustNotContain: ["placeholder"],
    });
  });

  await runCase("[4/15] pdx partial derivative template", async (page) => {
    await applySuggestionByTyping(page, "pdx");
    await page.keyboard.type("f", { delay: typeDelayMs });
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.type("x", { delay: typeDelayMs });
    await waitForExactLatex(page, "\\frac{\\partial f}{\\partial x}", "pdx");
    await assertRenderedOutput(page, {
      label: "pdx",
      mustContain: ["f", "x"],
      mustContainAny: [["∂"]],
      mustNotContain: ["placeholder"],
    });
  });

  await runCase("[5/15] expectation operator", async (page) => {
    await applySuggestionByTyping(page, "expect");
    await waitForExactLatex(page, "\\mathbb{E}", "expect");
    await assertRenderedOutput(page, {
      label: "expect",
      mustContainAny: [["E"]],
    });
  });

  await runCase("[6/15] probability operator", async (page) => {
    await applySuggestionByTyping(page, "prob");
    await waitForExactLatex(page, "\\mathbb{P}", "prob");
    await assertRenderedOutput(page, {
      label: "prob",
      mustContainAny: [["P"]],
    });
  });

  await runCase("[7/15] auto operator <= to leq", async (page) => {
    await focusMathField(page);
    await page.keyboard.type("a<=b", { delay: typeDelayMs });
    await waitForExactLatex(page, "a\\leq b", "leq");
    await assertRenderedOutput(page, {
      label: "leq",
      mustContain: ["a", "b"],
      mustContainAny: [["≤"]],
      mustNotContain: ["<="],
    });
  });

  await runCase("[8/15] auto operator <=> to Leftrightarrow", async (page) => {
    await focusMathField(page);
    await page.keyboard.type("P<=>Q", { delay: typeDelayMs });
    await waitForExactLatex(page, "P\\Leftrightarrow Q", "iff");
    await assertRenderedOutput(page, {
      label: "iff",
      mustContain: ["P", "Q"],
      mustContainAny: [["⇔"]],
      mustNotContain: ["<=>"],
    });
  });

  await runCase("[9/15] auto operator ... to ldots", async (page) => {
    await focusMathField(page);
    await page.keyboard.type("a...b", { delay: typeDelayMs });
    await waitForExactLatex(page, "a\\ldots b", "ldots");
    await assertRenderedOutput(page, {
      label: "ldots",
      mustContain: ["a", "b"],
      mustContainAny: [["…"]],
      mustNotContain: ["..."],
    });
  });

  await runCase("[10/15] auto operator >= to geq", async (page) => {
    await focusMathField(page);
    await page.keyboard.type("a>=b", { delay: typeDelayMs });
    await waitForExactLatex(page, "a\\geq b", "geq");
    await assertRenderedOutput(page, {
      label: "geq",
      mustContain: ["a", "b"],
      mustContainAny: [["≥"]],
      mustNotContain: [">="],
    });
  });

  await runCase("[11/15] auto operator != to neq", async (page) => {
    await focusMathField(page);
    await page.keyboard.type("a!=b", { delay: typeDelayMs });
    await waitForExactLatex(page, "a\\neq b", "neq");
    await assertRenderedOutput(page, {
      label: "neq",
      mustContain: ["a", "b"],
      mustNotContain: ["!="],
    });
  });

  await runCase("[12/15] auto operator <-> to leftrightarrow", async (page) => {
    await focusMathField(page);
    await page.keyboard.type("A<->B", { delay: typeDelayMs });
    await waitForExactLatex(page, "A\\leftrightarrow B", "leftrightarrow");
    await assertRenderedOutput(page, {
      label: "leftrightarrow",
      mustContain: ["A", "B"],
      mustContainAny: [["↔"]],
      mustNotContain: ["<->"],
    });
  });

  await runCase("[13/15] epsilon variant selection", async (page) => {
    await applySuggestionByTyping(page, "epsilon", { pickIndex: 1 });
    await waitForExactLatex(page, "\\varepsilon", "varepsilon");
    await assertRenderedOutput(page, {
      label: "varepsilon",
      mustContainAny: [["ϵ", "ε"]],
      mustNotContain: ["epsilon"],
    });
  });

  await runCase("[14/15] overline accent template", async (page) => {
    await applySuggestionByTyping(page, "overline");
    await page.keyboard.type("AB", { delay: typeDelayMs });
    await waitForExactLatex(page, "\\overline{AB}", "overline");
    await assertRenderedOutput(page, {
      label: "overline",
      mustContain: ["A", "B"],
      mustNotContain: ["placeholder"],
    });
  });

  await runCase("[15/15] norm template", async (page) => {
    await applySuggestionByTyping(page, "norm");
    await page.keyboard.type("x", { delay: typeDelayMs });
    await waitForExactLatex(page, "\\left\\lVert x\\right\\rVert", "norm");
    await assertRenderedOutput(page, {
      label: "norm",
      mustContain: ["x"],
      mustContainAny: [["∥", "‖", "|"]],
      mustNotContain: ["placeholder"],
    });
  });

  log("math-wysiwyg specialized e2e passed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-specialized-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});

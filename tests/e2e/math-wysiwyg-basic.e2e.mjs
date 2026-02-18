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
  console.log(`[math-wysiwyg-basic-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-basic-"));
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
  await pause(80);
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
  const normalizedHint = String(hint ?? "").trim().toLowerCase();
  await page.waitForFunction(
    (expectedHint) => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) return false;
      if (panel.getAttribute("aria-hidden") !== "false") return false;
      const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item"));
      if (items.length === 0) return false;
      if (!expectedHint) return true;
      return items.some((item) => {
        const hintNode = item.querySelector(".math-wysiwyg-label");
        const hintText = (hintNode?.textContent ?? "").trim().toLowerCase();
        return hintText === expectedHint;
      });
    },
    normalizedHint,
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
      text: (item.textContent ?? "").replace(/\s+/g, " ").trim(),
      hint: (
        item.querySelector(".math-wysiwyg-label")?.textContent ?? ""
      )
        .replace(/\s+/g, " ")
        .trim(),
      active:
        item.classList.contains("is-active") || item.getAttribute("aria-selected") === "true",
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
        if (!field || typeof field.getValue !== "function") {
          return false;
        }
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
        // ignore protocol races when dialogs auto-close during shutdown
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
    assert.equal(
      normalizeLatex(await getMathFieldLatex(page)),
      "",
      `${label}: math-field should be empty at case start`
    );
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
          // ignore force kill failure
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
  await runCase("[1/10] fraction via suggestion + placeholders", async (page) => {
    await applySuggestionByTyping(page, "frac", { pickIndex: 0 });
    await page.keyboard.type("a", { delay: typeDelayMs });
    await page.keyboard.press("Tab");
    await page.keyboard.type("b", { delay: typeDelayMs });
    await waitForExactLatex(page, "\\frac{a}{b}", "fraction");
    await assertRenderedOutput(page, {
      label: "fraction",
      mustContain: ["a", "b"],
      mustNotContain: ["frac", "placeholder"],
    });
  });

  await runCase("[2/10] square root via suggestion", async (page) => {
    await applySuggestionByTyping(page, "sqrt", { pickIndex: 0 });
    await page.keyboard.type("x", { delay: typeDelayMs });
    await waitForExactLatex(page, "\\sqrt{x}", "sqrt");
    await assertRenderedOutput(page, {
      label: "sqrt",
      mustContain: ["x"],
      mustContainAny: [["√"]],
      mustNotContain: ["sqrt", "placeholder"],
    });
  });

  await runCase("[3/10] summation with limits via suggestion navigation", async (page) => {
    await applySuggestionByTyping(page, "sum", { pickIndex: 1 });
    await page.keyboard.type("n", { delay: typeDelayMs });
    await page.keyboard.press("Tab");
    await page.keyboard.type("i=1", { delay: typeDelayMs });
    await waitForExactLatex(page, "\\sum_{i=1}^{n}", "sum");
    await assertRenderedOutput(page, {
      label: "sum",
      mustContain: ["i", "1", "n"],
      mustContainAny: [["∑", "Σ"]],
      mustNotContain: ["sum", "placeholder"],
    });
  });

  await runCase("[4/10] operator auto-replace (-> to \\to)", async (page) => {
    await focusMathField(page);
    await page.keyboard.type("A->B", { delay: typeDelayMs });
    await waitForExactLatex(page, "A\\to B", "arrow");
    await assertRenderedOutput(page, {
      label: "arrow",
      mustContain: ["A", "B"],
      mustContainAny: [["→"]],
      mustNotContain: ["->"],
    });
  });

  await runCase("[5/10] integral symbol", async (page) => {
    await applySuggestionByTyping(page, "int", { pickIndex: 0 });
    await waitForExactLatex(page, "\\int", "integral");
    await assertRenderedOutput(page, {
      label: "integral",
      mustContainAny: [["∫"]],
      mustNotContain: ["placeholder"],
    });
  });

  await runCase("[6/10] logarithm", async (page) => {
    await applySuggestionByTyping(page, "log", { pickIndex: 0 });
    await page.keyboard.type("x", { delay: typeDelayMs });
    await waitForExactLatex(page, "\\log x", "log");
    await assertRenderedOutput(page, {
      label: "log",
      mustContain: ["x"],
      mustContainAny: [["log"]],
      mustNotContain: ["placeholder"],
    });
  });

  await runCase("[7/10] sine function", async (page) => {
    await applySuggestionByTyping(page, "sin", { pickIndex: 0 });
    await page.keyboard.type("x", { delay: typeDelayMs });
    await waitForExactLatex(page, "\\sin x", "sin");
    await assertRenderedOutput(page, {
      label: "sin",
      mustContain: ["x"],
      mustContainAny: [["sin"]],
      mustNotContain: ["placeholder"],
    });
  });

  await runCase("[8/10] cosine function", async (page) => {
    await applySuggestionByTyping(page, "cos", { pickIndex: 0 });
    await page.keyboard.type("x", { delay: typeDelayMs });
    await waitForExactLatex(page, "\\cos x", "cos");
    await assertRenderedOutput(page, {
      label: "cos",
      mustContain: ["x"],
      mustContainAny: [["cos"]],
      mustNotContain: ["placeholder"],
    });
  });

  await runCase("[9/10] tangent function", async (page) => {
    await applySuggestionByTyping(page, "tan", { pickIndex: 0 });
    await page.keyboard.type("x", { delay: typeDelayMs });
    await waitForExactLatex(page, "\\tan x", "tan");
    await assertRenderedOutput(page, {
      label: "tan",
      mustContain: ["x"],
      mustContainAny: [["tan"]],
      mustNotContain: ["placeholder"],
    });
  });

  await runCase("[10/10] exponential function", async (page) => {
    await applySuggestionByTyping(page, "exp", { pickIndex: 0 });
    await page.keyboard.type("x", { delay: typeDelayMs });
    await waitForExactLatex(page, "\\exp x", "exp");
    await assertRenderedOutput(page, {
      label: "exp",
      mustContain: ["x"],
      mustContainAny: [["exp"]],
      mustNotContain: ["placeholder"],
    });
  });

  log("math-wysiwyg-basic e2e passed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-basic-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});

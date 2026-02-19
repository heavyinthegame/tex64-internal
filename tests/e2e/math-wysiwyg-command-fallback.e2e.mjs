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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "130", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "30", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "25", 10);
const isMac = process.platform === "darwin";
const selectAllShortcut = isMac ? "Meta+A" : "Control+A";
const explicitSuggestShortcut = isMac ? "Meta+." : "Control+.";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-command-fallback-e2e ${now()}] ${message}`);
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
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-command-fallback-")
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
  await pause(70);
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
    if (!field || typeof field.getValue !== "function") {
      return "";
    }
    try {
      return String(field.getValue("latex") ?? "");
    } catch {
      return "";
    }
  });

const clearMathField = async (page) => {
  await focusMathField(page);
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Escape");
    await page.keyboard.press(selectAllShortcut);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    await pause(30);
    if (!normalizeLatex(await getMathFieldLatex(page))) {
      return;
    }
    for (let j = 0; j < 4; j += 1) {
      await page.keyboard.press("Backspace");
      await pause(15);
      if (!normalizeLatex(await getMathFieldLatex(page))) {
        return;
      }
    }
  }
  assert.equal(normalizeLatex(await getMathFieldLatex(page)), "", "failed to clear math-field");
};

const waitForExactLatex = async (page, expected, label) => {
  const expectedNormalized = normalizeLatex(expected);
  await page.waitForFunction(
    (needle) => {
      const field = document.getElementById("block-math-input");
      if (!field || typeof field.getValue !== "function") {
        return false;
      }
      try {
        return String(field.getValue("latex") ?? "").replace(/\s+/g, "") === needle;
      } catch {
        return false;
      }
    },
    expectedNormalized,
    { timeout: 10000 }
  );
  const actual = normalizeLatex(await getMathFieldLatex(page));
  assert.equal(actual, expectedNormalized, `${label}: latex mismatch\nexpected ${expected}\nactual ${actual}`);
};

const waitForLatexIncludes = async (page, expectedPart, label) => {
  const expected = normalizeLatex(expectedPart);
  await page.waitForFunction(
    (needle) => {
      const field = document.getElementById("block-math-input");
      if (!field || typeof field.getValue !== "function") {
        return false;
      }
      try {
        return String(field.getValue("latex") ?? "")
          .replace(/\s+/g, "")
          .includes(needle);
      } catch {
        return false;
      }
    },
    expected,
    { timeout: 10000 }
  );
  const actual = normalizeLatex(await getMathFieldLatex(page));
  assert.ok(actual.includes(expected), `${label}: latex mismatch\nexpected include ${expected}\nactual ${actual}`);
};

const waitForLatexStartsWith = async (page, expectedPrefix, label) => {
  const expected = normalizeLatex(expectedPrefix);
  await page.waitForFunction(
    (needle) => {
      const field = document.getElementById("block-math-input");
      if (!field || typeof field.getValue !== "function") {
        return false;
      }
      try {
        return String(field.getValue("latex") ?? "")
          .replace(/\s+/g, "")
          .startsWith(needle);
      } catch {
        return false;
      }
    },
    expected,
    { timeout: 10000 }
  );
  const actual = normalizeLatex(await getMathFieldLatex(page));
  assert.ok(
    actual.startsWith(expected),
    `${label}: latex mismatch\nexpected start ${expected}\nactual ${actual}`
  );
};

const waitForSuggestionsVisible = async (page) => {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      return Boolean(
        panel instanceof HTMLElement &&
          panel.getAttribute("aria-hidden") === "false" &&
          panel.querySelectorAll(".math-wysiwyg-item").length > 0
      );
    },
    undefined,
    { timeout: 10000 }
  );
};

const getSuggestionSnapshot = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!(panel instanceof HTMLElement) || panel.getAttribute("aria-hidden") !== "false") {
      return { items: [], activeIndex: -1 };
    }
    const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item")).map((item) => ({
      hint: (item.querySelector(".math-wysiwyg-label")?.textContent ?? "").trim(),
      active:
        item.classList.contains("is-active") || item.getAttribute("aria-selected") === "true",
    }));
    const activeIndex = items.findIndex((item) => item.active);
    return { items, activeIndex };
  });

const applySuggestionByHint = async (page, token, hint, options = {}) => {
  const explicit = options.explicit === true;
  await focusMathField(page);
  await page.keyboard.type(token, { delay: typeDelayMs });
  if (explicit) {
    await page.keyboard.press(explicitSuggestShortcut);
  }
  await waitForSuggestionsVisible(page);

  const initial = await getSuggestionSnapshot(page);
  const maxMoves = Math.max(1, initial.items.length + 2);
  for (let i = 0; i < maxMoves; i += 1) {
    const snapshot = await getSuggestionSnapshot(page);
    const activeHint =
      snapshot.activeIndex >= 0 ? snapshot.items[snapshot.activeIndex]?.hint ?? "" : "";
    if (activeHint === hint) {
      await page.keyboard.press("Enter");
      await pause(60);
      return;
    }
    await page.keyboard.press("ArrowDown");
    await pause(35);
  }

  const snapshot = await getSuggestionSnapshot(page);
  const hints = snapshot.items.map((item) => item.hint);
  throw new Error(
    `${token}: suggestion hint "${hint}" not selected. visible hints=[${hints.join(", ")}]`
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
    const placeholderCount = root.querySelectorAll(
      ".ML__placeholder, .ML__prompt, .ML__editablePromptBox"
    ).length;
    const errorCount = root.querySelectorAll(".ML__error").length;
    return { rawText, placeholderCount, errorCount };
  });

const assertRenderedOutput = async (page, label) => {
  const snapshot = await getRenderSnapshot(page);
  assert.ok(snapshot, `${label}: render snapshot is unavailable`);
  assert.equal(snapshot.errorCount, 0, `${label}: render has MathLive error node(s)`);
  assert.equal(snapshot.placeholderCount, 0, `${label}: placeholder remains in rendered output`);
  assert.ok(!snapshot.rawText.includes("\\"), `${label}: render still shows raw LaTeX slash`);
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
      try {
        await dialog.dismiss();
      } catch {
        // ignore close races
      }
    });

    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await page.waitForFunction(() => Boolean(window.MathLive?.convertLatexToMarkup), undefined, {
      timeout: 20000,
    });
    await openSideTab(page, "blocks");
    await waitForMathFieldReady(page);
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
      } catch {
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

const run = async () => {
  await runCase("[1/2] known command suggestions remain insertable", async (page) => {
    await clearMathField(page);
    await applySuggestionByHint(page, "cos", "cos");
    await waitForExactLatex(page, "\\cos", "known command suggestion");
    await assertRenderedOutput(page, "known command suggestion");
  });

  await runCase("[2/2] repeated trig suggestion keeps token boundaries intact", async (page) => {
    await clearMathField(page);
    await focusMathField(page);
    const applyFromCurrentCaret = async (token, hint) => {
      await page.keyboard.type(token, { delay: typeDelayMs });
      await waitForSuggestionsVisible(page);
      const initial = await getSuggestionSnapshot(page);
      const maxMoves = Math.max(1, initial.items.length + 2);
      for (let i = 0; i < maxMoves; i += 1) {
        const snapshot = await getSuggestionSnapshot(page);
        const activeHint =
          snapshot.activeIndex >= 0 ? snapshot.items[snapshot.activeIndex]?.hint ?? "" : "";
        if (activeHint === hint) {
          await page.keyboard.press("Enter");
          await pause(60);
          return;
        }
        await page.keyboard.press("ArrowDown");
        await pause(35);
      }
      const snapshot = await getSuggestionSnapshot(page);
      const hints = snapshot.items.map((item) => item.hint);
      throw new Error(`${token}: suggestion hint "${hint}" not selected. visible hints=[${hints.join(", ")}]`);
    };

    await applyFromCurrentCaret("cos", "cos");
    await waitForExactLatex(page, "\\cos", "first cos suggestion");
    await applyFromCurrentCaret("cos", "cos");
    await waitForExactLatex(page, "\\cos\\cos", "second cos suggestion");
    await assertRenderedOutput(page, "repeated cos suggestion");
  });

  log("math-wysiwyg command-fallback e2e passed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-command-fallback-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});

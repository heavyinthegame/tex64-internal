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
const triggerCatalogPath = path.join(repoRoot, "web-src", "app", "math-wysiwyg-triggers.ts");
const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "120", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "25", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "20", 10);
const isMac = process.platform === "darwin";
const explicitSuggestShortcut = isMac ? "Meta+." : "Control+.";
const selectAllShortcut = isMac ? "Meta+A" : "Control+A";
const catalogModeRaw = String(process.env.E2E_WYSIWYG_CATALOG_MODE ?? "auto")
  .trim()
  .toLowerCase();
const catalogMode = catalogModeRaw === "explicit" ? "explicit" : "auto";
if (catalogModeRaw && catalogModeRaw !== "auto" && catalogModeRaw !== "explicit") {
  throw new Error(`invalid E2E_WYSIWYG_CATALOG_MODE: ${catalogModeRaw}`);
}
const useExplicitSuggest = catalogMode === "explicit";
const MAX_FAILURES_TO_PRINT = 20;
const MAX_PLACEHOLDER_FILL_STEPS = 40;
const SESSION_LAUNCH_RETRIES = 3;

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-catalog-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const normalizeLatex = (value) => String(value ?? "").replace(/\s+/g, "");
const isClosedError = (error) =>
  /target page, context or browser has been closed/i.test(String(error ?? ""));

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

const readTriggerTokens = async () => {
  const source = await fs.readFile(triggerCatalogPath, "utf8");
  const seen = new Set();
  const tokens = [];
  for (const match of source.matchAll(/trigger:\s*"([^"\r\n]+)"/g)) {
    const token = String(match[1] ?? "").trim();
    if (!token) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-catalog-"));
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
  const selector = `button.tab[data-tab="${key}"]`;
  const tab = page.locator(selector);
  await tab.waitFor({ state: "visible", timeout: 12000 });
  try {
    await tab.click({ timeout: 5000 });
  } catch {
    await page.evaluate((query) => {
      const node = document.querySelector(query);
      if (node instanceof HTMLButtonElement) {
        node.click();
      }
    }, selector);
  }
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 12000,
  });
  await pause(60);
};

const ensureBlockSettingsSuggestionsReady = async (page) => {
  const ensurePressed = async (selector) => {
    const node = page.locator(selector);
    await node.waitFor({ state: "visible", timeout: 8000 });
    const current = await node.getAttribute("aria-pressed");
    if (current !== "true") {
      await node.click({ timeout: 4000 });
      await pause(50);
    }
    const next = await node.getAttribute("aria-pressed");
    assert.equal(next, "true", `${selector}: option did not become active`);
  };

  const settingsButton = page.locator("#block-settings-button");
  await settingsButton.waitFor({ state: "visible", timeout: 8000 });
  await settingsButton.click({ timeout: 4000 });
  await page.waitForSelector("#block-settings-modal[aria-hidden='false']", { timeout: 8000 });
  await page.click("[data-block-settings-target='suggestions']", { timeout: 4000 });
  await page.waitForSelector(".block-settings-page.is-active[data-block-settings-page='suggestions']", {
    timeout: 8000,
  });

  await ensurePressed("[data-wysiwyg-auto='on']");
  for (const pack of ["math", "physics", "cs", "personal", "jp"]) {
    await ensurePressed(`[data-wysiwyg-pack='${pack}']`);
  }

  await page.click("#block-settings-close", { timeout: 4000 });
  await page.waitForSelector("#block-settings-modal[aria-hidden='true']", { timeout: 8000 });
  await pause(60);
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
  await page.waitForFunction(
    () => {
      const active = document.activeElement;
      return active?.id === "block-math-input" || active?.closest?.("#block-math-input");
    },
    undefined,
    { timeout: 8000 }
  );
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

const getPlaceholderCount = async (page) =>
  page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!(field instanceof HTMLElement) || field.tagName.toLowerCase() !== "math-field") {
      return 0;
    }
    const root = field.shadowRoot;
    if (!(root instanceof ShadowRoot)) {
      return 0;
    }
    return root.querySelectorAll(".ML__placeholder, .ML__prompt, .ML__editablePromptBox").length;
  });

const clearMathField = async (page) => {
  await page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!field) {
      return;
    }
    if (typeof field.setValue === "function") {
      try {
        field.setValue("");
      } catch {
        // ignore and fallback to keyboard clear
      }
    }
    if (typeof field.executeCommand === "function") {
      try {
        field.executeCommand("deleteAll");
      } catch {
        // ignore and fallback to keyboard clear
      }
    }
  });
  if (!normalizeLatex(await getMathFieldLatex(page))) {
    return;
  }
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

const fillRemainingPlaceholders = async (page, token) => {
  await focusMathField(page);
  for (let step = 0; step < MAX_PLACEHOLDER_FILL_STEPS; step += 1) {
    const count = await getPlaceholderCount(page);
    if (count === 0) {
      return;
    }
    await page.keyboard.type("x", { delay: typeDelayMs });
    await pause(20);
    const afterInput = await getPlaceholderCount(page);
    if (afterInput === 0) {
      return;
    }
    await page.keyboard.press("Tab");
    await pause(20);
  }
  const count = await getPlaceholderCount(page);
  assert.equal(count, 0, `${token}: placeholder did not resolve`);
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

const assertRenderedOutput = async (page, label) => {
  const snapshot = await getRenderSnapshot(page);
  assert.ok(snapshot, `${label}: render snapshot is unavailable`);
  assert.equal(snapshot.errorCount, 0, `${label}: render has MathLive error node(s)`);
  assert.equal(snapshot.placeholderCount, 0, `${label}: placeholder remains in rendered output`);
  assert.ok(!snapshot.rawText.includes("\\"), `${label}: render still shows raw LaTeX slash`);
};

const waitForSuggestionVisible = async (page, hint) => {
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

const getSuggestionCount = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!(panel instanceof HTMLElement)) return 0;
    if (panel.getAttribute("aria-hidden") !== "false") return 0;
    return panel.querySelectorAll(".math-wysiwyg-item").length;
  });

const getSuggestionHints = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!(panel instanceof HTMLElement)) return [];
    if (panel.getAttribute("aria-hidden") !== "false") return [];
    return Array.from(panel.querySelectorAll(".math-wysiwyg-item .math-wysiwyg-label"))
      .map((node) => (node.textContent ?? "").trim().toLowerCase())
      .filter(Boolean);
  });

const getSuggestionSnapshot = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!(panel instanceof HTMLElement) || panel.getAttribute("aria-hidden") !== "false") {
      return { items: [], activeIndex: -1 };
    }
    const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item")).map((item) => ({
      hint: (item.querySelector(".math-wysiwyg-label")?.textContent ?? "").trim().toLowerCase(),
      active:
        item.classList.contains("is-active") || item.getAttribute("aria-selected") === "true",
    }));
    const activeIndex = items.findIndex((item) => item.active);
    return { items, activeIndex };
  });

const applySuggestionByToken = async (page, token) => {
  await clearMathField(page);
  await focusMathField(page);
  await page.keyboard.type(token, { delay: typeDelayMs });
  if (useExplicitSuggest) {
    await page.keyboard.press(explicitSuggestShortcut);
  }
  try {
    await waitForSuggestionVisible(page, token);
  } catch (error) {
    const hints = await getSuggestionHints(page);
    throw new Error(
      `${token}: ${catalogMode} suggestion hint not found; visible hints=[${hints.join(", ")}]`,
      { cause: error }
    );
  }
  const suggestionCount = await getSuggestionCount(page);
  assert.ok(suggestionCount > 0, `${token}: no suggestions shown`);
  const tokenKey = token.toLowerCase();
  const initial = await getSuggestionSnapshot(page);
  const maxMoves = Math.max(1, initial.items.length + 2);
  let matched = false;
  for (let i = 0; i < maxMoves; i += 1) {
    const snapshot = await getSuggestionSnapshot(page);
    const activeHint =
      snapshot.activeIndex >= 0 ? snapshot.items[snapshot.activeIndex]?.hint ?? "" : "";
    if (activeHint === tokenKey) {
      matched = true;
      break;
    }
    await page.keyboard.press("ArrowDown");
    await pause(35);
  }
  if (!matched) {
    const hints = (await getSuggestionSnapshot(page)).items.map((item) => item.hint);
    throw new Error(`${token}: intended suggestion not selected; visible hints=[${hints.join(", ")}]`);
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
  await pause(50);
};

const run = async () => {
  const triggerTokens = await readTriggerTokens();
  assert.ok(triggerTokens.length > 0, "no trigger tokens parsed");
  const startIndex = Math.max(
    0,
    Number.parseInt(process.env.E2E_WYSIWYG_TRIGGER_START ?? "0", 10) || 0
  );
  const requestedEnd = Number.parseInt(
    process.env.E2E_WYSIWYG_TRIGGER_END ?? String(triggerTokens.length),
    10
  );
  const endIndex = Math.max(startIndex, Math.min(triggerTokens.length, requestedEnd));
  const scopedTokens = triggerTokens.slice(startIndex, endIndex);
  assert.ok(scopedTokens.length > 0, "no scoped trigger tokens");
  log(
    `parsed trigger tokens: ${triggerTokens.length}, range: [${startIndex}, ${endIndex}), mode=${catalogMode}`
  );

  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  let session = null;

  const stopSession = async () => {
    if (!session?.electronApp) {
      session = null;
      return;
    }
    try {
      await Promise.race([
        session.electronApp.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("electronApp.close timeout")), 5000)
        ),
      ]);
    } catch (closeError) {
      log(`close fallback: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
      try {
        session.electronApp.process()?.kill("SIGKILL");
      } catch {
        // ignore force-kill failure
      }
    } finally {
      session = null;
      cleanupStaleElectron();
    }
  };

  const startSession = async () => {
    let launchError = null;
    for (let attempt = 0; attempt < SESSION_LAUNCH_RETRIES; attempt += 1) {
      try {
        cleanupStaleElectron();
        const electronApp = await electron.launch({
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
            // ignore protocol races
          }
        });
        await postToBridge(page, { type: "openRecentProject", path: workspacePath });
        await waitForWorkspaceReady(page);
        await page.waitForFunction(() => Boolean(window.MathLive?.convertLatexToMarkup), undefined, {
          timeout: 20000,
        });
        await openSideTab(page, "blocks");
        await ensureBlockSettingsSuggestionsReady(page);
        await waitForMathFieldReady(page);
        session = { electronApp, page };
        return;
      } catch (error) {
        launchError = error;
        cleanupStaleElectron();
        await pause(400);
      }
    }
    throw launchError ?? new Error("failed to launch session");
  };

  try {
    log(`workspace copy: ${workspacePath}`);
    await fs.mkdir(userDataPath, { recursive: true });
    await startSession();

    const failures = [];
    const page = session.page;
    for (let offset = 0; offset < scopedTokens.length; offset += 1) {
      const token = scopedTokens[offset];
      const absoluteIndex = startIndex + offset;
      if (page.isClosed()) {
        failures.push(`${token}: page closed before validation at index ${absoluteIndex}`);
        break;
      }
      try {
        await applySuggestionByToken(page, token);
        await fillRemainingPlaceholders(page, token);
        const latex = await getMathFieldLatex(page);
        assert.ok(normalizeLatex(latex).length > 0, `${token}: latex is empty after applying suggestion`);
        assert.ok(!latex.includes("#?"), `${token}: unresolved #? placeholder found`);
        await assertRenderedOutput(page, token);
      } catch (error) {
        failures.push(`${token}: ${error instanceof Error ? error.message : String(error)}`);
        if (isClosedError(error) || page.isClosed()) {
          break;
        }
      }
      if ((offset + 1) % 25 === 0 || offset + 1 === scopedTokens.length) {
        log(`progress ${offset + 1}/${scopedTokens.length}, failures=${failures.length}`);
      }
    }

    if (failures.length > 0) {
      const head = failures.slice(0, MAX_FAILURES_TO_PRINT).join("\n- ");
      throw new Error(
        `trigger coverage failures: ${failures.length}/${scopedTokens.length} in range [${startIndex}, ${endIndex})\n- ${head}`
      );
    }

    log("math-wysiwyg catalog e2e passed");
  } finally {
    await stopSession();
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log("workspace copy removed");
    } else {
      log(`workspace copy kept ${tempDir}`);
    }
  }
};

run().catch((error) => {
  console.error("[math-wysiwyg-catalog-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});

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
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "35", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);
const isMac = process.platform === "darwin";
const selectAllShortcut = isMac ? "Meta+A" : "Control+A";
const explicitSuggestShortcut = "Control+.";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-interactions-e2e ${now()}] ${message}`);
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-interactions-"));
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

const typeToken = async (page, token) => {
  await focusMathField(page);
  await page.keyboard.type(token, { delay: typeDelayMs });
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
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press(selectAllShortcut);
    await page.keyboard.press("Backspace");
    await pause(50);
    if (!normalizeLatex(await getMathFieldLatex(page))) {
      return;
    }
  }
  assert.equal(normalizeLatex(await getMathFieldLatex(page)), "", "failed to clear math-field");
};

const isSuggestionPanelVisible = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    return Boolean(
      panel instanceof HTMLElement &&
        panel.getAttribute("aria-hidden") === "false" &&
        panel.querySelectorAll(".math-wysiwyg-item").length > 0
    );
  });

const getSuggestionHints = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!(panel instanceof HTMLElement) || panel.getAttribute("aria-hidden") !== "false") {
      return [];
    }
    return Array.from(panel.querySelectorAll(".math-wysiwyg-item .math-wysiwyg-label"))
      .map((node) => (node.textContent ?? "").trim())
      .filter(Boolean);
  });

const getActiveSuggestionHint = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!(panel instanceof HTMLElement) || panel.getAttribute("aria-hidden") !== "false") {
      return "";
    }
    const active = panel.querySelector(".math-wysiwyg-item.is-active, .math-wysiwyg-item[aria-selected=\"true\"]");
    if (!(active instanceof HTMLElement)) {
      return "";
    }
    return (active.querySelector(".math-wysiwyg-label")?.textContent ?? "").trim();
  });

const waitForSuggestionVisible = async (page, hint) => {
  const expected = String(hint ?? "").trim().toLowerCase();
  await page.waitForFunction(
    (expectedHint) => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) return false;
      if (panel.getAttribute("aria-hidden") !== "false") return false;
      const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item"));
      if (items.length === 0) return false;
      if (!expectedHint) return true;
      return items.some((item) => {
        const label = (item.querySelector(".math-wysiwyg-label")?.textContent ?? "")
          .trim()
          .toLowerCase();
        return label === expectedHint;
      });
    },
    expected,
    { timeout: 10000 }
  );
};

const waitForSuggestionHidden = async (page) => {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) return true;
      return panel.getAttribute("aria-hidden") !== "false";
    },
    undefined,
    { timeout: 4000 }
  );
};

const openSuggestionsSettings = async (page) => {
  await page.click("#block-settings-button");
  await page.waitForFunction(() => {
    const modal = document.getElementById("block-settings-modal");
    return Boolean(modal?.classList.contains("is-open") && modal?.getAttribute("aria-hidden") === "false");
  });
  const navButton = page.locator('[data-block-settings-target="suggestions"]');
  if ((await navButton.count()) > 0) {
    await navButton.first().click();
  } else {
    await page.evaluate(() => {
      document
        .querySelectorAll(".block-settings-page")
        .forEach((node) => node.classList.remove("is-active"));
      const target = document.querySelector(
        '.block-settings-page[data-block-settings-page="suggestions"]'
      );
      target?.classList.add("is-active");
    });
  }
  await page.waitForSelector('.block-settings-page.is-active[data-block-settings-page="suggestions"]', {
    timeout: 5000,
  });
};

const closeSettingsModal = async (page) => {
  await page.click("#block-settings-close");
  await page.waitForFunction(() => {
    const modal = document.getElementById("block-settings-modal");
    return Boolean(!modal?.classList.contains("is-open") && modal?.getAttribute("aria-hidden") === "true");
  });
};

const setAutoSuggest = async (page, enabled) => {
  const selector = enabled ? '[data-wysiwyg-auto="on"]' : '[data-wysiwyg-auto="off"]';
  const button = page.locator(selector);
  await button.click();
  await page.waitForFunction(
    ({ targetSelector }) => {
      const target = document.querySelector(targetSelector);
      return Boolean(target instanceof HTMLElement && target.classList.contains("is-active"));
    },
    { targetSelector: selector },
    { timeout: 3000 }
  );
};

const setPackEnabled = async (page, packId, enabled) => {
  const selector = `[data-wysiwyg-pack="${packId}"]`;
  const isActive = await page.evaluate((query) => {
    const node = document.querySelector(query);
    return Boolean(node instanceof HTMLElement && node.classList.contains("is-active"));
  }, selector);
  if (isActive !== enabled) {
    await page.click(selector);
  }
  await page.waitForFunction(
    ({ query, expected }) => {
      const node = document.querySelector(query);
      return Boolean(
        node instanceof HTMLElement &&
          node.classList.contains("is-active") === expected &&
          node.getAttribute("aria-pressed") === (expected ? "true" : "false")
      );
    },
    { query: selector, expected: enabled },
    { timeout: 3000 }
  );
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
        const latex = String(field.getValue("latex") ?? "").replace(/\s+/g, "");
        return latex.includes(needle);
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

const waitForExactLatex = async (page, expected, label) => {
  const normalized = normalizeLatex(expected);
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
    normalized,
    { timeout: 6000 }
  );
  const actual = normalizeLatex(await getMathFieldLatex(page));
  assert.equal(actual, normalized, `${label}: latex mismatch\nexpected ${normalized}\nactual ${actual}`);
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
  await runCase("[1/8] explicit shortcut works with autoSuggest off", async (page) => {
    await openSuggestionsSettings(page);
    await setAutoSuggest(page, false);
    await closeSettingsModal(page);

    await typeToken(page, "sin");
    await pause(250);
    assert.equal(await isSuggestionPanelVisible(page), false, "autoSuggest off should keep panel hidden");

    await page.keyboard.press(explicitSuggestShortcut);
    await waitForSuggestionVisible(page, "sin");
    await page.keyboard.press("Enter");
    await waitForLatexIncludes(page, "\\sin", "explicit shortcut apply");
  });

  await runCase("[2/8] ArrowDown + Enter applies non-default candidate", async (page) => {
    await typeToken(page, "int");
    await waitForSuggestionVisible(page, "int");
    await page.keyboard.press("ArrowDown");
    await pause(70);
    await page.keyboard.press("Enter");
    await waitForLatexIncludes(page, "\\mathrm{d}", "non-default int candidate");
  });

  await runCase("[3/8] Tab keeps placeholder navigation even when suggestions are open", async (page) => {
    await typeToken(page, "frac");
    await waitForSuggestionVisible(page, "frac");
    await page.keyboard.press("Enter");
    await pause(90);

    await page.keyboard.type("a", { delay: typeDelayMs });
    await page.keyboard.press(explicitSuggestShortcut);
    await page.waitForFunction(
      () => {
        const panel = document.querySelector(".math-wysiwyg-panel");
        if (!(panel instanceof HTMLElement)) return false;
        if (panel.getAttribute("aria-hidden") !== "false") return false;
        return panel.querySelectorAll(".math-wysiwyg-item").length > 0;
      },
      undefined,
      { timeout: 10000 }
    );
    const defaultHint = await getActiveSuggestionHint(page);
    assert.ok(defaultHint, "suggestion should be visible before Tab");

    await page.keyboard.press("Tab");
    await page.keyboard.type("b", { delay: typeDelayMs });
    await page.keyboard.press("Escape");

    const latex = normalizeLatex(await getMathFieldLatex(page));
    assert.equal(
      latex,
      normalizeLatex("\\frac{a}{b}"),
      `Tab should not hijack placeholder navigation while suggestion panel is open: ${latex}`
    );
  });

  await runCase("[4/8] Escape closes suggestion panel", async (page) => {
    await typeToken(page, "log");
    await waitForSuggestionVisible(page, "log");
    await page.keyboard.press("Escape");
    await waitForSuggestionHidden(page);
    assert.equal(await isSuggestionPanelVisible(page), false, "Escape should close panel");
  });

  await runCase("[5/8] backslash direct input is blocked and unknown token stays literal", async (page) => {
    await clearMathField(page);
    await focusMathField(page);

    await page.keyboard.press("Backslash");
    await pause(120);
    await waitForExactLatex(page, "", "backslash should not insert raw token");
    assert.equal(await isSuggestionPanelVisible(page), true, "backslash should open suggestion panel");

    await page.keyboard.press("Escape");
    await waitForSuggestionHidden(page);
    await clearMathField(page);
    await focusMathField(page);

    const rawCommandToken = "qxzvjk";
    await page.keyboard.type(rawCommandToken, { delay: typeDelayMs });
    await page.keyboard.press(explicitSuggestShortcut);
    await pause(160);
    const hints = await getSuggestionHints(page);
    assert.equal(
      hints.includes("入力コマンド"),
      false,
      `raw command hint should not appear: [${hints.join(", ")}]`
    );
    assert.equal(
      await isSuggestionPanelVisible(page),
      false,
      "unknown token should not keep suggestion panel open"
    );
    await waitForExactLatex(page, rawCommandToken, "unknown token should stay literal");
  });

  await runCase("[6/8] Tab and Shift+Tab move placeholders", async (page) => {
    await typeToken(page, "frac");
    await waitForSuggestionVisible(page, "frac");
    await page.keyboard.press("Enter");
    await pause(120);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.type("a", { delay: typeDelayMs });
    await page.keyboard.press("Tab");
    await page.keyboard.type("b", { delay: typeDelayMs });
    const latex = normalizeLatex(await getMathFieldLatex(page));
    assert.equal(latex, normalizeLatex("\\frac{a}{b}"), `placeholder navigation failed: ${latex}`);
  });

  await runCase("[7/8] math pack toggle affects auto-suggest", async (page) => {
    await openSuggestionsSettings(page);
    await setAutoSuggest(page, true);
    await setPackEnabled(page, "math", false);
    await closeSettingsModal(page);

    await typeToken(page, "min");
    await pause(180);
    const hintsWhenPackOff = (await getSuggestionHints(page)).map((hint) => hint.toLowerCase());
    assert.equal(
      hintsWhenPackOff.includes("min"),
      false,
      "math pack off should hide 'min' trigger candidates"
    );
    assert.equal(
      hintsWhenPackOff.includes("入力コマンド"),
      false,
      "raw command fallback should not appear when pack candidates are unavailable"
    );
    assert.equal(
      await isSuggestionPanelVisible(page),
      false,
      "math pack off should not keep panel open for unknown token-only match"
    );

    await clearMathField(page);
    await openSuggestionsSettings(page);
    await setPackEnabled(page, "math", true);
    await closeSettingsModal(page);

    await typeToken(page, "min");
    await waitForSuggestionVisible(page, "min");
  });

  await runCase("[8/8] text-like wrapper arguments suppress auto-suggest while typing", async (page) => {
    const wrappers = [
      { token: "rm", hint: "rm", expected: "\\mathrm{" },
      { token: "op", hint: "op", expected: "\\operatorname{" },
      { token: "sf", hint: "sf", expected: "\\mathsf{" },
    ];
    for (const wrapper of wrappers) {
      await clearMathField(page);
      await typeToken(page, wrapper.token);
      await waitForSuggestionVisible(page, wrapper.hint);
      await page.keyboard.press("Enter");
      await waitForLatexIncludes(page, wrapper.expected, `${wrapper.token} wrapper inserted`);
      await page.keyboard.type("sin", { delay: typeDelayMs });
      await pause(220);
      assert.equal(
        await isSuggestionPanelVisible(page),
        false,
        `suggestions should stay hidden inside ${wrapper.token} wrapper`
      );
      await page.keyboard.press("Escape");
      await pause(40);
    }

    await clearMathField(page);
    await typeToken(page, "argmax");
    await waitForSuggestionVisible(page, "argmax");
    await page.keyboard.press("Enter");
    await waitForLatexIncludes(page, "\\operatorname*{", "argmax inserted");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("sin", { delay: typeDelayMs });
    await pause(220);
    assert.equal(
      await isSuggestionPanelVisible(page),
      false,
      "suggestions should stay hidden while editing operatorname* text"
    );
  });

  log("math-wysiwyg interactions e2e passed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-interactions-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});

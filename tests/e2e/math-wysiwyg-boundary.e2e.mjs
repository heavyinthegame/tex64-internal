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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "140", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "35", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "25", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-boundary-e2e ${now()}] ${message}`);
};
const selectedBoundaryCaseRaw = String(process.env.E2E_BOUNDARY_CASE ?? "").trim();
const selectedBoundaryCase = (() => {
  if (!selectedBoundaryCaseRaw) {
    return null;
  }
  const parsed = Number.parseInt(selectedBoundaryCaseRaw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 9) {
    throw new Error(`invalid E2E_BOUNDARY_CASE: ${selectedBoundaryCaseRaw}`);
  }
  return parsed;
})();
const shouldRunBoundaryCase = (index) =>
  selectedBoundaryCase === null || Number(index) === selectedBoundaryCase;

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const allowE2EQuit = async (app) => {
  if (!app) {
    return;
  }
  await app
    .evaluate(() => {
      global.__tex64E2EAllowQuit = true;
    })
    .catch(() => {});
};

const installE2EQuitGuard = async (app) => {
  if (!app) {
    return;
  }
  await app
    .evaluate(({ app: electronApp }) => {
      if (global.__tex64E2EQuitGuardInstalled === true) {
        return;
      }
      global.__tex64E2EQuitGuardInstalled = true;
      global.__tex64E2EAllowQuit = false;
      electronApp.on("before-quit", (event) => {
        if (global.__tex64E2EAllowQuit !== true) {
          event.preventDefault();
        }
      });
      process.on("SIGTERM", () => {
        if (global.__tex64E2EAllowQuit === true) {
          process.exit(0);
        }
      });
    })
    .catch(() => {});
};

const normalizeLatex = (value) => String(value ?? "").replace(/\s+/g, "");

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

const isTransientElectronError = (error) => {
  const message = error?.message ?? String(error);
  return (
    message.includes("Process failed to launch") ||
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Target closed")
  );
};

const launchElectronWithRetry = async (userDataPath, label) => {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      cleanupStaleElectron();
      await pause(120);
      const app = await electron.launch({
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
      await installE2EQuitGuard(app);
      return app;
    } catch (error) {
      lastError = error;
      if (!isTransientElectronError(error) || attempt >= 5) {
        throw error;
      }
      log(
        `${label}: transient launch error, retrying (${attempt}/5): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      // Give Playwright/Electron process teardown a moment before relaunch.
      await pause(300);
    }
  }
  throw lastError;
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-boundary-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const writeDetectionFixture = async (workspacePath) => {
  const fixturePath = path.join(workspacePath, "sections", "blocks-detection-fixture.tex");
  const fixtureContent = `\\section{Blocks Detection Fixture}
% $comment_math + 1$
Inline math: $x + y$.
\\begin{verbatim}
$verbatim_math$
\\end{verbatim}
\\begin{custombox}
  a + b = c
\\end{custombox}
\\begin{equationbox}
  p + q = r
\\end{equationbox}
`;
  await fs.writeFile(fixturePath, fixtureContent, "utf8");
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

const openSettingsPage = async (page, pageId) => {
  await openSideTab(page, "settings");
  await page.waitForSelector("#settings-panel", { timeout: 10000 });

  const alreadyOpen = await page
    .locator(`.settings-page[data-settings-page="${pageId}"].is-active`)
    .count();
  if (alreadyOpen > 0) {
    return;
  }

  const navSelector = `button.settings-nav-item[data-settings-target="${pageId}"]`;
  const navVisible = await page.locator(navSelector).isVisible().catch(() => false);
  if (!navVisible) {
    const clickedBack = await page.evaluate(() => {
      const activePage = document.querySelector(".settings-page.is-active");
      const backButton = activePage?.querySelector("button.settings-back[data-settings-back]");
      if (backButton instanceof HTMLButtonElement) {
        backButton.click();
        return true;
      }
      return false;
    });
    if (clickedBack) {
      await pause(120);
    }
  }

  await page.evaluate((selector) => {
    const button = document.querySelector(selector);
    if (button instanceof HTMLButtonElement) {
      button.click();
    }
  }, navSelector);

  await page.waitForSelector(`.settings-page[data-settings-page="${pageId}"].is-active`, {
    timeout: 10000,
  });
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

const applySuggestionByTyping = async (page, token, options = {}) => {
  const pickIndex = Number.isFinite(options.pickIndex) ? Math.max(0, options.pickIndex) : 0;
  await focusMathField(page);
  await page.keyboard.type(token, { delay: typeDelayMs });
  await waitForSuggestionVisible(page, token);
  for (let i = 0; i < pickIndex; i += 1) {
    await page.keyboard.press("ArrowDown");
    await pause(30);
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

const waitForIssueMessage = async (page, needle) => {
  const expected = String(needle ?? "").trim().toLowerCase();
  await page.waitForFunction(
    (messageNeedle) =>
      Array.from(document.querySelectorAll("#issues-list .issue-message")).some((node) =>
        (node.textContent ?? "").toLowerCase().includes(messageNeedle)
      ),
    expected,
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
  await pause(80);
};

const waitForMathLatexNormalized = async (page, expectedNormalized, label) => {
  await page.waitForFunction(
    (expected) => {
      const field = document.getElementById("block-math-input");
      if (!field || typeof field.getValue !== "function") return false;
      try {
        const latex = String(field.getValue("latex") ?? "").replace(/\s+/g, "");
        return latex === expected;
      } catch {
        return false;
      }
    },
    expectedNormalized,
    { timeout: 10000 }
  );
  const actual = normalizeLatex(await getMathFieldLatex(page));
  assert.equal(actual, expectedNormalized, `${label}: latex mismatch\nactual=${actual}`);
};

const waitForMathLatexShape = async (page, options) => {
  const tokenGroups = Array.isArray(options?.includes)
    ? options.includes
        .map((group) => (Array.isArray(group) ? group : [group]))
        .map((group) =>
          group.map((value) => String(value ?? "").replace(/\s+/g, "")).filter(Boolean)
        )
        .filter((group) => group.length > 0)
    : [];
  const minLength = Number.isFinite(options?.minLength) ? Math.max(0, options.minLength) : 0;
  const label = String(options?.label ?? "math latex shape");

  try {
    await page.waitForFunction(
      ({ expectedTokenGroups, expectedLength }) => {
        const field = document.getElementById("block-math-input");
        if (!field || typeof field.getValue !== "function") return false;
        try {
          const latex = String(field.getValue("latex") ?? "").replace(/\s+/g, "");
          if (latex.includes("#?")) return false;
          if (latex.length < expectedLength) return false;
          return expectedTokenGroups.every((group) => group.some((token) => latex.includes(token)));
        } catch {
          return false;
        }
      },
      { expectedTokenGroups: tokenGroups, expectedLength: minLength },
      { timeout: 12000 }
    );
  } catch (error) {
    const actualLatex = normalizeLatex(await getMathFieldLatex(page));
    throw new Error(
      `${label}: timed out waiting latex shape\nexpected tokens=${tokenGroups
        .map((group) => group.join("|"))
        .join(",")}\nactual=${actualLatex}`,
      { cause: error }
    );
  }

  const actual = normalizeLatex(await getMathFieldLatex(page));
  assert.ok(!actual.includes("#?"), `${label}: unresolved placeholder token remains\nactual=${actual}`);
  assert.ok(actual.length >= minLength, `${label}: formula is too short\nactual=${actual}`);
  tokenGroups.forEach((group) => {
    assert.ok(
      group.some((token) => actual.includes(token)),
      `${label}: expected token missing (${group.join("|")})\nactual=${actual}`
    );
  });
};

const getMathRenderSnapshot = async (page) =>
  page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!(field instanceof HTMLElement) || field.tagName.toLowerCase() !== "math-field") {
      return null;
    }
    const root = field.shadowRoot;
    if (!(root instanceof ShadowRoot)) {
      return null;
    }
    return {
      placeholderCount: root.querySelectorAll(".ML__placeholder, .ML__prompt, .ML__editablePromptBox")
        .length,
      errorCount: root.querySelectorAll(".ML__error").length,
      rawText: (root.querySelector(".ML__latex")?.textContent ?? root.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    };
  });

const assertMathRenderStable = async (page, label) => {
  const snapshot = await getMathRenderSnapshot(page);
  assert.ok(snapshot, `${label}: render snapshot is unavailable`);
  assert.equal(snapshot.errorCount, 0, `${label}: render has MathLive error node(s)`);
  assert.equal(snapshot.placeholderCount, 0, `${label}: placeholder remains in rendered output`);
  assert.ok(!snapshot.rawText.includes("\\"), `${label}: render still shows raw LaTeX slash`);
};

const waitForMathInputEmpty = async (page, label) => {
  await page.waitForFunction(
    () => {
      const field = document.getElementById("block-math-input");
      if (!field || typeof field.getValue !== "function") return false;
      try {
        const latex = String(field.getValue("latex") ?? "").replace(/\s+/g, "");
        return latex === "";
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 10000 }
  );
  const actual = normalizeLatex(await getMathFieldLatex(page));
  assert.equal(actual, "", `${label}: math input expected empty`);
};

const waitForAutoDetectedUiState = async (page, enabled) => {
  await page.waitForFunction(
    (expected) => {
      const body = document.querySelector('.panel[data-panel="blocks"] .blocks-panel');
      if (!(body instanceof HTMLElement)) {
        return false;
      }
      return body.classList.contains("is-auto-detected") === expected;
    },
    enabled,
    { timeout: 10000 }
  );
};

const waitForDetectedDecorationState = async (page, expected) => {
  await page.waitForFunction(
    (state) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      const model = active?.getModel?.();
      if (!model || typeof model.getAllDecorations !== "function") {
        return false;
      }
      const decorations = model.getAllDecorations();
      const hasInline = decorations.some(
        (decoration) => decoration?.options?.inlineClassName === "detected-block-highlight"
      );
      const hasGlyph = decorations.some(
        (decoration) => decoration?.options?.glyphMarginClassName === "detected-block-glyph"
      );
      return hasInline === state.inline && hasGlyph === state.glyph;
    },
    expected,
    { timeout: 10000 }
  );
};

const waitForMathKeyboardHidden = async (page) => {
  await page.waitForFunction(
    () => {
      const dock = document.getElementById("math-keyboard-dock");
      if (!(dock instanceof HTMLElement)) return false;
      return dock.getAttribute("aria-hidden") === "true" && !dock.classList.contains("is-open");
    },
    undefined,
    { timeout: 10000 }
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

const waitForModalState = async (page, id, open) => {
  await page.waitForFunction(
    ({ modalId, shouldOpen }) => {
      const modal = document.getElementById(modalId);
      if (!(modal instanceof HTMLElement)) return false;
      const isOpen = modal.classList.contains("is-open");
      const aria = modal.getAttribute("aria-hidden");
      return isOpen === shouldOpen && aria === (shouldOpen ? "false" : "true");
    },
    { modalId: id, shouldOpen: open },
    { timeout: 10000 }
  );
};

const readActiveEditorValue = async (page) =>
  page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    return String(active?.getModel?.()?.getValue?.() ?? "");
  });

const waitEditorContains = async (page, needle) => {
  const candidates = (Array.isArray(needle) ? needle : [needle])
    .map((value) => String(value ?? ""))
    .filter(Boolean);
  assert.ok(candidates.length > 0, "waitEditorContains requires at least one needle");
  await page.waitForFunction(
    (expectedList) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      const text = String(active?.getModel?.()?.getValue?.() ?? "");
      return expectedList.some((expected) => text.includes(expected));
    },
    candidates,
    { timeout: 15000 }
  );
};

const waitForTabDirtyState = async (page, filePath, expectedDirty) => {
  await page.waitForFunction(
    ({ path, expected }) => {
      const selectors = [
        `#editor-tabs-list .editor-tab[data-path="${path}"]`,
        `#editor-tabs-list-secondary .editor-tab[data-path="${path}"]`,
      ];
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (!(node instanceof HTMLElement)) continue;
        return node.classList.contains("is-dirty") === expected;
      }
      return false;
    },
    { path: filePath, expected: expectedDirty },
    { timeout: 10000 }
  );
};

const saveActiveFileViaBridge = async (page, filePath) => {
  const content = await readActiveEditorValue(page);
  await postToBridge(page, {
    type: "saveFile",
    path: filePath,
    content,
    format: false,
    formatSource: "save",
  });
};

const installBridgeIncomingSpy = async (page) => {
  const installed = await page.evaluate(() => {
    if ((window).__tex64IncomingSpyInstalled) {
      return true;
    }
    const bridge = window.tex64Bridge;
    if (!bridge || typeof bridge.onMessage !== "function") {
      return false;
    }
    const messages = [];
    const unsubscribe = bridge.onMessage((message) => {
      messages.push(message);
    });
    (window).__tex64IncomingSpyInstalled = true;
    (window).__tex64IncomingMessages = messages;
    (window).__tex64IncomingUnsubscribe = unsubscribe;
    return true;
  });
  assert.equal(installed, true, "failed to install tex64Bridge incoming spy");
};

const waitForIncomingBridgeMessage = async (page, expected) => {
  await page.waitForFunction(
    (criteria) => {
      const list = (window).__tex64IncomingMessages;
      if (!Array.isArray(list)) {
        return false;
      }
      return list.some((message) => {
        if (!message || message.type !== criteria.type) {
          return false;
        }
        const payload = message.payload ?? null;
        if (typeof criteria.source === "string" && payload?.source !== criteria.source) {
          return false;
        }
        return true;
      });
    },
    expected,
    { timeout: 10000 }
  );
};

const addEnvRegistryEntry = async (page, name, kind) => {
  await openSettingsPage(page, "env");
  await page.fill("#env-registry-input", name);
  await page.selectOption("#env-registry-kind", kind);
  await page.click("#env-registry-add");
  await page.waitForSelector(
    `#env-registry-${kind} .env-registry-row[data-env-name="${name}"][data-env-kind="${kind}"]`,
    { timeout: 10000 }
  );
};

const removeEnvRegistryEntry = async (page, name, kind) => {
  await openSettingsPage(page, "env");
  await page.evaluate(
    ({ envName, envKind }) => {
      const button = document.querySelector(
        `#env-registry-${envKind} .env-registry-remove[data-env-name="${envName}"][data-env-kind="${envKind}"]`
      );
      if (button instanceof HTMLButtonElement) {
        button.click();
      }
    },
    { envName: name, envKind: kind }
  );
  await page.waitForFunction(
    ({ envName, envKind }) => {
      const row = document.querySelector(
        `#env-registry-${envKind} .env-registry-row[data-env-name="${envName}"][data-env-kind="${envKind}"]`
      );
      return !(row instanceof HTMLElement);
    },
    { envName: name, envKind: kind },
    { timeout: 10000 }
  );
};

const runCase = async (label, test, options = {}) => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  let electronApp;

  try {
    await options.prepareWorkspace?.(workspacePath);
    log(`${label}: workspace copy ${workspacePath}`);
    await fs.mkdir(userDataPath, { recursive: true });
    electronApp = await launchElectronWithRetry(userDataPath, label);

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
    await test(page, { workspacePath });
    log(`${label}: passed`);
  } finally {
    if (electronApp) {
      try {
        await allowE2EQuit(electronApp);
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
  if (shouldRunBoundaryCase(1)) {
    await runCase(
      "[1/9] non-tex blocks are rejected before diff",
      async (page) => {
        await openFile(page, "notes/block-non-tex.txt");
        await openSideTab(page, "blocks");
        await waitForMathFieldReady(page);
        await focusMathField(page);
        await page.keyboard.type("x+1", { delay: typeDelayMs });
        await page.click("#block-insert-button");
        await waitForIssueMessage(page, ".tex ファイルでのみ挿入できます");
        await waitForDiffModalState(page, false);

        await page.click("#block-mode-toggle");
        await waitForBlockMode(page, "insert");
      },
      {
        prepareWorkspace: async (workspacePath) => {
          const target = path.join(workspacePath, "notes", "block-non-tex.txt");
          await fs.writeFile(target, "Plain text for non-tex blocks test.\n", "utf8");
        },
      }
    );
  }

  if (shouldRunBoundaryCase(2)) {
    await runCase(
      "[2/9] auto detection excludes comment/verbatim and highlights detected blocks",
      async (page) => {
        await openFile(page, "sections/blocks-detection-fixture.tex");
        await openSideTab(page, "blocks");
        await waitForMathFieldReady(page);
        await setBlockMode(page, "edit");

        await setEditorCursor(page, 2, 8);
        await waitForMathInputEmpty(page, "comment exclusion");
        await waitForAutoDetectedUiState(page, false);
        await waitForDetectedDecorationState(page, { inline: false, glyph: false });

        await setEditorCursor(page, 3, 16);
        await waitForMathLatexNormalized(page, "x+y", "inline detection");
        await waitForAutoDetectedUiState(page, true);
        await waitForDetectedDecorationState(page, { inline: true, glyph: true });

        await setEditorCursor(page, 5, 3);
        await waitForMathInputEmpty(page, "verbatim exclusion");
        await waitForAutoDetectedUiState(page, false);
        await waitForDetectedDecorationState(page, { inline: false, glyph: false });

        await setEditorCursor(page, 11, 4);
        await waitForMathLatexNormalized(page, "p+q=r", "heuristic env detection");
        await waitForAutoDetectedUiState(page, true);
        await waitForDetectedDecorationState(page, { inline: true, glyph: true });
        await setBlockMode(page, "insert");
      },
      {
        prepareWorkspace: async (workspacePath) => {
          await writeDetectionFixture(workspacePath);
        },
      }
    );
  }

  if (shouldRunBoundaryCase(3)) {
    await runCase(
      "[3/9] env registry table/math classification switches detection",
      async (page) => {
        await openFile(page, "sections/blocks-detection-fixture.tex");
        await openSideTab(page, "blocks");
        await waitForMathFieldReady(page);
        await setBlockMode(page, "edit");

        await setEditorCursor(page, 8, 5);
        await waitForMathInputEmpty(page, "custom env before registry");
        await waitForAutoDetectedUiState(page, false);

        await addEnvRegistryEntry(page, "custombox", "table");
        await openSideTab(page, "blocks");
        await waitForMathFieldReady(page);
        await setBlockMode(page, "edit");
        await setEditorCursor(page, 8, 5);
        await waitForMathInputEmpty(page, "custom env registered as table");
        await waitForAutoDetectedUiState(page, false);

        await removeEnvRegistryEntry(page, "custombox", "table");
        await addEnvRegistryEntry(page, "custombox", "math");
        await openSideTab(page, "blocks");
        await waitForMathFieldReady(page);
        await setBlockMode(page, "edit");
        await setEditorCursor(page, 8, 5);
        await waitForMathLatexNormalized(page, "a+b=c", "custom env registered as math");
        await waitForAutoDetectedUiState(page, true);
        await setBlockMode(page, "insert");
      },
      {
        prepareWorkspace: async (workspacePath) => {
          await writeDetectionFixture(workspacePath);
        },
      }
    );
  }

  if (shouldRunBoundaryCase(4)) {
    await runCase("[4/9] edit detection sync + Escape", async (page) => {
      await openFile(page, "sections/blocks.tex");
      await openSideTab(page, "blocks");
      await waitForMathFieldReady(page);

      await setEditorCursor(page, 2, 20);
      await setBlockMode(page, "edit");
      await waitForMathLatexNormalized(page, "a^2+b^2=c^2", "inline detection");

      await setEditorCursor(page, 36, 5);
      await waitForMathInputEmpty(page, "verbatim line in blocks.tex");

      await page.keyboard.press("Escape");
      await waitForBlockMode(page, "insert");
    });
  }

  if (shouldRunBoundaryCase(5)) {
    await runCase("[5/9] capture button opens picker and cropper flow", async (page) => {
      await openFile(page, "sections/blocks.tex");
      await openSideTab(page, "blocks");
      await waitForMathFieldReady(page);
      await page.evaluate(() => {
        (window).__tex64TestCaptureApi = {
          listSources: async () => [
            {
              id: "window:mock-capture",
              title: "Mock Capture",
              app: "Mock",
              thumbnailUrl:
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+YAAAAABJRU5ErkJggg==",
              width: 1,
              height: 1,
            },
          ],
        };
      });

      await page.click("#block-capture-button");
      await waitForModalState(page, "math-capture-window-modal", true);
      await page.click('.capture-window-item[data-id="window:mock-capture"]');
      await waitForModalState(page, "math-capture-window-modal", false);
      await waitForModalState(page, "math-capture-crop-modal", true);
      await page.click("#math-capture-crop-retry");
      await waitForModalState(page, "math-capture-crop-modal", false);
    });
  }

  if (shouldRunBoundaryCase(6)) {
    await runCase(
      "[6/9] diff submit applies insert, requests format, and appends blocks history",
      async (page, { workspacePath }) => {
        await openFile(page, "sections/blocks.tex");
        await openSideTab(page, "blocks");
        await waitForMathFieldReady(page);
        await installBridgeIncomingSpy(page);

        await setEditorCursor(page, 34, 1);
        const before = await readActiveEditorValue(page);

        await applySuggestionByTyping(page, "argmax", { pickIndex: 0 });
        await waitForMathLatexNormalized(page, "\\operatorname*{arg\\,max}", "argmax draft");

        await page.click("#block-insert-button");
        await waitForDiffModalState(page, true);
        await page.click("#diff-modal-submit");
        await waitForDiffModalState(page, false);

        await waitForIncomingBridgeMessage(page, {
          type: "formatResult",
          source: "blockInsert",
        });
        await waitEditorContains(page, "\\operatorname*{arg\\,max}");
        const after = await readActiveEditorValue(page);
        assert.notEqual(after, before, "editor content did not change after diff submit");

        const blocksHistoryPath = path.join(workspacePath, ".tex64", "blocks.json");
        let history = null;
        for (let i = 0; i < 40; i += 1) {
          try {
            const raw = await fs.readFile(blocksHistoryPath, "utf8");
            history = JSON.parse(raw);
            if (Array.isArray(history) && history.length >= 2) {
              break;
            }
          } catch {
            // wait for async write
          }
          // eslint-disable-next-line no-await-in-loop
          await pause(80);
        }
        assert.ok(Array.isArray(history), "blocks history was not created");
        assert.equal(history.length, 2, "blocks history should append one entry");
        assert.equal(history[0]?.snippet, "seed");
        assert.equal(history[0]?.mode, "seed");
        const latest = history[history.length - 1];
        assert.equal(latest?.file, "sections/blocks.tex");
        assert.equal(latest?.mode, "new");
        assert.ok(
          String(latest?.snippet ?? "").includes("\\operatorname*{arg\\,max}"),
          "latest blocks history entry does not contain inserted snippet"
        );
        assert.ok(
          typeof latest?.createdAt === "string" && latest.createdAt.length > 0,
          "latest blocks history entry missing createdAt"
        );

        await waitForTabDirtyState(page, "sections/blocks.tex", true);
        await saveActiveFileViaBridge(page, "sections/blocks.tex");
        await waitForTabDirtyState(page, "sections/blocks.tex", false);
      },
      {
        prepareWorkspace: async (workspacePath) => {
          const tex64Dir = path.join(workspacePath, ".tex64");
          await fs.mkdir(tex64Dir, { recursive: true });
          await fs.writeFile(
            path.join(tex64Dir, "blocks.json"),
            JSON.stringify(
              [{ snippet: "seed", mode: "seed", createdAt: "2000-01-01T00:00:00.000Z" }],
              null,
              2
            ),
            "utf8"
          );
        },
      }
    );
  }

  if (shouldRunBoundaryCase(7)) {
    await runCase("[7/9] math keyboard dock stays hidden in all block states", async (page) => {
      await openFile(page, "sections/blocks.tex");
      await openSideTab(page, "blocks");
      await waitForMathFieldReady(page);
      await waitForMathKeyboardHidden(page);

      await setEditorCursor(page, 2, 20);
      await setBlockMode(page, "edit");
      await waitForMathLatexNormalized(page, "a^2+b^2=c^2", "edit mode math detection");
      await waitForMathKeyboardHidden(page);

      await setBlockMode(page, "insert");
      await waitForMathKeyboardHidden(page);
    });
  }

  if (shouldRunBoundaryCase(8)) {
    await runCase("[8/9] Gaussian integral is authored via UI and applied through diff", async (page) => {
      await openFile(page, "sections/blocks.tex");
      await openSideTab(page, "blocks");
      await waitForMathFieldReady(page);
      await installBridgeIncomingSpy(page);

      await setEditorCursor(page, 34, 1);
      const before = await readActiveEditorValue(page);

      await page.keyboard.type("I=", { delay: typeDelayMs });
      await applySuggestionByTyping(page, "int", { pickIndex: 0 });
      await page.keyboard.type("(-∞→∞) e^(-x^2) dx = √π", { delay: typeDelayMs });

      await waitForMathLatexShape(page, {
        includes: [
          "\\int",
          "\\infty",
          "e^",
          "x^2",
          "dx",
          ["\\sqrt", "\\surd"],
          "\\pi",
        ],
        minLength: 20,
        label: "gaussian integral composition",
      });
      await assertMathRenderStable(page, "gaussian integral composition");

      await page.click("#block-insert-button");
      await waitForDiffModalState(page, true);
      await page.click("#diff-modal-submit");
      await waitForDiffModalState(page, false);

      await waitForIncomingBridgeMessage(page, {
        type: "formatResult",
        source: "blockInsert",
      });
      await waitEditorContains(page, "\\int");
      await waitEditorContains(page, "\\infty");
      await waitEditorContains(page, ["\\sqrt", "\\surd"]);
      await waitEditorContains(page, "\\pi");
      const after = await readActiveEditorValue(page);
      assert.notEqual(after, before, "editor content did not change after Gaussian-integral diff submit");
    });
  }

  if (shouldRunBoundaryCase(9)) {
    await runCase("[9/9] physics PDE is authored via UI and applied through diff", async (page) => {
      await openFile(page, "sections/blocks.tex");
      await openSideTab(page, "blocks");
      await waitForMathFieldReady(page);
      await installBridgeIncomingSpy(page);

      await setEditorCursor(page, 34, 1);
      const before = await readActiveEditorValue(page);

      await applySuggestionByTyping(page, "pdx", { pickIndex: 0 });
      await page.keyboard.type("u", { delay: typeDelayMs });
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.type("t", { delay: typeDelayMs });
      await page.keyboard.type("+c", { delay: typeDelayMs });
      await applySuggestionByTyping(page, "nabla", { pickIndex: 0 });
      await page.keyboard.type("u=0", { delay: typeDelayMs });

      await waitForMathLatexShape(page, {
        includes: ["\\frac", "\\partialu", "\\partialt", "+c", "\\nabla", "u=0"],
        minLength: 20,
        label: "physics PDE composition",
      });
      await assertMathRenderStable(page, "physics PDE composition");

      await page.click("#block-insert-button");
      await waitForDiffModalState(page, true);
      await page.click("#diff-modal-submit");
      await waitForDiffModalState(page, false);

      await waitForIncomingBridgeMessage(page, {
        type: "formatResult",
        source: "blockInsert",
      });
      await waitEditorContains(page, "\\partial");
      await waitEditorContains(page, "\\nabla");
      const after = await readActiveEditorValue(page);
      assert.notEqual(after, before, "editor content did not change after physics-PDE diff submit");
    });
  }

  log("math-wysiwyg boundary e2e passed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-boundary-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});

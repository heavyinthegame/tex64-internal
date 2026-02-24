import assert from "node:assert/strict";
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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "180", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);
const saveShortcut = process.platform === "darwin" ? "Meta+S" : "Control+S";

const runtimeEnvNames = ["lualatex", "latexmk", "latexindent", "synctex"];
const expectedEnvCheckCommands = [
  "lualatex",
  "pdflatex",
  "xelatex",
  "uplatex",
  "latexmk",
  "latexindent",
  "synctex",
];

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[settings-runtime-env-e2e ${now()}] ${message}`);

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const toPosix = (value) => value.split(path.sep).join("/");

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

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-settings-runtime-env-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "userdata");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  return { tempDir, workspacePath, userDataPath };
};

const launchApp = async ({ workspacePath, userDataPath }) => {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let app = null;
    try {
      app = await electron.launch({
        args: ["."],
        cwd: repoRoot,
        slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
        env: {
          ...process.env,
          TEX64_E2E: "1",
          TEX64_E2E_HEADLESS: "1",
          TEX64_E2E_USERDATA: userDataPath,
          TEX64_E2E_DIALOG_QUEUE: JSON.stringify({
            openWorkspace: [toPosix(workspacePath)],
          }),
        },
      });
      await installE2EQuitGuard(app);
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1660, height: 980 });
      await page.waitForSelector("body.is-ready", { timeout: 25000 });
      return { app, page };
    } catch (error) {
      lastError = error;
      if (app) {
        await allowE2EQuit(app);
        await app.close().catch(() => {});
      }
      if (attempt < 5) {
        await pause(320);
      }
    }
  }
  throw lastError;
};

const waitForLauncherVisible = async (page, timeout = 15000) => {
  await page.waitForFunction(
    () => {
      const launcher = document.getElementById("launcher");
      return Boolean(
        launcher &&
          launcher.classList.contains("is-visible") &&
          launcher.getAttribute("aria-hidden") === "false" &&
          document.body.classList.contains("has-launcher")
      );
    },
    undefined,
    { timeout }
  );
};

const openWorkspaceViaLauncher = async (page) => {
  await waitForLauncherVisible(page, 20000);
  await page.waitForSelector("#launcher-open", { timeout: 10000 });
  await page.click("#launcher-open");
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 30000,
  });
  await page.waitForSelector("#file-tree", { state: "attached", timeout: 15000 });
};

const clickSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 10000,
  });
};

const openSettingsPage = async (page, pageId) => {
  await clickSideTab(page, "settings");
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
    const visibleBackButtons = page.locator("button.settings-back[data-settings-back]:visible");
    if ((await visibleBackButtons.count()) > 0) {
      await visibleBackButtons.first().click();
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

const setCheckbox = async (page, selector, expected) => {
  const checked = await page.isChecked(selector);
  if (checked !== expected) {
    const id = selector.startsWith("#") ? selector.slice(1) : null;
    if (id) {
      await page.click(`label[for="${id}"]`);
    } else {
      await page.click(selector);
    }
  }
  await page.waitForFunction(
    ({ nodeSelector, value }) => {
      const input = document.querySelector(nodeSelector);
      return input instanceof HTMLInputElement && input.checked === value;
    },
    { nodeSelector: selector, value: expected },
    { timeout: 8000 }
  );
};

const installMainIpcRecorder = async (app) => {
  const installed = await app
    .evaluate(({ ipcMain }) => {
      if (global.__settingsRuntimeEnvMainRecorderInstalled === true) {
        return true;
      }
      global.__settingsRuntimeEnvMainRecorderInstalled = true;
      global.__settingsRuntimeEnvMainMessages = [];
      ipcMain.on("tex64", (_event, message) => {
        try {
          const snapshot =
            message && typeof message === "object"
              ? JSON.parse(JSON.stringify(message))
              : message;
          global.__settingsRuntimeEnvMainMessages.push(snapshot);
        } catch {
          global.__settingsRuntimeEnvMainMessages.push({ type: "__unserializable" });
        }
      });
      return true;
    })
    .catch(() => false);
  assert.equal(installed, true, "failed to install main IPC recorder");
};

const clearMainIpcRecorder = async (app) => {
  await app
    .evaluate(() => {
      global.__settingsRuntimeEnvMainMessages = [];
    })
    .catch(() => {});
};

const waitForEnvCheckRequests = async (app, expectedCommands, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  let found = false;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const commands = await app.evaluate(() => {
      const messages = Array.isArray(global.__settingsRuntimeEnvMainMessages)
        ? global.__settingsRuntimeEnvMainMessages
        : [];
      return messages
        .filter((entry) => entry?.type === "env:check" && typeof entry?.command === "string")
        .map((entry) => entry.command);
    });
    const commandSet = new Set(commands);
    if (expectedCommands.every((command) => commandSet.has(command))) {
      found = true;
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!found) {
    const snapshot = await app
      .evaluate(() => {
        const messages = Array.isArray(global.__settingsRuntimeEnvMainMessages)
          ? global.__settingsRuntimeEnvMainMessages
          : [];
        const envChecks = messages
          .filter((entry) => entry?.type === "env:check")
          .map((entry) => entry?.command)
          .filter((entry) => typeof entry === "string");
        return {
          count: messages.length,
          envChecks,
        };
      })
      .catch(() => ({ count: -1, envChecks: [] }));
    throw new Error(
      `env:check timeout. expected=${expectedCommands.join(",")} seen=${JSON.stringify(snapshot)}`
    );
  }
};

const waitForSavePayloadAlignEnv = async (app, envName, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  let found = false;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const tables = await app.evaluate(() => {
      const messages = Array.isArray(global.__settingsRuntimeEnvMainMessages)
        ? global.__settingsRuntimeEnvMainMessages
        : [];
      return messages
        .filter((entry) => entry?.type === "saveFile")
        .map((entry) =>
          entry?.formatSettings?.alignEnvs &&
          Array.isArray(entry.formatSettings.alignEnvs.table)
            ? entry.formatSettings.alignEnvs.table
            : []
        );
    });
    if (tables.some((table) => Array.isArray(table) && table.includes(envName))) {
      found = true;
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!found) {
    const snapshot = await app
      .evaluate(() => {
        const messages = Array.isArray(global.__settingsRuntimeEnvMainMessages)
          ? global.__settingsRuntimeEnvMainMessages
          : [];
        const saveFiles = messages
          .filter((entry) => entry?.type === "saveFile")
          .map((entry) => ({
            path: entry?.path ?? null,
            alignTable:
              entry?.formatSettings?.alignEnvs &&
              Array.isArray(entry.formatSettings.alignEnvs.table)
                ? entry.formatSettings.alignEnvs.table
                : [],
          }));
        const tailTypes = messages
          .map((entry) => entry?.type)
          .filter((entry) => typeof entry === "string")
          .slice(-20);
        return { count: messages.length, saveFiles, tailTypes };
      })
      .catch(() => ({ count: -1, saveFiles: [], tailTypes: [] }));
    throw new Error(
      `save payload should include align env: ${envName}; snapshot=${JSON.stringify(snapshot)}`
    );
  }
};

const waitForRuntimeStatusResolved = async (page, envNames, timeout = 30000) => {
  await page.waitForFunction(
    (targets) =>
      targets.every((envName) => {
        const item = document.querySelector(`.env-item[data-env="${envName}"]`);
        if (!(item instanceof HTMLElement)) {
          return false;
        }
        const badge = item.querySelector(".env-badge");
        if (!(badge instanceof HTMLElement)) {
          return false;
        }
        const text = (badge.textContent ?? "").trim();
        return text === "利用可能" || text === "未検出";
      }),
    envNames,
    { timeout }
  );
};

const readRuntimeRows = async (page, envNames) =>
  page.evaluate((targets) => {
    const result = {};
    targets.forEach((envName) => {
      const item = document.querySelector(`.env-item[data-env="${envName}"]`);
      const badge = item?.querySelector(".env-badge");
      const button = item?.querySelector(".env-btn");
      result[envName] = {
        badgeText: badge instanceof HTMLElement ? (badge.textContent ?? "").trim() : "",
        buttonText: button instanceof HTMLElement ? (button.textContent ?? "").trim() : "",
        buttonHidden: button instanceof HTMLElement ? button.classList.contains("is-hidden") : true,
        target: button instanceof HTMLElement ? button.dataset.target ?? "" : "",
      };
    });
    return result;
  }, envNames);

const assertRuntimeRows = (rows) => {
  const expectedTargets = {
    lualatex: "basictex",
    latexmk: "latexmk",
    latexindent: "basictex",
    synctex: "basictex",
  };

  runtimeEnvNames.forEach((envName) => {
    const row = rows[envName];
    assert.ok(row, `missing runtime row snapshot for ${envName}`);
    assert.ok(
      row.badgeText === "利用可能" || row.badgeText === "未検出",
      `unexpected badge state for ${envName}: ${row.badgeText}`
    );
    assert.equal(row.buttonHidden, false, `${envName}: install button should be visible`);
    if (row.badgeText === "利用可能") {
      assert.equal(
        row.buttonText,
        "更新/再インストール",
        `${envName}: install button text mismatch for available state`
      );
    } else {
      assert.equal(row.buttonText, "インストール", `${envName}: install button text mismatch`);
    }
    assert.equal(row.target, expectedTargets[envName], `${envName}: install target mismatch`);
  });
};

const getDisabledEnvNames = async (page) =>
  page.evaluate(() => {
    try {
      const raw = localStorage.getItem("tex64.disabled-env-registry");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? parsed.filter((name) => typeof name === "string")
        : [];
    } catch {
      return [];
    }
  });

const setEnvRegistryEnabled = async (page, { name, kind, enabled }) => {
  const selector = `#env-registry-${kind} .env-registry-toggle[data-env-name="${name}"][data-env-kind="${kind}"]`;
  await page.waitForSelector(selector, { timeout: 10000 });
  const current = await page.$eval(selector, (node) =>
    node instanceof HTMLButtonElement ? node.classList.contains("is-on") : null
  );
  assert.notEqual(current, null, `env registry toggle missing: ${name}/${kind}`);
  if (current !== enabled) {
    await page.click(selector);
  }
  await page.waitForFunction(
    ({ toggleSelector, expected }) => {
      const node = document.querySelector(toggleSelector);
      if (!(node instanceof HTMLButtonElement)) {
        return false;
      }
      const on = node.classList.contains("is-on");
      const text = (node.textContent ?? "").trim();
      const aria = node.getAttribute("aria-pressed");
      return (
        on === expected &&
        text === (expected ? "ON" : "OFF") &&
        aria === (expected ? "true" : "false")
      );
    },
    { toggleSelector: selector, expected: enabled },
    { timeout: 10000 }
  );
};

const addEnvRegistryEntry = async (page, { name, kind }) => {
  await openSettingsPage(page, "env");
  await page.fill("#env-registry-input", name);
  await page.selectOption("#env-registry-kind", kind);
  await page.click("#env-registry-add");
  await page.waitForSelector(
    `#env-registry-${kind} .env-registry-row[data-env-name="${name}"][data-env-kind="${kind}"]`,
    { timeout: 10000 }
  );
};

const removeEnvRegistryEntry = async (page, { name, kind }) => {
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

const readEnvRegistryRowMeta = async (page, { name, kind }) =>
  page.evaluate(
    ({ envName, envKind }) => {
      const row = document.querySelector(
        `#env-registry-${envKind} .env-registry-row[data-env-name="${envName}"][data-env-kind="${envKind}"]`
      );
      if (!(row instanceof HTMLElement)) {
        return null;
      }
      const meta = row.querySelector(".env-registry-meta");
      const flags = Array.from(row.querySelectorAll(".env-registry-flag"))
        .map((node) => (node.textContent ?? "").trim())
        .filter(Boolean);
      return {
        meta: meta instanceof HTMLElement ? (meta.textContent ?? "").trim() : "",
        flags,
        hasRemoveButton: row.querySelector(".env-registry-remove") instanceof HTMLButtonElement,
      };
    },
    { envName: name, envKind: kind }
  );

const focusEditor = async (page) => {
  const editor = page.locator("#editor .monaco-editor");
  await editor.waitFor({ state: "visible", timeout: 15000 });
  await editor.click({ position: { x: 120, y: 80 } });
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    if (editors[0]?.focus) {
      editors[0].focus();
    }
  });
  await pause(120);
};

const appendLineToEditor = async (page, value) => {
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const model = active?.getModel?.();
    if (!active || !model) {
      return;
    }
    const lineNumber = model.getLineCount();
    const column = model.getLineMaxColumn(lineNumber);
    active.setPosition({ lineNumber, column });
    active.revealPositionInCenterIfOutsideViewport?.({ lineNumber, column });
    active.focus();
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type(value);
};

const run = async () => {
  const { tempDir, workspacePath, userDataPath } = await createWorkspaceCopy();
  let app;
  try {
    log(`workspace copy: ${workspacePath}`);
    ({ app } = await launchApp({ workspacePath, userDataPath }));
    const page = await app.firstWindow();
    page.on("dialog", async (dialog) => {
      try {
        await dialog.dismiss();
      } catch {
        // ignore protocol races on auto-closed dialogs
      }
    });

    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page);
    await installMainIpcRecorder(app);

    log("[1/4] runtime checks and recheck wiring");
    await clearMainIpcRecorder(app);
    await openSettingsPage(page, "runtime");
    await waitForEnvCheckRequests(app, expectedEnvCheckCommands, 15000);
    await waitForRuntimeStatusResolved(page, runtimeEnvNames, 30000);
    let runtimeRows = await readRuntimeRows(page, runtimeEnvNames);
    assertRuntimeRows(runtimeRows);

    await clearMainIpcRecorder(app);
    await page.click("#settings-env-refresh");
    await waitForEnvCheckRequests(app, expectedEnvCheckCommands, 15000);
    await waitForRuntimeStatusResolved(page, runtimeEnvNames, 30000);
    runtimeRows = await readRuntimeRows(page, runtimeEnvNames);
    assertRuntimeRows(runtimeRows);

    log("[2/4] editor ghost settings + align-env persistence");
    await openSettingsPage(page, "editor");
    await setCheckbox(page, "#editor-ghost-completion", true);
    await page.fill("#editor-ghost-debounce", "260");
    await page.locator("#editor-ghost-debounce").blur();
    await page.waitForFunction(
      () => localStorage.getItem("tex64.editor.ghostCompletion.debounceMs") === "260",
      undefined,
      { timeout: 8000 }
    );
    await page.fill("#editor-ghost-max-chars", "180");
    await page.locator("#editor-ghost-max-chars").blur();
    await page.waitForFunction(
      () => localStorage.getItem("tex64.editor.ghostCompletion.maxChars") === "180",
      undefined,
      { timeout: 8000 }
    );
    await setCheckbox(page, "#editor-ghost-completion", false);
    await page.waitForFunction(
      () =>
        localStorage.getItem("tex64.editor.ghostCompletion") === "false" &&
        document.getElementById("editor-ghost-debounce") instanceof HTMLInputElement &&
        document.getElementById("editor-ghost-debounce").disabled === true &&
        document.getElementById("editor-ghost-max-chars") instanceof HTMLInputElement &&
        document.getElementById("editor-ghost-max-chars").disabled === true,
      undefined,
      { timeout: 8000 }
    );
    await setCheckbox(page, "#editor-ghost-completion", true);
    await page.waitForFunction(
      () => localStorage.getItem("tex64.editor.ghostCompletion") === "true",
      undefined,
      { timeout: 8000 }
    );

    await openSettingsPage(page, "format");
    await setCheckbox(page, "#editor-align-env", false);
    await page.waitForFunction(
      () => localStorage.getItem("tex64.editor.alignEnv") === "false",
      undefined,
      { timeout: 8000 }
    );
    await setCheckbox(page, "#editor-align-env", true);
    await page.waitForFunction(
      () => localStorage.getItem("tex64.editor.alignEnv") === "true",
      undefined,
      { timeout: 8000 }
    );

    log("[3/4] env registry metadata + enable/disable + custom CRUD");
    await openSettingsPage(page, "env");
    const eqnarrayMeta = await readEnvRegistryRowMeta(page, { name: "eqnarray", kind: "math" });
    assert.ok(eqnarrayMeta, "eqnarray row missing");
    assert.equal(eqnarrayMeta.meta, "latex", "eqnarray package label mismatch");
    assert.ok(eqnarrayMeta.flags.includes("非推奨"), "eqnarray discouraged label missing");

    await setEnvRegistryEnabled(page, { name: "eqnarray", kind: "math", enabled: false });
    let disabled = await getDisabledEnvNames(page);
    assert.ok(disabled.includes("eqnarray"), "eqnarray should be disabled");
    await setEnvRegistryEnabled(page, { name: "eqnarray", kind: "math", enabled: true });
    disabled = await getDisabledEnvNames(page);
    assert.ok(!disabled.includes("eqnarray"), "eqnarray should be re-enabled");

    const customTableEnv = "chapter14tableenv";
    await addEnvRegistryEntry(page, { name: customTableEnv, kind: "table" });
    const customMeta = await readEnvRegistryRowMeta(page, {
      name: customTableEnv,
      kind: "table",
    });
    assert.ok(customMeta, "custom table env row missing");
    assert.equal(customMeta.meta, "custom", "custom env package label mismatch");
    assert.ok(customMeta.flags.includes("custom"), "custom flag missing");
    assert.equal(customMeta.hasRemoveButton, true, "custom env remove button missing");

    await setEnvRegistryEnabled(page, { name: customTableEnv, kind: "table", enabled: false });
    disabled = await getDisabledEnvNames(page);
    assert.ok(disabled.includes(customTableEnv), "custom table env should be disabled");
    await setEnvRegistryEnabled(page, { name: customTableEnv, kind: "table", enabled: true });
    disabled = await getDisabledEnvNames(page);
    assert.ok(!disabled.includes(customTableEnv), "custom table env should be re-enabled");

    await removeEnvRegistryEntry(page, { name: customTableEnv, kind: "table" });

    log("[4/4] env registry propagates into format payload on save");
    const customAlignEnv = "chapter14alignenv";
    await addEnvRegistryEntry(page, { name: customAlignEnv, kind: "table" });
    await clearMainIpcRecorder(app);
    await focusEditor(page);
    await appendLineToEditor(page, `% CH14_FORMAT_PAYLOAD_${Date.now()}`);
    await page.keyboard.press(saveShortcut);
    await waitForSavePayloadAlignEnv(app, customAlignEnv, 20000);
    await removeEnvRegistryEntry(page, { name: customAlignEnv, kind: "table" });

    log("all checks passed");
  } finally {
    if (app) {
      try {
        await allowE2EQuit(app);
        await Promise.race([
          app.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("app.close timeout")), 5000)
          ),
        ]);
      } catch {
        try {
          app.process()?.kill("SIGKILL");
        } catch {
          // ignore force-kill failure
        }
      }
    }
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log(`workspace copy removed: ${tempDir}`);
    } else {
      log(`workspace copy kept: ${tempDir}`);
    }
  }
};

run().catch((error) => {
  console.error("[settings-runtime-env-e2e] failed:", error);
  process.exitCode = 1;
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const require = createRequire(import.meta.url);
const { BuildService } = require("../../electron/services/build.cjs");
const buildService = new BuildService();

const sourceWorkspace = path.join(repoRoot, "test-workspace");
const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "180", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "40", 10);

const ERROR_CASES = [
  {
    id: "undefined-command",
    rootPath: "cases/build/error-undefined-command.tex",
    expectedPath: "cases/build/error-undefined-command.tex",
    expectedLine: 5,
    messageNeedles: ["undefined control sequence"],
  },
  {
    id: "missing-input",
    rootPath: "cases/build/error-missing-input.tex",
    expectedPath: "cases/build/error-missing-input.tex",
    expectedLine: 4,
    messageNeedles: ["does-not-exist", "emergency stop"],
  },
  {
    id: "missing-graphic",
    rootPath: "cases/build/error-missing-graphic.tex",
    expectedPath: "cases/build/error-missing-graphic.tex",
    expectedLine: 5,
    messageNeedles: ["missing-image-fil", "missing-image-file"],
  },
  {
    id: "unbalanced-env",
    rootPath: "cases/build/error-unbalanced-env.tex",
    expectedPath: "cases/build/error-unbalanced-env.tex",
    expectedLine: 7,
    messageNeedles: ["missing $ inserted"],
  },
];

const WARNING_CASES = [
  {
    id: "warn-undefined-ref",
    logPath: "warn-undefined-ref.log",
    expectedPath: "cases/build/warn-undefined-ref.tex",
    expectedLine: 4,
    messageNeedles: ["does-not-exist", "undefined"],
  },
  {
    id: "warn-undefined-cite",
    logPath: "warn-undefined-cite.log",
    expectedPath: "cases/build/warn-undefined-cite.tex",
    expectedLine: 4,
    messageNeedles: ["missing2024", "citation"],
  },
  {
    id: "warn-overfull",
    logPath: "warn-overfull.log",
    expectedPath: "cases/build/warn-overfull.tex",
    expectedLine: 4,
    messageNeedles: ["overfull", "hbox"],
  },
];

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[issues-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-issues-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "userdata");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  return { tempDir, workspacePath, userDataPath };
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

const waitForActivePanel = async (page, key, timeout = 10000) => {
  await page.waitForFunction(
    (tabKey) => {
      const panel = document.querySelector(`.sidebar-panel .panel[data-panel="${tabKey}"]`);
      return panel instanceof HTMLElement && panel.classList.contains("is-active");
    },
    key,
    { timeout }
  );
};

const openSideTab = async (page, key) => {
  await page.evaluate((tabKey) => {
    const tab = document.querySelector(`button.tab[data-tab="${tabKey}"]`);
    if (tab instanceof HTMLButtonElement) {
      tab.classList.remove("is-hidden");
      tab.setAttribute("aria-hidden", "false");
      tab.click();
    }
    const panel = document.querySelector(`.sidebar-panel .panel[data-panel="${tabKey}"]`);
    if (panel instanceof HTMLElement) {
      panel.classList.remove("is-hidden");
    }
  }, key);
  await waitForActivePanel(page, key);
  await pause(80);
};

const focusEditor = async (page) => {
  await page.waitForSelector("#editor .monaco-editor", { timeout: 10000 });
  await page.click("#editor .monaco-editor", { position: { x: 80, y: 80 } });
  await pause(80);
};

const clickBuildAndWait = async (page, timeout = 120000) => {
  await page.click("#build-button");
  await page.waitForFunction(
    () => {
      const button = document.getElementById("build-button");
      return button instanceof HTMLButtonElement && !button.classList.contains("is-busy");
    },
    undefined,
    { timeout }
  );
};

const injectIssues = async (page, payload) => {
  await page.evaluate((value) => {
    window.tex64UpdateIssues?.(value);
  }, payload);
  await pause(60);
};

const injectIndex = async (page, payload) => {
  await page.evaluate((value) => {
    window.tex64UpdateIndex?.(value);
  }, payload);
  await pause(60);
};

const clearIssuesState = async (page) => {
  await injectIssues(page, { count: 0, summary: "", status: "success", issues: [] });
};

const waitForIssueRows = async (page) => {
  await page.waitForFunction(
    () => document.querySelectorAll("#issues-list .issue-item").length > 0,
    undefined,
    { timeout: 15000 }
  );
};

const readIssueRows = async (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("#issues-list .issue-item")).map((item, index) => ({
      index,
      severity: item instanceof HTMLElement ? item.dataset.severity ?? "" : "",
      action: item instanceof HTMLElement ? item.dataset.action ?? "" : "",
      location: item.querySelector(".issue-location")?.textContent?.trim() ?? "",
      message: item.querySelector(".issue-message")?.textContent?.trim() ?? "",
      hint: item.querySelector(".issue-hintline")?.textContent?.trim() ?? "",
      resolution: item.querySelector(".issue-resolution")?.textContent?.trim() ?? "",
      disabled: item instanceof HTMLButtonElement ? item.disabled : false,
    }))
  );

const assertIssueRowDisplay = (row, context) => {
  assert.notEqual(row.severity, "", `${context}: severity should be shown`);
  assert.notEqual(row.location, "", `${context}: location should be shown`);
  assert.notEqual(row.message, "", `${context}: message should be shown`);
  assert.notEqual(row.hint, "", `${context}: hint should be shown`);
};

const findIssueRowIndex = (rows, testCase, severity) => {
  const expectedLocation = `${testCase.expectedPath}:${testCase.expectedLine}`;
  const loweredNeedles = testCase.messageNeedles.map((needle) => needle.toLowerCase());
  const index = rows.findIndex((row) => {
    const loweredMessage = row.message.toLowerCase();
    const messageMatches = loweredNeedles.some((needle) => loweredMessage.includes(needle));
    const locationMatches =
      row.location === expectedLocation ||
      (row.location.includes(testCase.expectedPath) &&
        row.location.endsWith(`:${testCase.expectedLine}`));
    return row.severity === severity && messageMatches && locationMatches;
  });
  return index;
};

const clickIssueByIndex = async (page, index) => {
  await page.evaluate((targetIndex) => {
    const rows = Array.from(document.querySelectorAll("#issues-list .issue-item"));
    const row = rows[targetIndex];
    if (!(row instanceof HTMLButtonElement)) {
      throw new Error(`issue row not found: index=${targetIndex}`);
    }
    row.click();
  }, index);
  await pause(80);
};

const hasLineDecoration = async (page, line, className) =>
  page.evaluate(
    ({ targetLine, targetClass }) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      if (!active || typeof active.getLineDecorations !== "function") {
        return false;
      }
      const decorations = active.getLineDecorations(targetLine) ?? [];
      return decorations.some((decoration) => {
        const name = decoration?.options?.className;
        if (typeof name !== "string") {
          return false;
        }
        return name.split(/\s+/).includes(targetClass);
      });
    },
    { targetLine: line, targetClass: className }
  );

const getActiveEditorLine = async (page) =>
  page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const position = active?.getPosition?.();
    return Number.isFinite(position?.lineNumber) ? position.lineNumber : null;
  });

const setRoot = async (page, relativePath) => {
  await postToBridge(page, { type: "setRoot", path: relativePath });
  await page.waitForFunction(
    (value) => {
      const select = document.getElementById("settings-root-select");
      return select instanceof HTMLSelectElement && select.value === value;
    },
    relativePath,
    { timeout: 15000 }
  );
  await pause(120);
};

const assertIssuesLogVisible = async (page) => {
  const visible = await page.evaluate(() => {
    const node = document.getElementById("issues-log");
    return Boolean(node && !node.classList.contains("is-hidden"));
  });
  assert.ok(visible, "issues log should be visible");
};

const assertIssuesLogContainsAny = async (page, needles) => {
  const loweredNeedles = needles.map((needle) => needle.toLowerCase());
  const contains = await page.evaluate((values) => {
    const text = (document.getElementById("issues-log-content")?.textContent ?? "").toLowerCase();
    return values.some((needle) => text.includes(needle));
  }, loweredNeedles);
  assert.ok(contains, `issues log should include one of: ${needles.join(", ")}`);
};

const resolveIssueFromLog = async (workspacePath, testCase, severity) => {
  const logPath = path.join(workspacePath, testCase.logPath);
  const rawLog = await fs.readFile(logPath, "utf8");
  const parsed = buildService.parseIssues(rawLog, workspacePath);
  const loweredNeedles = testCase.messageNeedles.map((needle) => needle.toLowerCase());
  const issue = parsed.find((candidate) => {
    if (!candidate || candidate.severity !== severity) {
      return false;
    }
    if (candidate.path !== testCase.expectedPath) {
      return false;
    }
    if (candidate.line !== testCase.expectedLine) {
      return false;
    }
    const message = String(candidate.message ?? "").toLowerCase();
    return loweredNeedles.some((needle) => message.includes(needle));
  });
  assert.ok(
    issue,
    `${testCase.id}: parsed warning issue not found\n${JSON.stringify(parsed, null, 2)}`
  );
  return issue;
};

const run = async () => {
  const { tempDir, workspacePath, userDataPath } = await createWorkspaceCopy();
  let electronApp;

  try {
    log(`workspace copy: ${workspacePath}`);
    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: {
        ...process.env,
        TEX64_E2E_USERDATA: userDataPath,
      },
    });
    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });

    log("opening workspace");
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);

    const total = ERROR_CASES.length;
    for (let index = 0; index < total; index += 1) {
      const testCase = ERROR_CASES[index];
      log(`[${index + 1}/${total}] ${testCase.id}`);
      await setRoot(page, testCase.rootPath);
      await openSideTab(page, "files");
      await focusEditor(page);
      await clickBuildAndWait(page);
      if (index === 0) {
        await waitForActivePanel(page, "issues", 15000);
      } else {
        await openSideTab(page, "issues");
      }
      await waitForIssueRows(page);
      const rows = await readIssueRows(page);
      assert.ok(rows.length > 0, `${testCase.id}: issues should be present`);
      const rowIndex = findIssueRowIndex(rows, testCase, "error");
      assert.ok(
        rowIndex >= 0,
        `${testCase.id}: matching issue row not found\n${JSON.stringify(rows, null, 2)}`
      );
      const row = rows[rowIndex];
      assert.equal(row.disabled, false, `${testCase.id}: row should be clickable`);
      assertIssueRowDisplay(row, testCase.id);
      assert.match(row.hint, /クリック/, `${testCase.id}: hint should guide click action`);
      await clickIssueByIndex(page, rowIndex);
      await page.waitForSelector(
        `#editor-tabs-list .editor-tab.is-active[data-path="${testCase.expectedPath}"]`,
        { timeout: 10000 }
      );
      assert.equal(
        await getActiveEditorLine(page),
        testCase.expectedLine,
        `${testCase.id}: editor line should match`
      );
      assert.equal(
        await hasLineDecoration(page, testCase.expectedLine, "issue-line-highlight"),
        true,
        `${testCase.id}: error line highlight should exist`
      );
      await assertIssuesLogVisible(page);
      await assertIssuesLogContainsAny(page, testCase.messageNeedles);
    }

    const warningTotal = WARNING_CASES.length;
    for (let index = 0; index < warningTotal; index += 1) {
      const testCase = WARNING_CASES[index];
      log(`[warn ${index + 1}/${warningTotal}] ${testCase.id}`);
      const warningIssue = await resolveIssueFromLog(workspacePath, testCase, "warning");
      await clearIssuesState(page);
      await openSideTab(page, "files");
      await focusEditor(page);
      await injectIssues(page, {
        count: 1,
        summary: testCase.id,
        status: "info",
        issues: [warningIssue],
      });
      await openSideTab(page, "issues");
      await waitForIssueRows(page);
      const rows = await readIssueRows(page);
      const rowIndex = findIssueRowIndex(rows, testCase, "warning");
      assert.ok(
        rowIndex >= 0,
        `${testCase.id}: warning row not found\n${JSON.stringify(rows, null, 2)}`
      );
      const row = rows[rowIndex];
      assertIssueRowDisplay(row, testCase.id);
      assert.match(row.hint, /クリック/, `${testCase.id}: warning hint should guide click action`);
      await clickIssueByIndex(page, rowIndex);
      await page.waitForSelector(
        `#editor-tabs-list .editor-tab.is-active[data-path="${testCase.expectedPath}"]`,
        { timeout: 10000 }
      );
      assert.equal(
        await getActiveEditorLine(page),
        testCase.expectedLine,
        `${testCase.id}: editor line should match`
      );
      assert.equal(
        await hasLineDecoration(page, testCase.expectedLine, "issue-line-warning"),
        true,
        `${testCase.id}: warning line highlight should exist`
      );
    }

    log("[sources] save/format issue sources are rendered and navigable");
    await clearIssuesState(page);
    await injectIssues(page, {
      count: 2,
      summary: "save-format-source",
      status: "error",
      issues: [
        {
          severity: "error",
          message: "save-source-e2e",
          path: "sections/intro.tex",
          line: 1,
        },
        {
          severity: "warning",
          message: "format-source-e2e",
          path: "main.tex",
          line: 25,
        },
      ],
    });
    await openSideTab(page, "issues");
    await waitForIssueRows(page);
    const sourceRows = await readIssueRows(page);
    const saveIndex = sourceRows.findIndex(
      (row) => row.severity === "error" && row.message.includes("save-source-e2e")
    );
    assert.ok(saveIndex >= 0, `save issue row not found\n${JSON.stringify(sourceRows, null, 2)}`);
    const saveRow = sourceRows[saveIndex];
    assertIssueRowDisplay(saveRow, "save-source");
    await clickIssueByIndex(page, saveIndex);
    await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="sections/intro.tex"]', {
      timeout: 10000,
    });
    assert.equal(await getActiveEditorLine(page), 1, "save-source should jump to intro:1");
    assert.equal(
      await hasLineDecoration(page, 1, "issue-line-highlight"),
      true,
      "save-source should render error highlight"
    );

    await openSideTab(page, "issues");
    const refreshedSourceRows = await readIssueRows(page);
    const formatIndex = refreshedSourceRows.findIndex(
      (row) => row.severity === "warning" && row.message.includes("format-source-e2e")
    );
    assert.ok(
      formatIndex >= 0,
      `format issue row not found\n${JSON.stringify(refreshedSourceRows, null, 2)}`
    );
    const formatRow = refreshedSourceRows[formatIndex];
    assertIssueRowDisplay(formatRow, "format-source");
    await clickIssueByIndex(page, formatIndex);
    await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
      timeout: 10000,
    });
    assert.equal(await getActiveEditorLine(page), 25, "format-source should jump to main:25");
    assert.equal(
      await hasLineDecoration(page, 25, "issue-line-warning"),
      true,
      "format-source should render warning highlight"
    );

    log("[runtime] open-runtime action routes to Runtime settings");
    await clearIssuesState(page);
    await injectIssues(page, {
      count: 1,
      summary: "runtime-missing",
      status: "error",
      issues: [
        {
          severity: "error",
          message: "latexmk が見つかりません。TeX環境を確認してください。",
          action: "open-runtime",
        },
      ],
    });
    await openSideTab(page, "issues");
    await page.waitForSelector('#issues-list .issue-item[data-action="open-runtime"]', {
      timeout: 10000,
    });
    const runtimeRows = await readIssueRows(page);
    const runtimeIndex = runtimeRows.findIndex((row) => row.action === "open-runtime");
    assert.ok(runtimeIndex >= 0, "runtime action issue row should exist");
    const runtimeRow = runtimeRows[runtimeIndex];
    assertIssueRowDisplay(runtimeRow, "runtime");
    assert.equal(runtimeRow.disabled, false, "runtime action row should be clickable");
    assert.match(runtimeRow.hint, /Runtime/, "runtime action hint should mention Runtime");
    await clickIssueByIndex(page, runtimeIndex);
    await page.waitForSelector(
      '.panel.is-active[data-panel="settings"] .settings-page[data-settings-page="runtime"].is-active',
      { timeout: 12000 }
    );

    log("[duplicate-label] warning from updateIndex snapshot");
    await clearIssuesState(page);
    await injectIssues(page, {
      count: 1,
      summary: "base-error-for-duplicate-label",
      status: "error",
      issues: [{ severity: "error", message: "base error", path: "main.tex", line: 1 }],
    });
    await injectIndex(page, {
      labels: [
        { key: "dup:issue-e2e", path: "main.tex", line: 10 },
        { key: "dup:issue-e2e", path: "sections/intro.tex", line: 2 },
      ],
      references: [],
      citations: [],
      sections: [],
      figures: [],
      tables: [],
      todos: [],
    });
    await openSideTab(page, "issues");
    await waitForIssueRows(page);
    const duplicateRows = await readIssueRows(page);
    const duplicateIndex = duplicateRows.findIndex(
      (row) =>
        row.severity === "warning" &&
        row.message.includes("Duplicate label: dup:issue-e2e")
    );
    assert.ok(
      duplicateIndex >= 0,
      `duplicate label warning not found\n${JSON.stringify(duplicateRows, null, 2)}`
    );
    const duplicateRow = duplicateRows[duplicateIndex];
    assertIssueRowDisplay(duplicateRow, "duplicate-label");
    assert.match(
      duplicateRow.location,
      /main\.tex:10$/,
      "duplicate label warning should include primary location"
    );
    assert.match(
      duplicateRow.hint,
      /クリックで移動/,
      "duplicate label warning should provide jump hint"
    );
    await clickIssueByIndex(page, duplicateIndex);
    await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
      timeout: 10000,
    });
    assert.equal(
      await getActiveEditorLine(page),
      10,
      "duplicate label warning jump should move to first duplicate line"
    );
    assert.equal(
      await hasLineDecoration(page, 10, "issue-line-warning"),
      true,
      "duplicate label warning line highlight should exist"
    );

    log("issues e2e passed");
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log("workspace copy removed");
    } else {
      log(`workspace copy kept: ${tempDir}`);
    }
  }
};

run().catch((error) => {
  console.error("[issues-e2e] FAILED");
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});

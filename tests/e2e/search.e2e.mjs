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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "220", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "60", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[search-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-search-"));
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

const waitForAppReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 20000 });
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 25000,
  });
};

const simulateWorkspaceUnselected = async (page) => {
  await page.evaluate(() => {
    window.tex64UpdateWorkspace?.({
      rootName: "ワークスペース未選択",
      rootPath: "",
      files: [],
      folders: [],
    });
  });
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
  await page.waitForFunction(
    (tabKey) => {
      const panel = document.querySelector(`.sidebar-panel .panel[data-panel="${tabKey}"]`);
      return panel instanceof HTMLElement && panel.classList.contains("is-active");
    },
    key,
    { timeout: 10000 }
  );
  await pause(80);
};

const setInputValue = async (page, selector, value) => {
  await page.evaluate(
    ({ targetSelector, targetValue }) => {
      const node = document.querySelector(targetSelector);
      if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
        throw new Error(`input not found: ${targetSelector}`);
      }
      node.value = targetValue;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { targetSelector: selector, targetValue: value }
  );
};

const clickDom = async (page, selector) => {
  await page.evaluate((targetSelector) => {
    const node = document.querySelector(targetSelector);
    if (!(node instanceof HTMLElement)) {
      throw new Error(`element not found: ${targetSelector}`);
    }
    node.click();
  }, selector);
};

const pressEnter = async (page, selector) => {
  await page.evaluate((targetSelector) => {
    const node = document.querySelector(targetSelector);
    if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
      throw new Error(`input not found: ${targetSelector}`);
    }
    node.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
      })
    );
    node.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
      })
    );
  }, selector);
};

const setCheckboxValue = async (page, selector, checked) => {
  await page.evaluate(
    ({ targetSelector, targetChecked }) => {
      const node = document.querySelector(targetSelector);
      if (!(node instanceof HTMLInputElement) || node.type !== "checkbox") {
        throw new Error(`checkbox not found: ${targetSelector}`);
      }
      node.checked = targetChecked;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { targetSelector: selector, targetChecked: checked }
  );
};

const runSearchByButton = async (page, query) => {
  await setInputValue(page, "#search-input", query);
  await clickDom(page, "#search-button");
};

const runSearchByEnter = async (page, query) => {
  await setInputValue(page, "#search-input", query);
  await pressEnter(page, "#search-input");
};

const waitForSearchSettled = async (page, timeout = 30000) => {
  await page.waitForFunction(
    () => {
      const empty = document.querySelector("#search-results .search-empty");
      if (empty) {
        return (empty.textContent ?? "").trim() !== "検索中...";
      }
      return document.querySelectorAll("#search-results .search-match-item").length > 0;
    },
    undefined,
    { timeout }
  );
};

const waitForSearchEmptyMessage = async (page, expected, timeout = 15000) => {
  await page.waitForFunction(
    (message) => {
      const empty = document.querySelector("#search-results .search-empty");
      return Boolean(empty) && (empty.textContent ?? "").trim() === message;
    },
    expected,
    { timeout }
  );
};

const countSearchItems = async (page) =>
  page.locator("#search-results .search-match-item").count();

const getSearchGroups = async (page) =>
  page.evaluate(() => {
    const parseLine = (raw) => {
      const value = (raw ?? "").trim();
      const match = value.match(/(\d+)/);
      return match ? Number.parseInt(match[1], 10) : null;
    };
    return Array.from(document.querySelectorAll(".search-file-group")).map((group) => {
      const header = group.querySelector(".search-file-header");
      const spans = header ? Array.from(header.querySelectorAll("span")) : [];
      const pathText = (spans[1]?.textContent ?? "").trim();
      const countText = (
        group.querySelector(".search-file-count")?.textContent ?? "0"
      ).trim();
      const count = Number.parseInt(countText.replace(/[^\d]/g, ""), 10) || 0;
      const lines = Array.from(group.querySelectorAll(".search-match-line"))
        .map((lineNode) => parseLine(lineNode.textContent))
        .filter((lineNo) => Number.isFinite(lineNo));
      return {
        path: pathText,
        count,
        lines,
      };
    });
  });

const clickSearchResult = async (page, targetPath, targetLine) =>
  page.evaluate(
    ({ pathValue, lineValue }) => {
      const groups = Array.from(document.querySelectorAll(".search-file-group"));
      for (const group of groups) {
        const header = group.querySelector(".search-file-header");
        const spans = header ? Array.from(header.querySelectorAll("span")) : [];
        const pathText = (spans[1]?.textContent ?? "").trim();
        if (pathText !== pathValue) {
          continue;
        }
        const items = Array.from(group.querySelectorAll(".search-match-item"));
        for (const item of items) {
          const lineText = item.querySelector(".search-match-line")?.textContent ?? "";
          const lineMatch = lineText.match(/(\d+)/);
          const line = lineMatch ? Number.parseInt(lineMatch[1], 10) : NaN;
          if (line === lineValue) {
            item.click();
            return true;
          }
        }
      }
      return false;
    },
    { pathValue: targetPath, lineValue: targetLine }
  );

const waitForSecondaryCursorLine = async (page, expectedLine, timeout = 15000) => {
  await page.waitForFunction(
    (line) => {
      const monacoApi = window.monaco?.editor;
      const editors = monacoApi?.getEditors ? monacoApi.getEditors() : [];
      for (const editor of editors) {
        const node = typeof editor.getDomNode === "function" ? editor.getDomNode() : null;
        if (!node || !node.closest('[data-editor-group="secondary"]')) {
          continue;
        }
        const position =
          typeof editor.getPosition === "function" ? editor.getPosition() : null;
        return position?.lineNumber === line;
      }
      return false;
    },
    expectedLine,
    { timeout }
  );
};

const setRenameForm = async (
  page,
  { from, to, label = true, cite = true }
) => {
  await setInputValue(page, "#search-rename-from", from);
  await setInputValue(page, "#search-rename-to", to);
  await setCheckboxValue(page, "#search-rename-label", label);
  await setCheckboxValue(page, "#search-rename-cite", cite);
};

const clickRenameRun = async (page) => {
  await clickDom(page, "#search-rename-run");
};

const waitForRenameState = async (page, className, timeout = 25000) => {
  await page.waitForFunction(
    (stateClass) => {
      const status = document.getElementById("search-rename-status");
      return Boolean(status) && status.classList.contains(stateClass);
    },
    className,
    { timeout }
  );
};

const getRenameStatusText = async (page) => {
  const value = await page
    .locator("#search-rename-status")
    .first()
    .textContent();
  return (value ?? "").trim();
};

const waitForBridgeMessage = async (page, type, timeout = 30000) =>
  page.evaluate(
    ({ eventType, eventTimeout }) =>
      new Promise((resolve) => {
        let off = null;
        const done = (value) => {
          if (off) {
            off();
            off = null;
          }
          resolve(value);
        };
        const timer = setTimeout(() => {
          done({ __timeout: true });
        }, eventTimeout);
        off = window.tex64Bridge.onMessage((message) => {
          if (message?.type !== eventType) {
            return;
          }
          clearTimeout(timer);
          done(message?.payload ?? null);
        });
      }),
    { eventType: type, eventTimeout: timeout }
  );

const openSearchRenameChatInAiPanel = async (page) => {
  await openSideTab(page, "ai");
  const selected = await page.evaluate(() => {
    const currentTitle = (document.getElementById("ai-topbar-title")?.textContent ?? "").trim();
    if (currentTitle.includes("シンボルリネーム")) {
      return true;
    }
    const toggle = document.getElementById("ai-history-toggle");
    if (toggle instanceof HTMLButtonElement) {
      toggle.click();
    }
    const items = Array.from(document.querySelectorAll("#ai-history-list .ai-history-item"));
    const target = items.find((item) =>
      (item.textContent ?? "").includes("シンボルリネーム")
    );
    if (!(target instanceof HTMLButtonElement)) {
      return false;
    }
    target.click();
    return true;
  });
  assert.equal(selected, true, "search-rename history item not found");
  await page.waitForFunction(
    () => (document.getElementById("ai-topbar-title")?.textContent ?? "").includes("シンボルリネーム"),
    undefined,
    { timeout: 10000 }
  );
};

const countAiProposals = async (page) =>
  page.locator("#ai-proposals .ai-proposal").count();

const getAiProposalPaths = async (page) =>
  page.$$eval("#ai-proposals .ai-proposal .ai-proposal-path", (nodes) =>
    nodes.map((node) => (node.textContent ?? "").trim()).filter(Boolean)
  );

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
        TEX64_E2E_HEADLESS: "1",
        TEX64_E2E_USERDATA: userDataPath,
      },
    });
    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });

    await waitForAppReady(page);
    log("open workspace for baseline UI access");
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await openSideTab(page, "search");

    log("[1/12] search without workspace");
    await simulateWorkspaceUnselected(page);
    await runSearchByButton(page, "anything");
    await waitForSearchEmptyMessage(page, "ワークスペースが未選択です。");

    log("[2/12] rename validation without workspace");
    await setRenameForm(page, {
      from: "sec:methods",
      to: "sec:methods-temp",
      label: true,
      cite: false,
    });
    await clickRenameRun(page);
    await waitForRenameState(page, "is-error");
    assert.equal(await getRenameStatusText(page), "ワークスペースが未選択です。");

    log("[3/12] open workspace");
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await openSideTab(page, "search");

    log("[4/12] empty query validation");
    await runSearchByButton(page, "");
    await waitForSearchEmptyMessage(page, "");

    log("[5/12] tex-only search (.bib-only term should not match)");
    await runSearchByButton(page, "Journal of TeX Studies");
    await waitForSearchSettled(page);
    await waitForSearchEmptyMessage(page, "一致する結果がありません。");

    log("[6/12] case-insensitive + grouped results");
    await runSearchByEnter(page, "SEC:METHODS");
    await waitForSearchSettled(page);
    const groupResults = await getSearchGroups(page);
    const totalCount = groupResults.reduce((sum, group) => sum + group.count, 0);
    assert.equal(totalCount, 3, "expected exactly 3 matches for SEC:METHODS");
    const groupedPaths = groupResults.map((group) => group.path);
    assert.ok(groupedPaths.includes("main.tex"), "main.tex group not found");
    assert.ok(groupedPaths.includes("sections/intro.tex"), "sections/intro.tex group not found");
    assert.ok(
      groupedPaths.includes("sections/methods.tex"),
      "sections/methods.tex group not found"
    );

    log("[7/12] search result jump opens secondary + split + path:line");
    const clicked = await clickSearchResult(page, "sections/intro.tex", 8);
    assert.ok(clicked, "could not click search result for sections/intro.tex:8");
    await page.waitForSelector('#editor-groups[data-split="true"]', { timeout: 10000 });
    await page.waitForSelector(
      '#editor-tabs-list-secondary .editor-tab.is-active[data-path="sections/intro.tex"]',
      { timeout: 15000 }
    );
    await waitForSecondaryCursorLine(page, 8);

    log("[8/12] max 200 results + loading state");
    await setInputValue(page, "#search-input", "TEX64_SEARCH_TOKEN");
    await pressEnter(page, "#search-input");
    const loadingShown = await page.evaluate(() => {
      const empty = document.querySelector("#search-results .search-empty");
      return (empty?.textContent ?? "").trim() === "検索中...";
    });
    assert.equal(loadingShown, true, "expected loading message while search is running");
    await page.waitForFunction(
      () => document.querySelectorAll("#search-results .search-match-item").length === 200,
      undefined,
      { timeout: 30000 }
    );
    assert.equal(await countSearchItems(page), 200, "search result count must be capped at 200");

    log("[9/12] rename validation: required from/to");
    await setRenameForm(page, { from: "", to: "", label: true, cite: true });
    await clickRenameRun(page);
    await waitForRenameState(page, "is-error");
    assert.equal(await getRenameStatusText(page), "現在のキーと新しいキーを入力してください。");

    log("[10/12] rename validation: same key / invalid chars / target required");
    await setRenameForm(page, {
      from: "sec:methods",
      to: "sec:methods",
      label: true,
      cite: true,
    });
    await clickRenameRun(page);
    await waitForRenameState(page, "is-error");
    assert.equal(await getRenameStatusText(page), "新しいキーが同じです。");

    await setRenameForm(page, {
      from: "sec: methods",
      to: "sec:methods-next",
      label: true,
      cite: true,
    });
    await clickRenameRun(page);
    await waitForRenameState(page, "is-error");
    assert.equal(await getRenameStatusText(page), "キーに空白・カンマ・{} は使えません。");

    await setRenameForm(page, {
      from: "sec:methods",
      to: "sec:methods-next",
      label: false,
      cite: false,
    });
    await clickRenameRun(page);
    await waitForRenameState(page, "is-error");
    assert.equal(await getRenameStatusText(page), "対象（ラベル/参照・引用）を選んでください。");

    log("[11/12] rename label/ref and verify in AI panel");
    const proposalsBeforeLabelRename = await countAiProposals(page);
    await setRenameForm(page, {
      from: "sec:methods",
      to: "sec:methods-e2e",
      label: true,
      cite: false,
    });
    const labelRenameResultPromise = waitForBridgeMessage(page, "search:renameResult", 30000);
    await clickRenameRun(page);
    const labelRenamePayload = await labelRenameResultPromise;
    assert.notEqual(
      labelRenamePayload?.__timeout,
      true,
      "search:renameResult was not received for label rename"
    );
    assert.equal(
      labelRenamePayload?.ok,
      true,
      `label rename failed: ${labelRenamePayload?.error ?? "unknown"}`
    );
    await waitForRenameState(page, "is-ok", 5000);
    assert.match(
      await getRenameStatusText(page),
      /AIパネルで確認できます。$/,
      "rename success message missing AI panel guidance"
    );

    await openSearchRenameChatInAiPanel(page);
    await page.waitForFunction(
      (baseline) => document.querySelectorAll("#ai-proposals .ai-proposal").length > baseline,
      proposalsBeforeLabelRename,
      { timeout: 30000 }
    );
    const labelRenamePaths = await getAiProposalPaths(page);
    assert.ok(labelRenamePaths.includes("main.tex"), "main.tex proposal missing after label rename");
    assert.ok(
      labelRenamePaths.includes("sections/methods.tex"),
      "sections/methods.tex proposal missing after label rename"
    );

    log("[12/12] rename cite (.bib included) and verify refs.bib proposal");
    await openSideTab(page, "search");
    const proposalsBeforeCiteRename = await countAiProposals(page);
    await setRenameForm(page, {
      from: "knuth1984",
      to: "knuth1984-e2e",
      label: false,
      cite: true,
    });
    const citeRenameResultPromise = waitForBridgeMessage(page, "search:renameResult", 30000);
    await clickRenameRun(page);
    const citeRenamePayload = await citeRenameResultPromise;
    assert.notEqual(
      citeRenamePayload?.__timeout,
      true,
      "search:renameResult was not received for cite rename"
    );
    assert.equal(
      citeRenamePayload?.ok,
      true,
      `cite rename failed: ${citeRenamePayload?.error ?? "unknown"}`
    );
    await waitForRenameState(page, "is-ok", 5000);
    assert.match(
      await getRenameStatusText(page),
      /AIパネルで確認できます。$/,
      "cite rename success message missing AI panel guidance"
    );

    await openSearchRenameChatInAiPanel(page);
    await page.waitForFunction(
      (baseline) => document.querySelectorAll("#ai-proposals .ai-proposal").length > baseline,
      proposalsBeforeCiteRename,
      { timeout: 30000 }
    );
    const citeRenamePaths = await getAiProposalPaths(page);
    assert.ok(
      citeRenamePaths.includes("refs.bib"),
      "refs.bib proposal missing after cite rename"
    );

    log("search e2e passed");
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
  console.error(error);
  process.exitCode = 1;
});

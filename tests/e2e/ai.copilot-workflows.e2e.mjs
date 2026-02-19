import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const retryLimit = Math.max(1, Number.parseInt(process.env.E2E_RETRY_LIMIT ?? "2", 10) || 1);
const scenarioRetryLimit = Math.max(
  1,
  Number.parseInt(process.env.E2E_SCENARIO_RETRY_LIMIT ?? "2", 10) || 1
);
const defaultTimeoutMs = Number.parseInt(process.env.E2E_AI_TIMEOUT_MS ?? "240000", 10);

const endpoint =
  (typeof process.env.TEX64_AI_PROXY_URL === "string" && process.env.TEX64_AI_PROXY_URL.trim()) ||
  "https://tex64.vercel.app/api/ai-chat";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[ai-copilot-e2e ${now()}] ${message}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toPosix = (value) => value.split(path.sep).join("/");

const writeFile = async (root, relativePath, content) => {
  const absolutePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
};

const writeUserSettings = async (userDataPath, patch = {}) => {
  await fs.mkdir(userDataPath, { recursive: true });
  const settingsPath = path.join(userDataPath, "tex64-user-settings.json");
  const payload = {
    agent: {
      temperature: 0.2,
      maxIterations: 40,
      stream: true,
      autoApply: false,
      autoBuild: false,
      allowRunCommand: false,
      // Disable file/read limits for E2E. We want to validate behavior, not gating.
      maxFileBytes: 0,
      maxReadFiles: 0,
      openFileMaxBytes: 0,
      openFileMaxChars: 0,
      ...patch,
    },
    recentProjects: [],
  };
  await fs.writeFile(settingsPath, JSON.stringify(payload, null, 2), "utf8");
};

const allowE2EQuit = async (app) => {
  if (!app) return;
  await app
    .evaluate(() => {
      global.__tex64E2EAllowQuit = true;
    })
    .catch(() => {});
};

const installE2EQuitGuard = async (app) => {
  if (!app) return;
  await app
    .evaluate(({ app: electronApp }) => {
      if (global.__tex64E2EQuitGuardInstalled === true) return;
      global.__tex64E2EQuitGuardInstalled = true;
      global.__tex64E2EAllowQuit = false;
      electronApp.on("before-quit", (event) => {
        if (global.__tex64E2EAllowQuit !== true) event.preventDefault();
      });
      process.on("SIGTERM", () => {
        if (global.__tex64E2EAllowQuit === true) process.exit(0);
      });
    })
    .catch(() => {});
};

const waitForLauncherVisible = async (page, timeout = 30000) => {
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
  await waitForLauncherVisible(page);
  await page.waitForSelector("#launcher-open", { timeout: 10000 });
  await page.click("#launcher-open");
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 35000 });
  await page.waitForFunction(
    () => {
      const tab = document.querySelector("#editor-tabs-list .editor-tab.is-active");
      const p = tab?.getAttribute("data-path") ?? "";
      return p.endsWith(".tex");
    },
    undefined,
    { timeout: 40000 }
  );
};

const openAiPanel = async (page) => {
  await page.evaluate(() => {
    const tab = document.querySelector('button.tab[data-tab="ai"]');
    if (tab instanceof HTMLButtonElement) {
      tab.classList.remove("is-hidden");
      tab.setAttribute("aria-hidden", "false");
      tab.click();
    }
    const panel = document.querySelector('.sidebar-panel .panel[data-panel="ai"]');
    if (panel instanceof HTMLElement) {
      panel.classList.remove("is-hidden");
      panel.classList.add("is-active");
    }
  });
  await page.waitForSelector("#ai-input", { timeout: 20000 });
};

const waitForAiIdle = async (page, timeout = defaultTimeoutMs) => {
  const waitUntilIdle = async (timeoutMs) => {
    await page.waitForFunction(
      () => {
        const send = document.getElementById("ai-send");
        const stop = document.getElementById("ai-stop");
        if (!(send instanceof HTMLButtonElement) || !(stop instanceof HTMLButtonElement)) return false;
        const sendVisible = getComputedStyle(send).display !== "none";
        const stopVisible = getComputedStyle(stop).display !== "none";
        return sendVisible && !send.disabled && !stopVisible;
      },
      undefined,
      { timeout: timeoutMs }
    );
  };

  try {
    await waitUntilIdle(timeout);
  } catch (error) {
    const canStop = await page.evaluate(() => {
      const stop = document.getElementById("ai-stop");
      if (!(stop instanceof HTMLButtonElement)) return false;
      return getComputedStyle(stop).display !== "none" && !stop.disabled;
    });
    if (!canStop) throw error;
    // DOM click avoids Playwright's "visible/enabled/stable" preconditions which can race
    // with UI transitions when the stop button is toggled rapidly.
    await page.evaluate(() => {
      const stop = document.getElementById("ai-stop");
      if (stop instanceof HTMLButtonElement) stop.click();
    });
    await waitUntilIdle(Math.min(30000, timeout));
  }
};

const waitForContinuationStart = async (page, beforeAssistantCount, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stopVisible = await page.evaluate(() => {
      const stop = document.getElementById("ai-stop");
      if (!(stop instanceof HTMLButtonElement)) return false;
      return getComputedStyle(stop).display !== "none" && !stop.disabled;
    });
    if (stopVisible) return;
    const assistantCount = await getAssistantMessageCount(page);
    if (assistantCount > beforeAssistantCount) return;
    await wait(120);
  }
  throw new Error("continuation did not start after apply-and-next");
};

const startNewChat = async (page) => {
  await waitForAiIdle(page);
  await page.click("#ai-chat-new", { force: true }).catch(() => {});
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#ai-chat-log .ai-message").length === 0 &&
      document.querySelectorAll("#ai-proposals .ai-proposal").length === 0,
    undefined,
    { timeout: 15000 }
  );
};

const sendPromptByKeyboard = async (page, prompt) => {
  await waitForAiIdle(page);
  await page.click("#ai-input", { force: true }).catch(() => {});
  await page.keyboard.insertText(prompt);
  await page.keyboard.press("Enter");
};

const waitForAssistantMessageContaining = async (page, needle, timeout = defaultTimeoutMs) => {
  await page.waitForFunction(
    (token) =>
      Array.from(document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content")).some(
        (node) => (node.textContent ?? "").includes(token)
      ),
    needle,
    { timeout }
  );
  return page.evaluate((token) => {
    const nodes = Array.from(
      document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content")
    );
    const found = nodes
      .map((node) => (node.textContent ?? "").trim())
      .filter((text) => text.includes(token))
      .pop();
    return found ?? "";
  }, needle);
};

const getAssistantMessageCount = async (page) =>
  page.evaluate(
    () => document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content").length
  );

const getLatestAssistantText = async (page) =>
  page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content")
    );
    return (nodes.at(-1)?.textContent ?? "").trim();
  });

const getProposalPaths = async (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("#ai-proposals .ai-proposal-path"))
      .map((node) => (node.textContent ?? "").trim())
      .filter(Boolean)
  );

const waitForProposalPath = async (page, targetPath, timeout = defaultTimeoutMs) => {
  await page.waitForFunction(
    (expectedPath) =>
      Array.from(document.querySelectorAll("#ai-proposals .ai-proposal-path")).some(
        (node) => (node.textContent ?? "").trim() === expectedPath
      ),
    targetPath,
    { timeout }
  );
};

const clickProposalAction = async (page, targetPath, label) => {
  const clicked = await page.evaluate(
    ({ expectedPath, actionLabel }) => {
      const cards = Array.from(document.querySelectorAll("#ai-proposals .ai-proposal"));
      const card = cards.find(
        (node) => (node.querySelector(".ai-proposal-path")?.textContent ?? "").trim() === expectedPath
      );
      if (!card) return false;
      const button = Array.from(card.querySelectorAll("button")).find(
        (node) => (node.textContent ?? "").trim() === actionLabel
      );
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    },
    { expectedPath: targetPath, actionLabel: label }
  );
  assert.ok(clicked, `proposal action not found: path=${targetPath}, label=${label}`);
};

const waitForSystemMessageContains = async (page, needle, timeout = 60000) => {
  await page.waitForFunction(
    (token) =>
      Array.from(document.querySelectorAll("#ai-chat-log .ai-message.is-system .ai-message-content")).some(
        (node) => (node.textContent ?? "").includes(token)
      ),
    needle,
    { timeout }
  );
};

const applyProposals = async (page, options = {}) => {
  const continueAfterLast = options.continueAfterLast === true;
  const allowedPaths =
    options.allowedPaths instanceof Set
      ? options.allowedPaths
      : Array.isArray(options.allowedPaths)
      ? new Set(options.allowedPaths)
      : null;
  const applied = [];

  const cards = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("#ai-proposals .ai-proposal"))
      .map((card) => {
        const id = card.getAttribute("data-proposal-id") ?? "";
        const path = (card.querySelector(".ai-proposal-path")?.textContent ?? "").trim();
        return { id, path };
      })
      .filter((entry) => Boolean(entry.id) && Boolean(entry.path));
  });

  if (cards.length === 0) {
    return { applied };
  }
  if (allowedPaths) {
    assert.ok(
      cards.every((entry) => allowedPaths.has(entry.path)),
      `unexpected proposal paths: ${cards.map((c) => c.path).join(", ")}`
    );
  }

  // If the assistant proposed multiple cards for the same file, applying them sequentially will
  // often create conflicts. Keep only the latest card per path and dismiss the rest.
  const keepIdByPath = new Map();
  cards.forEach((entry) => {
    keepIdByPath.set(entry.path, entry.id);
  });
  const dismissIds = cards
    .filter((entry) => keepIdByPath.get(entry.path) !== entry.id)
    .map((entry) => entry.id);

  for (const proposalId of dismissIds) {
    const countBefore = await page.evaluate(
      () => document.querySelectorAll("#ai-proposals .ai-proposal").length
    );
    const dismissed = await page.evaluate((id) => {
      const card = document.querySelector(`#ai-proposals .ai-proposal[data-proposal-id="${id}"]`);
      if (!(card instanceof HTMLElement)) return false;
      const button = Array.from(card.querySelectorAll("button")).find(
        (node) => (node.textContent ?? "").trim() === "取り消し"
      );
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    }, proposalId);
    assert.ok(dismissed, `failed to dismiss proposal: ${proposalId}`);
    await page.waitForFunction(
      (before) => document.querySelectorAll("#ai-proposals .ai-proposal").length === before - 1,
      countBefore,
      { timeout: 15000 }
    );
  }

  const keptPaths = Array.from(keepIdByPath.keys()).sort();
  for (let i = 0; i < keptPaths.length; i += 1) {
    const targetPath = keptPaths[i];
    const isLast = i === keptPaths.length - 1;
    const label = isLast && continueAfterLast ? "適用して次へ" : "適用";
    const assistantCountBefore = isLast && continueAfterLast ? await getAssistantMessageCount(page) : null;
    const proposalCountBefore = await page.evaluate(
      () => document.querySelectorAll("#ai-proposals .ai-proposal").length
    );
    const systemCountBefore = await page.evaluate(
      () => document.querySelectorAll("#ai-chat-log .ai-message.is-system .ai-message-content").length
    );

    await clickProposalAction(page, targetPath, label);

    const deadline = Date.now() + 60000;
    while (true) {
      if (Date.now() > deadline) {
        const debug = await page.evaluate(() => {
          const proposalPaths = Array.from(document.querySelectorAll("#ai-proposals .ai-proposal-path"))
            .map((node) => (node.textContent ?? "").trim())
            .filter(Boolean);
          const systemNodes = Array.from(
            document.querySelectorAll("#ai-chat-log .ai-message.is-system .ai-message-content")
          );
          const lastSystem = (systemNodes.at(-1)?.textContent ?? "").trim();
          return { proposalPaths, lastSystem, systemCount: systemNodes.length };
        });
        throw new Error(
          `timed out waiting for apply result (path=${targetPath}); proposals=${debug.proposalPaths.join(
            ", "
          )}; lastSystem=${JSON.stringify(debug.lastSystem)}; systemCount=${debug.systemCount}`
        );
      }

      const state = await page.evaluate(() => {
        const proposalCount = document.querySelectorAll("#ai-proposals .ai-proposal").length;
        const systemNodes = Array.from(
          document.querySelectorAll("#ai-chat-log .ai-message.is-system .ai-message-content")
        );
        const systemCount = systemNodes.length;
        const lastSystem = (systemNodes.at(-1)?.textContent ?? "").trim();
        return { proposalCount, systemCount, lastSystem };
      });

      if (state.proposalCount === proposalCountBefore - 1) {
        break;
      }
      if (state.systemCount > systemCountBefore) {
        if (state.lastSystem.startsWith("適用失敗") || state.lastSystem.startsWith("適用競合")) {
          throw new Error(`apply failed (path=${targetPath}): ${state.lastSystem}`);
        }
      }
      await wait(120);
    }

    applied.push({ path: targetPath, label });
    assert.ok(
      (await page.evaluate(() => document.querySelectorAll("#ai-proposals .ai-proposal").length)) ===
        proposalCountBefore - 1,
      "proposal count did not decrement after apply"
    );

    if (isLast && continueAfterLast && assistantCountBefore !== null) {
      await waitForContinuationStart(page, assistantCountBefore, 60000);
    }
  }

  return { applied };
};

const installBridgeCollector = async (page) => {
  await page.evaluate(() => {
    if (!Array.isArray(window.__aiCopilotE2ELog)) {
      window.__aiCopilotE2ELog = [];
    }
    window.__aiCopilotE2ELog.length = 0;
    if (typeof window.__aiCopilotE2EUnsub === "function") {
      try {
        window.__aiCopilotE2EUnsub();
      } catch {
        // noop
      }
      window.__aiCopilotE2EUnsub = null;
    }
    const bridge = window.tex64Bridge;
    if (!bridge || typeof bridge.onMessage !== "function") {
      throw new Error("tex64Bridge.onMessage is not available");
    }
    window.__aiCopilotE2EUnsub = bridge.onMessage((message) => {
      if (!message || typeof message.type !== "string") return;
      if (!message.type.startsWith("agent:")) return;
      window.__aiCopilotE2ELog.push({
        type: message.type,
        payload: message.payload ?? null,
        at: Date.now(),
      });
    });
  });
};

const getMessageLog = async (page) =>
  page.evaluate(() => (Array.isArray(window.__aiCopilotE2ELog) ? window.__aiCopilotE2ELog.slice() : []));

const countToolCalls = (entries, toolName) =>
  entries.filter((entry) => entry.type === "agent:tool" && entry.payload?.name === toolName).length;

const isRetryableError = (error) => {
  const message = String(error?.message ?? error ?? "");
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Process failed to launch") ||
    message.includes("Browser closed") ||
    message.includes("socket hang up") ||
    message.includes("Timeout") ||
    message.includes("timed out") ||
    message.includes("continuation did not start") ||
    message.includes("適用失敗") ||
    message.includes("適用競合") ||
    message.includes("apply failed") ||
    message.includes("ERR_CONNECTION")
  );
};

const createWorkspaceBuildFix = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-ai-copilot-buildfix-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "user-data");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });

  await writeFile(
    workspacePath,
    "main.tex",
    [
      "% !TEX TS-program = lualatex",
      "\\documentclass{article}",
      "\\usepackage{amsmath}",
      "\\begin{document}",
      "\\input{paper/broken}",
      "\\end{document}",
      "",
    ].join("\n")
  );

  await writeFile(
    workspacePath,
    "paper/broken.tex",
    [
      "\\section{Broken}",
      "このファイルにはE2E用の意図的なビルドエラーがあります。",
      "% TODO_MINOR_KEEP: keep this line exactly as-is.",
      "\\undefinedcommand{abc}",
      "\\begin{equation}",
      "a = b",
      "% MISSING_END_EQUATION (intentional)",
      "",
    ].join("\n")
  );

  return { tempDir, workspacePath, userDataPath };
};

const createWorkspaceLargeAuthoring = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-ai-copilot-authoring-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "user-data");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });

  await writeFile(
    workspacePath,
    "main.tex",
    [
      "% !TEX TS-program = lualatex",
      "\\documentclass{article}",
      "\\usepackage{hyperref}",
      "\\begin{document}",
      "\\input{paper/intro}",
      "% INSERT_RELATED_HERE",
      "\\input{paper/body}",
      "\\input{paper/conclusion}",
      "\\end{document}",
      "",
    ].join("\n")
  );

  await writeFile(
    workspacePath,
    "paper/intro.tex",
    ["\\section{Intro}", "既存イントロです。", ""].join("\n")
  );
  await writeFile(
    workspacePath,
    "paper/body.tex",
    ["\\section{Body}", "既存ボディです。", ""].join("\n")
  );
  await writeFile(
    workspacePath,
    "paper/conclusion.tex",
    ["\\section{Conclusion}", "既存結論です。", ""].join("\n")
  );

  return { tempDir, workspacePath, userDataPath };
};

const withApp = async ({ workspacePath, userDataPath }, runOnPage) => {
  let electronApp;
  try {
    await writeUserSettings(userDataPath);
    electronApp = await electron.launch({
      cwd: repoRoot,
      env: {
        ...process.env,
        TEX64_E2E: "1",
        TEX64_E2E_HEADLESS: "1",
        TEX64_E2E_USERDATA: userDataPath,
        TEX64_E2E_DIALOG_QUEUE: JSON.stringify({ openWorkspace: [toPosix(workspacePath)] }),
        TEX64_AI_PROXY_URL: endpoint,
        NODE_ENV: "test",
      },
      args: ["."],
    });
    await installE2EQuitGuard(electronApp);

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1680, height: 980 });
    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page);
    await openAiPanel(page);
    await installBridgeCollector(page);
    return await runOnPage(page);
  } finally {
    await allowE2EQuit(electronApp);
    await electronApp?.close().catch(() => {});
  }
};

const scenarioBuildFixLoop = async () => {
  const state = await createWorkspaceBuildFix();
  const { tempDir, workspacePath, userDataPath } = state;
  const brokenFile = path.join(workspacePath, "paper", "broken.tex");
  const mainFile = path.join(workspacePath, "main.tex");
  const pdfPath = path.join(workspacePath, "main.pdf");

  const mainBefore = await fs.readFile(mainFile, "utf8");
  assert.ok(mainBefore.includes("\\input{paper/broken}"), "workspace main.tex missing broken input");
  await fs.rm(pdfPath, { force: true }).catch(() => {});

  let results = null;
  try {
    results = await withApp({ workspacePath, userDataPath }, async (page) => {
      log("scenario build-fix-loop: sending prompt");
      await startNewChat(page);

      const prompt = [
        "main.tex をビルドして、ビルドが成功するまでエラー修正を自律的に進めてください。",
        "前提: 変更は必ず propose_patch で提案してください（ユーザーが適用します）。",
        "制約:",
        "- 必ず run_build を実行してエラーを確認する",
        "- 修正範囲は paper/broken.tex と main.tex のみ（他ファイルは変更しない）",
        "- `TODO_MINOR_KEEP` を含む行は絶対に変更しない",
        "- 提案は必要最小限にする（余計な整形や表現変更はしない）",
        "ビルド成功が確認できたら、その旨を短く報告して終了してください。",
      ].join("\n");
      await sendPromptByKeyboard(page, prompt);

      await waitForAiIdle(page, defaultTimeoutMs);

      const allowedPaths = new Set(["paper/broken.tex", "main.tex"]);
      const firstProposalPaths = await getProposalPaths(page);
      if (firstProposalPaths.length === 0) {
        const assistant = await getLatestAssistantText(page).catch(() => "");
        const entries = await getMessageLog(page).catch(() => []);
        const errors = Array.isArray(entries)
          ? entries
              .filter((entry) => entry.type === "agent:error")
              .map((entry) => entry.payload?.message)
              .filter((msg) => typeof msg === "string" && msg.trim())
          : [];
        throw new Error(
          `no proposals were produced in build-fix scenario; assistant=${JSON.stringify(
            assistant
          )}; errors=${JSON.stringify(errors)}`
        );
      }
      assert.ok(
        firstProposalPaths.every((p) => allowedPaths.has(p)),
        `unexpected proposal paths in build-fix scenario: ${firstProposalPaths.join(", ")}`
      );
      await applyProposals(page, { continueAfterLast: true, allowedPaths });

      // AI may need another patch round; loop up to 3 rounds.
      for (let round = 0; round < 3; round += 1) {
        await waitForAiIdle(page, defaultTimeoutMs);
        const proposalPaths = await getProposalPaths(page);
        const pdfExists = await fs
          .access(pdfPath)
          .then(() => true)
          .catch(() => false);

        if (proposalPaths.length === 0 && pdfExists) {
          break;
        }
        if (proposalPaths.length === 0 && !pdfExists) {
          const lastAssistant = await getLatestAssistantText(page).catch(() => "");
          throw new Error(
            `agent became idle without proposals and without PDF output; lastAssistant=${JSON.stringify(
              lastAssistant
            )}`
          );
        }
        assert.ok(
          proposalPaths.every((p) => allowedPaths.has(p)),
          `unexpected proposal paths during build-fix: ${proposalPaths.join(", ")}`
        );
        await applyProposals(page, { continueAfterLast: true, allowedPaths });
      }

      await waitForAiIdle(page, defaultTimeoutMs);
      const remainingProposalPaths = await getProposalPaths(page);
      assert.ok(
        remainingProposalPaths.every((p) => allowedPaths.has(p)),
        `unexpected remaining proposal paths in build-fix scenario: ${remainingProposalPaths.join(", ")}`
      );
      assert.ok(
        remainingProposalPaths.length <= 3,
        `too many remaining proposals in build-fix scenario: ${remainingProposalPaths.length}`
      );
      const assistantText = await getLatestAssistantText(page);
      assert.ok(assistantText.length > 20, "final assistant response too short");

      // Ensure no background auto-continue after reaching idle.
      const countA = await getAssistantMessageCount(page);
      await wait(1500);
      const countB = await getAssistantMessageCount(page);
      assert.equal(countA, countB, "assistant should not keep auto-continuing after completion");

      const entries = await getMessageLog(page);
      const runBuildCount = countToolCalls(entries, "run_build");
      const proposePatchCount = countToolCalls(entries, "propose_patch");
      assert.ok(runBuildCount >= 2, `expected run_build >= 2, got ${runBuildCount}`);
      assert.ok(proposePatchCount >= 1, `expected propose_patch >= 1, got ${proposePatchCount}`);

      return { runBuildCount, proposePatchCount };
    });

    const brokenAfter = await fs.readFile(brokenFile, "utf8");
    assert.ok(brokenAfter.includes("TODO_MINOR_KEEP"), "must not modify TODO_MINOR_KEEP line");
    const hasBeginEquation = brokenAfter.includes("\\begin{equation}");
    const hasEndEquation = brokenAfter.includes("\\end{equation}");
    assert.ok(!hasBeginEquation || hasEndEquation, "equation environment should be closed if it remains");

    const mainAfter = await fs.readFile(mainFile, "utf8");
    assert.ok(
      mainAfter.includes("\\input{paper/broken}"),
      "main.tex should keep paper/broken input (don't drop content to \"fix\" build)"
    );
    const hasActiveUndefinedCommand = brokenAfter
      .split(/\r?\n/)
      .some((line) => line.includes("\\undefinedcommand") && !line.trimStart().startsWith("%"));
    if (hasActiveUndefinedCommand) {
      const combined = `${mainAfter}\n${brokenAfter}`;
      const definitionPattern = /\\(newcommand|providecommand|def)\\s*\\{?\\\\undefinedcommand\\b/;
      assert.ok(
        definitionPattern.test(combined),
        "undefinedcommand is still used; it must be defined via newcommand/providecommand/def"
      );
    }

    const pdfStat = await fs.stat(pdfPath).catch(() => null);
    assert.ok(pdfStat && pdfStat.size > 500, `expected main.pdf to exist after successful build: ${pdfPath}`);

    return {
      name: "build-fix-loop",
      workspacePath,
      pdfPath,
      ...results,
    };
  } finally {
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    } else {
      log(`workspace kept: ${tempDir}`);
    }
  }
};

const scenarioLargeMultiFileAuthoring = async () => {
  const state = await createWorkspaceLargeAuthoring();
  const { tempDir, workspacePath, userDataPath } = state;
  const mainFile = path.join(workspacePath, "main.tex");
  const relatedFile = path.join(workspacePath, "paper", "related.tex");
  const pdfPath = path.join(workspacePath, "main.pdf");

  await fs.readFile(mainFile, "utf8");
  await fs.rm(pdfPath, { force: true }).catch(() => {});

  let results = null;
  try {
    results = await withApp({ workspacePath, userDataPath }, async (page) => {
      log("scenario large-authoring: sending prompt");
      await startNewChat(page);

      const prompt = [
        "論文の Related Work セクションを追加してください。",
        "要件:",
        "- `paper/related.tex` を新規作成し、\\section{Related Work} から始める",
        "- 内容は最低25行以上（1行1文でOK）で、執筆が進む程度に具体的に書く",
        "- main.tex の `% INSERT_RELATED_HERE` を `\\input{paper/related}` に置換して Related Work を組み込む",
        "- 変更提案は main.tex と paper/related.tex の2件だけ（他ファイルは変更しない）",
        "- LaTeXのコンパイルエラーが出ないように書く（特殊文字 _ % # & $ { } \\ は必要なら適切にエスケープ、図表/引用コマンドは使わない）",
        "最後にビルド検証も行いたいので、提案を出したら一旦止めてください（ユーザーが適用後に続行します）。",
        "適用後は main.tex を run_build で検証し、成功/失敗を短く報告してください。",
      ].join("\n");

      await sendPromptByKeyboard(page, prompt);
      await waitForProposalPath(page, "paper/related.tex", defaultTimeoutMs);
      await waitForProposalPath(page, "main.tex", defaultTimeoutMs);
      await waitForAiIdle(page, defaultTimeoutMs);

      const proposalPaths = await getProposalPaths(page);
      assert.ok(
        proposalPaths.every((p) => p === "paper/related.tex" || p === "main.tex"),
        `unexpected proposal paths: ${proposalPaths.join(", ")}`
      );

      const toolLogStartIndex = (await getMessageLog(page)).length;

      // Apply new file first, then apply-and-next main.tex to continue and run build.
      await clickProposalAction(page, "paper/related.tex", "適用");
      await waitForSystemMessageContains(page, "適用完了: paper/related.tex", 60000);
      const assistantCountBeforeContinue = await getAssistantMessageCount(page);
      await clickProposalAction(page, "main.tex", "適用して次へ");
      await waitForSystemMessageContains(page, "適用完了: main.tex", 60000);
      await waitForContinuationStart(page, assistantCountBeforeContinue, 60000);

      const allowedFixPaths = new Set([
        "main.tex",
        "paper/related.tex",
        "paper/intro.tex",
        "paper/body.tex",
        "paper/conclusion.tex",
      ]);
      for (let round = 0; round < 3; round += 1) {
        await waitForAiIdle(page, defaultTimeoutMs);
        const pdfExists = await fs
          .access(pdfPath)
          .then(() => true)
          .catch(() => false);
        if (pdfExists) {
          break;
        }
        const proposalPaths = await getProposalPaths(page);
        assert.ok(
          proposalPaths.length > 0,
          "build did not produce a PDF and no proposals were provided to fix it"
        );
        // Auto-apply only within a safe subset to avoid unrelated churn while chasing build success.
        assert.ok(
          proposalPaths.every((p) => allowedFixPaths.has(p)),
          `unexpected build-fix proposal paths: ${proposalPaths.join(", ")}`
        );
        await applyProposals(page, { continueAfterLast: true, allowedPaths: allowedFixPaths });
      }

      await waitForAiIdle(page, defaultTimeoutMs);
      const pdfExistsAfterFix = await fs
        .access(pdfPath)
        .then(() => true)
        .catch(() => false);
      if (!pdfExistsAfterFix) {
        const lastAssistant = await getLatestAssistantText(page).catch(() => "");
        const remaining = await getProposalPaths(page).catch(() => []);
        throw new Error(
          `expected PDF after build-fix loop; lastAssistant=${JSON.stringify(
            lastAssistant
          )}; proposals=${Array.isArray(remaining) ? remaining.join(", ") : ""}`
        );
      }
      const assistantText = await getLatestAssistantText(page);
      assert.ok(assistantText.length > 20, "assistant response missing after large authoring");

      // After "apply-and-next" the assistant may propose additional improvements, but it must
      // stay within the LaTeX workspace and not explode in scope.
      const continuationProposalPaths = await getProposalPaths(page);
      assert.ok(
        continuationProposalPaths.every(
          (p) =>
            p === "main.tex" ||
            (p.startsWith("paper/") && p.endsWith(".tex"))
        ),
        `unexpected proposal paths after continuation: ${continuationProposalPaths.join(", ")}`
      );
      assert.ok(
        continuationProposalPaths.length <= 6,
        `too many follow-up proposals after continuation: ${continuationProposalPaths.length}`
      );

      // Ensure no background auto-continue after reaching idle.
      const countA = await getAssistantMessageCount(page);
      await wait(1500);
      const countB = await getAssistantMessageCount(page);
      assert.equal(countA, countB, "assistant should not keep auto-continuing after completion");

      const entries = await getMessageLog(page);
      const runBuildCount = countToolCalls(entries, "run_build");
      assert.ok(runBuildCount >= 1, `expected run_build >= 1 after apply-and-next, got ${runBuildCount}`);

      const afterApplyEntries = entries.slice(toolLogStartIndex);
      const runBuildAfterApply = countToolCalls(afterApplyEntries, "run_build");
      assert.ok(
        runBuildAfterApply >= 1,
        `expected run_build to be invoked after apply-and-next, got ${runBuildAfterApply}`
      );

      return { runBuildCount };
    });

    const relatedText = await fs.readFile(relatedFile, "utf8");
    assert.ok(relatedText.includes("\\section{Related Work}"), "related.tex should start with Related Work section");
    const relatedLines = relatedText.split(/\r?\n/).filter((line) => line.trim().length > 0);
    assert.ok(relatedLines.length >= 25, `related.tex should have >= 25 non-empty lines, got ${relatedLines.length}`);

    const mainAfter = await fs.readFile(mainFile, "utf8");
    assert.ok(mainAfter.includes("\\input{paper/related}"), "main.tex should include paper/related input");
    assert.ok(!mainAfter.includes("% INSERT_RELATED_HERE"), "insert marker should be replaced");

    const pdfStat = await fs.stat(pdfPath).catch(() => null);
    assert.ok(pdfStat && pdfStat.size > 500, `expected main.pdf to exist after build: ${pdfPath}`);

    return {
      name: "large-multifile-authoring",
      workspacePath,
      pdfPath,
      ...results,
    };
  } finally {
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    } else {
      log(`workspace kept: ${tempDir}`);
    }
  }
};

const runOnce = async () => {
  const scenarios = [scenarioBuildFixLoop, scenarioLargeMultiFileAuthoring];
  const results = [];
  for (const scenario of scenarios) {
    let lastError = null;
    for (let attempt = 1; attempt <= scenarioRetryLimit; attempt += 1) {
      try {
        const result = await scenario();
        results.push({ ...result, attempt });
        break;
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error) || attempt >= scenarioRetryLimit) {
          throw error;
        }
        const text = error instanceof Error ? error.message : String(error);
        console.warn(`[ai-copilot-e2e] scenario retry ${attempt}/${scenarioRetryLimit}: ${text}`);
        await wait(800 * attempt);
      }
    }
    if (lastError && results.length === 0) {
      throw lastError;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        endpoint,
        scenarios: results,
        note: "real api + ui-driven workflows (build-fix loop + large multi-file authoring)",
      },
      null,
      2
    )
  );
};

const runWithRetries = async () => {
  let lastError = null;
  for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
    try {
      await runOnce();
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt >= retryLimit) {
        throw error;
      }
      const text = error instanceof Error ? error.message : String(error);
      console.warn(`[ai-copilot-e2e] retry ${attempt}/${retryLimit}: ${text}`);
      await wait(1200 * attempt);
    }
  }
  throw lastError ?? new Error("ai copilot workflows e2e failed");
};

runWithRetries().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

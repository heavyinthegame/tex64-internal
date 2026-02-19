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

const retryLimit = Math.max(1, Number.parseInt(process.env.E2E_RETRY_LIMIT ?? "2", 10) || 1);
const scenarioRetryLimit = Math.max(
  1,
  Number.parseInt(process.env.E2E_SCENARIO_RETRY_LIMIT ?? "4", 10) || 1
);
const endpoint =
  (typeof process.env.TEX64_AI_PROXY_URL === "string" && process.env.TEX64_AI_PROXY_URL.trim()) ||
  "https://tex64.vercel.app/api/ai-chat";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-ai-real-api-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });

  const aiRoot = path.join(workspacePath, "ai-real-api");
  await fs.mkdir(aiRoot, { recursive: true });
  await fs.writeFile(
    path.join(aiRoot, "methods.tex"),
    "This line contains TODO_REAL_PATCH and should be updated.\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(aiRoot, "search-target.tex"),
    "Search marker: TEX64_SEARCH_TOKEN\n",
    "utf8"
  );

  return { tempDir, workspacePath, aiRoot };
};

const waitForLauncherVisible = async (page, timeout = 25000) => {
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
  await waitForLauncherVisible(page, 30000);
  await page.waitForSelector("#launcher-open", { timeout: 10000 });
  await page.click("#launcher-open");
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 30000 });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 35000,
  });
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
  await page.waitForSelector('#ai-input', { timeout: 20000 });
};

const waitForInputIdle = async (page, timeoutMs = 120000) => {
  const waitUntilIdle = async (timeout) => {
    await page.waitForFunction(
      () => {
        const send = document.getElementById("ai-send");
        const stop = document.getElementById("ai-stop");
        if (!(send instanceof HTMLButtonElement) || !(stop instanceof HTMLButtonElement)) {
          return false;
        }
        const sendVisible = getComputedStyle(send).display !== "none";
        const stopVisible = getComputedStyle(stop).display !== "none";
        return sendVisible && !send.disabled && !stopVisible;
      },
      undefined,
      { timeout }
    );
  };

  try {
    await waitUntilIdle(timeoutMs);
  } catch (error) {
    const canStop = await page.evaluate(() => {
      const stop = document.getElementById("ai-stop");
      if (!(stop instanceof HTMLButtonElement)) {
        return false;
      }
      return getComputedStyle(stop).display !== "none" && !stop.disabled;
    });
    if (!canStop) {
      throw error;
    }
    await page.click("#ai-stop");
    await waitUntilIdle(Math.min(timeoutMs, 30000));
  }
};

const startFreshChat = async (page) => {
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
  await page.click("#ai-input", { force: true }).catch(() => {});
  await page.keyboard.insertText(prompt);
  await page.keyboard.press("Enter");
};

const installBridgeCollector = async (page) => {
  await page.evaluate(() => {
    if (!Array.isArray(window.__aiE2EMessageLog)) {
      window.__aiE2EMessageLog = [];
    }
    window.__aiE2EMessageLog.length = 0;
    if (typeof window.__aiE2EUnsubscribe === "function") {
      try {
        window.__aiE2EUnsubscribe();
      } catch {
        // noop
      }
      window.__aiE2EUnsubscribe = null;
    }
    const bridge = window.tex64Bridge;
    if (!bridge || typeof bridge.onMessage !== "function") {
      throw new Error("tex64Bridge.onMessage is not available");
    }
    window.__aiE2EUnsubscribe = bridge.onMessage((message) => {
      if (!message || typeof message.type !== "string") {
        return;
      }
      if (!message.type.startsWith("agent:")) {
        return;
      }
      window.__aiE2EMessageLog.push({
        type: message.type,
        payload: message.payload ?? null,
        at: Date.now(),
      });
    });
  });
};

const getMessageLog = async (page) =>
  page.evaluate(() =>
    Array.isArray(window.__aiE2EMessageLog) ? window.__aiE2EMessageLog.slice() : []
  );

const getLatestAssistantText = async (page) =>
  page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content")
    );
    return (nodes.at(-1)?.textContent ?? "").trim();
  });

const getToolsFromEntries = (entries) =>
  entries
    .filter((entry) => entry.type === "agent:tool")
    .map((entry) => entry.payload?.name)
    .filter((name) => typeof name === "string" && name.length > 0);

const getErrorsFromEntries = (entries) =>
  entries
    .filter((entry) => entry.type === "agent:error")
    .map((entry) => entry.payload?.message)
    .filter((message) => typeof message === "string" && message.trim().length > 0)
    .map((message) => message.trim());

const waitForToolsOrError = async (page, startIndex, expectedTools, timeoutMs = 90000) => {
  const deadline = Date.now() + timeoutMs;
  let lastSeenTools = [];
  while (Date.now() < deadline) {
    const log = await getMessageLog(page);
    const entries = log.slice(startIndex);
    const errors = getErrorsFromEntries(entries);
    if (errors.length > 0) {
      throw new Error(`agent:error: ${errors.at(-1)}`);
    }

    const tools = getToolsFromEntries(entries);
    lastSeenTools = tools;
    const seen = new Set(tools);
    if (expectedTools.every((name) => seen.has(name))) {
      return { entries, tools };
    }
    await wait(180);
  }

  const assistant = await getLatestAssistantText(page).catch(() => "");
  throw new Error(
    `required tools were not observed: ${expectedTools.join(",")}; seen=${JSON.stringify(
      Array.from(new Set(lastSeenTools))
    )}; assistant=${JSON.stringify(assistant)}`
  );
};

const waitForProposalPath = async (page, filePath, timeoutMs = 90000) => {
  await page.waitForFunction(
    (targetPath) => {
      const nodes = Array.from(
        document.querySelectorAll("#ai-proposals .ai-proposal .ai-proposal-path")
      );
      return nodes.some((node) => (node.textContent || "").trim() === targetPath);
    },
    filePath,
    { timeout: timeoutMs }
  );
};

const applyProposalByPath = async (page, filePath, timeoutMs = 90000) => {
  const card = page
    .locator("#ai-proposals .ai-proposal")
    .filter({ has: page.locator(".ai-proposal-path", { hasText: filePath }) })
    .first();
  await card.waitFor({ state: "visible", timeout: timeoutMs });
  await card.locator(".ai-proposal-actions .panel-button:not(.ghost)").first().click();
};

const waitForPathState = async (targetPath, shouldExist, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exists = await fs
      .access(targetPath)
      .then(() => true)
      .catch(() => false);
    if (exists === shouldExist) {
      return;
    }
    await wait(100);
  }
  throw new Error(`path state mismatch: ${targetPath} expected=${shouldExist}`);
};

const waitForFileNotContains = async (targetPath, needle, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await fs.readFile(targetPath, "utf8").catch(() => null);
    if (typeof text === "string" && !text.includes(needle)) {
      return;
    }
    await wait(120);
  }
  throw new Error(`file still contained forbidden snippet: ${targetPath}`);
};

const isRetryableError = (error) => {
  const message = String(error?.message ?? error ?? "");
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Process failed to launch") ||
    message.includes("Browser closed") ||
    message.includes("socket hang up") ||
    message.includes("timed out") ||
    message.includes("ERR_CONNECTION")
  );
};

const withScenarioApp = async (tempDir, workspacePath, scenarioId, attempt, runOnPage) => {
  const userDataPath = path.join(tempDir, `user-data-${scenarioId}-${attempt}`);
  let electronApp;
  try {
    electronApp = await electron.launch({
      cwd: repoRoot,
      env: {
        ...process.env,
        TEX64_E2E: "1",
        TEX64_E2E_HEADLESS: "1",
        TEX64_E2E_USERDATA: userDataPath,
        TEX64_E2E_DIALOG_QUEUE: JSON.stringify({
          openWorkspace: [workspacePath],
        }),
        TEX64_AI_PROXY_URL: endpoint,
        NODE_ENV: "test",
      },
      args: ["."],
    });
    await installE2EQuitGuard(electronApp);

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });
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

const runPromptScenario = async (tempDir, workspacePath, scenario) => {
  let lastError = null;

  for (let attempt = 1; attempt <= scenarioRetryLimit; attempt += 1) {
    await scenario.prepare?.();
    try {
      return await withScenarioApp(
        tempDir,
        workspacePath,
        scenario.id,
        attempt,
        async (page) => {
          let promptError = null;
          for (const prompt of scenario.prompts) {
            await startFreshChat(page);
            const startIndex = (await getMessageLog(page)).length;
            await sendPromptByKeyboard(page, prompt);
            try {
              const outcome = await waitForToolsOrError(
                page,
                startIndex,
                scenario.expectedTools,
                scenario.timeoutMs ?? 90000
              );
              if (scenario.expectedProposalPath) {
                await waitForProposalPath(page, scenario.expectedProposalPath, scenario.timeoutMs ?? 90000);
              }
              await waitForInputIdle(page, scenario.timeoutMs ?? 90000);
              await scenario.afterSuccess?.({ page, outcome });
              return {
                name: scenario.name,
                attempt,
                tools: Array.from(new Set(outcome.tools)),
                expectedProposalPath: scenario.expectedProposalPath ?? null,
              };
            } catch (error) {
              promptError = error;
              await waitForInputIdle(page).catch(() => {});
            }
          }
          throw promptError ?? new Error(`scenario failed without prompt error: ${scenario.name}`);
        }
      );
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt >= scenarioRetryLimit) {
        throw error;
      }
      await wait(350 * attempt);
    }
  }

  throw lastError ?? new Error(`scenario failed: ${scenario.name}`);
};

const runRepeatedBuildScenario = async (tempDir, workspacePath) => {
  const prompts = [
    "main.tex をビルドして、エラー/警告の有無だけを短く報告してください。必ず run_build を実行してください。",
    "もう一度 main.tex を再ビルドして、前回との差分があるか一言で返してください。必ず run_build を実行してください。",
  ];

  for (let attempt = 1; attempt <= scenarioRetryLimit; attempt += 1) {
    try {
      return await withScenarioApp(tempDir, workspacePath, "run-build-repeat", attempt, async (page) => {
        let runBuildCount = 0;
        for (const prompt of prompts) {
          await startFreshChat(page);
          const startIndex = (await getMessageLog(page)).length;
          await sendPromptByKeyboard(page, prompt);
          const outcome = await waitForToolsOrError(page, startIndex, ["run_build"], 90000);
          runBuildCount += outcome.tools.filter((name) => name === "run_build").length;
          await waitForInputIdle(page, 90000);
        }
        assert.ok(runBuildCount >= 2, `expected run_build >= 2, got ${runBuildCount}`);
        return {
          name: "run-build-repeat",
          attempt,
          tools: ["run_build"],
          runBuildCount,
          expectedProposalPath: null,
        };
      });
    } catch (error) {
      if (!isRetryableError(error) || attempt >= scenarioRetryLimit) {
        throw error;
      }
      await wait(350 * attempt);
    }
  }

  throw new Error("run-build-repeat failed");
};

const run = async () => {
  const { tempDir, workspacePath, aiRoot } = await createWorkspaceCopy();
  try {
    const scenarios = [
      {
        id: "project-structure",
        name: "project-structure",
        expectedTools: ["get_project_structure"],
        prompts: [
          "プロジェクト全体の構造を把握したいです。必ず get_project_structure を実行して、主要な tex ファイルの場所だけ短く教えてください。",
          "個別編集はせず、get_project_structure を1回実行して概要のみ返してください。",
        ],
      },
      {
        id: "search-token",
        name: "search-token",
        expectedTools: ["search_files"],
        prompts: [
          "`TEX64_SEARCH_TOKEN` の出現位置を確認したいです。必ず search_files を使って、見つかったパスだけ返してください。",
          "全文検索ツール search_files を1回実行して `TEX64_SEARCH_TOKEN` の結果を返してください。",
        ],
      },
      {
        id: "get-app-settings",
        name: "get-app-settings",
        expectedTools: ["get_app_settings"],
        prompts: [
          "compileEngine と pdfViewerMode を確認したいです。必ず get_app_settings を使って現在値を返してください。",
          "設定取得ツール get_app_settings を実行して compileEngine/pdfViewerMode を返してください。",
        ],
      },
      {
        id: "propose-patch",
        name: "propose-patch",
        expectedTools: ["propose_patch"],
        expectedProposalPath: "ai-real-api/methods.tex",
        prepare: async () => {
          await fs.writeFile(
            path.join(aiRoot, "methods.tex"),
            "This line contains TODO_REAL_PATCH and should be updated.\n",
            "utf8"
          );
        },
        prompts: [
          "`ai-real-api/methods.tex` の `TODO_REAL_PATCH` だけを置換する最小差分の提案を1件作ってください。必ず propose_patch を使ってください。",
          "変更対象は `ai-real-api/methods.tex` の `TODO_REAL_PATCH` のみです。propose_patch で1件提案してください。",
        ],
        afterSuccess: async ({ page }) => {
          const filePath = path.join(aiRoot, "methods.tex");
          await applyProposalByPath(page, "ai-real-api/methods.tex");
          await waitForFileNotContains(filePath, "TODO_REAL_PATCH");
          await waitForInputIdle(page, 60000);
        },
      },
    ];

    const results = [];
    for (const scenario of scenarios) {
      const result = await runPromptScenario(tempDir, workspacePath, scenario);
      results.push(result);
    }

    const buildResult = await runRepeatedBuildScenario(tempDir, workspacePath);
    results.push(buildResult);

    const allToolNames = results.flatMap((item) => item.tools ?? []);
    const observed = new Set(allToolNames);
    const expected = [
      "get_project_structure",
      "search_files",
      "get_app_settings",
      "propose_patch",
      "run_build",
    ];
    expected.forEach((name) => {
      assert.ok(observed.has(name), `missing expected tool: ${name}`);
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          endpoint,
          workspacePath,
          toolsVerified: expected,
          toolEvents: allToolNames.length,
          scenarios: results.map((item) => ({
            name: item.name,
            attempt: item.attempt,
            tools: item.tools,
            proposalPath: item.expectedProposalPath ?? null,
            runBuildCount: item.runBuildCount ?? null,
          })),
          note: "real api + real user input + apply verification (no mock)",
        },
        null,
        2
      )
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};

const runWithRetries = async () => {
  let lastError = null;
  for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
    try {
      await run();
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt >= retryLimit) {
        throw error;
      }
      await wait(600 * attempt);
    }
  }
  throw lastError ?? new Error("ai real api e2e failed");
};

runWithRetries().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

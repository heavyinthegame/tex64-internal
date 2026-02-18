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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-ai-real-api-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });

  const aiRoot = path.join(workspacePath, "ai-real-api");
  await fs.mkdir(aiRoot, { recursive: true });
  await fs.writeFile(
    path.join(aiRoot, "methods.tex"),
    "This line contains TODO_REAL_PATCH and should be updated.\\n",
    "utf8"
  );
  await fs.writeFile(path.join(aiRoot, "old-name.tex"), "legacy file\\n", "utf8");
  await fs.writeFile(path.join(aiRoot, "trash.tex"), "trash file\\n", "utf8");
  await fs.writeFile(
    path.join(aiRoot, "search-target.tex"),
    "Search marker: TEX64_SEARCH_TOKEN\\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(aiRoot, "symbols.tex"),
    [
      "\\section{Symbols}",
      "\\label{sec:legacy-symbol}",
      "See Section~\\ref{sec:legacy-symbol} for details.",
      "",
    ].join("\\n"),
    "utf8"
  );

  return { tempDir, workspacePath, aiRoot };
};

const postToBridge = async (page, payload) => {
  await page.evaluate((message) => {
    const bridge = window.tex64Bridge;
    if (!bridge || typeof bridge.postMessage !== "function") {
      throw new Error("tex64Bridge.postMessage is not available");
    }
    bridge.postMessage(message);
  }, payload);
};

const openWorkspace = async (page, workspacePath) => {
  await page.waitForSelector("body.is-ready", { timeout: 30000 });
  await postToBridge(page, { type: "openRecentProject", path: workspacePath });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 30000,
  });
};

const openAiPanel = async (page) => {
  await page.click('button.tab[data-tab="ai"]');
  await page.waitForSelector('.sidebar-panel .panel.is-active[data-panel="ai"]', {
    timeout: 15000,
  });
  await page.waitForSelector("#ai-input", { timeout: 15000 });
};

const waitForInputIdle = async (page, timeoutMs = 100000) => {
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
    { timeout: timeoutMs }
  );
};

const startFreshChat = async (page) => {
  await waitForInputIdle(page);
  await page.click("#ai-chat-new");
  await waitForInputIdle(page);
};

const sendPromptByKeyboard = async (page, prompt) => {
  await waitForInputIdle(page);
  await page.click("#ai-input");
  await page.keyboard.insertText(prompt);
  await page.keyboard.press("Enter");
};

const installBridgeCollector = async (page) => {
  await page.evaluate(() => {
    if (!Array.isArray(window.__aiE2EMessageLog)) {
      window.__aiE2EMessageLog = [];
    }
    if (typeof window.__aiE2EUnsubscribe === "function") {
      try {
        window.__aiE2EUnsubscribe();
      } catch {
        // ignore
      }
      window.__aiE2EUnsubscribe = null;
    }
    const bridge = window.tex64Bridge;
    if (!bridge || typeof bridge.onMessage !== "function") {
      throw new Error("tex64Bridge.onMessage is not available");
    }
    window.__aiE2EUnsubscribe = bridge.onMessage((message) => {
      if (!message || typeof message.type !== "string") return;
      if (!message.type.startsWith("agent:")) return;
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
    const last = nodes[nodes.length - 1];
    return (last?.textContent || "").trim();
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

const countToolName = (entries, targetName) =>
  entries.filter((entry) => entry.type === "agent:tool" && entry.payload?.name === targetName).length;

const waitForToolsOrError = async (page, startIndex, expectedTools, timeoutMs = 90000) => {
  const deadline = Date.now() + timeoutMs;
  let lastSeenTools = [];

  while (Date.now() < deadline) {
    const log = await getMessageLog(page);
    const entries = log.slice(startIndex);
    const errors = getErrorsFromEntries(entries);
    if (errors.length > 0) {
      throw new Error(`agent:error: ${errors[errors.length - 1]}`);
    }

    const tools = getToolsFromEntries(entries);
    lastSeenTools = tools;
    const seen = new Set(tools);
    if (expectedTools.every((name) => seen.has(name))) {
      return { tools, entries };
    }

    await wait(150);
  }

  const assistantText = await getLatestAssistantText(page).catch(() => "");
  throw new Error(
    `required tools were not observed: ${expectedTools.join(", ")}; seen=${JSON.stringify(
      Array.from(new Set(lastSeenTools))
    )}; assistant=${JSON.stringify(assistantText)}`
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

const waitForDirectory = async (targetPath, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stat = await fs.stat(targetPath).catch(() => null);
    if (stat?.isDirectory()) {
      return;
    }
    await wait(100);
  }
  throw new Error(`directory was not created: ${targetPath}`);
};

const waitForFileContains = async (targetPath, needle, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await fs.readFile(targetPath, "utf8").catch(() => null);
    if (typeof text === "string" && text.includes(needle)) {
      return;
    }
    await wait(100);
  }
  throw new Error(`file did not contain expected snippet: ${targetPath}`);
};

const waitForFileNotContains = async (targetPath, needle, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await fs.readFile(targetPath, "utf8").catch(() => null);
    if (typeof text === "string" && !text.includes(needle)) {
      return;
    }
    await wait(100);
  }
  throw new Error(`file still contained forbidden snippet: ${targetPath}`);
};

const runScenario = async (
  page,
  {
    name,
    prompts,
    expectedTools,
    expectedProposalPath = null,
    retries = 2,
    timeoutMs = 90000,
    afterSuccess = null,
  }
) => {
  let lastError = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    console.error(`[scenario] ${name} attempt ${attempt + 1}/${retries}`);
    await startFreshChat(page);
    const marker = (await getMessageLog(page)).length;
    const prompt = prompts[Math.min(attempt, prompts.length - 1)];
    await sendPromptByKeyboard(page, prompt);

    try {
      const outcome = await waitForToolsOrError(page, marker, expectedTools, timeoutMs);
      if (expectedProposalPath) {
        await waitForProposalPath(page, expectedProposalPath, timeoutMs);
      }
      await waitForInputIdle(page, timeoutMs);
      if (typeof afterSuccess === "function") {
        await afterSuccess({ page, marker, outcome, attempt: attempt + 1 });
      }
      console.error(`[scenario] ${name} ok attempt=${attempt + 1}`);
      return {
        name,
        attempt: attempt + 1,
        prompt,
        tools: Array.from(new Set(outcome.tools)),
        expectedTools,
        expectedProposalPath,
      };
    } catch (error) {
      lastError = error;
      console.error(
        `[scenario] ${name} failed attempt=${attempt + 1}: ${error?.message ?? "unknown error"}`
      );
      await waitForInputIdle(page, timeoutMs).catch(() => {});
    }
  }

  throw new Error(`[${name}] ${lastError?.message ?? "scenario failed"}`);
};

const runBuildOnceWithRetry = async (page, prompts, timeoutMs, retries = 3) => {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    await startFreshChat(page);
    const marker = (await getMessageLog(page)).length;
    const prompt = prompts[Math.min(attempt, prompts.length - 1)];
    await sendPromptByKeyboard(page, prompt);
    try {
      const outcome = await waitForToolsOrError(page, marker, ["run_build"], timeoutMs);
      await waitForInputIdle(page, timeoutMs);
      return { marker, outcome, attempt: attempt + 1 };
    } catch (error) {
      lastError = error;
      await waitForInputIdle(page, timeoutMs).catch(() => {});
    }
  }
  throw lastError ?? new Error("run_build was not observed");
};

const runRepeatedBuildScenario = async (page, timeoutMs = 100000) => {
  const name = "run-build-repeat";
  console.error(`[scenario] ${name} attempt 1/1`);

  const first = await runBuildOnceWithRetry(
    page,
    [
      "main.tex をビルドして、エラー数と警告数を短く教えてください。必ず run_build を実行してください。",
      "この依頼では他の編集をせず、main.tex のビルド検証だけ実行してください。",
      "run_build だけを使って main.tex を検証してください。",
    ],
    timeoutMs
  );

  const second = await runBuildOnceWithRetry(
    page,
    [
      "もう一度 main.tex をビルドして、前回との差分があれば一言で教えてください。必ず run_build を実行してください。",
      "再検証です。main.tex を再ビルドして結果だけ教えてください。",
      "run_build を再実行して最新結果を報告してください。",
    ],
    timeoutMs
  );

  const log = await getMessageLog(page);
  const markerMin = Math.min(first.marker, second.marker);
  const entries = log.slice(markerMin);
  const runBuildCount = countToolName(entries, "run_build");
  assert.ok(
    runBuildCount >= 2,
    `expected run_build to be called at least twice, got ${runBuildCount}`
  );

  console.error(`[scenario] ${name} ok run_build_count=${runBuildCount}`);
  return {
    name,
    attempt: 1,
    tools: ["run_build"],
    runBuildCount,
    proposalPath: null,
  };
};

const run = async () => {
  const { tempDir, workspacePath, aiRoot } = await createWorkspaceCopy();
  const endpoint =
    (typeof process.env.TEX64_AI_PROXY_URL === "string" && process.env.TEX64_AI_PROXY_URL.trim()) ||
    "https://tex64.vercel.app/api/ai-chat";

  const electronApp = await electron.launch({
    cwd: repoRoot,
    env: {
      ...process.env,
      TEX64_E2E: "1",
      TEX64_E2E_WORKSPACE: workspacePath,
      TEX64_AI_PROXY_URL: endpoint,
      NODE_ENV: "test",
    },
    args: ["."],
  });

  try {
    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });

    await openWorkspace(page, workspacePath);
    await openAiPanel(page);
    await installBridgeCollector(page);

    const scenarios = [
      {
        name: "project-structure",
        prompts: [
          "執筆前に全体像を掴みたいです。プロジェクトのフォルダ構成を確認して、主要な tex ファイルの場所を短く教えてください。",
          "個別ファイルではなく、まず全体の構造を確認した上で要点を返してください。",
        ],
        expectedTools: ["get_project_structure"],
      },
      {
        name: "index-sections-citations",
        prompts: [
          "本文の再構成をしたいです。現在の section 見出しと citation キーを一覧で整理してください。",
          "索引情報を使って sections と citations を先に確認してから回答してください。",
        ],
        expectedTools: ["get_index"],
      },
      {
        name: "search-token",
        prompts: [
          "検索の確認です。`TEX64_SEARCH_TOKEN` を含む箇所を探して、見つかったファイルパスを教えてください。",
          "プロジェクト全文検索を使って `TEX64_SEARCH_TOKEN` の出現位置を確認してください。",
        ],
        expectedTools: ["search_files"],
      },
      {
        name: "get-app-settings",
        prompts: [
          "現在のアプリ設定を確認したいです。compileEngine と pdfViewerMode と ghostCompletionEnabled を教えてください。",
          "設定取得ツールを使って compileEngine / pdfViewerMode / ghostCompletionEnabled を返してください。",
        ],
        expectedTools: ["get_app_settings"],
      },
      {
        name: "set-app-settings",
        prompts: [
          "一時的に表示モードを変えたいです。pdfViewerMode を tab に更新して、更新後の値を教えてください。",
          "設定更新を使って pdfViewerMode を tab にしてください。",
        ],
        expectedTools: ["set_app_settings"],
      },
      {
        name: "read-methods",
        prompts: [
          "`ai-real-api/methods.tex` の現在内容を確認したいです。冒頭1行だけ教えてください。",
          "まず `ai-real-api/methods.tex` の内容を読み取って、先頭行をそのまま返してください。",
        ],
        expectedTools: ["read_file"],
      },
      {
        name: "propose-write",
        prompts: [
          "調査メモを追加したいです。`ai-real-api/analysis-note.md` に3行の下書きを作る変更提案を1件ください。",
          "`ai-real-api/analysis-note.md` の新規作成提案を1件だけ出してください。",
        ],
        expectedTools: ["propose_write"],
        expectedProposalPath: "ai-real-api/analysis-note.md",
        afterSuccess: async ({ page }) => {
          const filePath = path.join(aiRoot, "analysis-note.md");
          await applyProposalByPath(page, "ai-real-api/analysis-note.md");
          await waitForPathState(filePath, true);
          await waitForInputIdle(page);
        },
      },
      {
        name: "propose-patch",
        prompts: [
          "`ai-real-api/methods.tex` の `TODO_REAL_PATCH` を学術文体の一文に置き換えたいです。最小差分の変更提案を1件ください。",
          "`ai-real-api/methods.tex` 内の `TODO_REAL_PATCH` のみを置換する修正提案を1件作ってください。",
        ],
        expectedTools: ["propose_patch"],
        expectedProposalPath: "ai-real-api/methods.tex",
        afterSuccess: async ({ page }) => {
          const filePath = path.join(aiRoot, "methods.tex");
          await applyProposalByPath(page, "ai-real-api/methods.tex");
          await waitForFileNotContains(filePath, "TODO_REAL_PATCH");
          await waitForInputIdle(page);
        },
      },
      {
        name: "propose-create-directory",
        prompts: [
          "関連研究を分割したいので、`ai-real-api/sections` ディレクトリを作る提案を1件ください。",
          "`ai-real-api/sections` を新規ディレクトリとして追加する提案を出してください。",
        ],
        expectedTools: ["propose_create_directory"],
        expectedProposalPath: "ai-real-api/sections",
        afterSuccess: async ({ page }) => {
          const dirPath = path.join(aiRoot, "sections");
          await applyProposalByPath(page, "ai-real-api/sections");
          await waitForDirectory(dirPath);
          await waitForInputIdle(page);
        },
      },
      {
        name: "propose-rename",
        prompts: [
          "`ai-real-api/old-name.tex` は名前が曖昧なので `ai-real-api/related-work.tex` に改名したいです。提案を1件ください。",
          "新規作成ではなく改名です。`ai-real-api/old-name.tex` を `ai-real-api/related-work.tex` に変更する提案をお願いします。",
        ],
        expectedTools: ["propose_rename"],
        expectedProposalPath: "ai-real-api/related-work.tex",
        afterSuccess: async ({ page }) => {
          const oldPath = path.join(aiRoot, "old-name.tex");
          const newPath = path.join(aiRoot, "related-work.tex");
          await applyProposalByPath(page, "ai-real-api/related-work.tex");
          await waitForPathState(oldPath, false);
          await waitForPathState(newPath, true);
          await waitForInputIdle(page);
        },
      },
      {
        name: "propose-delete",
        prompts: [
          "`ai-real-api/trash.tex` は不要なので削除提案を1件ください。",
          "`ai-real-api/trash.tex` を削除する変更提案を1件だけ作ってください。",
        ],
        expectedTools: ["propose_delete"],
        expectedProposalPath: "ai-real-api/trash.tex",
        afterSuccess: async ({ page }) => {
          const filePath = path.join(aiRoot, "trash.tex");
          await applyProposalByPath(page, "ai-real-api/trash.tex");
          await waitForPathState(filePath, false);
          await waitForInputIdle(page);
        },
      },
      {
        name: "rename-latex-symbol",
        prompts: [
          "label 名を整理したいです。`sec:legacy-symbol` を `sec:modern-symbol` に横断リネームしてください。",
          "LaTeX シンボルのリネーム機能を使って `sec:legacy-symbol` を `sec:modern-symbol` に変更してください。",
        ],
        expectedTools: ["rename_latex_symbol"],
        expectedProposalPath: "ai-real-api/symbols.tex",
        afterSuccess: async ({ page }) => {
          const filePath = path.join(aiRoot, "symbols.tex");
          await applyProposalByPath(page, "ai-real-api/symbols.tex");
          await waitForFileContains(filePath, "sec:modern-symbol");
          await waitForInputIdle(page);
        },
      },
    ];

    const results = [];
    for (const scenario of scenarios) {
      const result = await runScenario(page, scenario);
      results.push(result);
    }

    const repeatBuildResult = await runRepeatedBuildScenario(page);
    results.push(repeatBuildResult);

    const allToolNames = (await getMessageLog(page))
      .filter((entry) => entry.type === "agent:tool")
      .map((entry) => entry.payload?.name)
      .filter((name) => typeof name === "string" && name.length > 0);

    const observed = new Set(allToolNames);
    const expected = [
      "get_project_structure",
      "get_index",
      "search_files",
      "get_app_settings",
      "set_app_settings",
      "read_file",
      "run_build",
      "propose_write",
      "propose_patch",
      "propose_create_directory",
      "propose_rename",
      "propose_delete",
      "rename_latex_symbol",
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
            proposalPath: item.expectedProposalPath ?? item.proposalPath ?? null,
            runBuildCount: item.runBuildCount ?? null,
          })),
          note: "real api + real user input + apply verification (no mock)",
        },
        null,
        2
      )
    );
  } finally {
    await electronApp.close().catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

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

const retryLimit = Math.max(1, Number.parseInt(process.env.E2E_RETRY_LIMIT ?? "3", 10) || 1);
const scenarioRetryLimit = Math.max(
  1,
  Number.parseInt(process.env.E2E_SCENARIO_RETRY_LIMIT ?? "3", 10) || 1
);

const endpoint =
  (typeof process.env.TEX64_AI_PROXY_URL === "string" && process.env.TEX64_AI_PROXY_URL.trim()) ||
  "https://tex64.vercel.app/api/ai-chat";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[ai-functions-real-e2e ${now()}] ${message}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toPosix = (value) => value.split(path.sep).join("/");

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-ai-functions-real-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });

  const aiRoot = path.join(workspacePath, "ai-tool-e2e");
  await fs.mkdir(aiRoot, { recursive: true });

  const markers = {
    read: `READ_MARKER_${Date.now()}`,
    readA: `READ_A_${Math.random().toString(16).slice(2, 8)}`,
    readB: `READ_B_${Math.random().toString(16).slice(2, 8)}`,
    search: `SEARCH_MARKER_${Math.random().toString(16).slice(2, 8)}`,
    patch: `PATCH_TOKEN_${Math.random().toString(16).slice(2, 8)}`,
    write: `WRITE_MARKER_${Math.random().toString(16).slice(2, 8)}`,
  };

  await fs.writeFile(path.join(aiRoot, "read-target.tex"), `Target: ${markers.read}\n`, "utf8");
  await fs.writeFile(path.join(aiRoot, "read-a.tex"), `A: ${markers.readA}\n`, "utf8");
  await fs.writeFile(path.join(aiRoot, "read-b.tex"), `B: ${markers.readB}\n`, "utf8");
  await fs.writeFile(
    path.join(aiRoot, "search-target.tex"),
    `Search marker: ${markers.search}\n`,
    "utf8"
  );
  await fs.writeFile(path.join(aiRoot, "patch-target.tex"), `Before ${markers.patch}\n`, "utf8");
  await fs.writeFile(path.join(aiRoot, "rename-me.tex"), "RENAME_ME_CONTENT\n", "utf8");
  await fs.writeFile(path.join(aiRoot, "delete-me.tex"), "DELETE_ME_CONTENT\n", "utf8");

  return { tempDir, workspacePath, aiRoot, markers };
};

const writeUserSettings = async (userDataPath, patch = {}) => {
  await fs.mkdir(userDataPath, { recursive: true });
  const settingsPath = path.join(userDataPath, "tex64-user-settings.json");
  const payload = {
    agent: {
      temperature: 0.2,
      maxIterations: 30,
      stream: true,
      autoApply: false,
      autoBuild: false,
      allowRunCommand: true,
      maxFileBytes: 0,
      maxReadFiles: 0,
      openFileMaxBytes: 0,
      openFileMaxChars: 0,
      costInputPerMillion: 0,
      costOutputPerMillion: 0,
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
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 40000,
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
  await page.waitForSelector("#ai-input", { timeout: 20000 });
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
    await waitUntilIdle(Math.min(30000, timeoutMs));
  }
};

const startFreshChat = async (page) => {
  await waitForInputIdle(page);
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
    if (!Array.isArray(window.__aiFunctionsE2ELog)) {
      window.__aiFunctionsE2ELog = [];
    }
    window.__aiFunctionsE2ELog.length = 0;
    if (typeof window.__aiFunctionsE2EUnsubscribe === "function") {
      try {
        window.__aiFunctionsE2EUnsubscribe();
      } catch {
        // noop
      }
      window.__aiFunctionsE2EUnsubscribe = null;
    }
    const bridge = window.tex64Bridge;
    if (!bridge || typeof bridge.onMessage !== "function") {
      throw new Error("tex64Bridge.onMessage is not available");
    }
    window.__aiFunctionsE2EUnsubscribe = bridge.onMessage((message) => {
      if (!message || typeof message.type !== "string") {
        return;
      }
      if (!message.type.startsWith("agent:")) {
        return;
      }
      window.__aiFunctionsE2ELog.push({
        type: message.type,
        payload: message.payload ?? null,
        at: Date.now(),
      });
    });
  });
};

const getMessageLog = async (page) =>
  page.evaluate(() =>
    Array.isArray(window.__aiFunctionsE2ELog) ? window.__aiFunctionsE2ELog.slice() : []
  );

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

const getLatestAssistantText = async (page) =>
  page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content")
    );
    return (nodes.at(-1)?.textContent ?? "").trim();
  });

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
    await wait(200);
  }
  const assistant = await getLatestAssistantText(page).catch(() => "");
  throw new Error(
    `required tools not observed: ${expectedTools.join(",")}; seen=${JSON.stringify(
      Array.from(new Set(lastSeenTools))
    )}; assistant=${JSON.stringify(assistant)}`
  );
};

const waitForProposalPath = async (page, filePath, timeoutMs = 90000) => {
  await page.waitForFunction(
    (targetPath) => {
      const nodes = Array.from(document.querySelectorAll("#ai-proposals .ai-proposal-path"));
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

const waitForSystemMessageContains = async (page, needle, timeoutMs = 60000) => {
  await page.waitForFunction(
    (token) =>
      Array.from(document.querySelectorAll("#ai-chat-log .ai-message.is-system .ai-message-content"))
        .some((node) => (node.textContent ?? "").includes(token)),
    needle,
    { timeout: timeoutMs }
  );
};

const waitForPathState = async (targetPath, shouldExist, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exists = await fs
      .access(targetPath)
      .then(() => true)
      .catch(() => false);
    if (exists === shouldExist) {
      return;
    }
    await wait(120);
  }
  throw new Error(`path state mismatch: ${targetPath} expected=${shouldExist}`);
};

const waitForFileContains = async (targetPath, needle, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await fs.readFile(targetPath, "utf8").catch(() => null);
    if (typeof text === "string" && text.includes(needle)) {
      return;
    }
    await wait(150);
  }
  throw new Error(`file did not contain expected snippet: ${targetPath}`);
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

const runOnce = async () => {
  const { tempDir, workspacePath, aiRoot, markers } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  await writeUserSettings(userDataPath, { allowRunCommand: true, stream: true });

  let electronApp;
  try {
    log(`workspace: ${workspacePath}`);
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
    await page.setViewportSize({ width: 1660, height: 980 });
    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page);
    await openAiPanel(page);
    await installBridgeCollector(page);

    const scenarios = [
      {
        id: "list-files",
        name: "list-files",
        expectedTools: ["list_files"],
        prompts: [
          [
            "執筆作業の前にファイルを確認します。",
            "ai-tool-e2e 配下の一覧を必ず list_files で取得してください（directory=ai-tool-e2e）。",
            "見つかった相対パスをそのまま列挙してください。ファイル変更はしないでください。",
          ].join("\n"),
          [
            "ai-tool-e2e のファイル一覧が必要です。",
            "必ず list_files で directory=ai-tool-e2e を実行し、結果のパスだけ返してください。",
          ].join("\n"),
        ],
        assertAssistant: (text) => {
          assert.ok(text.includes("ai-tool-e2e/"), "assistant should include ai-tool-e2e paths");
        },
      },
      {
        id: "read-file",
        name: "read-file",
        expectedTools: ["read_file"],
        prompts: [
          [
            "ai-tool-e2e/read-target.tex を必ず read_file で読み取り、含まれるマーカーをそのまま返してください。",
            `期待するマーカー: ${markers.read}`,
            "ファイル変更はしないでください。",
          ].join("\n"),
        ],
        assertAssistant: (text) => {
          assert.ok(text.includes(markers.read), "assistant should echo marker from read_file");
        },
      },
      {
        id: "read-files",
        name: "read-files",
        expectedTools: ["read_files"],
        prompts: [
          [
            "ai-tool-e2e/read-a.tex と ai-tool-e2e/read-b.tex を必ず read_files で読み取り、",
            "それぞれのマーカー文字列を1行ずつ返してください。ファイル変更はしないでください。",
            `A=${markers.readA}`,
            `B=${markers.readB}`,
          ].join("\n"),
        ],
        assertAssistant: (text) => {
          assert.ok(text.includes(markers.readA), "assistant should include marker A");
          assert.ok(text.includes(markers.readB), "assistant should include marker B");
        },
      },
      {
        id: "search-files",
        name: "search-files",
        expectedTools: ["search_files"],
        prompts: [
          [
            `次のトークンがどのファイルにあるか確認したいです: ${markers.search}`,
            "必ず search_files を使って、見つかったパスだけ返してください。ファイル変更はしないでください。",
          ].join("\n"),
        ],
        assertAssistant: (text) => {
          assert.ok(
            text.includes("ai-tool-e2e/search-target.tex"),
            "assistant should include search-target path"
          );
        },
      },
      {
        id: "project-structure",
        name: "project-structure",
        expectedTools: ["get_project_structure"],
        prompts: [
          [
            "プロジェクト構造を短く把握したいです。",
            "必ず get_project_structure を1回実行して、main.tex と sections/ があることだけ確認して返してください。",
            "ファイル変更はしないでください。",
          ].join("\n"),
        ],
        assertAssistant: (text) => {
          assert.ok(text.toLowerCase().includes("main.tex"), "assistant should mention main.tex");
          assert.ok(text.includes("sections"), "assistant should mention sections");
        },
      },
      {
        id: "get-index",
        name: "get-index",
        expectedTools: ["get_index"],
        prompts: [
          [
            "執筆の参照整合性を確認します。",
            "必ず get_index を実行して labels と citations を確認し、",
            "`sec:overview` と `knuth1984` が存在するかだけ短く答えてください。",
            "ファイル変更はしないでください。",
          ].join("\n"),
        ],
        assertAssistant: (text) => {
          assert.match(text, /(sec:overview|overview)/i, "assistant should mention sec:overview");
          assert.match(text, /(knuth1984|knuth)/i, "assistant should mention knuth1984");
        },
      },
      {
        id: "settings-get-set",
        name: "settings-get-set",
        expectedTools: ["get_app_settings", "set_app_settings"],
        prompts: [
          [
            "執筆支援の設定を確認して更新します。",
            "必ず get_app_settings で pdfViewerMode を取得し、",
            "次に set_app_settings で pdfViewerMode を window に変更し、最後に window になったことを一言で確認してください。",
            "ファイル変更はしないでください。",
          ].join("\n"),
        ],
        assertAssistant: (text) => {
          assert.match(text, /window/i, "assistant should confirm pdfViewerMode window");
        },
      },
      {
        id: "rename-latex-symbol",
        name: "rename-latex-symbol",
        expectedTools: ["rename_latex_symbol"],
        prompts: [
          [
            "参照ラベルを整理します。",
            "必ず rename_latex_symbol を使って `sec:overview` を `sec:overview_ai_e2e` にリネームしてください。",
            "変更は提案として出してください（適用はしません）。",
          ].join("\n"),
        ],
        expectedProposalPaths: ["main.tex"],
        afterSuccess: async ({ page }) => {
          await applyProposalByPath(page, "main.tex");
          await waitForSystemMessageContains(page, "適用完了: main.tex", 60000);
          await waitForFileContains(path.join(workspacePath, "main.tex"), "sec:overview_ai_e2e", 20000);
        },
      },
      {
        id: "propose-write",
        name: "propose-write",
        expectedTools: ["propose_write"],
        prompts: [
          [
            "新しい節の下書きを作ります。",
            "必ず propose_write を使って `ai-tool-e2e/new-section.tex` を新規作成してください。",
            `本文中に次のマーカー行を必ず含めてください: ${markers.write}`,
          ].join("\n"),
        ],
        expectedProposalPaths: ["ai-tool-e2e/new-section.tex"],
        afterSuccess: async ({ page }) => {
          const target = path.join(aiRoot, "new-section.tex");
          await applyProposalByPath(page, "ai-tool-e2e/new-section.tex");
          await waitForSystemMessageContains(page, "適用完了: ai-tool-e2e/new-section.tex", 60000);
          await waitForPathState(target, true, 20000);
          await waitForFileContains(target, markers.write, 20000);
        },
      },
      {
        id: "propose-patch",
        name: "propose-patch",
        expectedTools: ["propose_patch"],
        prompts: [
          [
            "最小限の修正をします。",
            "必ず propose_patch を使って `ai-tool-e2e/patch-target.tex` の",
            `\`${markers.patch}\` を \`${markers.patch}_DONE\` に置換する提案を作ってください。`,
          ].join("\n"),
        ],
        expectedProposalPaths: ["ai-tool-e2e/patch-target.tex"],
        afterSuccess: async ({ page }) => {
          const target = path.join(aiRoot, "patch-target.tex");
          await applyProposalByPath(page, "ai-tool-e2e/patch-target.tex");
          await waitForSystemMessageContains(page, "適用完了: ai-tool-e2e/patch-target.tex", 60000);
          await waitForFileContains(target, `${markers.patch}_DONE`, 20000);
        },
      },
      {
        id: "propose-mkdir",
        name: "propose-mkdir",
        expectedTools: ["propose_create_directory"],
        prompts: [
          [
            "新しいフォルダを作ります。",
            "必ず propose_create_directory を使って `ai-tool-e2e/new-dir` を作成する提案を出してください。",
          ].join("\n"),
        ],
        expectedProposalPaths: ["ai-tool-e2e/new-dir"],
        afterSuccess: async ({ page }) => {
          const target = path.join(aiRoot, "new-dir");
          await applyProposalByPath(page, "ai-tool-e2e/new-dir");
          await waitForSystemMessageContains(page, "適用完了: ai-tool-e2e/new-dir", 60000);
          await waitForPathState(target, true, 20000);
        },
      },
      {
        id: "propose-rename",
        name: "propose-rename",
        expectedTools: ["propose_rename"],
        prompts: [
          [
            "ファイル名を整理します。",
            "必ず propose_rename を使って `ai-tool-e2e/rename-me.tex` を `ai-tool-e2e/renamed.tex` に移動してください。",
          ].join("\n"),
        ],
        expectedProposalPaths: ["ai-tool-e2e/renamed.tex"],
        afterSuccess: async ({ page }) => {
          const oldPath = path.join(aiRoot, "rename-me.tex");
          const newPath = path.join(aiRoot, "renamed.tex");
          await applyProposalByPath(page, "ai-tool-e2e/renamed.tex");
          await waitForSystemMessageContains(page, "適用完了: ai-tool-e2e/renamed.tex", 60000);
          await waitForPathState(oldPath, false, 20000);
          await waitForPathState(newPath, true, 20000);
          await waitForFileContains(newPath, "RENAME_ME_CONTENT", 20000);
        },
      },
      {
        id: "propose-delete",
        name: "propose-delete",
        expectedTools: ["propose_delete"],
        prompts: [
          [
            "不要ファイルを削除します。",
            "必ず propose_delete を使って `ai-tool-e2e/delete-me.tex` の削除提案を出してください。",
          ].join("\n"),
        ],
        expectedProposalPaths: ["ai-tool-e2e/delete-me.tex"],
        afterSuccess: async ({ page }) => {
          const target = path.join(aiRoot, "delete-me.tex");
          await applyProposalByPath(page, "ai-tool-e2e/delete-me.tex");
          await waitForSystemMessageContains(page, "適用完了: ai-tool-e2e/delete-me.tex", 60000);
          await waitForPathState(target, false, 20000);
        },
      },
      {
        id: "run-command",
        name: "run-command",
        expectedTools: ["run_command"],
        prompts: [
          [
            "作業ディレクトリを確認します。",
            "必ず run_command で `pwd` を実行し、出力されたパスをそのまま1行で返してください。",
            "ファイル変更はしないでください。",
          ].join("\n"),
        ],
        assertAssistant: (text) => {
          assert.ok(text.includes(workspacePath), "assistant should include pwd output path");
        },
      },
      {
        id: "run-build",
        name: "run-build",
        expectedTools: ["run_build"],
        prompts: [
          [
            "変更後にビルドで検証します。",
            "必ず run_build を実行して main.tex が成功か失敗かだけ短く答えてください。",
            "ファイル変更はしないでください。",
          ].join("\n"),
        ],
        assertAssistant: (text) => {
          assert.ok(text.length > 0, "assistant build report should not be empty");
        },
        timeoutMs: 180000,
      },
    ];

    const results = [];
    for (const scenario of scenarios) {
      log(`scenario: ${scenario.name}`);
      let lastError = null;
      for (let attempt = 1; attempt <= scenarioRetryLimit; attempt += 1) {
        await startFreshChat(page);
        const startIndex = (await getMessageLog(page)).length;
        const prompt = scenario.prompts[Math.min(attempt - 1, scenario.prompts.length - 1)];
        await sendPromptByKeyboard(page, prompt);
        try {
          const outcome = await waitForToolsOrError(
            page,
            startIndex,
            scenario.expectedTools,
            scenario.timeoutMs ?? 90000
          );
          if (Array.isArray(scenario.expectedProposalPaths)) {
            for (const expectedPath of scenario.expectedProposalPaths) {
              await waitForProposalPath(page, expectedPath, scenario.timeoutMs ?? 90000);
            }
          }
          await waitForInputIdle(page, scenario.timeoutMs ?? 90000);
          const assistantText = await getLatestAssistantText(page);
          assert.ok(assistantText.length > 0, `assistant response empty in ${scenario.name}`);
          scenario.assertAssistant?.(assistantText);
          await scenario.afterSuccess?.({ page, outcome });
          results.push({ name: scenario.name, tools: outcome.tools });
          break;
        } catch (error) {
          lastError = error;
          if (!isRetryableError(error) && attempt >= scenarioRetryLimit) {
            throw error;
          }
          await wait(450 * attempt);
        }
        if (attempt >= scenarioRetryLimit) {
          throw lastError ?? new Error(`scenario failed: ${scenario.name}`);
        }
      }
    }

    const allTools = results.flatMap((entry) => entry.tools ?? []);
    const observed = new Set(allTools);
    const expected = [
      "list_files",
      "read_file",
      "read_files",
      "search_files",
      "get_project_structure",
      "get_index",
      "rename_latex_symbol",
      "run_build",
      "run_command",
      "get_app_settings",
      "set_app_settings",
      "propose_write",
      "propose_patch",
      "propose_delete",
      "propose_rename",
      "propose_create_directory",
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
          toolEvents: allTools.length,
          scenarios: results,
          note: "real api + ui-driven prompts + tool coverage + apply verification (no mock)",
        },
        null,
        2
      )
    );
  } finally {
    await allowE2EQuit(electronApp);
    await electronApp?.close().catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
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
      console.warn(`[ai-functions-real-e2e] retry ${attempt}/${retryLimit}: ${text}`);
      await wait(800 * attempt);
    }
  }
  throw lastError ?? new Error("ai functions real e2e failed");
};

runWithRetries().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});


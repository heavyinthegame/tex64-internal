import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const sourceWorkspace = path.join(repoRoot, "test-workspace");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const poll = async (fn, { timeoutMs = 20000, intervalMs = 80, errorMessage = "timed out" } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(intervalMs);
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error(errorMessage);
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-ai-real-user-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });

  const aiRoot = path.join(workspacePath, "ai-real");
  await fs.mkdir(aiRoot, { recursive: true });
  await fs.writeFile(path.join(aiRoot, "methods.tex"), "TODO_METHOD_SENTENCE\n", "utf8");
  await fs.writeFile(path.join(aiRoot, "old-name.tex"), "old file body\n", "utf8");
  await fs.writeFile(path.join(aiRoot, "delete-me.tex"), "delete target\n", "utf8");

  return { tempDir, workspacePath };
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
    timeout: 10000,
  });
  await page.waitForSelector("#ai-input", { timeout: 10000 });
};

const waitForInputIdle = async (page) => {
  await page.waitForFunction(() => {
    const send = document.getElementById("ai-send");
    const stop = document.getElementById("ai-stop");
    if (!(send instanceof HTMLButtonElement) || !(stop instanceof HTMLButtonElement)) return false;
    const sendVisible = getComputedStyle(send).display !== "none";
    const stopVisible = getComputedStyle(stop).display !== "none";
    return sendVisible && !send.disabled && !stopVisible;
  }, { timeout: 30000 });
};

const sendPromptByKeyboard = async (page, prompt) => {
  await waitForInputIdle(page);
  await page.click("#ai-input");
  await page.keyboard.insertText(prompt);
  await page.keyboard.press("Enter");
};

const startFreshChat = async (page) => {
  await waitForInputIdle(page);
  await page.click("#ai-chat-new");
  await waitForInputIdle(page);
};

const waitForAssistantText = async (page, expectedText, timeoutMs = 20000) => {
  await page.waitForFunction(
    (needle) => {
      const nodes = Array.from(
        document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content")
      );
      return nodes.some((node) => (node.textContent || "").includes(needle));
    },
    expectedText,
    { timeout: timeoutMs }
  );
};

const waitForProposalPath = async (page, filePath) => {
  await page.waitForFunction(
    (targetPath) => {
      const nodes = Array.from(
        document.querySelectorAll("#ai-proposals .ai-proposal .ai-proposal-path")
      );
      return nodes.some((node) => (node.textContent || "").trim() === targetPath);
    },
    filePath,
    { timeout: 20000 }
  );
};

const applyProposalByPath = async (page, filePath) => {
  const card = page
    .locator("#ai-proposals .ai-proposal")
    .filter({ has: page.locator(".ai-proposal-path", { hasText: filePath }) })
    .first();
  await card.waitFor({ state: "visible", timeout: 20000 });
  await card.locator(".ai-proposal-actions .panel-button:not(.ghost)").first().click();
};

const waitForFileContains = async (filePath, snippet, timeoutMs = 15000) => {
  await poll(
    async () => {
      const text = await fs.readFile(filePath, "utf8");
      return text.includes(snippet) ? text : null;
    },
    {
      timeoutMs,
      intervalMs: 120,
      errorMessage: `file did not contain expected text: ${filePath}`,
    }
  );
};

const waitForPathState = async (targetPath, shouldExist, timeoutMs = 15000) => {
  await poll(
    async () => {
      const exists = await fs
        .access(targetPath)
        .then(() => true)
        .catch(() => false);
      return exists === shouldExist ? true : null;
    },
    {
      timeoutMs,
      intervalMs: 120,
      errorMessage: `path state mismatch: ${targetPath} expected=${shouldExist}`,
    }
  );
};

const getTextFromParts = (parts) => {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
};

const getActiveUserText = (body) => {
  const contents = Array.isArray(body?.contents) ? body.contents : [];
  for (let i = contents.length - 1; i >= 0; i -= 1) {
    const entry = contents[i];
    if (entry?.role !== "user") continue;
    return getTextFromParts(entry.parts);
  }
  return "";
};

const getLatestEntry = (body) => {
  const contents = Array.isArray(body?.contents) ? body.contents : [];
  if (contents.length === 0) return null;
  return contents[contents.length - 1] ?? null;
};

const getLatestUserText = (body) => {
  const entry = getLatestEntry(body);
  if (!entry || entry.role !== "user") return "";
  return getTextFromParts(entry.parts);
};

const getLatestToolName = (body) => {
  const entry = getLatestEntry(body);
  if (!entry || entry.role !== "tool") return "";
  const parts = Array.isArray(entry.parts) ? entry.parts : [];
  for (const part of parts) {
    const name = part?.functionResponse?.name;
    if (typeof name === "string" && name) {
      return name;
    }
  }
  return "";
};

const waitForRequest = async (requests, startIndex, predicate, timeoutMs = 15000) => {
  try {
    return await poll(
      async () => {
        for (let i = startIndex; i < requests.length; i += 1) {
          const request = requests[i];
          if (predicate(request, i)) {
            return { request, index: i };
          }
        }
        return null;
      },
      {
        timeoutMs,
        intervalMs: 80,
        errorMessage: "matching request was not observed",
      }
    );
  } catch (error) {
    const observed = requests.slice(startIndex).map((request, idx) => ({
      index: startIndex + idx,
      latestRole: getLatestEntry(request)?.role ?? "",
      user: getLatestUserText(request),
      tool: getLatestToolName(request),
      activeUser: getActiveUserText(request),
    }));
    const detail = JSON.stringify(observed, null, 2);
    throw new Error(`matching request was not observed\\nobserved=${detail}`, { cause: error });
  }
};

const jsonResponse = (payload) => JSON.stringify(payload);

const asFunctionCall = (name, args) => ({
  candidates: [
    {
      content: {
        parts: [
          {
            functionCall: {
              name,
              args,
            },
          },
        ],
      },
    },
  ],
  usageMetadata: {
    promptTokenCount: 30,
    candidatesTokenCount: 8,
    totalTokenCount: 38,
  },
});

const asText = (text) => ({
  candidates: [
    {
      content: {
        parts: [{ text }],
      },
    },
  ],
  usageMetadata: {
    promptTokenCount: 20,
    candidatesTokenCount: 10,
    totalTokenCount: 30,
  },
});

const resolveScenarioResponse = (body) => {
  const userText = getActiveUserText(body);
  const lastTool = getLatestToolName(body);

  const isIntro = userText.includes("intro-draft.tex");
  const isPatch = userText.includes("TODO_METHOD_SENTENCE");
  const isRename = userText.includes("old-name.tex") && userText.includes("related-work.tex");
  const isDelete = userText.includes("delete-me.tex");
  const isMkdir = userText.includes("appendix") && userText.includes("ディレクトリ");
  const isAnalysis = userText.includes("構成") && userText.includes("引用キー");
  const isAutonomous = userText.startsWith("執筆を自律的に継続してください。");

  if (isIntro) {
    if (lastTool === "propose_write") {
      return asText("序論草案の提案を作成しました。次に内容確認をお願いします。");
    }
    return asFunctionCall("propose_write", {
      path: "ai-real/intro-draft.tex",
      content:
        "\\section{Introduction}\\nThis draft introduces the research context and motivation.\\n",
      summary: "序論の下書きを追加",
    });
  }

  if (isPatch) {
    if (lastTool === "propose_patch") {
      return asText("methods の文体修正案を作成しました。適用して確認してください。");
    }
    return asFunctionCall("propose_patch", {
      path: "ai-real/methods.tex",
      search: "TODO_METHOD_SENTENCE",
      replace: "This section describes the method in a formal academic style.",
      replaceAll: false,
      summary: "methods の文体を論文調へ修正",
    });
  }

  if (isRename) {
    if (lastTool === "propose_rename") {
      return asText("ファイル名整理の提案を作成しました。適用してください。");
    }
    return asFunctionCall("propose_rename", {
      oldPath: "ai-real/old-name.tex",
      newPath: "ai-real/related-work.tex",
      summary: "関連研究ファイルへ改名",
    });
  }

  if (isDelete) {
    if (lastTool === "propose_delete") {
      return asText("不要ファイル削除の提案を作成しました。適用してください。");
    }
    return asFunctionCall("propose_delete", {
      path: "ai-real/delete-me.tex",
      summary: "不要ファイルを削除",
    });
  }

  if (isMkdir) {
    if (lastTool === "propose_create_directory") {
      return asText("付録用ディレクトリの提案を作成しました。適用してください。");
    }
    return asFunctionCall("propose_create_directory", {
      path: "ai-real/appendix",
      summary: "付録用ディレクトリを作成",
    });
  }

  if (isAnalysis) {
    if (lastTool === "get_project_structure") {
      return asFunctionCall("get_index", {
        kinds: ["sections", "citations"],
        limit: 20,
      });
    }
    if (lastTool === "get_index") {
      return asFunctionCall("search_files", {
        query: "TEX64_SEARCH_TOKEN",
      });
    }
    if (lastTool === "search_files") {
      return asFunctionCall("read_file", {
        path: "main.tex",
      });
    }
    if (lastTool === "read_file") {
      return asText("構成・引用キー・検索結果を確認しました。重大な破綻は見当たりません。");
    }
    return asFunctionCall("get_project_structure", {
      maxDepth: 3,
    });
  }

  if (isAutonomous) {
    if (lastTool === "propose_write") {
      return asText("自律継続の待機提案を作成しました。");
    }
    return asFunctionCall("propose_write", {
      path: "ai-real/autonomous-hold.tex",
      content: "autonomous hold\\n",
      summary: "自律継続の待機提案",
    });
  }

  return asText("リクエストを受け付けました。追加の指示をお願いします。");
};

const createMockServer = async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = {};
      }
      requests.push(body);
      const payload = resolveScenarioResponse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(jsonResponse(payload));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) {
    throw new Error("failed to start mock ai server");
  }

  return {
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
    proxyUrl: `http://127.0.0.1:${port}/ai`,
  };
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const mock = await createMockServer();

  const electronApp = await electron.launch({
    cwd: repoRoot,
    env: {
      ...process.env,
      TEX64_AI_PROXY_URL: mock.proxyUrl,
      TEX64_E2E: "1",
      TEX64_E2E_WORKSPACE: workspacePath,
      NODE_ENV: "test",
    },
    args: ["."],
  });

  try {
    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });

    await openWorkspace(page, workspacePath);
    await openAiPanel(page);
    await startFreshChat(page);

    const introPrompt =
      "関連研究との接続を意識した序論の下書きを、ai-real/intro-draft.tex に作ってください。";
    let startIndex = mock.requests.length;
    await sendPromptByKeyboard(page, introPrompt);
    await waitForRequest(mock.requests, startIndex, (request) =>
      getLatestUserText(request).includes("intro-draft.tex")
    );
    await waitForRequest(mock.requests, startIndex, (request) => getLatestToolName(request) === "propose_write");
    await waitForProposalPath(page, "ai-real/intro-draft.tex");
    await applyProposalByPath(page, "ai-real/intro-draft.tex");
    await waitForFileContains(
      path.join(workspacePath, "ai-real", "intro-draft.tex"),
      "\\section{Introduction}"
    );
    await waitForAssistantText(page, "序論草案の提案を作成しました");
    await startFreshChat(page);

    const patchPrompt =
      "methods の文章がラフなので、ai-real/methods.tex の TODO_METHOD_SENTENCE を論文調に直してください。";
    startIndex = mock.requests.length;
    await sendPromptByKeyboard(page, patchPrompt);
    await waitForRequest(mock.requests, startIndex, (request) =>
      getLatestUserText(request).includes("TODO_METHOD_SENTENCE")
    );
    await waitForRequest(mock.requests, startIndex, (request) => getLatestToolName(request) === "propose_patch");
    await waitForProposalPath(page, "ai-real/methods.tex");
    await applyProposalByPath(page, "ai-real/methods.tex");
    await waitForFileContains(
      path.join(workspacePath, "ai-real", "methods.tex"),
      "formal academic style"
    );
    await startFreshChat(page);

    const renamePrompt =
      "ファイル名を整理したいので ai-real/old-name.tex を ai-real/related-work.tex に変更してください。";
    startIndex = mock.requests.length;
    await sendPromptByKeyboard(page, renamePrompt);
    await waitForRequest(mock.requests, startIndex, (request) =>
      getLatestUserText(request).includes("related-work.tex")
    );
    await waitForRequest(mock.requests, startIndex, (request) => getLatestToolName(request) === "propose_rename");
    await waitForProposalPath(page, "ai-real/related-work.tex");
    await applyProposalByPath(page, "ai-real/related-work.tex");
    await waitForPathState(path.join(workspacePath, "ai-real", "old-name.tex"), false);
    await waitForPathState(path.join(workspacePath, "ai-real", "related-work.tex"), true);
    await startFreshChat(page);

    const deletePrompt = "不要になった ai-real/delete-me.tex を削除してください。";
    startIndex = mock.requests.length;
    await sendPromptByKeyboard(page, deletePrompt);
    await waitForRequest(mock.requests, startIndex, (request) =>
      getLatestUserText(request).includes("delete-me.tex")
    );
    await waitForRequest(mock.requests, startIndex, (request) => getLatestToolName(request) === "propose_delete");
    await waitForProposalPath(page, "ai-real/delete-me.tex");
    await applyProposalByPath(page, "ai-real/delete-me.tex");
    await waitForPathState(path.join(workspacePath, "ai-real", "delete-me.tex"), false);
    await startFreshChat(page);

    const mkdirPrompt = "付録を分けたいので ai-real/appendix ディレクトリを作ってください。";
    startIndex = mock.requests.length;
    await sendPromptByKeyboard(page, mkdirPrompt);
    await waitForRequest(mock.requests, startIndex, (request) => getLatestUserText(request).includes("appendix"));
    await waitForRequest(
      mock.requests,
      startIndex,
      (request) => getLatestToolName(request) === "propose_create_directory"
    );
    await waitForProposalPath(page, "ai-real/appendix");
    await applyProposalByPath(page, "ai-real/appendix");
    await waitForPathState(path.join(workspacePath, "ai-real", "appendix"), true);
    await startFreshChat(page);

    const analysisPrompt =
      "この原稿の構成と引用キーを確認し、問題になりそうな点だけ短く教えてください。";
    startIndex = mock.requests.length;
    await sendPromptByKeyboard(page, analysisPrompt);
    await waitForRequest(mock.requests, startIndex, (request) => getLatestToolName(request) === "get_project_structure");
    await waitForRequest(mock.requests, startIndex, (request) => getLatestToolName(request) === "get_index");
    await waitForRequest(mock.requests, startIndex, (request) => getLatestToolName(request) === "search_files");
    await waitForRequest(mock.requests, startIndex, (request) => getLatestToolName(request) === "read_file");
    await waitForAssistantText(page, "構成・引用キー・検索結果を確認しました");

    const observedToolNames = new Set(
      mock.requests
        .map((request) => getLatestToolName(request))
        .filter((name) => typeof name === "string" && name.length > 0)
    );

    const expectedTools = [
      "propose_write",
      "propose_patch",
      "propose_rename",
      "propose_delete",
      "propose_create_directory",
      "get_project_structure",
      "get_index",
      "search_files",
      "read_file",
    ];

    expectedTools.forEach((toolName) => {
      assert.ok(observedToolNames.has(toolName), `missing tool call: ${toolName}`);
    });

    await waitForInputIdle(page);

    console.log(
      JSON.stringify(
        {
          ok: true,
          workspacePath,
          requestCount: mock.requests.length,
          toolsVerified: expectedTools,
          scenarios: [
            "intro draft write",
            "methods patch",
            "rename file",
            "delete file",
            "create directory",
            "analysis chain (structure/index/search/read)",
          ],
        },
        null,
        2
      )
    );
  } finally {
    await electronApp.close().catch(() => {});
    await mock.close().catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

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
const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "220", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "40", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[ai-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const pollUntil = async (predicate, timeoutMs = 8000, intervalMs = 120) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const ok = await predicate();
      if (ok) return;
    } catch (error) {
      lastError = error;
    }
    await pause(intervalMs);
  }
  if (lastError) throw lastError;
  throw new Error(`timed out after ${timeoutMs}ms`);
};

const waitForFileText = async (filePath, validate, description, timeoutMs = 8000) => {
  let lastText = "";
  await pollUntil(async () => {
    try {
      lastText = await fs.readFile(filePath, "utf8");
    } catch {
      return false;
    }
    return validate(lastText);
  }, timeoutMs);
  if (!validate(lastText)) {
    throw new Error(`file check failed (${description}): ${filePath}`);
  }
  return lastText;
};

const pathExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const countOccurrences = (text, needle) => {
  if (!needle) return 0;
  return text.split(needle).length - 1;
};

const getLastUserPartsFromRequestBody = (body) => {
  const contents = Array.isArray(body?.contents) ? body.contents : [];
  for (let i = contents.length - 1; i >= 0; i -= 1) {
    const entry = contents[i];
    if (entry?.role !== "user") continue;
    return Array.isArray(entry.parts) ? entry.parts : [];
  }
  return [];
};

const seedAiScenarioFiles = async (workspacePath) => {
  const aiRoot = path.join(workspacePath, "ai-e2e");
  await fs.mkdir(aiRoot, { recursive: true });
  await fs.writeFile(path.join(aiRoot, "rename-source.tex"), "rename source\n", "utf8");
  await fs.writeFile(path.join(aiRoot, "delete-target.tex"), "delete target\n", "utf8");
  await fs.writeFile(path.join(aiRoot, "fail-delete.tex"), "fail delete\n", "utf8");
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-ai-"));
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
  await page.waitForSelector("body.is-ready", { timeout: 20000 });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 25000,
  });
};

const createMockAiProxy = async () => {
  const requests = [];
  const queueByKey = new Map([
    [
      "FLOW_BASIC",
      [
        {
          type: "functionCall",
          name: "propose_write",
          args: {
            path: "ai-e2e/basic.tex",
            content: "basic proposal\n",
            summary: "basic proposal",
          },
        },
        {
          type: "text",
          text: "FLOW_BASIC complete\n次の提案: 適用結果を確認してください。",
        },
      ],
    ],
    [
      "FLOW_NEXT",
      [
        {
          type: "functionCall",
          name: "propose_write",
          args: {
            path: "ai-e2e/next-1.tex",
            content: "next proposal one\n",
            summary: "next proposal one",
          },
        },
        {
          type: "text",
          text: "FLOW_NEXT first complete\n次の提案: 適用して次へを実行してください。",
        },
        {
          type: "functionCall",
          name: "propose_write",
          args: {
            path: "ai-e2e/next-2.tex",
            content: "next proposal two\n",
            summary: "next proposal two",
          },
        },
        {
          type: "text",
          text: "FLOW_NEXT autonomous complete\n次の提案: 次の修正案を確認してください。",
        },
      ],
    ],
    [
      "FLOW_PATCH",
      [
        {
          type: "functionCall",
          name: "propose_patch",
          args: {
            path: "diff-preview.tex",
            search: "alpha",
            replace: "omega",
            replaceAll: true,
            summary: "replace alpha with omega",
          },
        },
        {
          type: "text",
          text: "FLOW_PATCH complete\n次の提案: 置換結果を確認してください。",
        },
      ],
    ],
    [
      "FLOW_AUTONOMOUS_AUTHOR",
      [
        {
          type: "functionCall",
          name: "propose_write",
          args: {
            path: "ai-e2e/autonomous/author.tex",
            content:
              "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nTODO_AUTHOR_SENTENCE\n\\end{document}\n",
            summary: "autonomous draft",
          },
        },
        {
          type: "text",
          text: "FLOW_AUTONOMOUS_AUTHOR step1\n次の提案: 文章を改善してください。",
        },
        {
          type: "functionCall",
          name: "propose_patch",
          args: {
            path: "ai-e2e/autonomous/author.tex",
            search: "TODO_AUTHOR_SENTENCE",
            replace: "This section is autonomously refined.",
            replaceAll: false,
            summary: "refine draft sentence",
          },
        },
        {
          type: "text",
          text: "FLOW_AUTONOMOUS_AUTHOR step2\n次の提案: 結論節を追加してください。",
        },
        {
          type: "functionCall",
          name: "propose_patch",
          args: {
            path: "ai-e2e/autonomous/author.tex",
            search: "\\end{document}",
            replace: "\\section{Conclusion}\nAutonomous loop completed.\n\\end{document}",
            replaceAll: false,
            summary: "add conclusion section",
          },
        },
        {
          type: "text",
          text: "FLOW_AUTONOMOUS_AUTHOR step3\n次の提案: 最終確認をしてください。",
        },
      ],
    ],
    [
      "FLOW_PATCH_MULTI",
      [
        {
          type: "functionCall",
          name: "propose_patch",
          args: {
            edits: [
              {
                path: "sections/intro.tex",
                search: "TEX64_SEARCH_TOKEN",
                replace: "AI_MULTI_TOKEN",
                replaceAll: false,
              },
              {
                path: "sections/methods.tex",
                search: "TEX64_SEARCH_TOKEN",
                replace: "AI_MULTI_TOKEN",
                replaceAll: false,
              },
            ],
            summary: "multi-file patch",
          },
        },
        {
          type: "text",
          text: "FLOW_PATCH_MULTI complete\n次の提案: 複数ファイルの適用結果を確認してください。",
        },
      ],
    ],
    [
      "FLOW_MULTIMODAL",
      [
        {
          type: "text",
          text: "FLOW_MULTIMODAL complete\n次の提案: 画像入力を確認しました。",
        },
      ],
    ],
    [
      "FLOW_MODAL_APPLY",
      [
        {
          type: "functionCall",
          name: "propose_write",
          args: {
            path: "ai-e2e/modal-apply.tex",
            content: "applied through modal\n",
            summary: "modal apply write",
          },
        },
        {
          type: "text",
          text: "FLOW_MODAL_APPLY complete\n次の提案: モーダル適用を確認してください。",
        },
      ],
    ],
    [
      "FLOW_MKDIR",
      [
        {
          type: "functionCall",
          name: "propose_create_directory",
          args: {
            path: "ai-e2e/new-folder/inner",
            summary: "create nested folder",
          },
        },
        {
          type: "text",
          text: "FLOW_MKDIR complete\n次の提案: フォルダ作成結果を確認してください。",
        },
      ],
    ],
    [
      "FLOW_RENAME",
      [
        {
          type: "functionCall",
          name: "propose_rename",
          args: {
            oldPath: "ai-e2e/rename-source.tex",
            newPath: "ai-e2e/renamed/renamed.tex",
            summary: "rename source file",
          },
        },
        {
          type: "text",
          text: "FLOW_RENAME complete\n次の提案: リネーム結果を確認してください。",
        },
      ],
    ],
    [
      "FLOW_DELETE",
      [
        {
          type: "functionCall",
          name: "propose_delete",
          args: {
            path: "ai-e2e/delete-target.tex",
            summary: "delete target file",
          },
        },
        {
          type: "text",
          text: "FLOW_DELETE complete\n次の提案: 削除結果を確認してください。",
        },
      ],
    ],
    [
      "FLOW_FAIL_APPLY",
      [
        {
          type: "functionCall",
          name: "propose_delete",
          args: {
            path: "ai-e2e/fail-delete.tex",
            summary: "delete file after external removal",
          },
        },
        {
          type: "text",
          text: "FLOW_FAIL_APPLY complete\n次の提案: 適用失敗ハンドリングを確認してください。",
        },
      ],
    ],
    [
      "FLOW_API_ERROR",
      [
        {
          type: "httpError",
          status: 500,
          error: "mock API failed for e2e",
        },
      ],
    ],
    [
      "FLOW_STREAM",
      [
        {
          type: "sseText",
          chunks: ["STREAM chunk A ", "STREAM chunk B"],
          delayMs: 420,
        },
      ],
    ],
    [
      "FLOW_CONTEXT",
      [
        {
          type: "text",
          text: "FLOW_CONTEXT complete\n次の提案: context payload を確認してください。",
        },
      ],
    ],
    [
      "PARALLEL_A",
      [
        {
          type: "functionCall",
          delayMs: 1800,
          name: "propose_write",
          args: {
            path: "ai-e2e/parallel-a.tex",
            content: "parallel a proposal\n",
            summary: "parallel a proposal",
          },
        },
        {
          type: "text",
          text: "PARALLEL_A complete\n次の提案: 適用内容を確認してください。",
        },
      ],
    ],
    [
      "PARALLEL_B",
      [
        {
          type: "functionCall",
          delayMs: 2500,
          name: "propose_write",
          args: {
            path: "ai-e2e/parallel-b.tex",
            content: "parallel b proposal\n",
            summary: "parallel b proposal",
          },
        },
        {
          type: "text",
          text: "PARALLEL_B complete\n次の提案: 適用内容を確認してください。",
        },
      ],
    ],
  ]);

  const extractScenarioKey = (contents) => {
    if (!Array.isArray(contents)) return "DEFAULT";
    let found = "DEFAULT";
    for (const entry of contents) {
      const parts = Array.isArray(entry?.parts) ? entry.parts : [];
      for (const part of parts) {
        const text = typeof part?.text === "string" ? part.text : "";
        const match = text.match(/\[\[AI_E2E:([A-Z0-9_]+)\]\]/);
        if (match) found = match[1];
      }
    }
    return found;
  };

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = {};
      }
      const key = extractScenarioKey(body?.contents);
      const queue = queueByKey.get(key) ?? [];
      const step = queue.shift() ?? {
        type: "text",
        text: `${key} fallback response\n次の提案: なし`,
      };
      requests.push({ key, at: Date.now(), stepType: step.type, body });

      if (step.type === "httpError") {
        const status = Number.isFinite(step.status) ? Math.max(400, step.status) : 500;
        const errorBody =
          typeof step.error === "string" && step.error.trim()
            ? { error: step.error.trim() }
            : { error: `HTTP ${status}` };
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(errorBody));
        return;
      }

      if (step.type === "sseText") {
        const chunks = Array.isArray(step.chunks)
          ? step.chunks.filter((entry) => typeof entry === "string" && entry.length > 0)
          : [];
        const textChunks = chunks.length > 0 ? chunks : ["STREAM fallback"];
        const delayMs =
          Number.isFinite(step.delayMs) && step.delayMs > 0 ? Math.floor(step.delayMs) : 180;
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const writeSse = (payload) => {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        for (let i = 0; i < textChunks.length; i += 1) {
          writeSse({
            candidates: [{ content: { parts: [{ text: textChunks[i] }] } }],
          });
          if (i < textChunks.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
        writeSse({
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 8,
            totalTokenCount: 20,
          },
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      if (Number.isFinite(step.delayMs) && step.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      }

      const part =
        step.type === "functionCall"
          ? { functionCall: { name: step.name, args: step.args ?? {} } }
          : { text: typeof step.text === "string" ? step.text : "ok" };
      const payload = {
        candidates: [{ content: { parts: [part] } }],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 8,
          totalTokenCount: 20,
        },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) throw new Error("failed to start mock ai proxy");

  return {
    proxyUrl: `http://127.0.0.1:${port}/ai`,
    countByKey: (key) => requests.filter((entry) => entry.key === key).length,
    lastRequestByKey: (key) => {
      const filtered = requests.filter((entry) => entry.key === key);
      return filtered.length > 0 ? filtered[filtered.length - 1] : null;
    },
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
    },
  };
};

const openAiTab = async (page) => {
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
    }
  });
  await page.waitForSelector('.sidebar-panel .panel.is-active[data-panel="ai"]', {
    timeout: 15000,
  });
};

const openHistory = async (page) => {
  await page.evaluate(() => {
    const history = document.getElementById("ai-history");
    if (history?.classList.contains("is-open")) return;
    const toggle = document.getElementById("ai-history-toggle");
    if (toggle instanceof HTMLButtonElement) toggle.click();
  });
  await page.waitForFunction(
    () => document.getElementById("ai-history")?.classList.contains("is-open") === true,
    undefined,
    { timeout: 5000 }
  );
};

const sendAiMessage = async (page, message) => {
  await page.fill("#ai-input", message);
  await page.click("#ai-send");
};

const sendAiMessageWithShiftEnter = async (page, firstLine, secondLine) => {
  await page.fill("#ai-input", firstLine);
  await page.focus("#ai-input");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type(secondLine);
  await page.keyboard.press("Enter");
};

const attachAiImage = async (page, filePath, expectedCount = 1) => {
  await page.setInputFiles("#ai-attach-input", filePath);
  await page.waitForFunction(
    (count) => document.querySelectorAll("#ai-attachments .ai-attachment-chip").length === count,
    expectedCount,
    { timeout: 5000 }
  );
};

const attachAiImageBuffer = async (page, payload, expectedCount = 1) => {
  await page.setInputFiles("#ai-attach-input", payload);
  await page.waitForFunction(
    (count) => document.querySelectorAll("#ai-attachments .ai-attachment-chip").length === count,
    expectedCount,
    { timeout: 5000 }
  );
};

const clearAiAttachments = async (page) => {
  await page.evaluate(() => {
    const removeButtons = Array.from(
      document.querySelectorAll("#ai-attachments .ai-attachment-remove")
    );
    removeButtons.forEach((button) => {
      if (button instanceof HTMLButtonElement) {
        button.click();
      }
    });
  });
  await page.waitForFunction(
    () => document.querySelectorAll("#ai-attachments .ai-attachment-chip").length === 0,
    undefined,
    { timeout: 5000 }
  );
};

const waitForAssistantText = async (page, needle, timeout = 30000) => {
  await page.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content"))
        .map((node) => (node.textContent ?? "").trim())
        .some((text) => text.includes(expected)),
    needle,
    { timeout }
  );
};

const waitForUserText = async (page, needle, timeout = 30000) => {
  await page.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll("#ai-chat-log .ai-message.is-user .ai-message-content"))
        .map((node) => node.textContent ?? "")
        .some((text) => text.includes(expected)),
    needle,
    { timeout }
  );
};

const waitForSystemText = async (page, needle, timeout = 30000) => {
  await page.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll("#ai-chat-log .ai-message.is-system .ai-message-content"))
        .map((node) => (node.textContent ?? "").trim())
        .some((text) => text.includes(expected)),
    needle,
    { timeout }
  );
};

const waitForNoticeText = async (page, needle, timeout = 10000) => {
  await page.waitForFunction(
    (expected) => {
      const statusText = document.getElementById("ai-status")?.textContent ?? "";
      if (statusText.includes(expected)) return true;
      return Array.from(document.querySelectorAll("#ai-chat-log .ai-message.is-system .ai-message-content"))
        .map((node) => (node.textContent ?? "").trim())
        .some((text) => text.includes(expected));
    },
    needle,
    { timeout }
  );
};

const waitForStatusText = async (page, needle, timeout = 10000) => {
  await page.waitForFunction(
    (expected) => (document.getElementById("ai-status")?.textContent ?? "").includes(expected),
    needle,
    { timeout }
  );
};

const waitForProposalCount = async (page, expectedCount, timeout = 30000) => {
  await page.waitForFunction(
    (count) => document.querySelectorAll("#ai-proposals .ai-proposal").length === count,
    expectedCount,
    { timeout }
  );
};

const waitForProposalCountAtLeast = async (page, expectedCount, timeout = 30000) => {
  await page.waitForFunction(
    (count) => document.querySelectorAll("#ai-proposals .ai-proposal").length >= count,
    expectedCount,
    { timeout }
  );
};

const clickFirstProposalButton = async (page, label) => {
  const clicked = await page.evaluate((targetLabel) => {
    const card = document.querySelector("#ai-proposals .ai-proposal");
    if (!(card instanceof HTMLElement)) return false;
    const button = Array.from(card.querySelectorAll("button")).find(
      (node) => (node.textContent ?? "").trim() === targetLabel
    );
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  }, label);
  assert.equal(clicked, true, `proposal button not found: ${label}`);
};

const clickProposalButtonByPath = async (page, proposalPath, label) => {
  const clicked = await page.evaluate(
    (params) => {
      const cards = Array.from(document.querySelectorAll("#ai-proposals .ai-proposal"));
      const card = cards.find(
        (entry) =>
          (entry.querySelector(".ai-proposal-path")?.textContent ?? "").trim() === params.path
      );
      if (!(card instanceof HTMLElement)) return false;
      const button = Array.from(card.querySelectorAll("button")).find(
        (node) => (node.textContent ?? "").trim() === params.label
      );
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    },
    { path: proposalPath, label }
  );
  assert.equal(clicked, true, `proposal button not found: ${proposalPath} / ${label}`);
};

const closeDiffModalIfOpen = async (page) => {
  await page.evaluate(() => {
    const cancel = document.getElementById("diff-modal-cancel");
    if (!(cancel instanceof HTMLButtonElement)) return;
    const modal = document.getElementById("diff-modal");
    if (modal?.classList.contains("is-open")) {
      cancel.click();
    }
  });
};

const waitForDiffModalOpen = async (page, timeout = 5000) => {
  await page.waitForFunction(
    () => document.getElementById("diff-modal")?.classList.contains("is-open") === true,
    undefined,
    { timeout }
  );
};

const getDiffSubmitLabel = async (page) => {
  return page.evaluate(() => {
    const submit = document.getElementById("diff-modal-submit");
    return (submit?.textContent ?? "").trim();
  });
};

const waitForProposalPath = async (page, expectedPath, timeout = 30000) => {
  await page.waitForFunction(
    (pathValue) =>
      Array.from(document.querySelectorAll("#ai-proposals .ai-proposal .ai-proposal-path"))
        .map((node) => (node.textContent ?? "").trim())
        .includes(pathValue),
    expectedPath,
    { timeout }
  );
};

const getTopbarTitle = async (page) => {
  return page.evaluate(() => (document.getElementById("ai-topbar-title")?.textContent ?? "").trim());
};

const clickHistoryItemByText = async (page, needle) => {
  const clicked = await page.evaluate((targetText) => {
    if (!targetText) return false;
    const items = Array.from(document.querySelectorAll("#ai-history-list .ai-history-item"));
    const target = items.find((item) =>
      (item.textContent ?? "").includes(targetText)
    );
    if (!(target instanceof HTMLButtonElement)) return false;
    target.click();
    return true;
  }, needle);
  assert.equal(clicked, true, `history item not found for text: ${needle}`);
};

const waitForSendEnabled = async (page, timeout = 10000) => {
  await page.waitForFunction(
    () => {
      const send = document.getElementById("ai-send");
      return send instanceof HTMLButtonElement && !send.disabled;
    },
    undefined,
    { timeout }
  );
};

const waitForRunningHistoryCount = async (page, expectedCount, timeout = 30000) => {
  await page.waitForFunction(
    (count) => document.querySelectorAll("#ai-history-list .ai-history-item.is-running").length === count,
    expectedCount,
    { timeout }
  );
};

const waitForRunningHistoryCountAtLeast = async (page, expectedCount, timeout = 30000) => {
  await page.waitForFunction(
    (count) => document.querySelectorAll("#ai-history-list .ai-history-item.is-running").length >= count,
    expectedCount,
    { timeout }
  );
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  let electronApp;
  let mockProxy;

  try {
    await seedAiScenarioFiles(workspacePath);
    mockProxy = await createMockAiProxy();
    log(`workspace copy: ${workspacePath}`);
    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: {
        ...process.env,
        TEX64_AI_PROXY_URL: mockProxy.proxyUrl,
      },
    });

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });

    log("open workspace");
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await openAiTab(page);
    await openHistory(page);

    const basicFilePath = path.join(workspacePath, "ai-e2e", "basic.tex");
    const next1FilePath = path.join(workspacePath, "ai-e2e", "next-1.tex");
    const next2FilePath = path.join(workspacePath, "ai-e2e", "next-2.tex");
    const patchFilePath = path.join(workspacePath, "diff-preview.tex");
    const autonomousFilePath = path.join(workspacePath, "ai-e2e", "autonomous", "author.tex");
    const modalApplyPath = path.join(workspacePath, "ai-e2e", "modal-apply.tex");
    const mkdirPath = path.join(workspacePath, "ai-e2e", "new-folder", "inner");
    const renameSourcePath = path.join(workspacePath, "ai-e2e", "rename-source.tex");
    const renameTargetPath = path.join(workspacePath, "ai-e2e", "renamed", "renamed.tex");
    const deleteTargetPath = path.join(workspacePath, "ai-e2e", "delete-target.tex");
    const failDeletePath = path.join(workspacePath, "ai-e2e", "fail-delete.tex");
    const multimodalImagePath = path.join(workspacePath, "figures", "sample-image.png");
    const oversizedImageBuffer = Buffer.alloc(6 * 1024 * 1024, 0x88);
    const totalLimitImageA = Buffer.alloc(5 * 1024 * 1024, 0x33);
    const totalLimitImageB = Buffer.alloc(4 * 1024 * 1024, 0x44);

    log("[1/16] basic message -> proposal -> preview -> apply -> file verify");
    await sendAiMessage(page, "[[AI_E2E:FLOW_BASIC]] basic flow");
    await waitForProposalCountAtLeast(page, 1);
    await waitForAssistantText(page, "FLOW_BASIC complete");
    await clickFirstProposalButton(page, "差分を見る");
    await waitForDiffModalOpen(page);
    await closeDiffModalIfOpen(page);
    await clickFirstProposalButton(page, "適用");
    await waitForProposalCount(page, 0);
    await waitForSystemText(page, "適用完了: ai-e2e/basic.tex");
    const basicText = await waitForFileText(
      basicFilePath,
      (text) => text === "basic proposal\n",
      "basic file should contain applied content"
    );
    assert.equal(basicText, "basic proposal\n");
    await page.evaluate(() => {
      const stop = document.getElementById("ai-stop");
      if (stop instanceof HTMLButtonElement && !stop.disabled) {
        stop.click();
      }
    });
    await pause(180);

    log("[2/16] apply-and-next triggers autonomous continuation");
    await page.click("#ai-chat-new");
    await sendAiMessage(page, "[[AI_E2E:FLOW_NEXT]] apply-next flow");
    await waitForProposalPath(page, "ai-e2e/next-1.tex");
    await clickFirstProposalButton(page, "適用して次へ");
    await waitForSystemText(page, "適用完了: ai-e2e/next-1.tex");
    const next1Text = await waitForFileText(
      next1FilePath,
      (text) => text === "next proposal one\n",
      "next-1 should be applied"
    );
    assert.equal(next1Text, "next proposal one\n");
    await waitForProposalPath(page, "ai-e2e/next-2.tex");
    assert.equal(await pathExists(next2FilePath), false, "next-2 must not be applied yet");
    assert.ok(
      mockProxy.countByKey("FLOW_NEXT") >= 4,
      `expected autonomous continuation requests, got ${mockProxy.countByKey("FLOW_NEXT")}`
    );

    log("[3/16] no implicit API continuation after apply");
    await page.click("#ai-chat-new");
    await sendAiMessage(page, "[[AI_E2E:FLOW_AUTONOMOUS_AUTHOR]] autonomous author flow");
    await waitForProposalPath(page, "ai-e2e/autonomous/author.tex");
    await waitForAssistantText(page, "FLOW_AUTONOMOUS_AUTHOR step1");
    await clickProposalButtonByPath(page, "ai-e2e/autonomous/author.tex", "適用");
    await waitForSystemText(page, "適用完了: ai-e2e/autonomous/author.tex");
    await waitForProposalCount(page, 0);
    const autonomousText = await waitForFileText(
      autonomousFilePath,
      (text) => text.includes("\\section{Intro}") && text.includes("TODO_AUTHOR_SENTENCE"),
      "single applied proposal should not auto-run follow-up rewrites"
    );
    assert.ok(
      !autonomousText.includes("\\section{Conclusion}"),
      "without explicit continue, conclusion should not be auto-added"
    );
    await pause(700);
    await waitForProposalCount(page, 0);
    assert.ok(
      mockProxy.countByKey("FLOW_AUTONOMOUS_AUTHOR") <= 2,
      `should not trigger extra API calls after apply, got ${mockProxy.countByKey("FLOW_AUTONOMOUS_AUTHOR")}`
    );
    const autonomousUserMessageCount = await page.locator("#ai-chat-log .ai-message.is-user").count();
    assert.equal(
      autonomousUserMessageCount,
      1,
      "single-instruction chat should remain single-turn unless user explicitly continues"
    );
    await page.evaluate(() => {
      const stop = document.getElementById("ai-stop");
      if (stop instanceof HTMLButtonElement && !stop.disabled) {
        stop.click();
      }
    });
    await pause(180);

    log("[4/16] patch proposal -> apply -> replacement verify");
    await page.click("#ai-chat-new");
    await sendAiMessage(page, "[[AI_E2E:FLOW_PATCH]] patch flow");
    await waitForProposalPath(page, "diff-preview.tex");
    await waitForAssistantText(page, "FLOW_PATCH complete");
    await clickFirstProposalButton(page, "差分を見る");
    await waitForDiffModalOpen(page);
    await page.waitForFunction(
      () => {
        const modalText = document.getElementById("diff-modal")?.textContent ?? "";
        const inlineText =
          document.querySelector("#ai-proposals .ai-proposal .ai-proposal-diff")?.textContent ?? "";
        return modalText.includes("omega") || inlineText.includes("omega");
      },
      undefined,
      { timeout: 5000 }
    );
    await closeDiffModalIfOpen(page);
    await clickFirstProposalButton(page, "適用");
    await waitForProposalCount(page, 0);
    await waitForSystemText(page, "適用完了: diff-preview.tex");
    const patchText = await waitForFileText(
      patchFilePath,
      (text) =>
        text.includes("omega 1") &&
        text.includes("\nomega\n") &&
        !text.includes("alpha"),
      "diff-preview replacement should be applied"
    );
    assert.equal(countOccurrences(patchText, "alpha"), 0, "all alpha tokens must be replaced");
    assert.equal(countOccurrences(patchText, "omega"), 2, "omega should appear in two places");

    log("[5/16] multi-file patch -> each proposal apply");
    await page.click("#ai-chat-new");
    await sendAiMessage(page, "[[AI_E2E:FLOW_PATCH_MULTI]] patch multi flow");
    await waitForProposalCountAtLeast(page, 2);
    await waitForProposalPath(page, "sections/intro.tex");
    await waitForProposalPath(page, "sections/methods.tex");
    await waitForAssistantText(page, "FLOW_PATCH_MULTI complete");
    await clickProposalButtonByPath(page, "sections/intro.tex", "適用");
    await waitForSystemText(page, "適用完了: sections/intro.tex");
    await clickProposalButtonByPath(page, "sections/methods.tex", "適用");
    await waitForSystemText(page, "適用完了: sections/methods.tex");
    await waitForProposalCount(page, 0);
    const introFilePath = path.join(workspacePath, "sections", "intro.tex");
    const methodsFilePath = path.join(workspacePath, "sections", "methods.tex");
    const introText = await waitForFileText(
      introFilePath,
      (text) => text.includes("AI_MULTI_TOKEN"),
      "intro should be replaced by multi patch"
    );
    const methodsText = await waitForFileText(
      methodsFilePath,
      (text) => text.includes("AI_MULTI_TOKEN"),
      "methods should be replaced by multi patch"
    );
    assert.equal(
      countOccurrences(introText, "AI_MULTI_TOKEN"),
      1,
      "intro token should be replaced once"
    );
    assert.equal(
      countOccurrences(methodsText, "AI_MULTI_TOKEN"),
      1,
      "methods token should be replaced once"
    );

    log("[6/16] apply via diff modal submit");
    await page.click("#ai-chat-new");
    await sendAiMessage(page, "[[AI_E2E:FLOW_MODAL_APPLY]] modal apply flow");
    await waitForProposalPath(page, "ai-e2e/modal-apply.tex");
    await waitForAssistantText(page, "FLOW_MODAL_APPLY complete");
    await clickProposalButtonByPath(page, "ai-e2e/modal-apply.tex", "差分を見る");
    await waitForDiffModalOpen(page);
    assert.equal(await getDiffSubmitLabel(page), "適用", "modal submit label should match apply");
    await page.click("#diff-modal-submit");
    await waitForProposalCount(page, 0);
    await waitForSystemText(page, "適用完了: ai-e2e/modal-apply.tex");
    const modalText = await waitForFileText(
      modalApplyPath,
      (text) => text === "applied through modal\n",
      "modal apply should write expected content"
    );
    assert.equal(modalText, "applied through modal\n");

    log("[7/16] mkdir proposal detail and apply");
    await page.click("#ai-chat-new");
    await sendAiMessage(page, "[[AI_E2E:FLOW_MKDIR]] mkdir flow");
    await waitForProposalPath(page, "ai-e2e/new-folder/inner");
    await waitForAssistantText(page, "FLOW_MKDIR complete");
    await clickProposalButtonByPath(page, "ai-e2e/new-folder/inner", "詳細を見る");
    await page.waitForFunction(
      () =>
        (document.querySelector(
          "#ai-proposals .ai-proposal .ai-proposal-diff.is-open .ai-proposal-diff-note"
        )?.textContent ?? "").includes("新しいフォルダを作成します。"),
      undefined,
      { timeout: 5000 }
    );
    await clickProposalButtonByPath(page, "ai-e2e/new-folder/inner", "作成");
    await waitForProposalCount(page, 0);
    await waitForSystemText(page, "適用完了: ai-e2e/new-folder/inner");
    await pollUntil(async () => {
      const stat = await fs.stat(mkdirPath).catch(() => null);
      return Boolean(stat?.isDirectory());
    }, 8000);

    log("[8/16] rename proposal detail and apply");
    await page.click("#ai-chat-new");
    await sendAiMessage(page, "[[AI_E2E:FLOW_RENAME]] rename flow");
    await waitForProposalPath(page, "ai-e2e/renamed/renamed.tex");
    await waitForAssistantText(page, "FLOW_RENAME complete");
    await clickProposalButtonByPath(page, "ai-e2e/renamed/renamed.tex", "詳細を見る");
    await page.waitForFunction(
      () => {
        const note =
          document.querySelector(
            "#ai-proposals .ai-proposal .ai-proposal-diff.is-open .ai-proposal-diff-note"
          )?.textContent ?? "";
        return note.includes("ai-e2e/rename-source.tex") && note.includes("ai-e2e/renamed/renamed.tex");
      },
      undefined,
      { timeout: 5000 }
    );
    await clickProposalButtonByPath(page, "ai-e2e/renamed/renamed.tex", "移動");
    await waitForProposalCount(page, 0);
    await waitForSystemText(page, "適用完了: ai-e2e/renamed/renamed.tex");
    assert.equal(await pathExists(renameSourcePath), false, "rename source should be removed");
    const renamedText = await waitForFileText(
      renameTargetPath,
      (text) => text === "rename source\n",
      "rename target should have source content"
    );
    assert.equal(renamedText, "rename source\n");

    log("[9/16] delete proposal via modal submit (label check)");
    await page.click("#ai-chat-new");
    await sendAiMessage(page, "[[AI_E2E:FLOW_DELETE]] delete flow");
    await waitForProposalPath(page, "ai-e2e/delete-target.tex");
    await waitForAssistantText(page, "FLOW_DELETE complete");
    await clickProposalButtonByPath(page, "ai-e2e/delete-target.tex", "差分を見る");
    await waitForDiffModalOpen(page);
    assert.equal(await getDiffSubmitLabel(page), "削除", "delete modal submit label should be 削除");
    await page.click("#diff-modal-submit");
    await waitForProposalCount(page, 0);
    await waitForSystemText(page, "適用完了: ai-e2e/delete-target.tex");
    assert.equal(await pathExists(deleteTargetPath), false, "delete target should be removed");

    log("[10/16] apply failure surfaces in chat and proposal stays");
    await page.click("#ai-chat-new");
    await sendAiMessage(page, "[[AI_E2E:FLOW_FAIL_APPLY]] fail apply flow");
    await waitForProposalPath(page, "ai-e2e/fail-delete.tex");
    await waitForAssistantText(page, "FLOW_FAIL_APPLY complete");
    await fs.rm(failDeletePath, { force: true });
    await clickProposalButtonByPath(page, "ai-e2e/fail-delete.tex", "削除");
    await waitForSystemText(page, "適用競合:");
    await waitForProposalPath(page, "ai-e2e/fail-delete.tex");
    await clickProposalButtonByPath(page, "ai-e2e/fail-delete.tex", "取り消し");
    await waitForProposalCount(page, 0);

    log("[11/16] proxy API error handling and recovery");
    await page.click("#ai-chat-new");
    await sendAiMessage(page, "[[AI_E2E:FLOW_API_ERROR]] api error flow");
    await waitForSystemText(page, "mock API failed for e2e");
    await waitForSendEnabled(page);

    log("[12/16] streaming delta and multiline input");
    await page.click("#ai-chat-new");
    await sendAiMessageWithShiftEnter(
      page,
      "[[AI_E2E:FLOW_STREAM]] stream line one",
      "stream line two"
    );
    await waitForUserText(page, "stream line one\nstream line two");
    await page.waitForFunction(
      () =>
        Array.from(
          document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content")
        )
          .map((node) => (node.textContent ?? "").trim())
          .some((text) => text.includes("STREAM chunk A") && !text.includes("STREAM chunk B")),
      undefined,
      { timeout: 8000 }
    );
    await waitForAssistantText(page, "STREAM chunk A STREAM chunk B");
    assert.ok(mockProxy.countByKey("FLOW_STREAM") >= 1, "stream scenario should call proxy");

    log("[13/16] multimodal message includes inline image payload");
    await page.click("#ai-chat-new");
    await attachAiImage(page, multimodalImagePath, 1);
    await sendAiMessage(page, "[[AI_E2E:FLOW_MULTIMODAL]] multimodal flow");
    await waitForUserText(page, "[添付画像 1件]");
    await page.waitForFunction(
      () => document.querySelectorAll("#ai-attachments .ai-attachment-chip").length === 0,
      undefined,
      { timeout: 5000 }
    );
    await waitForAssistantText(page, "FLOW_MULTIMODAL complete");
    const multimodalRequest = mockProxy.lastRequestByKey("FLOW_MULTIMODAL");
    assert.ok(multimodalRequest, "multimodal request should be captured");
    const multimodalParts = getLastUserPartsFromRequestBody(multimodalRequest?.body);
    const multimodalImagePart = multimodalParts.find((part) => {
      const mimeType = part?.inlineData?.mimeType ?? "";
      const data = part?.inlineData?.data ?? "";
      return (
        typeof mimeType === "string" &&
        mimeType.startsWith("image/") &&
        typeof data === "string" &&
        data.length > 40
      );
    });
    assert.ok(multimodalImagePart, "inline image data should be included in user parts");
    assert.ok(
      multimodalParts.some(
        (part) =>
          typeof part?.text === "string" && part.text.includes("[[AI_E2E:FLOW_MULTIMODAL]]")
      ),
      "multimodal message text should be included in user parts"
    );

    log("[14/16] attachment validation for size and total limit");
    await page.evaluate(() => {
      const stop = document.getElementById("ai-stop");
      if (stop instanceof HTMLButtonElement && !stop.disabled) {
        stop.click();
      }
    });
    await openHistory(page);
    await waitForRunningHistoryCount(page, 0, 10000);
    await page.click("#ai-chat-new");
    await attachAiImageBuffer(
      page,
      {
        name: "too-large.png",
        mimeType: "image/png",
        buffer: oversizedImageBuffer,
      },
      0
    );
    await attachAiImageBuffer(
      page,
      {
        name: "limit-a.png",
        mimeType: "image/png",
        buffer: totalLimitImageA,
      },
      1
    );
    await attachAiImageBuffer(
      page,
      {
        name: "limit-b.png",
        mimeType: "image/png",
        buffer: totalLimitImageB,
      },
      1
    );
    await clearAiAttachments(page);

    log("[15/16] context payload defaults");
    await page.click("#ai-chat-new");
    await sendAiMessage(page, "[[AI_E2E:FLOW_CONTEXT]] context flow");
    await waitForAssistantText(page, "FLOW_CONTEXT complete");
    const contextRequest = mockProxy.lastRequestByKey("FLOW_CONTEXT");
    assert.ok(contextRequest, "context request should be captured");
    const systemPrompt =
      contextRequest?.body?.systemInstruction?.parts?.[0]?.text ??
      contextRequest?.body?.systemInstruction?.parts?.[0]?.inlineData?.data ??
      "";
    assert.ok(systemPrompt.includes("## ワークスペース"), "system prompt should include workspace section");
    assert.ok(systemPrompt.includes("- Active file: main.tex"), "active file path should be passed");
    assert.ok(systemPrompt.includes("## Active file snapshot"), "active file snapshot should be attached");
    assert.ok(
      systemPrompt.includes("- Context controls: selection=on, openFiles=on, issues=on"),
      "default context controls should be reflected in system prompt"
    );
    assert.ok(
      !systemPrompt.includes("- User referenced files:"),
      "explicit context refs should not be included without a dedicated input field"
    );
    assert.ok(
      systemPrompt.includes("\\title{tex64 Test Workspace}"),
      "active file content should include main.tex snapshot"
    );
    assert.ok(systemPrompt.includes("- Open files:"), "open files list should be included by default");

    log("[16/16] history switch + parallel run + stop active chat");
    await page.click("#ai-chat-new");
    await waitForProposalCount(page, 0);
    const freshChatTitle = await getTopbarTitle(page);
    assert.equal(freshChatTitle, "新規チャット", "new chat title should be shown");
    const messageCount = await page.locator("#ai-chat-log .ai-message").count();
    assert.equal(messageCount, 0, "new chat should start with empty log");
    await openHistory(page);
    const historyCount = await page.locator("#ai-history-list .ai-history-item").count();
    assert.ok(historyCount >= 6, "history should contain multiple chats");
    await clickHistoryItemByText(page, "FLOW_NEXT");
    await waitForProposalPath(page, "ai-e2e/next-2.tex");
    await page.click("#ai-chat-new");
    await waitForProposalCount(page, 0);

    await sendAiMessage(page, "[[AI_E2E:PARALLEL_A]] parallel a");
    await page.click("#ai-chat-new");
    await sendAiMessage(page, "[[AI_E2E:PARALLEL_B]] parallel b");
    await openHistory(page);
    await waitForRunningHistoryCountAtLeast(page, 2, 8000);

    await page.click("#ai-stop");
    await waitForSendEnabled(page);
    await waitForRunningHistoryCount(page, 1, 10000);
    await waitForRunningHistoryCount(page, 0, 30000);
    assert.ok(
      mockProxy.countByKey("PARALLEL_A") >= 2,
      `parallel A should complete run, got ${mockProxy.countByKey("PARALLEL_A")}`
    );
    assert.ok(
      mockProxy.countByKey("PARALLEL_B") >= 1,
      `parallel B should start run, got ${mockProxy.countByKey("PARALLEL_B")}`
    );

    log("ai e2e passed");
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    if (mockProxy) {
      await mockProxy.close();
    }
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log("workspace copy removed");
    } else {
      log(`workspace copy kept: ${tempDir}`);
    }
    await pause(10);
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

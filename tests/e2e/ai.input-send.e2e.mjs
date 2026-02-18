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

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-ai-input-"));
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

const waitForAssistantContains = async (page, text, timeoutMs = 15000) => {
  await page.waitForFunction(
    (needle) => {
      const nodes = Array.from(
        document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content")
      );
      return nodes.some((node) => (node.textContent || "").includes(needle));
    },
    text,
    { timeout: timeoutMs }
  );
};

const getLastUserParts = (body) => {
  const contents = Array.isArray(body?.contents) ? body.contents : [];
  for (let i = contents.length - 1; i >= 0; i -= 1) {
    const entry = contents[i];
    if (entry?.role !== "user") continue;
    return Array.isArray(entry.parts) ? entry.parts : [];
  }
  return [];
};

const readUserText = (parts) =>
  parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();

const waitForMatchingRequest = async (requests, startIndex, predicate, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    for (let i = startIndex; i < requests.length; i += 1) {
      const request = requests[i];
      if (predicate(request)) {
        return request;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  const observed = requests
    .slice(startIndex)
    .map((request) => readUserText(getLastUserParts(request)))
    .filter((entry) => typeof entry === "string" && entry.length > 0);
  throw new Error(
    `timed out while waiting for matching AI request; observed=${JSON.stringify(observed)}`
  );
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const requests = [];

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
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
      const payload = {
        candidates: [{ content: { parts: [{ text: "INPUT_SEND_ACK" }] } }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
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
  if (!port) {
    throw new Error("failed to allocate ai mock server port");
  }

  const electronApp = await electron.launch({
    cwd: repoRoot,
    env: {
      ...process.env,
      TEX64_AI_PROXY_URL: `http://127.0.0.1:${port}/ai`,
      TEX64_E2E: "1",
      TEX64_E2E_WORKSPACE: workspacePath,
      NODE_ENV: "test",
    },
    args: ["."],
  });

  try {
    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await openAiTab(page);

    const step1Text = "実入力テスト1: click send";
    const step1RequestStart = requests.length;
    await page.click("#ai-input");
    await page.keyboard.type(step1Text, { delay: 5 });
    await page.click("#ai-send");
    const step1Request = await waitForMatchingRequest(
      requests,
      step1RequestStart,
      (request) => readUserText(getLastUserParts(request)) === step1Text
    );
    assert.ok(step1Request, "step1: matching user request should exist");

    await page.click("#ai-chat-new");
    const step2Text = "実入力テスト2: enter send";
    const step2RequestStart = requests.length;
    await page.click("#ai-input");
    await page.keyboard.type(step2Text, { delay: 5 });
    await page.keyboard.press("Enter");
    const step2Request = await waitForMatchingRequest(
      requests,
      step2RequestStart,
      (request) => readUserText(getLastUserParts(request)) === step2Text
    );
    assert.ok(step2Request, "step2: matching user request should exist");

    await page.click("#ai-chat-new");
    const multilineA = "実入力テスト3: first line";
    const multilineB = "second line";
    const multilineText = `${multilineA}\n${multilineB}`;
    const step3RequestStart = requests.length;
    await page.click("#ai-input");
    await page.keyboard.type(multilineA, { delay: 5 });
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(multilineB, { delay: 5 });
    await page.keyboard.press("Enter");
    const step3Request = await waitForMatchingRequest(
      requests,
      step3RequestStart,
      (request) => readUserText(getLastUserParts(request)) === multilineText
    );
    assert.ok(step3Request, "step3: matching user request should exist");

    const imagePath = path.join(workspacePath, "figures", "sample-image.png");
    const step4Text = "実入力テスト4: image + text";
    await page.click("#ai-chat-new");
    const step4RequestStart = requests.length;
    await page.setInputFiles("#ai-attach-input", imagePath);
    await page.waitForSelector("#ai-attachments .ai-attachment-chip", { timeout: 5000 });
    await page.click("#ai-input");
    await page.keyboard.type(step4Text, { delay: 5 });
    await page.click("#ai-send");
    const step4Request = await waitForMatchingRequest(
      requests,
      step4RequestStart,
      (request) => {
        const parts = getLastUserParts(request);
        const text = readUserText(parts);
        const hasImagePart = parts.some(
          (part) => part?.inlineData && typeof part.inlineData.data === "string"
        );
        return text === step4Text && hasImagePart;
      }
    );
    assert.ok(step4Request, "step4: matching user request should exist");
    {
      const parts = getLastUserParts(step4Request);
      const text = readUserText(parts);
      const imageParts = parts.filter(
        (part) => part?.inlineData && typeof part.inlineData.data === "string"
      );
      assert.equal(text, step4Text, "step4: text part mismatch");
      assert.ok(imageParts.length >= 1, "step4: inlineData image part should exist");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          requests: requests.length,
          checks: [
            "click send",
            "enter send",
            "shift+enter newline",
            "image attach + send",
          ],
        },
        null,
        2
      )
    );
  } finally {
    await electronApp.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

await run();

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
const retryLimit = Math.max(1, Number.parseInt(process.env.E2E_RETRY_LIMIT ?? "8", 10) || 1);
const scenarioRetryLimit = Math.max(
  1,
  Number.parseInt(process.env.E2E_SCENARIO_RETRY_LIMIT ?? "6", 10) || 1
);
const endpoint =
  (typeof process.env.TEX64_AI_PROXY_URL === "string" && process.env.TEX64_AI_PROXY_URL.trim()) ||
  "https://tex64.vercel.app/api/ai-chat";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-ai-input-real-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const waitForLauncherVisible = async (page, timeout = 20000) => {
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
  await waitForLauncherVisible(page, 25000);
  await page.waitForSelector("#launcher-open", { timeout: 10000 });
  await page.click("#launcher-open");
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 25000 });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 30000,
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

const waitForAiIdle = async (page, timeoutMs = 120000) => {
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
      const stopVisible = getComputedStyle(stop).display !== "none";
      return stopVisible && !stop.disabled;
    });
    if (!canStop) {
      throw error;
    }
    await page.click("#ai-stop");
    await waitUntilIdle(Math.min(30000, timeoutMs));
  }
};

const startFreshChat = async (page) => {
  await waitForAiIdle(page);
  await page.click("#ai-chat-new");
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#ai-chat-log .ai-message").length === 0 &&
      document.querySelectorAll("#ai-proposals .ai-proposal").length === 0,
    undefined,
    { timeout: 15000 }
  );
};

const waitForUserMessageContains = async (page, needle, timeoutMs = 15000) => {
  await page.waitForFunction(
    (token) =>
      Array.from(document.querySelectorAll("#ai-chat-log .ai-message.is-user .ai-message-content")).some(
        (node) => (node.textContent || "").includes(token)
      ),
    needle,
    { timeout: timeoutMs }
  );
};

const getAssistantMessageCount = async (page) =>
  page.evaluate(
    () => document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content").length
  );

const waitForAssistantMessageAfter = async (page, baselineCount, timeoutMs = 120000) => {
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content").length > count,
    baselineCount,
    { timeout: timeoutMs }
  );
  const lastText = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content")
    );
    return (nodes.at(-1)?.textContent ?? "").trim();
  });
  assert.ok(lastText.length > 0, "assistant response should not be empty");
};

const sendByButton = async (page, text) => {
  const baselineAssistant = await getAssistantMessageCount(page);
  await page.click("#ai-input");
  await page.keyboard.insertText(text);
  await page.click("#ai-send");
  await waitForUserMessageContains(page, text);
  await waitForAssistantMessageAfter(page, baselineAssistant);
};

const sendByEnter = async (page, text) => {
  const baselineAssistant = await getAssistantMessageCount(page);
  await page.click("#ai-input");
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
  await waitForUserMessageContains(page, text);
  await waitForAssistantMessageAfter(page, baselineAssistant);
};

const sendMultilineByShiftEnter = async (page, lineA, lineB) => {
  const text = `${lineA}\n${lineB}`;
  const baselineAssistant = await getAssistantMessageCount(page);
  await page.click("#ai-input");
  await page.keyboard.insertText(lineA);
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.insertText(lineB);
  await page.keyboard.press("Enter");
  await waitForUserMessageContains(page, lineA);
  await waitForUserMessageContains(page, lineB);
  await waitForAssistantMessageAfter(page, baselineAssistant);
  return text;
};

const sendWithImageAttachment = async (page, imagePath, text) => {
  const baselineAssistant = await getAssistantMessageCount(page);
  await page.setInputFiles("#ai-attach-input", imagePath);
  await page.waitForSelector("#ai-attachments .ai-attachment-chip", { timeout: 8000 });
  await page.click("#ai-input");
  await page.keyboard.insertText(text);
  await page.click("#ai-send");
  await waitForUserMessageContains(page, text);
  await waitForAssistantMessageAfter(page, baselineAssistant);
};

const isRetryableError = (error) => {
  const message = String(error?.message ?? error ?? "");
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Process failed to launch") ||
    message.includes("Browser closed") ||
    message.includes("socket hang up") ||
    message.includes("timed out")
  );
};

const runScenario = async (tempDir, workspacePath, scenarioId, execute) => {
  let attempt = 1;
  while (attempt <= scenarioRetryLimit) {
    const userDataPath = path.join(tempDir, `user-data-${scenarioId}-${attempt}`);
    let electronApp;
    try {
      electronApp = await electron.launch({
        cwd: repoRoot,
        env: {
          ...process.env,
          TEX64_AI_PROXY_URL: endpoint,
          TEX64_E2E: "1",
          TEX64_E2E_HEADLESS: "1",
          TEX64_E2E_USERDATA: userDataPath,
          TEX64_E2E_DIALOG_QUEUE: JSON.stringify({
            openWorkspace: [workspacePath],
          }),
          NODE_ENV: "test",
        },
        args: ["."],
      });

      const page = await electronApp.firstWindow();
      await page.setViewportSize({ width: 1440, height: 900 });
      await openWorkspaceViaLauncher(page);
      await waitForWorkspaceReady(page);
      await openAiTab(page);
      await startFreshChat(page);
      await execute(page);
      return;
    } catch (error) {
      if (!isRetryableError(error) || attempt >= scenarioRetryLimit) {
        throw error;
      }
      await wait(400 * attempt);
      attempt += 1;
    } finally {
      await electronApp?.close().catch(() => {});
    }
  }
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();

  try {
    await runScenario(tempDir, workspacePath, "click", async (page) => {
      await sendByButton(
        page,
        "UI送信テスト1(click)。ツールを使わず『受信OK-1』とだけ返答してください。"
      );
    });

    await runScenario(tempDir, workspacePath, "enter", async (page) => {
      await sendByEnter(
        page,
        "UI送信テスト2(enter)。ツールを使わず『受信OK-2』とだけ返答してください。"
      );
    });

    await runScenario(tempDir, workspacePath, "shift-enter", async (page) => {
      await sendMultilineByShiftEnter(
        page,
        "UI送信テスト3(shift+enter)。",
        "ツールを使わず『受信OK-3』とだけ返答してください。"
      );
    });

    const imagePath = path.join(workspacePath, "figures", "sample-image.png");
    await runScenario(tempDir, workspacePath, "image", async (page) => {
      await sendWithImageAttachment(
        page,
        imagePath,
        "UI送信テスト4(image)。ツールを使わず『受信OK-4』とだけ返答してください。"
      );
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          endpoint,
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
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

const runWithRetries = async () => {
  let attempt = 1;
  while (attempt <= retryLimit) {
    try {
      await run();
      return;
    } catch (error) {
      if (!isRetryableError(error) || attempt >= retryLimit) {
        throw error;
      }
      await wait(500 * attempt);
      attempt += 1;
    }
  }
};

runWithRetries().catch((error) => {
  console.error("[ai-input-send-e2e] FAILED");
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});

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
const retryLimit = Math.max(1, Number.parseInt(process.env.E2E_RETRY_LIMIT ?? "12", 10) || 1);

const toPosix = (value) => value.split(path.sep).join("/");

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-ai-attachments-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "user-data");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  return { tempDir, workspacePath, userDataPath };
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
  await page.waitForSelector("body.is-ready", { timeout: 20000 });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 25000,
  });
};

const clickSelectorDom = async (page, selector) => {
  const clicked = await page.evaluate((targetSelector) => {
    const target = document.querySelector(targetSelector);
    if (!(target instanceof HTMLElement)) return false;
    target.click();
    return true;
  }, selector);
  assert.equal(clicked, true, `click target not found: ${selector}`);
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

const waitForAttachmentCount = async (page, expectedCount, timeoutMs = 8000) => {
  await page.waitForFunction(
    (count) => document.querySelectorAll("#ai-attachments .ai-attachment-chip").length === count,
    expectedCount,
    { timeout: timeoutMs }
  );
};

const waitForNoticeText = async (page, needle, timeoutMs = 12000) => {
  await page.waitForFunction(
    (expected) => {
      const statusText = document.getElementById("ai-status")?.textContent ?? "";
      if (statusText.includes(expected)) return true;
      return Array.from(
        document.querySelectorAll("#ai-chat-log .ai-message.is-system .ai-message-content")
      )
        .map((node) => (node.textContent ?? "").trim())
        .some((text) => text.includes(expected));
    },
    needle,
    { timeout: timeoutMs }
  );
};

const clearAttachments = async (page) => {
  const deadline = Date.now() + 12000;
  while (Date.now() <= deadline) {
    const remaining = await page.evaluate(() => {
      const remove = document.querySelector("#ai-attachments .ai-attachment-remove");
      if (!(remove instanceof HTMLButtonElement)) return 0;
      remove.click();
      return document.querySelectorAll("#ai-attachments .ai-attachment-chip").length;
    });
    if (remaining === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("timed out while clearing attachments");
};

const runOnce = async () => {
  const { tempDir, workspacePath, userDataPath } = await createWorkspaceCopy();
  let electronApp;
  try {
    electronApp = await electron.launch({
      cwd: repoRoot,
      env: {
        ...process.env,
        TEX64_E2E: "1",
        TEX64_E2E_HEADLESS: "1",
        TEX64_E2E_USERDATA: userDataPath,
        TEX64_E2E_DIALOG_QUEUE: JSON.stringify({ openWorkspace: [toPosix(workspacePath)] }),
      },
      args: ["."],
    });

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1520, height: 920 });
    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page);
    await openAiTab(page);
    await clickSelectorDom(page, "#ai-chat-new");

    const tooLargeImage = {
      name: "too-large.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 0x9a),
    };
    const totalLimitImageA = {
      name: "limit-a.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(4 * 1024 * 1024 + 256 * 1024, 0x33),
    };
    const totalLimitImageB = {
      name: "limit-b.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(4 * 1024 * 1024 + 128 * 1024, 0x44),
    };
    const countLimitImages = Array.from({ length: 5 }, (_, index) => ({
      name: `count-limit-${index + 1}.png`,
      mimeType: "image/png",
      buffer: Buffer.alloc(64 * 1024, 0x21 + index),
    }));

    await page.setInputFiles("#ai-attach-input", tooLargeImage);
    await waitForAttachmentCount(page, 0);
    await waitForNoticeText(page, "5MBを超える画像は添付できません");

    await page.setInputFiles("#ai-attach-input", totalLimitImageA);
    await waitForAttachmentCount(page, 1);
    await page.setInputFiles("#ai-attach-input", totalLimitImageB);
    await waitForAttachmentCount(page, 1);
    await waitForNoticeText(page, "添付画像の合計サイズは8MBまでです。");
    await clearAttachments(page);

    await page.setInputFiles("#ai-attach-input", countLimitImages);
    await waitForAttachmentCount(page, 4);
    await waitForNoticeText(page, "画像添付は最大4件までです。");
    await clearAttachments(page);

    await page.setInputFiles("#ai-attach-input", {
      name: "not-image.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("not-image", "utf8"),
    });
    await waitForAttachmentCount(page, 0);
    await waitForNoticeText(page, "画像ファイルのみ添付できます");

    await page.evaluate(() => {
      const proto = FileReader.prototype;
      const key = "__tex64E2EOriginalReadAsDataURL";
      const existing = proto[key];
      if (typeof existing !== "function") {
        Object.defineProperty(proto, key, {
          value: proto.readAsDataURL,
          configurable: true,
          writable: false,
        });
      }
      proto.readAsDataURL = function (file) {
        if (file && typeof file.name === "string" && file.name.includes("force-read-error")) {
          window.setTimeout(() => {
            if (typeof this.onerror === "function") {
              this.onerror(new ProgressEvent("error"));
            }
          }, 0);
          return;
        }
        return proto[key].call(this, file);
      };
    });
    try {
      await page.setInputFiles("#ai-attach-input", {
        name: "force-read-error.png",
        mimeType: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      });
      await waitForAttachmentCount(page, 0);
      await waitForNoticeText(page, "画像の読み込みに失敗したため添付できませんでした");
    } finally {
      await page.evaluate(() => {
        const proto = FileReader.prototype;
        const key = "__tex64E2EOriginalReadAsDataURL";
        if (typeof proto[key] === "function") {
          proto.readAsDataURL = proto[key];
        }
      });
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          checks: [
            "single-size-limit",
            "total-size-limit",
            "max-count-limit",
            "non-image-rejection",
            "read-failure-rejection",
          ],
        },
        null,
        2
      )
    );
  } finally {
    await electronApp?.close().catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

const isRetryableError = (error) => {
  const message = String(error?.message ?? error ?? "");
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Process failed to launch") ||
    message.includes("Browser closed") ||
    message.includes("socket hang up")
  );
};

const runWithRetries = async () => {
  let attempt = 1;
  while (attempt <= retryLimit) {
    try {
      await runOnce();
      return;
    } catch (error) {
      if (!isRetryableError(error) || attempt >= retryLimit) {
        throw error;
      }
      const text = error instanceof Error ? error.message : String(error);
      console.warn(`[ai-attachments-e2e] retry ${attempt}/${retryLimit}: ${text}`);
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
};

await runWithRetries();

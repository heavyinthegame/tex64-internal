import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  launchApp,
  createTempDir,
  writeWorkspaceFile,
  removeDir,
  repoRoot,
} from "./helpers.js";

const BASE_MAIN = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Main",
  "\\end{document}",
  "",
].join("\n");

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+0LwAAAABJRU5ErkJggg==";

const TEXT = {
  status: {
    ready: "\u6e96\u5099\u5b8c\u4e86",
  },
  unsupported: {
    title: "\u975e\u5bfe\u5fdc\u30d5\u30a1\u30a4\u30eb\u3067\u3059",
    desc: "\u3053\u306e\u30d5\u30a1\u30a4\u30eb\u5f62\u5f0f\u306f\u30a8\u30c7\u30a3\u30bf\u3067\u958b\u3051\u307e\u305b\u3093\u3002",
  },
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("#file-tree");
  await page.waitForSelector('button.file-item[data-path="main.tex"]');
  await page.waitForFunction(() => !!window.__tex180Editor);
  await page.waitForSelector('.editor-tab.is-active[data-path="main.tex"]');
};

const setLocalStorageAndReload = async (page, values) => {
  await page.evaluate((entries) => {
    Object.entries(entries).forEach(([key, value]) => {
      if (value === null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, String(value));
      }
    });
  }, values);
  await page.reload();
  await waitForWorkspaceReady(page);
};

const writeBinaryFile = async (root, relativePath, buffer) => {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
  return fullPath;
};

const createViewerWorkspace = async () => {
  const root = await createTempDir("viewer-");
  await writeWorkspaceFile(root, "main.tex", BASE_MAIN);
  const pdfBuffer = await fs.readFile(
    path.join(repoRoot, "test-workspace", "main.pdf")
  );
  await writeBinaryFile(root, "sample.pdf", pdfBuffer);
  await writeBinaryFile(root, "image.png", Buffer.from(PNG_BASE64, "base64"));
  await writeBinaryFile(root, "data.bin", Buffer.from("binary", "utf8"));
  return root;
};

const withViewerApp = async (run) => {
  const root = await createViewerWorkspace();
  const { electronApp, page } = await launchApp({ workspacePath: root });
  await waitForWorkspaceReady(page);
  try {
    return await run({ electronApp, page, root });
  } finally {
    await electronApp.close();
    await removeDir(root);
  }
};

const openFileFromTree = async (page, filePath) => {
  const selector = `button.file-item[data-path="${filePath}"]`;
  await page.waitForSelector(selector);
  await page.click(selector);
  await page.waitForSelector(`${selector}.is-active`);
  await page.waitForSelector(`.editor-tab.is-active[data-path="${filePath}"]`);
};

const waitForPdfReady = async (page) => {
  const frame = page.frameLocator("#editor-viewer-pdf");
  await expect(frame.locator("#pdf-status")).toHaveText(TEXT.status.ready);
  return frame;
};

const getPdfUrl = async (page) => {
  const frame = page.frameLocator("#editor-viewer-pdf");
  return frame.locator("body").evaluate(() => window.__tex180PdfViewer?.state?.url ?? null);
};

const getPdfScale = async (page) => {
  const frame = page.frameLocator("#editor-viewer-pdf");
  return frame.locator("body").evaluate(() => window.__tex180PdfViewer?.state?.scale ?? 0);
};

const dispatchPdfWheel = async (page, deltaY) => {
  const frame = page.frameLocator("#editor-viewer-pdf");
  await frame.locator("#pdf-scroll").evaluate(
    (scrollEl, wheelDelta) => {
      const rect = scrollEl.getBoundingClientRect();
      const event = new WheelEvent("wheel", {
        deltaY: wheelDelta,
        metaKey: true,
        ctrlKey: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true,
      });
      scrollEl.dispatchEvent(event);
    },
    deltaY
  );
};

test("T5-01 open pdf viewer", async () => {
  await withViewerApp(async ({ page }) => {
    await openFileFromTree(page, "sample.pdf");
    await expect(page.locator("#editor-viewer")).toHaveAttribute("data-view", "pdf");
    await expect(page.locator("#editor-viewer")).toHaveClass(/is-visible/);
    await expect(page.locator("#editor-viewer-pdf")).toHaveAttribute(
      "src",
      /pdf-viewer\.html/
    );
    await expect(page.locator("#editor")).toHaveClass(/is-hidden/);
  });
});

test("T5-02 open image viewer", async () => {
  await withViewerApp(async ({ page }) => {
    await openFileFromTree(page, "image.png");
    await expect(page.locator("#editor-viewer")).toHaveAttribute("data-view", "image");
    await expect(page.locator("#editor-viewer")).toHaveClass(/is-visible/);
    await expect(page.locator("#editor-viewer-image")).toHaveAttribute("src", /blob:/);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const img = document.getElementById("editor-viewer-image");
          return img instanceof HTMLImageElement ? img.naturalWidth : 0;
        })
      )
      .toBeGreaterThan(0);
    await expect(page.locator("#editor")).toHaveClass(/is-hidden/);
  });
});

test("T5-03 unsupported file viewer", async () => {
  await withViewerApp(async ({ page }) => {
    await openFileFromTree(page, "data.bin");
    await expect(page.locator("#editor-viewer")).toHaveAttribute("data-view", "unsupported");
    await expect(page.locator("#editor-viewer-message h2")).toHaveText(
      TEXT.unsupported.title
    );
    await expect(page.locator("#editor-viewer-message p")).toHaveText(
      TEXT.unsupported.desc
    );
    await expect(page.locator("#editor")).toHaveClass(/is-hidden/);
  });
});

test("T5-04 viewer to editor", async () => {
  await withViewerApp(async ({ page }) => {
    await openFileFromTree(page, "sample.pdf");
    await expect(page.locator("#editor-viewer")).toHaveAttribute("data-view", "pdf");
    await openFileFromTree(page, "main.tex");
    await expect(page.locator("#editor-viewer")).toHaveAttribute("data-view", "hidden");
    await expect(page.locator("#editor")).not.toHaveClass(/is-hidden/);
  });
});

test("T5-05 pdf reload", async () => {
  await withViewerApp(async ({ page }) => {
    await openFileFromTree(page, "sample.pdf");
    const frame = await waitForPdfReady(page);
    await expect.poll(() => getPdfUrl(page)).not.toBeNull();
    const startUrl = await getPdfUrl(page);
    await frame.locator("#pdf-reload").click();
    await expect
      .poll(() => getPdfUrl(page))
      .not.toBe(startUrl);
    await expect(frame.locator("#pdf-status")).toHaveText(TEXT.status.ready);
  });
});

test("T5-06 pdf zoom with wheel", async () => {
  await withViewerApp(async ({ page }) => {
    await openFileFromTree(page, "sample.pdf");
    await waitForPdfReady(page);
    await expect.poll(() => getPdfScale(page)).toBeGreaterThan(0);
    const initialScale = await getPdfScale(page);
    await dispatchPdfWheel(page, 120);
    await expect
      .poll(() => getPdfScale(page))
      .toBeLessThan(initialScale);
  });
});

test("T5-08 pdf viewer title shows file name", async () => {
  await withViewerApp(async ({ page }) => {
    await openFileFromTree(page, "sample.pdf");
    const frame = await waitForPdfReady(page);
    await expect(frame.locator("#pdf-title")).toHaveText("sample.pdf");
  });
});

test("T5-08 open PDF from tree uses tab view even in window mode", async () => {
  await withViewerApp(async ({ page }) => {
    await setLocalStorageAndReload(page, {
      "tex180.editor.pdfViewerMode": "window",
    });
    await openFileFromTree(page, "sample.pdf");
    await expect(page.locator("#editor-viewer")).toHaveAttribute("data-view", "pdf");
    await expect(page.locator("#editor-viewer")).toHaveClass(/is-visible/);
  });
});

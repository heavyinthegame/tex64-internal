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

const TEXT = {
  build: {
    building: "\u30d3\u30eb\u30c9\u4e2d...",
    busy: "\u3059\u3067\u306b\u30d3\u30eb\u30c9\u4e2d\u3067\u3059\u3002",
    cancelled: "\u30d3\u30eb\u30c9\u3092\u30ad\u30e3\u30f3\u30bb\u30eb\u3057\u307e\u3057\u305f\u3002",
    success: "\u30d3\u30eb\u30c9\u6210\u529f",
    failed: "\u30d3\u30eb\u30c9\u5931\u6557",
  },
  errors: {
    pdfMissing: "\u0050\u0044\u0046\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3002",
    latexmkMissing:
      "\u006c\u0061\u0074\u0065\u0078\u006d\u006b\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3002",
    synctexFailed: "\u0053\u0079\u006e\u0063\u0054\u0065\u0058 \u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002",
  },
  status: {
    pdfReady: "\u6e96\u5099\u5b8c\u4e86",
  },
  warning: "\u8b66\u544a\u304c\u3042\u308a\u307e\u3059\u3002",
};

let cachedPdfBase64 = null;

const getPdfBase64 = async () => {
  if (cachedPdfBase64) {
    return cachedPdfBase64;
  }
  const pdfPath = path.join(repoRoot, "test-workspace", "main.pdf");
  const data = await fs.readFile(pdfPath);
  cachedPdfBase64 = data.toString("base64");
  return cachedPdfBase64;
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("#file-tree");
  await page.waitForFunction(() => !!window.__tex180Editor);
  await page.waitForSelector(".editor-tab.is-active");
};

const sendBridgeMessage = async (electronApp, type, payload) => {
  await electronApp.evaluate(
    ({ messageType, messagePayload }) => {
      const { BrowserWindow } = require("electron");
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.send("tex180:message", {
        type: messageType,
        payload: messagePayload,
      });
    },
    { messageType: type, messagePayload: payload }
  );
};

const blockBridgeTypes = async (page, blockedTypes) => {
  await page.waitForFunction(() => !!window.tex180Bridge?.postMessage);
  await page.evaluate((types) => {
    const bridge = window.tex180Bridge;
    if (!bridge?.postMessage) {
      return;
    }
    if (bridge.__e2eIntercept) {
      bridge.__e2eBlocked = types;
      return;
    }
    const original = bridge.postMessage.bind(bridge);
    bridge.__e2eBlocked = types;
    bridge.postMessage = (payload) => {
      if (payload && bridge.__e2eBlocked?.includes(payload.type)) {
        return;
      }
      return original(payload);
    };
    bridge.__e2eIntercept = true;
  }, blockedTypes);
};

const resetPostMessages = async (page) => {
  await page.evaluate(() => {
    window.__tex180PostMessages = [];
  });
};

const getPostMessages = async (page) =>
  page.evaluate(() => window.__tex180PostMessages || []);

const writeBinaryFile = async (root, relativePath, buffer) => {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
  return fullPath;
};

const createWorkspace = async ({
  files = {},
  binaryFiles = {},
  folders = [],
  includeMain = true,
} = {}) => {
  const root = await createTempDir("build-");
  const mergedFiles = includeMain ? { "main.tex": BASE_MAIN, ...files } : files;
  for (const folder of folders) {
    await fs.mkdir(path.join(root, folder), { recursive: true });
  }
  await Promise.all(
    Object.entries(mergedFiles).map(([relativePath, content]) =>
      writeWorkspaceFile(root, relativePath, content)
    )
  );
  await Promise.all(
    Object.entries(binaryFiles).map(([relativePath, buffer]) =>
      writeBinaryFile(root, relativePath, buffer)
    )
  );
  return root;
};

const withWorkspaceApp = async (setup, run) => {
  const root = await createWorkspace(setup);
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

const ensureFolderOpen = async (page, folderPath) => {
  const selector = `details.file-folder[data-path="${folderPath}"]`;
  await page.waitForSelector(selector);
  const isOpen = await page.evaluate((sel) => {
    const target = document.querySelector(sel);
    return Boolean(target && target.open);
  }, selector);
  if (!isOpen) {
    await page.click(`${selector} > summary`);
  }
};

const setEditorValue = async (page, value) => {
  await page.evaluate((content) => {
    window.__tex180Editor?.setValue?.(content);
  }, value);
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

const waitForPdfReady = async (page) => {
  const frame = page.frameLocator("#editor-viewer-pdf");
  await expect(frame.locator("#pdf-status")).toHaveText(TEXT.status.pdfReady);
  return frame;
};

const openPdfInViewer = async (electronApp, page, pdfPath = "main.pdf") => {
  const data = await getPdfBase64();
  await sendBridgeMessage(electronApp, "openFileResult", {
    path: pdfPath,
    kind: "pdf",
    data,
    mimeType: "application/pdf",
  });
  await expect(page.locator("#editor-viewer")).toHaveAttribute("data-view", "pdf");
  await waitForPdfReady(page);
};

const getPdfLastSync = async (page) => {
  const frame = page.frameLocator("#editor-viewer-pdf");
  return frame.locator("body").evaluate(() => window.__tex180PdfViewer?.state?.lastSync ?? null);
};

test("T7-01 build starts", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await blockBridgeTypes(page, ["build"]);
    await resetPostMessages(page);
    await page.click("#build-button");
    await expect(page.locator("#build-button")).toBeDisabled();
    await expect(page.locator("#build-button")).toHaveClass(/is-busy/);
    await sendBridgeMessage(electronApp, "setBuildState", {
      state: "building",
      message: TEXT.build.building,
    });
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.build.building);
  });
});

test("T7-02 build waits for save", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await blockBridgeTypes(page, ["saveFile"]);
    await setEditorValue(page, `${BASE_MAIN}\nDirty`);
    await expect(page.locator('.editor-tab[data-path="main.tex"]')).toHaveClass(/is-dirty/);
    await resetPostMessages(page);
    await blockBridgeTypes(page, ["build"]);
    await page.click("#build-button");
    await expect
      .poll(() => getPostMessages(page))
      .toSatisfy((messages) => messages.some((msg) => msg.type === "saveFile"));
    await expect
      .poll(() => getPostMessages(page))
      .toSatisfy((messages) => messages.some((msg) => msg.type === "build"));
    const messages = await getPostMessages(page);
    const saveIndex = messages.findIndex((msg) => msg.type === "saveFile");
    const buildIndex = messages.findIndex((msg) => msg.type === "build");
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(saveIndex);
  });
});

test("T7-03 build busy message", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await blockBridgeTypes(page, ["build"]);
    await page.click("#build-button");
    await sendBridgeMessage(electronApp, "setBuildState", {
      state: "building",
      message: TEXT.build.building,
    });
    await sendBridgeMessage(electronApp, "updateIssues", {
      count: 0,
      summary: TEXT.build.busy,
      status: "info",
      issues: [],
    });
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.build.busy);
  });
});

test("T7-04 build without workspace shows cancel", async () => {
  const { electronApp, page } = await launchApp({ workspacePath: null });
  try {
    await page.evaluate(() => {
      document.getElementById("build-button")?.click();
    });
    await sendBridgeMessage(electronApp, "setBuildState", {
      state: "idle",
      message: "cancelled",
    });
    await sendBridgeMessage(electronApp, "updateIssues", {
      count: 0,
      summary: TEXT.build.cancelled,
      status: "info",
      issues: [],
    });
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.build.cancelled);
  } finally {
    await electronApp.close();
  }
});

test("T7-05 build success updates issues and PDF", async () => {
  const pdfBuffer = Buffer.from(await getPdfBase64(), "base64");
  await withWorkspaceApp(
    { binaryFiles: { "main.pdf": pdfBuffer } },
    async ({ electronApp, page }) => {
      await setLocalStorageAndReload(page, {
        "tex180.editor.pdfViewerMode": "tab",
      });
      await blockBridgeTypes(page, ["build"]);
      await page.click("#build-button");
      await sendBridgeMessage(electronApp, "setBuildState", {
        state: "success",
        message: TEXT.build.success,
      });
      await sendBridgeMessage(electronApp, "updateIssues", {
        count: 0,
        summary: TEXT.build.success,
        status: "success",
        issues: [],
      });
      await openPdfInViewer(electronApp, page);
      await expect(page.locator("#issues-hint")).toHaveText(TEXT.build.success);
    }
  );
});

test("T7-06 build success with warnings", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "updateIssues", {
      count: 1,
      summary: TEXT.warning,
      status: "info",
      issues: [
        { severity: "warning", message: "Warning: demo", path: "main.tex", line: 2 },
      ],
    });
    await expect(page.locator("#issues-count")).toHaveText("1");
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.warning);
    await expect(page.locator("#issues-list .issue-item")).toHaveCount(1);
    await expect(page.locator("#issues-list .issue-item")).toHaveAttribute(
      "data-severity",
      "warning"
    );
  });
});

test("T7-07 build failure keeps previous PDF", async () => {
  const pdfBuffer = Buffer.from(await getPdfBase64(), "base64");
  await withWorkspaceApp(
    { binaryFiles: { "main.pdf": pdfBuffer } },
    async ({ electronApp, page }) => {
      await openPdfInViewer(electronApp, page);
      await sendBridgeMessage(electronApp, "setBuildState", {
        state: "failed",
        message: TEXT.build.failed,
      });
      await sendBridgeMessage(electronApp, "updateIssues", {
        count: 1,
        summary: TEXT.build.failed,
        status: "error",
        issues: [
          { severity: "error", message: "Error: demo", path: "main.tex", line: 1 },
        ],
      });
      await expect(page.locator("#issues-tab")).toHaveClass(/is-alert/);
      await expect(page.locator("#editor-viewer")).toHaveAttribute("data-view", "pdf");
    }
  );
});

test("T7-08 build success without PDF shows error", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "setBuildState", {
      state: "failed",
      message: TEXT.errors.pdfMissing,
    });
    await sendBridgeMessage(electronApp, "updateIssues", {
      count: 1,
      summary: TEXT.errors.pdfMissing,
      status: "error",
      issues: [{ severity: "error", message: TEXT.errors.pdfMissing }],
    });
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.pdfMissing);
  });
});

test("T7-09 build fails when latexmk missing", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "updateIssues", {
      count: 1,
      summary: TEXT.errors.latexmkMissing,
      status: "error",
      issues: [{ severity: "error", message: TEXT.errors.latexmkMissing }],
    });
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.latexmkMissing);
  });
});

test("T7-10 build target respects manual root", async () => {
  await withWorkspaceApp(
    {
      files: {
        "chapters/root.tex": "Root",
        "chapters/other.tex": "Other",
        ".tex180/settings.json": JSON.stringify({ rootFile: "chapters/root.tex" }),
      },
      folders: ["chapters", ".tex180"],
    },
    async ({ page }) => {
      await ensureFolderOpen(page, "chapters");
      await openFileFromTree(page, "chapters/other.tex");
      await blockBridgeTypes(page, ["build"]);
      await resetPostMessages(page);
      await page.click("#build-button");
      await expect
        .poll(() => getPostMessages(page))
        .toSatisfy((messages) => messages.some((msg) => msg.type === "build"));
      const messages = await getPostMessages(page);
      const build = messages.find((msg) => msg.type === "build");
      expect(build?.mainFile).toBe("chapters/root.tex");
    }
  );
});

test("T7-11 build target uses active tex when no root", async () => {
  await withWorkspaceApp(
    {
      includeMain: false,
      files: { "notes/alpha.tex": "Alpha" },
      folders: ["notes"],
    },
    async ({ page }) => {
      await ensureFolderOpen(page, "notes");
      await openFileFromTree(page, "notes/alpha.tex");
      await blockBridgeTypes(page, ["build"]);
      await resetPostMessages(page);
      await page.click("#build-button");
      await expect
        .poll(() => getPostMessages(page))
        .toSatisfy((messages) => messages.some((msg) => msg.type === "build"));
      const messages = await getPostMessages(page);
      const build = messages.find((msg) => msg.type === "build");
      expect(build?.mainFile).toBe("notes/alpha.tex");
    }
  );
});

test("T7-12 non-tex build targets main.tex", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+0LwAAAABJRU5ErkJggg==",
    "base64"
  );
  await withWorkspaceApp(
    { binaryFiles: { "image.png": png } },
    async ({ page }) => {
      await openFileFromTree(page, "image.png");
      await blockBridgeTypes(page, ["build"]);
      await resetPostMessages(page);
      await page.click("#build-button");
      await expect
        .poll(() => getPostMessages(page))
        .toSatisfy((messages) => messages.some((msg) => msg.type === "build"));
      const messages = await getPostMessages(page);
      const build = messages.find((msg) => msg.type === "build");
      expect(build?.mainFile).toBe("main.tex");
    }
  );
});

test("T7-13 pdf viewer mode tab opens in app", async () => {
  const pdfBuffer = Buffer.from(await getPdfBase64(), "base64");
  await withWorkspaceApp(
    { binaryFiles: { "main.pdf": pdfBuffer } },
    async ({ electronApp, page }) => {
      await setLocalStorageAndReload(page, {
        "tex180.editor.pdfViewerMode": "tab",
      });
      await blockBridgeTypes(page, ["build"]);
      await resetPostMessages(page);
      await page.click("#build-button");
      await expect
        .poll(() => getPostMessages(page))
        .toSatisfy((messages) => messages.some((msg) => msg.type === "build"));
      const messages = await getPostMessages(page);
      const build = messages.find((msg) => msg.type === "build");
      expect(build?.pdfViewerMode).toBe("tab");
      await openPdfInViewer(electronApp, page);
      await expect(page.locator("#editor-viewer")).toHaveAttribute("data-view", "pdf");
    }
  );
});

test("T7-14 pdf viewer mode window stays external", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await setLocalStorageAndReload(page, {
      "tex180.editor.pdfViewerMode": "window",
    });
    await blockBridgeTypes(page, ["build"]);
    await resetPostMessages(page);
    await page.click("#build-button");
    await expect
      .poll(() => getPostMessages(page))
      .toSatisfy((messages) => messages.some((msg) => msg.type === "build"));
    const messages = await getPostMessages(page);
    const build = messages.find((msg) => msg.type === "build");
    expect(build?.pdfViewerMode).toBe("window");
    await sendBridgeMessage(electronApp, "setBuildState", {
      state: "success",
      message: TEXT.build.success,
    });
    await expect(page.locator("#editor-viewer")).toHaveAttribute("data-view", "hidden");
  });
});

test("T7-15 auto synctex on triggers forward", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await setLocalStorageAndReload(page, {
      "tex180.editor.autoSynctexOnBuild": "true",
    });
    await blockBridgeTypes(page, ["synctex:forward"]);
    await resetPostMessages(page);
    await sendBridgeMessage(electronApp, "setBuildState", {
      state: "success",
      message: TEXT.build.success,
    });
    await expect
      .poll(() => getPostMessages(page))
      .toSatisfy((messages) => messages.some((msg) => msg.type === "synctex:forward"));
  });
});

test("T7-16 auto synctex off skips forward", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await setLocalStorageAndReload(page, {
      "tex180.editor.autoSynctexOnBuild": "false",
    });
    await resetPostMessages(page);
    await sendBridgeMessage(electronApp, "setBuildState", {
      state: "success",
      message: TEXT.build.success,
    });
    const messages = await getPostMessages(page);
    expect(messages.some((msg) => msg.type === "synctex:forward")).toBe(false);
  });
});

test("T7-16b auto synctex skips non-tex target", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+0LwAAAABJRU5ErkJggg==",
    "base64"
  );
  const root = await createWorkspace({
    binaryFiles: { "image.png": png },
    includeMain: false,
  });
  let electronApp;
  let page;
  try {
    ({ electronApp, page } = await launchApp({ workspacePath: root }));
    await waitForWorkspaceReady(page);
    await setLocalStorageAndReload(page, {
      "tex180.editor.autoSynctexOnBuild": "true",
    });
    await openFileFromTree(page, "image.png");
    await resetPostMessages(page);
    await sendBridgeMessage(electronApp, "setBuildState", {
      state: "success",
      message: TEXT.build.success,
    });
    const messages = await getPostMessages(page);
    expect(messages.some((msg) => msg.type === "synctex:forward")).toBe(false);
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    await removeDir(root);
  }
});

test("T7-17 synctex failure shows error", async () => {
  await withWorkspaceApp({}, async ({ electronApp, page }) => {
    await sendBridgeMessage(electronApp, "synctex:forwardResult", {
      ok: false,
      error: TEXT.errors.synctexFailed,
    });
    await expect(page.locator("#issues-hint")).toHaveText(TEXT.errors.synctexFailed);
  });
});

test("T7-18 synctex fallback for comment line", async () => {
  const pdfBuffer = Buffer.from(await getPdfBase64(), "base64");
  await withWorkspaceApp(
    { binaryFiles: { "main.pdf": pdfBuffer } },
    async ({ electronApp, page }) => {
      await setLocalStorageAndReload(page, {
        "tex180.editor.pdfViewerMode": "tab",
      });
      await openPdfInViewer(electronApp, page);
      await sendBridgeMessage(electronApp, "synctex:forwardResult", {
        ok: true,
        page: 2,
        x: 10,
        y: 20,
        pdfPath: "main.pdf",
        fallback: true,
      });
      await expect
        .poll(() => getPdfLastSync(page))
        .toMatchObject({ page: 2, x: 10, y: 20 });
    }
  );
});

test("T7-19 synctex fallback to top", async () => {
  const pdfBuffer = Buffer.from(await getPdfBase64(), "base64");
  await withWorkspaceApp(
    { binaryFiles: { "main.pdf": pdfBuffer } },
    async ({ electronApp, page }) => {
      await setLocalStorageAndReload(page, {
        "tex180.editor.pdfViewerMode": "tab",
      });
      await openPdfInViewer(electronApp, page);
      await sendBridgeMessage(electronApp, "synctex:forwardResult", {
        ok: true,
        page: 1,
        x: 0,
        y: 0,
        pdfPath: "main.pdf",
        fallback: true,
      });
      await expect
        .poll(() => getPdfLastSync(page))
        .toMatchObject({ page: 1 });
    }
  );
});

test("T7-20 synctex button is absent", async () => {
  await withWorkspaceApp({}, async ({ page }) => {
    await expect(page.locator("#synctex-button")).toHaveCount(0);
  });
});

import { test, expect, _electron as electron } from "@playwright/test";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs/promises";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const templateRoot = path.join(repoRoot, "test-partial");

test.describe.configure({ mode: "serial" });

const copyWorkspace = async (sourcePath, targetPath) => {
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.mkdir(targetPath, { recursive: true });
  await fs.cp(sourcePath, targetPath, { recursive: true });
};

const openAllFolders = async (page) => {
  await page.evaluate(() => {
    document.querySelectorAll("#file-tree details").forEach((details) => {
      details.open = true;
      const summary = details.querySelector("summary");
      if (summary) {
        summary.classList.add("is-open");
      }
    });
  });
};

const setupBuildStateHook = async (page) => {
  await page.waitForFunction(() => typeof window.tex64SetBuildState === "function");
  await page.evaluate(() => {
    if (window.__tex64BuildStateHooked) {
      return;
    }
    window.__tex64BuildStateHooked = true;
    const original = window.tex64SetBuildState;
    window.tex64SetBuildState = (payload) => {
      window.__tex64LastBuildState = payload;
      if (typeof original === "function") {
        original(payload);
      }
    };
  });
};

const launchApp = async (testInfo, templateName) => {
  const workspacePath = testInfo.outputPath("workspace");
  const userDataPath = testInfo.outputPath("userdata");
  await copyWorkspace(path.join(templateRoot, templateName), workspacePath);
  await fs.mkdir(userDataPath, { recursive: true });

  const env = {
    ...process.env,
    TEX180_E2E: "1",
    TEX180_E2E_WORKSPACE: workspacePath,
    TEX180_E2E_USERDATA: userDataPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot],
    cwd: repoRoot,
    env,
  });
  const page = await app.firstWindow();
  await page.waitForSelector("#file-tree .file-item");
  await openAllFolders(page);
  await setupBuildStateHook(page);
  await page.evaluate(() => {
    window.__tex64PostMessages = [];
  });
  return { app, page, workspacePath };
};

const openFile = async (page, filePath) => {
  await page.click(`button.file-item[data-path="${filePath}"]`);
  await page.waitForFunction(
    (pathValue) => {
      const active = document.querySelector(".editor-tab.is-active");
      return active?.getAttribute("data-path") === pathValue;
    },
    filePath
  );
};

const setCursorLine = async (page, lineNumber) => {
  await page.waitForFunction(() => window.__tex64Editor?.getModel?.());
  await page.evaluate((line) => {
    const editor = window.__tex64Editor;
    if (!editor?.setPosition) {
      return;
    }
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.revealLineInCenter?.(line);
    editor.focus?.();
  }, lineNumber);
};

const waitForBuildResult = async (page) => {
  await page.waitForFunction(
    () => {
      const state = window.__tex64LastBuildState?.state;
      return state === "success" || state === "failed";
    },
    null,
    { timeout: 120000 }
  );
  return page.evaluate(() => window.__tex64LastBuildState);
};

const getFileMtime = async (filePath) => {
  try {
    const stat = await fs.stat(filePath);
    return stat.mtimeMs;
  } catch {
    return null;
  }
};

const waitForPdfUpdate = async (pdfPath, previousMtime) => {
  await expect
    .poll(
      async () => {
        try {
          const stat = await fs.stat(pdfPath);
          if (previousMtime === null) {
            return stat.mtimeMs > 0;
          }
          return stat.mtimeMs > previousMtime;
        } catch {
          return false;
        }
      },
      { timeout: 120000 }
    )
    .toBe(true);
  const stat = await fs.stat(pdfPath);
  return stat.mtimeMs;
};

const extractPdfText = async (pdfPath) => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = await fs.readFile(pdfPath);
  const task = pdfjs.getDocument({ data: new Uint8Array(data), disableWorker: true });
  const pdf = await task.promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(" ");
    pages.push(pageText);
  }
  await task.destroy();
  return pages.join("\n");
};

const runPartialBuild = async (page, pdfPath, previousMtime) => {
  await page.evaluate(() => {
    window.__tex64LastBuildState = null;
  });
  await page.click("#partial-build-button");
  const buildResult = await waitForBuildResult(page);
  if (buildResult?.state !== "success") {
    const log = await page.evaluate(() => {
      const content = document.getElementById("issues-log-content");
      return content?.textContent ?? "";
    });
    throw new Error(
      `Partial build failed: ${buildResult?.message ?? "unknown"}\n${log}`.trim()
    );
  }
  const nextMtime = await waitForPdfUpdate(pdfPath, previousMtime);
  const text = await extractPdfText(pdfPath);
  return { text, mtime: nextMtime };
};

const getLastBuildPayload = async (page) =>
  page.evaluate(() => {
    const log = window.__tex64PostMessages;
    if (!Array.isArray(log)) {
      return null;
    }
    for (let i = log.length - 1; i >= 0; i -= 1) {
      const entry = log[i];
      if (entry && entry.type === "build") {
        return entry;
      }
    }
    return null;
  });

test("partial build: single-file sections", async ({}, testInfo) => {
  test.setTimeout(120000);
  const { app, page, workspacePath } = await launchApp(testInfo, "single");
  const pdfPath = path.join(workspacePath, ".tex64", "preview", "partial.pdf");

  await openFile(page, "main.tex");
  await setCursorLine(page, 6);
  let previousMtime = await getFileMtime(pdfPath);
  let result = await runPartialBuild(page, pdfPath, previousMtime);
  expect(result.text).toContain("ALPHAONLY");
  expect(result.text).toContain("ROOTMACRO");
  expect(result.text).not.toContain("BETAONLY");

  await setCursorLine(page, 12);
  previousMtime = result.mtime;
  result = await runPartialBuild(page, pdfPath, previousMtime);
  expect(result.text).toContain("BETAONLY");
  expect(result.text).toContain("ROOTMACRO");
  expect(result.text).not.toContain("ALPHAONLY");

  await app.close();
});

test("partial build: include-only chapters", async ({}, testInfo) => {
  test.setTimeout(120000);
  const { app, page, workspacePath } = await launchApp(testInfo, "include");
  const pdfPath = path.join(workspacePath, ".tex64", "preview", "partial.pdf");

  await openFile(page, "chapters/alpha.tex");
  await setCursorLine(page, 2);
  let previousMtime = await getFileMtime(pdfPath);
  let result = await runPartialBuild(page, pdfPath, previousMtime);
  expect(result.text).toContain("INCLUDEALPHA");
  expect(result.text).toContain("INCLUDEROOT");
  expect(result.text).not.toContain("INCLUDEBETA");

  await openFile(page, "chapters/beta.tex");
  await setCursorLine(page, 2);
  previousMtime = result.mtime;
  result = await runPartialBuild(page, pdfPath, previousMtime);
  expect(result.text).toContain("INCLUDEBETA");
  expect(result.text).toContain("INCLUDEROOT");
  expect(result.text).not.toContain("INCLUDEALPHA");

  await app.close();
});

test("partial build: subfile preamble is included", async ({}, testInfo) => {
  test.setTimeout(120000);
  const { app, page, workspacePath } = await launchApp(testInfo, "subfile");
  const pdfPath = path.join(workspacePath, ".tex64", "preview", "partial.pdf");

  await openFile(page, "chapters/standalone.tex");
  await setCursorLine(page, 7);
  const previousMtime = await getFileMtime(pdfPath);
  await page.evaluate(() => {
    window.__tex64PostMessages = [];
  });
  await page.click("#partial-build-button");
  await page.waitForFunction(
    () => Array.isArray(window.__tex64PostMessages) && window.__tex64PostMessages.length > 0
  );
  const editorLines = await page.evaluate(() => {
    const editor = window.__tex64Editor;
    const model = editor?.getModel?.();
    if (!model?.getLineCount || !model.getLineContent) {
      return [];
    }
    const lineCount = model.getLineCount();
    const lines = [];
    for (let lineNumber = 1; lineNumber <= Math.min(lineCount, 6); lineNumber += 1) {
      lines.push(model.getLineContent(lineNumber));
    }
    return lines;
  });
  expect(editorLines[1]).toContain("\\newcommand{\\SubMacro}{SUBMACRO}");
  expect(editorLines[3]).toContain("\\begin{document}");
  const preambleSnapshot = await page.evaluate(() => {
    const editor = window.__tex64Editor;
    const model = editor?.getModel?.();
    if (!model?.getLineCount || !model.getLineContent) {
      return null;
    }
    const stripLineComment = (line) => {
      const idx = line.indexOf("%");
      if (idx === -1) {
        return line;
      }
      for (let i = idx; i < line.length; i += 1) {
        if (line[i] !== "%") {
          continue;
        }
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && line[j] === "\\\\"; j -= 1) {
          backslashes += 1;
        }
        if (backslashes % 2 === 0) {
          return line.slice(0, i);
        }
      }
      return line;
    };
    const normalizeCommandLine = (line) =>
      stripLineComment(line).replace(/\s+/g, "");
    const lineCount = model.getLineCount();
    let beginDocLine = null;
    const lines = [];
    for (let lineNumber = 1; lineNumber <= lineCount; lineNumber += 1) {
      const line = model.getLineContent(lineNumber);
      lines.push(line);
      const normalized = normalizeCommandLine(line);
      const matches = normalized.includes("\\begin{document}");
      if (beginDocLine === null && matches) {
        beginDocLine = lineNumber;
      }
    }
    const preambleLines =
      beginDocLine && beginDocLine > 1
        ? lines
            .slice(0, beginDocLine - 1)
            .filter((entry) => !normalizeCommandLine(entry).includes("\\documentclass"))
        : [];
    return { beginDocLine, preambleLines };
  });
  expect(preambleSnapshot?.beginDocLine).toBe(4);
  expect(preambleSnapshot?.preambleLines?.[0]).toContain(
    "\\newcommand{\\SubMacro}{SUBMACRO}"
  );
  const payload = await getLastBuildPayload(page);
  expect(payload?.mainFile).toBe("main.tex");
  expect(payload?.partial?.path).toBe("chapters/standalone.tex");
  expect(payload?.partial?.content).toContain("\\SubMacro");
  const preamble = payload?.partial?.preamble ?? "";
  expect(preamble).toContain("\\newcommand{\\SubMacro}{SUBMACRO}");
  const result = await waitForBuildResult(page);
  if (result?.state !== "success") {
    const log = await page.evaluate(() => {
      const content = document.getElementById("issues-log-content");
      return content?.textContent ?? "";
    });
    throw new Error(
      `Partial build failed: ${result?.message ?? "unknown"}\n${log}`.trim()
    );
  }
  const nextMtime = await waitForPdfUpdate(pdfPath, previousMtime);
  const text = await extractPdfText(pdfPath);
  expect(text).toContain("ROOTMACRO");
  expect(text).toContain("SUBMACRO");
  expect(text).toContain("GAMMAONLY");

  await app.close();
});

test("partial build: subfiles + input", async ({}, testInfo) => {
  test.setTimeout(120000);
  const { app, page, workspacePath } = await launchApp(testInfo, "subfiles-input");
  const pdfPath = path.join(workspacePath, ".tex64", "preview", "partial.pdf");

  await openFile(page, "chapters/alpha.tex");
  await setCursorLine(page, 7);
  let previousMtime = await getFileMtime(pdfPath);
  let result = await runPartialBuild(page, pdfPath, previousMtime);
  expect(result.text).toContain("ALPHAONLY");
  expect(result.text).toContain("ROOTSUB");
  expect(result.text).toContain("ALPHAMACRO");
  expect(result.text).not.toContain("BETAONLY");

  await openFile(page, "chapters/beta.tex");
  await setCursorLine(page, 2);
  previousMtime = result.mtime;
  result = await runPartialBuild(page, pdfPath, previousMtime);
  expect(result.text).toContain("BETAONLY");
  expect(result.text).toContain("ROOTSUB");
  expect(result.text).not.toContain("ALPHAONLY");
  expect(result.text).not.toContain("ALPHAMACRO");

  await app.close();
});

test("partial build: begin document with whitespace/comment", async ({}, testInfo) => {
  test.setTimeout(120000);
  const { app, page, workspacePath } = await launchApp(testInfo, "begin-comment");
  const pdfPath = path.join(workspacePath, ".tex64", "preview", "partial.pdf");

  await openFile(page, "main.tex");
  await setCursorLine(page, 6);
  let previousMtime = await getFileMtime(pdfPath);
  let result = await runPartialBuild(page, pdfPath, previousMtime);
  expect(result.text).toContain("ALPHAONLY");
  expect(result.text).toContain("SPACEROOT");
  expect(result.text).not.toContain("BETAONLY");

  await setCursorLine(page, 9);
  previousMtime = result.mtime;
  result = await runPartialBuild(page, pdfPath, previousMtime);
  expect(result.text).toContain("BETAONLY");
  expect(result.text).toContain("SPACEROOT");
  expect(result.text).not.toContain("ALPHAONLY");

  await app.close();
});

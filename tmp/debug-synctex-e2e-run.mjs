import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const repoRoot = process.cwd();
const sourceWorkspace = path.join(repoRoot, 'test-workspace');

const cleanupBuildArtifacts = async (workspacePath) => {
  const staleExtensions = new Set(['.aux','.bbl','.blg','.fdb_latexmk','.fls','.lof','.log','.lot','.nav','.out','.pdf','.snm','.synctex.gz','.toc']);
  const skipDirs = new Set(['.git','.tex64','node_modules']);
  const stack = [workspacePath];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) {
          continue;
        }
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!staleExtensions.has(ext)) {
        continue;
      }
      await fs.rm(entryPath, { force: true });
    }
  }
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tex64-e2e-synctex-debug-'));
  const workspacePath = path.join(tempDir, 'workspace');
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const postToBridge = async (page, payload) => {
  await page.evaluate((value) => {
    window.tex64Bridge.postMessage(value);
  }, payload);
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector('body.is-ready', { timeout: 15000 });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 20000,
  });
};

const waitForBuildIdle = async (page) => {
  await page.waitForFunction(
    () => {
      const button = document.getElementById('build-button');
      return button instanceof HTMLButtonElement && !button.classList.contains('is-busy');
    },
    undefined,
    { timeout: 120000 }
  );
};

const initBridgeCollector = async (page) => {
  await page.evaluate(() => {
    window.__synctexTestMessages = [];
    if (window.__synctexBridgeInstalled !== true) {
      window.__synctexBridgeInstalled = true;
      window.tex64Bridge.onMessage((message) => {
        window.__synctexTestMessages.push({
          type: message?.type,
          payload: message?.payload ?? null,
          at: Date.now(),
        });
      });
    }
  });
};

const waitForBridgeMessage = async (page, type, timeoutMs = 12000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await page.evaluate((expectedType) => {
      const messages = window.__synctexTestMessages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return null;
      }
      const index = messages.findIndex((item) => item?.type === expectedType);
      if (index === -1) {
        return null;
      }
      const item = messages[index];
      messages.splice(index, 1);
      return { type: item.type, payload: item.payload };
    }, type);
    if (message && message.type === type) {
      return message.payload;
    }
    await page.waitForTimeout(15);
  }
  throw new Error(`Timed out waiting for bridge message: ${type}`);
};

const isSkippableLine = (lineText) => {
  if (typeof lineText !== 'string') return true;
  const trimmed = lineText.trim();
  return !trimmed || trimmed.startsWith('%');
};

const isStructuralLine = (lineText) => {
  if (typeof lineText !== 'string') {
    return false;
  }
  const trimmed = lineText.trim();
  if (!trimmed) return false;
  if (/^\\(?:begin|end|label|caption|centering|toprule|midrule|bottomrule|hline|cline)\b/.test(trimmed)) {
    return true;
  }
  if (/\\\\\s*$/.test(trimmed)) return true;
  if (/(^|[^\\])&/.test(trimmed)) return true;
  if (
    /^\\(?:input|include|subfile|import|includeonly)\b/.test(trimmed) ||
    /^\\(?:begin\{document\}|end\{document\}|maketitle|tableofcontents|listoffigures|listoftables|appendix|bibliography|bibliographystyle|printbibliography)\b/.test(trimmed)
  ) {
    return true;
  }
  return false;
};

const collectSectionsCases = async (workspacePath) => {
  const sectionsPath = path.join(workspacePath, 'sections');
  const raw = await fs.readdir(sectionsPath, { withFileTypes: true });
  const texFiles = raw
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tex'))
    .map((entry) => path.join(sectionsPath, entry.name))
    .sort((left, right) => left.localeCompare(right));

  const cases = [];
  for (const sourcePath of texFiles) {
    const rawSource = await fs.readFile(sourcePath, 'utf8');
    const lines = rawSource.split(/\r?\n/);
    lines.forEach((lineText, index) => {
      if (isSkippableLine(lineText) || isStructuralLine(lineText)) {
        return;
      }
      const lineNumber = index + 1;
      const firstNonSpace = lineText.search(/\S/);
      const column = firstNonSpace >= 0 ? firstNonSpace + 1 : 1;
      cases.push({
        sourcePath,
        relativePath: path.relative(workspacePath, sourcePath).split(path.sep).join('/'),
        line: lineNumber,
        column,
      });
    });
  }
  return cases;
};

const normalizeForCompare = (workspacePath, targetPath) => {
  if (!targetPath || typeof targetPath !== 'string') return null;
  const resolved = path.isAbsolute(targetPath) ? targetPath : path.join(workspacePath, targetPath);
  return path.normalize(resolved);
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  let electronApp;
  try {
    await cleanupBuildArtifacts(workspacePath);
    electronApp = await electron.launch({ args: ['.'], cwd: repoRoot, env: { ...process.env } });
    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });
    await initBridgeCollector(page);
    await postToBridge(page, { type: 'openRecentProject', path: workspacePath });
    await waitForWorkspaceReady(page);
    await postToBridge(page, { type: 'build' });
    await waitForBuildIdle(page);

    const cases = await collectSectionsCases(workspacePath);
    for (const item of cases) {
      await postToBridge(page, {
        type: 'synctex:forward',
        path: item.relativePath,
        line: item.line,
        column: item.column,
        fallbackToTop: false,
      });
      const forwardResult = await waitForBridgeMessage(page, 'synctex:forwardResult');
      if (!forwardResult || forwardResult.ok !== true) {
        console.log('FORWARD-FAIL', item.relativePath, item.line, forwardResult?.error ?? 'unknown');
        continue;
      }
      await postToBridge(page, {
        type: 'synctex:reverse',
        page: forwardResult.page,
        x: forwardResult.x,
        y: forwardResult.y,
        pdfPath: forwardResult.pdfPath,
      });
      const reverseResult = await waitForBridgeMessage(page, 'synctex:reverseResult');
      if (!reverseResult || reverseResult.ok !== true) {
        console.log('REVERSE-FAIL', item.relativePath, item.line, reverseResult?.error ?? 'unknown');
        continue;
      }
      const expected = normalizeForCompare(workspacePath, item.relativePath);
      const actual = normalizeForCompare(workspacePath, reverseResult.path);
      const lineDiff = Math.abs((reverseResult.line ?? NaN) - item.line);
      if (lineDiff > 1 || actual !== expected) {
        console.log('BAD', {
          source: item.relativePath,
          expected,
          actual,
          reversePath: reverseResult.path,
          targetLine: item.line,
          reverseLine: reverseResult.line,
          lineDiff,
          sameFile: expected === actual,
          confidence: reverseResult.confidence,
          scoreGap: reverseResult.scoreGap,
          distance: reverseResult.distance,
        });
      }
    }
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

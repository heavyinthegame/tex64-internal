#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SynctexService } = require('/Users/wedd/tex64/electron/services/synctex.cjs');
const { _electron: electron } = require('playwright');

const repoRoot = '/Users/wedd/tex64';
const sourceWorkspace = path.join(repoRoot, 'test-workspace');

const isSkippable = (lineText) => {
  if (typeof lineText !== 'string') {
    return false;
  }
  const trimmed = lineText.trim();
  if (!trimmed || trimmed.startsWith('%')) {
    return true;
  }
  if (/^\\(?:begin|end|label|caption|centering|toprule|midrule|bottomrule|hline|cline)\b/.test(trimmed)) {
    return true;
  }
  if (/\\\\\s*$/.test(trimmed)) return true;
  if (/(^|[^\\])&/.test(trimmed)) return true;
  return false;
};

const findColumn = (lineText) => {
  if (typeof lineText !== 'string' || !lineText.length) return 1;
  const firstNonSpace = lineText.search(/\S/);
  return firstNonSpace >= 0 ? firstNonSpace + 1 : 1;
};

const collectCases = async (workspacePath) => {
  const sections = path.join(workspacePath, 'sections');
  const raw = await fs.readdir(sections, { withFileTypes: true });
  const files = raw
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tex'))
    .map((entry) => path.join(sections, entry.name))
    .sort((left, right) => left.localeCompare(right));
  const cases = [];
  for (const sourcePath of files) {
    const rawSource = await fs.readFile(sourcePath, 'utf8');
    const lines = rawSource.split(/\r?\n/);
    lines.forEach((lineText, index) => {
      if (isSkippable(lineText)) return;
      cases.push({
        sourcePath,
        sourceRelative: path.relative(workspacePath, sourcePath).split(path.sep).join('/'),
        line: index + 1,
        lineText,
        column: findColumn(lineText),
      });
    });
  }
  return cases;
};

(async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tex64-handler-comp-'));
  const workspacePath = path.join(tempDir, 'workspace');
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  const service = new SynctexService();
  const pdfPath = path.join(workspacePath, 'main.pdf');

  const cleanup = async (app) => {
    if (app) await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  };

  let app;
  try {
    const removeArtifacts = async () => {
      const stale = new Set(['.aux','.bbl','.blg','.fdb_latexmk','.fls','.lof','.log','.lot','.nav','.out','.pdf','.snm','.synctex.gz','.toc']);
      const skip = new Set(['.git','.tex64','node_modules']);
      const stack = [workspacePath];
      while (stack.length) {
        const current = stack.pop();
        let entries = [];
        try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (skip.has(entry.name)) continue;
            stack.push(full);
            continue;
          }
          if (!entry.isFile()) continue;
          if (!stale.has(path.extname(entry.name).toLowerCase())) continue;
          await fs.rm(full, { force: true });
        }
      }
    };

    await removeArtifacts();

    app = await electron.launch({ args: ['.'], cwd: repoRoot, env: { ...process.env } });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });

    await page.evaluate(() => {
      window.__m = [];
      window.tex64Bridge.onMessage((message) => {
        window.__m.push({ type: message?.type, payload: message?.payload ?? null, at: Date.now() });
      });
    });

    await page.evaluate((p) => {
      window.tex64Bridge.postMessage({ type: 'openRecentProject', path: p });
    }, workspacePath);

    await page.waitForSelector('body.is-ready', { timeout: 15000 });
    await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', { timeout: 20000 });

    await page.evaluate(() => {
      window.tex64Bridge.postMessage({ type: 'build' });
    });
    await page.waitForFunction(() => {
      const button = document.getElementById('build-button');
      return button instanceof HTMLButtonElement && !button.classList.contains('is-busy');
    }, undefined, { timeout: 120000 });

    await page.waitForTimeout(250);

    const cases = await collectCases(workspacePath);
    for (const item of cases) {
      const expected = `${item.sourceRelative}:${item.line}`;
      await page.evaluate((value) => {
        window.tex64Bridge.postMessage(value);
      }, {
        type: 'synctex:forward',
        path: item.sourceRelative,
        line: item.line,
        column: item.column,
        fallbackToTop: false,
      });

      const wait = async () => {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          const found = await page.evaluate((expectedType) => {
            const messages = window.__m;
            const index = messages.findIndex((item) => item?.type === expectedType);
            if (index === -1) return null;
            const item = messages.splice(index, 1)[0];
            return item;
          }, 'synctex:forwardResult');
          if (found?.type) return found.payload;
          await page.waitForTimeout(5);
        }
        throw new Error('timeout forward');
      };
      const forward = await wait();
      const serviceForward = await service.forward({
        sourcePath: item.sourcePath,
        line: item.line,
        column: item.column,
        pdfPath,
        hintLine: item.line,
        hintColumn: item.column,
      });
      if (!forward?.ok || !serviceForward?.ok) {
        console.log('FAILED forward', expected, forward?.error, serviceForward?.error);
        continue;
      }
      if (
        forward.page !== serviceForward.page ||
        Math.abs((forward.x ?? 0) - (serviceForward.x ?? 0)) > 1e-3 ||
        Math.abs((forward.y ?? 0) - (serviceForward.y ?? 0)) > 1e-3
      ) {
        console.log('DIFF', expected, 'app=', {
          page: forward.page,
          x: forward.x,
          y: forward.y,
          fallback: forward.fallback,
          same: forward.roundtripSameSourcePath,
          diff: forward.roundtripDiff,
          matchedLine: forward.matchedLine,
          matchDiff: forward.matchDiff,
        }, 'svc=', {
          page: serviceForward.page,
          x: serviceForward.x,
          y: serviceForward.y,
          fallback: serviceForward.fallback,
          same: serviceForward.sameSourcePath,
          diff: serviceForward.matchedLine ? null : null,
          matchedLine: serviceForward.matchedLine,
          matchDiff: serviceForward.matchDiff,
        });
      }
    }

    console.log('done', cases.length);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup(app);
  }
})();

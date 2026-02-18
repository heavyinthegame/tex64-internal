import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const repoRoot = process.cwd();
const sourceWorkspace = path.join(repoRoot, 'tests/e2e/fixtures/synctex-precision');

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tex64-neigh-'));
const workspacePath = path.join(tempDir, 'workspace');
await fs.cp(sourceWorkspace, workspacePath, { recursive: true });

const app = await electron.launch({ args: ['.'], cwd: repoRoot, env: { ...process.env } });
const page = await app.firstWindow();
await page.setViewportSize({ width: 1200, height: 900 });

await page.evaluate(() => {
  if (!window.__synctexTestMessages) window.__synctexTestMessages = [];
  window.tex64Bridge.onMessage((msg) => {
    const requestId = msg?.payload && typeof msg.payload === 'object' ? msg.payload?.requestId : msg?.requestId;
    window.__synctexTestMessages.push({ type: msg?.type, requestId, payload: msg?.payload ?? null });
  });
});

const post = async (payload) => page.evaluate((value) => window.tex64Bridge.postMessage(value), payload);

const wait = async (type, requestId) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const msg = await page.evaluate((params) => {
      const msgs = window.__synctexTestMessages;
      if (!Array.isArray(msgs) || msgs.length === 0) return null;
      const idx = msgs.findIndex((item) => item.type === params.type && (!params.requestId || item.requestId === params.requestId));
      if (idx === -1) return null;
      const item = msgs[idx];
      msgs.splice(idx, 1);
      return item;
    }, { type, requestId });
    if (msg) return msg;
    await page.waitForTimeout(20);
  }
  throw new Error('timeout ' + type);
};

await post({ type: 'openRecentProject', path: workspacePath });
await page.waitForSelector('body.is-ready', { timeout: 15000 });
await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', { timeout: 20000 });
await post({ type: 'build' });
await page.waitForFunction(() => {
  const btn = document.getElementById('build-button');
  return btn instanceof HTMLButtonElement && !btn.classList.contains('is-busy');
}, undefined, { timeout: 40000 });
await page.waitForTimeout(200);

for (const relativePath of ['sections/overview.tex', 'sections/appendix.tex']) {
  const req = `f-${relativePath}`;
  await post({ type: 'synctex:forward', requestId: req, path: relativePath, line: 1, column: 1, fallbackToTop: false });
  const fw = (await wait('synctex:forwardResult', req)).payload;
  if (!fw?.ok) {
    console.log('forward fail', relativePath, fw);
    continue;
  }
  const offsets = [-8, -4, 0, 4, 8];
  const checks = [];
  for (const dx of offsets) {
    for (const dy of offsets) {
      const id = `r-${relativePath}-${dx}-${dy}`;
      await post({
        type: 'synctex:reverse',
        requestId: id,
        page: fw.page,
        x: fw.x + dx,
        y: fw.y + dy,
        pdfPath: fw.pdfPath,
        bypassHint: true,
        refineLines: 3,
        allowExpandedOffsets: true,
      });
      const rv = (await wait('synctex:reverseResult', id)).payload;
      checks.push({ dx, dy, ok: rv?.ok, path: rv?.path, line: rv?.line, scoreGap: rv?.scoreGap, distance: rv?.distance, conf: rv?.confidence });
    }
  }
  console.log(`--- ${relativePath}`);
  console.log('base', { page: fw.page, x: fw.x, y: fw.y, pdfPath: fw.pdfPath });
  for (const c of checks) {
    console.log(JSON.stringify(c));
  }
}

await app.close();
await fs.rm(tempDir, { recursive: true, force: true });

import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';

const repoRoot = '/Users/wedd/tex64';
const workspacePath = '/Users/wedd/tex64/test-sample-hover';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, slowMo: 30, env: { ...process.env } });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1700, height: 980 });
    await page.evaluate((p) => window.tex64Bridge.postMessage({ type: 'openRecentProject', path: p }), workspacePath);
    await page.waitForSelector('body.is-ready', { timeout: 20000 });
    await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', { timeout: 30000 });
    await page.locator('#editor .monaco-editor').click({ position: { x: 120, y: 120 } });
    await wait(200);

    const ok = await page.evaluate(() => {
      const eds = window.monaco?.editor?.getEditors?.() ?? [];
      const editor = eds.find((e) => e.hasTextFocus?.()) ?? eds[0];
      const model = editor?.getModel?.();
      if (!editor || !model) return false;
      const lineCount = model.getLineCount();
      let targetLine = -1;
      for (let i = 1; i <= lineCount; i += 1) {
        const t = model.getLineContent(i);
        if (t.includes('MATH-inline-absnorm:')) { targetLine = i; break; }
      }
      if (targetLine < 0) return false;
      const line = model.getLineContent(targetLine);
      const token = 'left|x';
      const idx = line.indexOf(token);
      if (idx < 0) return false;
      const col = idx + Math.floor(token.length / 2) + 1;
      editor.setPosition({ lineNumber: targetLine, column: col });
      editor.revealPositionInCenterIfOutsideViewport?.({ lineNumber: targetLine, column: col });
      editor.trigger('debug', 'editor.action.showHover', {});
      editor.focus();
      return true;
    });

    if (!ok) throw new Error('position failed');
    await wait(500);

    const info = await page.evaluate(() => {
      const hover = Array.from(document.querySelectorAll('.monaco-hover')).find((n) => {
        const s = window.getComputedStyle(n);
        const r = n.getBoundingClientRect();
        return !n.classList.contains('hidden') && s.display !== 'none' && s.visibility !== 'hidden' && Number.parseFloat(s.opacity || '1') > 0.1 && r.width > 1 && r.height > 1;
      });
      if (!hover) return null;
      const rm = hover.querySelector('.rendered-markdown');
      return {
        text: (hover.textContent || '').replace(/\s+/g, ' ').trim(),
        html: (rm?.innerHTML || hover.innerHTML || '').slice(0, 5000),
        bg: window.getComputedStyle(hover).backgroundColor,
        width: Math.round(hover.getBoundingClientRect().width),
        height: Math.round(hover.getBoundingClientRect().height),
      };
    });

    const outPath = '/Users/wedd/tex64/tmp/debug-absnorm-hover.png';
    await page.screenshot({ path: outPath, fullPage: false });
    await fs.writeFile('/Users/wedd/tex64/tmp/debug-absnorm-hover.json', JSON.stringify(info, null, 2));
    console.log('INFO', JSON.stringify(info));
    console.log('SHOT', outPath);
  } finally {
    await app.close();
  }
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

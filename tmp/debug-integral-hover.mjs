import { _electron as electron } from 'playwright';

const repoRoot = '/Users/wedd/tex64';
const workspacePath = '/Users/wedd/tex64/test-sample-hover';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, slowMo: 24, env: { ...process.env } });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1700, height: 980 });
    await page.evaluate((p) => window.tex64Bridge.postMessage({ type: 'openRecentProject', path: p }), workspacePath);
    await page.waitForSelector('body.is-ready', { timeout: 20000 });
    await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', { timeout: 30000 });
    await page.locator('#editor .monaco-editor').click({ position: { x: 120, y: 120 } });
    await wait(220);

    await page.evaluate(() => {
      const eds = window.monaco?.editor?.getEditors?.() ?? [];
      const editor = eds.find((e) => e.hasTextFocus?.()) ?? eds[0];
      const model = editor?.getModel?.();
      if (!editor || !model) return;
      let ln = -1;
      for (let i = 1; i <= model.getLineCount(); i += 1) {
        const t = model.getLineContent(i);
        if (t.includes('MATH-inline-paren:')) { ln = i; break; }
      }
      if (ln < 0) return;
      const line = model.getLineContent(ln);
      const token = 'int_0^1';
      const idx = line.indexOf(token);
      if (idx < 0) return;
      const col = idx + Math.floor(token.length / 2) + 1;
      editor.setPosition({ lineNumber: ln, column: col });
      editor.revealPositionInCenterIfOutsideViewport?.({ lineNumber: ln, column: col });
      editor.trigger('dbg', 'editor.action.showHover', {});
      editor.focus();
    });

    await wait(500);
    const out = '/Users/wedd/tex64/tmp/debug-integral-hover.png';
    await page.screenshot({ path: out, fullPage: false });
    console.log(out);
  } finally {
    await app.close();
  }
};

run().catch((e) => { console.error(e); process.exit(1); });

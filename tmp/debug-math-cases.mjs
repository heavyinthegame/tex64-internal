import { _electron as electron } from 'playwright';

const repoRoot = '/Users/wedd/tex64';
const workspacePath = '/Users/wedd/tex64/test-sample-hover';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const probes = [
  { id: 'MATH-inline', line: 'MATH-inline:', token: 'E=mc^2' },
  { id: 'MATH-inline-paren', line: 'MATH-inline-paren:', token: 'int_0^1' },
  { id: 'MATH-inline-absnorm', line: 'MATH-inline-absnorm:', token: 'left|x' },
  { id: 'MATH-display-bracket', line: '\\sum_{k=1}^{n}', token: 'sum_{k=1}^{n}' },
  { id: 'MATH-display-dollar', line: '\\Theta_S^{(\\mathrm{det})}', token: 'mapsto' },
  { id: 'MATH-equation-env', line: '+ \\frac{\\|J\\|}{\\rho}', token: 'frac' },
];

const run = async () => {
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, slowMo: 20, env: { ...process.env } });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1700, height: 980 });
    await page.evaluate((p) => window.tex64Bridge.postMessage({ type: 'openRecentProject', path: p }), workspacePath);
    await page.waitForSelector('body.is-ready', { timeout: 20000 });
    await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', { timeout: 30000 });
    await page.locator('#editor .monaco-editor').click({ position: { x: 120, y: 120 } });
    await wait(200);

    const results = [];
    for (const probe of probes) {
      const hit = await page.evaluate((p) => {
        const eds = window.monaco?.editor?.getEditors?.() ?? [];
        const editor = eds.find((e) => e.hasTextFocus?.()) ?? eds[0];
        const model = editor?.getModel?.();
        if (!editor || !model) return false;
        let ln = -1;
        for (let i = 1; i <= model.getLineCount(); i += 1) {
          const t = model.getLineContent(i);
          if (t.includes(p.line)) { ln = i; break; }
        }
        if (ln < 0) return false;
        const text = model.getLineContent(ln);
        const idx = text.indexOf(p.token);
        if (idx < 0) return false;
        const col = idx + Math.floor(p.token.length / 2) + 1;
        editor.setPosition({ lineNumber: ln, column: col });
        editor.revealPositionInCenterIfOutsideViewport?.({ lineNumber: ln, column: col });
        editor.trigger('debug', 'editor.action.showHover', {});
        editor.focus();
        return true;
      }, probe);
      if (!hit) {
        results.push({ id: probe.id, error: 'target-not-found' });
        continue;
      }
      await wait(280);
      const info = await page.evaluate(() => {
        const hover = Array.from(document.querySelectorAll('.monaco-hover')).find((n) => {
          const s = window.getComputedStyle(n);
          const r = n.getBoundingClientRect();
          return !n.classList.contains('hidden') && s.display !== 'none' && s.visibility !== 'hidden' && Number.parseFloat(s.opacity || '1') > 0.1 && r.width > 1 && r.height > 1;
        });
        if (!hover) return null;
        return {
          text: (hover.textContent || '').replace(/\s+/g, ' ').trim(),
          html: (hover.querySelector('.rendered-markdown')?.innerHTML || '').slice(0, 300),
          w: Math.round(hover.getBoundingClientRect().width),
          h: Math.round(hover.getBoundingClientRect().height),
        };
      });
      results.push({ id: probe.id, ...info });
    }

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await app.close();
  }
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

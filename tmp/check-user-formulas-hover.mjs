import { _electron as electron } from 'playwright';

const repoRoot = '/Users/wedd/tex64';
const workspacePath = '/Users/wedd/tex64/test-sample-hover';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const probes = [
  { id: 'sets', lineContains: 'MATH-inline-sets:', token: 'setminus' },
  { id: 'relops', lineContains: 'MATH-inline-relops:', token: 'equiv' },
  { id: 'opname', lineContains: 'MATH-inline-opname:', token: 'argmax' },
  { id: 'prob', lineContains: 'MATH-inline-prob:', token: 'mathbb{E}' },
  { id: 'sumprod', lineContains: 'MATH-inline-sumprod:', token: 'bigcup' },
  { id: 'alignat', lineContains: '\\begin{alignat}{2}', token: 'x_1+x_2' },
  { id: 'flalign', lineContains: '\\begin{flalign}', token: 'u+v' },
];

const run = async () => {
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, slowMo: 20, env: { ...process.env } });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1680, height: 980 });
    await page.evaluate((p) => window.tex64Bridge.postMessage({ type: 'openRecentProject', path: p }), workspacePath);
    await page.waitForSelector('body.is-ready', { timeout: 20000 });
    await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', { timeout: 30000 });
    await page.locator('#editor .monaco-editor').click({ position: { x: 120, y: 120 } });
    await wait(250);

    const results = [];
    for (const p of probes) {
      const ok = await page.evaluate((payload) => {
        const editors = window.monaco?.editor?.getEditors?.() ?? [];
        const editor = editors.find((ed) => ed.hasTextFocus?.()) ?? editors[0];
        const model = editor?.getModel?.();
        if (!editor || !model) return false;

        let ln = -1;
        for (let i = 1; i <= model.getLineCount(); i += 1) {
          const t = model.getLineContent(i);
          if (t.includes(payload.lineContains)) { ln = i; break; }
        }
        if (ln < 0) return false;

        let targetLine = ln;
        let text = model.getLineContent(targetLine);
        if (!text.includes(payload.token)) {
          for (let j = ln; j <= Math.min(model.getLineCount(), ln + 6); j += 1) {
            const tj = model.getLineContent(j);
            if (tj.includes(payload.token)) { targetLine = j; text = tj; break; }
          }
        }

        const idx = text.indexOf(payload.token);
        if (idx < 0) return false;
        const col = idx + Math.floor(payload.token.length / 2) + 1;

        editor.trigger('chk', 'editor.action.hideHover', {});
        editor.setPosition({ lineNumber: targetLine, column: col });
        editor.revealPositionInCenterIfOutsideViewport?.({ lineNumber: targetLine, column: col });
        editor.focus();
        editor.trigger('chk', 'editor.action.showHover', {});
        return true;
      }, p);

      if (!ok) {
        results.push({ id: p.id, ok: false, reason: 'locate-failed' });
        continue;
      }

      await wait(280);
      const stat = await page.evaluate(() => {
        const hover = Array.from(document.querySelectorAll('.monaco-hover')).find((n) => {
          const s = window.getComputedStyle(n);
          const r = n.getBoundingClientRect();
          return !n.classList.contains('hidden') && s.display !== 'none' && s.visibility !== 'hidden' && Number.parseFloat(s.opacity || '1') > 0.1 && r.width > 1 && r.height > 1;
        });
        if (!hover) return { visible: false };
        return {
          visible: true,
          hasMathImage: !!hover.querySelector('img[src*="#tex64-math"]'),
          text: (hover.textContent || '').replace(/\s+/g, ' ').trim(),
          w: Math.round(hover.getBoundingClientRect().width),
          h: Math.round(hover.getBoundingClientRect().height),
        };
      });
      results.push({ id: p.id, ok: true, ...stat });
    }

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await app.close();
  }
};

run().catch((e) => { console.error(e); process.exit(1); });

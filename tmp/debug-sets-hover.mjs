import { _electron as electron } from 'playwright';

const run = async () => {
  const app = await electron.launch({ args: ['.'], cwd: '/Users/wedd/tex64', env: { ...process.env } });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1680, height: 980 });
    await page.evaluate((p) => window.tex64Bridge.postMessage({ type: 'openRecentProject', path: p }), '/Users/wedd/tex64/test-sample-hover');
    await page.waitForSelector('body.is-ready', { timeout: 20000 });
    await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', { timeout: 30000 });
    await page.locator('#editor .monaco-editor').click({ position: { x: 120, y: 120 } });

    await page.evaluate(() => {
      const eds = window.monaco?.editor?.getEditors?.() ?? [];
      const editor = eds.find((ed) => ed.hasTextFocus?.()) ?? eds[0];
      const model = editor?.getModel?.();
      let ln = -1;
      for (let i = 1; i <= model.getLineCount(); i += 1) {
        const t = model.getLineContent(i);
        if (t.includes('MATH-inline-sets:')) { ln = i; break; }
      }
      const line = model.getLineContent(ln);
      const idx = line.indexOf('setminus');
      editor.setPosition({ lineNumber: ln, column: idx + 4 });
      editor.revealPositionInCenterIfOutsideViewport?.({ lineNumber: ln, column: idx + 4 });
      editor.trigger('dbg', 'editor.action.showHover', {});
      editor.focus();
    });

    await new Promise((r)=>setTimeout(r, 400));

    const info = await page.evaluate(() => {
      const hover = Array.from(document.querySelectorAll('.monaco-hover')).find((n) => {
        const s = window.getComputedStyle(n);
        const r = n.getBoundingClientRect();
        return !n.classList.contains('hidden') && s.display !== 'none' && s.visibility !== 'hidden' && Number.parseFloat(s.opacity || '1') > 0.1 && r.width > 1 && r.height > 1;
      });
      if (!hover) return null;
      const img = hover.querySelector('img[src*="#tex64-math"]');
      const src = img?.getAttribute('src') || '';
      const decoded = decodeURIComponent((src.split('#')[0] || '').replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
      return {
        hoverRect: hover.getBoundingClientRect().toJSON ? hover.getBoundingClientRect().toJSON() : { w: hover.getBoundingClientRect().width, h: hover.getBoundingClientRect().height },
        imgRect: img ? { w: img.getBoundingClientRect().width, h: img.getBoundingClientRect().height } : null,
        srcHead: src.slice(0,220),
        svgHead: decoded.slice(0,500),
        svgTail: decoded.slice(-300),
      };
    });
    console.log(JSON.stringify(info, null, 2));
  } finally {
    await app.close();
  }
};

run().catch((e)=>{console.error(e);process.exit(1);});

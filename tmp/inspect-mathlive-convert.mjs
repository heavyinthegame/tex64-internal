import { _electron as electron } from 'playwright';

const run = async () => {
  const app = await electron.launch({ args: ['.'], cwd: '/Users/wedd/tex64', env: { ...process.env } });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('body.is-ready', { timeout: 20000 });
    const out = await page.evaluate(() => {
      const ml = window.MathLive;
      if (!ml) return { ok: false, reason: 'no-mathlive' };
      const samples = [
        String.raw`\\int_0^1 x^2\\,dx`,
        String.raw`\\left|x\\right| + \\lVert v \\rVert`,
        String.raw`\\Theta_S^{(\\mathrm{det})} + R + X_{i:t} \\mapsto X_{i,t} + \\frac{\\|J\\|}{\\rho}`
      ];
      const res = samples.map((s) => {
        let markup = '';
        let mathml = '';
        let err = '';
        try { markup = ml.convertLatexToMarkup(`\\displaystyle ${s}`) || ''; } catch (e) { err += `markup:${String(e)};`; }
        try { mathml = ml.convertLatexToMathMl(`\\displaystyle ${s}`) || ''; } catch (e) { err += `mathml:${String(e)};`; }
        return {
          input: s,
          markupHead: markup.slice(0, 220),
          mathmlHead: mathml.slice(0, 220),
          markupHasClass: /class=/.test(markup),
          mathmlHasMath: /<math/i.test(mathml),
          err,
        };
      });
      return { ok: true, res };
    });
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await app.close();
  }
};

run().catch((e) => { console.error(e); process.exit(1); });

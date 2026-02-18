import { _electron as electron } from 'playwright';

const run = async () => {
  const app = await electron.launch({ args: ['.'], cwd: '/Users/wedd/tex64', env: { ...process.env } });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('body.is-ready', { timeout: 20000 });
    const out = await page.evaluate(() => {
      const ml = window.MathLive;
      const samples = [
        String.raw`\int_0^1 x^2\,dx`,
        String.raw`\left|x\right| + \lVert v \rVert`,
        String.raw`\Theta_S^{(\mathrm{det})} + R + X_{i:t} \mapsto X_{i,t} + \frac{\|J\|}{\rho}`,
      ];
      return samples.map((s)=>{
        let markup=''; let mathml='';
        try { markup = ml.convertLatexToMarkup(`\\displaystyle ${s}`) || ''; } catch(e){ markup='ERR:'+String(e); }
        try { mathml = ml.convertLatexToMathMl(`\\displaystyle ${s}`) || ''; } catch(e){ mathml='ERR:'+String(e); }
        return {
          input:s,
          markupHead:markup.slice(0,260),
          mathmlHead:mathml.slice(0,260),
          markupError: /ML__error/.test(markup),
          mathmlHasLVert: /∥|Vert|lVert|rVert/.test(mathml),
        };
      });
    });
    console.log(JSON.stringify(out,null,2));
  } finally {
    await app.close();
  }
};
run().catch((e)=>{console.error(e);process.exit(1);});

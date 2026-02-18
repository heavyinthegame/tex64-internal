import { _electron as electron } from 'playwright';

const forms = [
  String.raw`\\lVert v \\rVert`,
  String.raw`\\left\\| v \\right\\|`,
  String.raw`\\left\\Vert v \\right\\Vert`,
  String.raw`\\Vert v \\Vert`,
  String.raw`\\left|v\\right|`,
  String.raw`\\left\\lVert v \\right\\rVert`,
];

const run = async () => {
  const app = await electron.launch({ args: ['.'], cwd: '/Users/wedd/tex64', env: { ...process.env } });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('body.is-ready', { timeout: 20000 });
    const out = await page.evaluate((inputForms) => {
      const ml = window.MathLive;
      return inputForms.map((f) => {
        const latex = `\\displaystyle ${f}`;
        let mathml = '';
        try { mathml = ml.convertLatexToMathMl(latex) || ''; } catch (e) { mathml = `ERR:${String(e)}`; }
        return {
          form: f,
          hasBackslashBar: /\\\|/.test(mathml) || /\\Vert|\\lVert|\\rVert/.test(mathml),
          hasDoubleBar: /∥|&#x2225;|&#8741;/.test(mathml),
          head: mathml.slice(0, 260),
        };
      });
    }, forms);
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await app.close();
  }
};

run().catch((e) => { console.error(e); process.exit(1); });

import { _electron as electron } from 'playwright';

const samples = [
  String.raw`A\cup B,\ A\cap B,\ A\setminus B,\ A^\complement`,
  String.raw`a\approx b,\ a\equiv b\pmod n,\ a\sim b,\ a\propto b`,
  String.raw`\operatorname{argmax}_{x\in X} f(x),\ \operatorname{diag}(A)`,
  String.raw`\Pr(A\mid B),\ \mathbb{E}[X],\ \mathrm{Var}(X)`,
  String.raw`\sum_{k=1}^{n}k^2,\ \prod_{i=1}^{m} i,\ \bigcup_{i=1}^{n}A_i`,
  String.raw`\begin{alignat}{2}
x_1+x_2 &= 1, &\qquad x_1-x_2 &= 0\\
y_1+y_2 &= 2, &\qquad y_1-y_2 &= 1
\end{alignat}`,
  String.raw`\begin{flalign}
u+v &= w && \text{(left and right anchored)}
\end{flalign}`,
];

const run = async () => {
  const app = await electron.launch({ args: ['.'], cwd: '/Users/wedd/tex64', env: { ...process.env } });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('body.is-ready', { timeout: 20000 });
    const out = await page.evaluate((arr) => {
      const ml = window.MathLive;
      return arr.map((s) => {
        let m = ''; let err = '';
        try { m = ml.convertLatexToMathMl(`\\displaystyle ${s}`) || ''; } catch (e) { err = String(e); }
        return { input: s.slice(0,80), ok: !!m.trim(), len: m.length, hasMathish: /<m(?:row|frac|table|i|o|n)/.test(m), err, head: m.slice(0,180) };
      });
    }, samples);
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await app.close();
  }
};
run().catch((e)=>{console.error(e);process.exit(1);});

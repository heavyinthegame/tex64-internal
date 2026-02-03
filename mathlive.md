# MathLive Suggestion Commands (TeX ベース)

このファイルは、サジェストで出てくる候補を **TeX コマンド基準** で整理した一覧です。  
`#?` は入力用プレースホルダー（MathLive 内で入力欄）を表します。

## Operators / Calculus
- `\\sum`
  - variants: `\\sum_{#?}^{#?}`
  - triggers: `sum`
  - aliases: `sigma`, `summation`, `summate`
- `\\prod`
  - variants: `\\prod_{#?}^{#?}`
  - triggers: `prod`
  - aliases: `product`, `multiplication`
  - note: `sum` でも候補に含まれます
- `\\int`
  - variants: `\\int_{#?}^{#?}`, `\\iint`, `\\iiint`, `\\oint`
  - triggers: `int`
  - aliases: `integral`, `integrate`, `integration`, `antiderivative`
- `\\sqrt`
  - variants: `\\sqrt{#?}`, `\\sqrt[#?]{#?}`
  - triggers: `sqrt`
  - aliases: `root`, `squareroot`
- `\\frac`
  - variants: `\\frac{#?}{#?}`, `\\dfrac{#?}{#?}`
  - triggers: `frac`
  - aliases: `fraction`, `divide`, `quotient`
- `\\lim`
  - variants: `\\lim_{#? \\to #?}`
  - triggers: `lim`
  - aliases: `limit`
- `\\limsup`
  - variants: `\\limsup_{#?}`
  - triggers: `limsup`
- `\\liminf`
  - variants: `\\liminf_{#?}`
  - triggers: `liminf`
- `\\operatorname*{arg\\,min}`
  - triggers: `argmin`
- `\\operatorname*{arg\\,max}`
  - triggers: `argmax`

## Differential / Vector Calculus
- `\\frac{\\mathrm{d}#?}{\\mathrm{d}#?}`
  - triggers: `ddx`
  - aliases: `deriv`, `d/dx`
- `\\frac{\\mathrm{d}^2 #?}{\\mathrm{d}#?^2}`
  - triggers: `d2dx2`
- `\\frac{\\partial^2 #?}{\\partial #?^2}`
  - triggers: `p2dx2`
- `\\frac{\\partial #?}{\\partial #?}`
  - triggers: `pdx`
  - aliases: `partiald`, `∂/∂x`
- `\\nabla\\cdot`, `\\nabla\\times`
  - triggers: `divergence`, `curl`
  - aliases: `curl2`
- `\\nabla^2`
  - triggers: `laplacian`

## Matrices / Piecewise
- `\\begin{matrix}#?&#?\\\\#?&#?\\end{matrix}`
  - triggers: `matrix`
  - aliases: `mat`
- `\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}`
  - triggers: `pmatrix`
  - aliases: `pmat`
- `\\begin{bmatrix}#?&#?\\\\#?&#?\\end{bmatrix}`
  - triggers: `bmatrix`
  - aliases: `bmat`
- `\\begin{Bmatrix}#?&#?\\\\#?&#?\\end{Bmatrix}`
  - triggers: `Bmatrix`
- `\\begin{vmatrix}#?&#?\\\\#?&#?\\end{vmatrix}`
  - triggers: `vmatrix`
- `\\begin{Vmatrix}#?&#?\\\\#?&#?\\end{Vmatrix}`
  - triggers: `Vmatrix`
- `\\begin{cases}#?&#?\\\\#?&#?\\end{cases}`
  - variants: `\\begin{cases}#? , & #?\\\\#? , & #?\\end{cases}`
  - triggers: `cases`
  - aliases: `piecewise`
- `\\binom{#?}{#?}`
  - triggers: `binom`
  - aliases: `choose`, `combination`, `ncr`

## Multiline / Alignment
- `\\begin{aligned}#? &= #?\\\\#? &= #?\\end{aligned}`
  - triggers: `aligned`
  - aliases: `align`
- `\\begin{array}{#?}#?\\end{array}`
  - triggers: `array`
  - aliases: `cases2`, `table`

## Functions
- `\\log`
  - variants: `\\log_{#?}`
  - triggers: `log`
  - aliases: `logarithm`
- `\\ln`
  - triggers: `ln`
- `\\exp`
  - variants: `e^{#?}`
  - triggers: `exp`
- `\\sin`, `\\cos`, `\\tan`, `\\cot`, `\\sec`, `\\csc`
  - triggers: `sin`, `cos`, `tan`, `cot`, `sec`, `csc`
  - aliases: `sine`, `cosine`, `tangent`, `cotangent`, `secant`, `cosecant`
- `\\arcsin`, `\\arccos`, `\\arctan`
  - triggers: `arcsin`, `arccos`, `arctan`
  - aliases: `arcsine`, `arccosine`, `arctangent`

## Fonts / Styles
- `\\mathbb{#?}`
  - triggers: `mathbb`, `bb`
- `\\mathfrak{#?}`
  - triggers: `mathfrak`, `frak`
- `\\mathsf{#?}`
  - triggers: `mathsf`, `sf`
- `\\mathtt{#?}`
  - triggers: `mathtt`, `tt`
- `\\mathit{#?}`
  - triggers: `mathit`, `it`

## Sets / Logic
- `\\in`, `\\notin`
  - triggers: `in`, `notin`
  - aliases: `element`, `notelement`
- `\\subset`, `\\subseteq`
  - triggers: `subset`
  - aliases: `subseteq`, `subsetof`
- `\\subsetneq`
  - triggers: `subset` (variant)
- `\\supset`, `\\supseteq`
  - triggers: `supset`
  - aliases: `superset`, `superseteq`
- `\\supsetneq`
  - triggers: `supset` (variant)
- `\\cup`, `\\bigcup`
  - triggers: `cup`, `bigcup`
  - aliases: `union`
- `\\cap`, `\\bigcap`
  - triggers: `cap`, `bigcap`
  - aliases: `intersection`
- `\\forall`, `\\exists`, `\\iff`
  - triggers: `forall`, `exists`, `iff`
- `\\therefore`, `\\because`
  - triggers: `therefore`, `because`
- `\\emptyset`
  - triggers: `empty`

## Relations / Comparison
- `\\leq`
  - variants: `\\leqq`
  - triggers: `leq`, `<=`
  - aliases: `le`, `lessequal`
- `\\leqslant`
  - triggers: `leq` (variant), `<=`
  - aliases: `leqslant`
- `\\geq`
  - variants: `\\geqq`
  - triggers: `geq`, `>=`
  - aliases: `ge`, `greaterequal`
- `\\geqslant`
  - triggers: `geq` (variant), `>=`
  - aliases: `geqslant`
- `\\neq`
  - triggers: `neq`, `!=`
  - aliases: `notequal`, `ne`
- `\\ll`, `\\gg`
  - triggers: `ll`, `gg`
- `\\mid`, `\\nmid`
  - triggers: `mid`, `nmid`
- `\\parallel`, `\\perp`
  - triggers: `parallel`, `perp`
- `\\approx`, `\\sim`, `\\simeq`
  - triggers: `approx`
  - aliases: `sim`, `simeq`, `similar`, `approximately`
- `\\equiv`, `\\cong`
  - triggers: `equiv`
  - aliases: `cong`, `congruent`, `identical`
- `\\propto`
  - triggers: `propto`
  - aliases: `proportional`
- `\\stackrel{def}{=}`
  - triggers: `defeq`

## Arrows / Maps
- `\\to`, `\\rightarrow`
  - triggers: `to`, `->`
  - aliases: `arrow`, `goes`
- `\\leftarrow`
  - variants: `\\Leftarrow`
  - triggers: `leftarrow`, `<-`
  - aliases: `left`
- `\\leftrightarrow`
  - variants: `\\Leftrightarrow`
  - triggers: `leftrightarrow`, `<->`, `<=>`
  - aliases: `iff2`
- `\\Rightarrow`
  - triggers: `implies`, `=>`
- `\\mapsto`
  - triggers: `mapsto`
  - aliases: `maps`
- `\\xrightarrow{#?}`, `\\xleftarrow{#?}`
  - triggers: `xrightarrow`, `xleftarrow`
  - aliases: `labeledarrow`
- `\\overset{#?}{#?}`
  - triggers: `overset`
  - aliases: `stackrel`

## Binary Operators
- `\\cdot`
  - triggers: `cdot`, `*`
  - aliases: `dot`
- `\\times`
  - triggers: `times`, `*`
- `\\div`
  - triggers: `div`
  - aliases: `divide`
- `\\pm`, `\\mp`
  - triggers: `pm`, `mp`, `+-`, `-+`
  - aliases: `plusminus`
- `\\circ`
  - triggers: `circ`
  - aliases: `compose`
- `\\oplus`, `\\otimes`
  - triggers: `oplus`, `otimes`
  - aliases: `directsum`, `tensor`
- `\\setminus`
  - triggers: `setminus`
  - aliases: `difference`
- `\\cdots`, `\\ldots`
  - triggers: `cdots`, `ldots`, `...`

## JP Triggers (opt-in)
- `\\int`
  - triggers: `sekibun`
- `\\sum`
  - triggers: `shiguma`
- `\\partial`
  - triggers: `henbibun`
- `\\sqrt{#?}`
  - triggers: `ruuto`

## Accents / Delimiters
- `\\left|#?\\right|`
  - triggers: `abs`
  - aliases: `absolute`, `absolutevalue`, `magnitude`
- `\\left\\lVert#?\\right\\rVert`
  - triggers: `norm`
  - aliases: `norms`
- `\\left\\lceil#?\\right\\rceil`
  - triggers: `ceil`
  - aliases: `ceiling`
- `\\left\\lfloor#?\\right\\rfloor`
  - triggers: `floor`
  - aliases: `flooring`
- `\\vec{#?}`, `\\overrightarrow{#?}`
  - triggers: `vec`
  - aliases: `vector`
- `\\hat{#?}`, `\\bar{#?}`, `\\overline{#?}`, `\\underline{#?}`, `\\tilde{#?}`
  - triggers: `hat`, `bar`, `overline`, `underline`, `tilde`
- `\\dot{#?}`, `\\ddot{#?}`
  - triggers: `dot`, `ddot`
- `\\angle`
  - triggers: `angle`

## Brackets / Templates
- `\\left(#?\\right)`
  - triggers: `par`
  - aliases: `parentheses`
- `\\left[#?\\right]`
  - triggers: `brack`
  - aliases: `brackets`
- `\\left\\{#?\\right\\}`
  - triggers: `brace`
  - aliases: `curly`
- `\\langle #? \\rangle`
  - triggers: `anglebr`
  - aliases: `langle`, `expectation2`
- `\\langle #?, #? \\rangle`
  - triggers: `inner`
  - aliases: `dot2`, `ip`
- `\\left.#?\\right|_{#?}`
  - triggers: `eval`
  - aliases: `evaluateat`

## Logic / Boolean
- `\\land`, `\\lor`, `\\neg`
  - triggers: `and`, `or`, `not`
  - aliases: `wedge`, `vee`, `lnot`
- `\\ni`
  - triggers: `ni`
  - aliases: `contains`

## Text / Fonts
- `\\text{#?}`
  - triggers: `text`
  - aliases: `mathrmtext`
- `\\mathrm{#?}`, `\\mathbf{#?}`, `\\mathcal{#?}`
  - triggers: `rm`, `bf`, `cal`
  - aliases: `roman`, `bold`, `script`
- `\\operatorname{#?}`
  - triggers: `op`
  - aliases: `operatorname`

## Special Symbols
- `\\infty`
  - triggers: `inf`, `infty`
  - aliases: `infinity`, `infinite`
- `\\partial`
  - triggers: `partial`
- `\\nabla`
  - triggers: `nabla`, `grad`

## Number Sets / Probability
- `\\mathbb{R}`
  - triggers: `real`
  - aliases: `realnumbers`, `reals`
- `\\mathbb{C}`
  - triggers: `complex`
  - aliases: `complexnumbers`, `complexes`
- `\\mathbb{Z}`
  - triggers: `integer`
  - aliases: `integers`
- `\\mathbb{Q}`
  - triggers: `rational`
  - aliases: `rationals`
- `\\mathbb{N}`
  - triggers: `natural`
  - aliases: `naturalnumbers`, `naturals`
- `\\mathbb{P}`
  - triggers: `prob`
  - aliases: `probability`
- `\\mathbb{E}`
  - triggers: `expect`
  - aliases: `expectation`

## Greek Letters
- `\\alpha`, `\\beta`
  - triggers: `alpha`, `beta`
- `\\gamma`, `\\Gamma`
  - triggers: `gamma`
- `\\delta`, `\\Delta`
  - triggers: `delta`
- `\\epsilon`, `\\varepsilon`
  - triggers: `epsilon`
- `\\zeta`, `\\eta`, `\\iota`
  - triggers: `zeta`, `eta`, `iota`
- `\\theta`, `\\vartheta`
  - triggers: `theta`
- `\\kappa`, `\\varkappa`
  - triggers: `kappa`
- `\\lambda`, `\\Lambda`
  - triggers: `lambda`
- `\\mu`, `\\nu`
  - triggers: `mu`, `nu`
- `\\xi`, `\\Xi`
  - triggers: `xi`
- `\\pi`, `\\pi_{#?}`, `\\pi^{#?}`, `\\pi_{#?}^{#?}`, `\\varpi`, `\\Pi`
  - triggers: `pi`
- `\\rho`, `\\varrho`
  - triggers: `rho`
- `\\sigma`, `\\varsigma`, `\\Sigma`
  - triggers: `sigma`
- `\\tau`
  - triggers: `tau`
- `\\upsilon`, `\\Upsilon`
  - triggers: `upsilon`
- `\\phi`, `\\varphi`
  - triggers: `phi`
- `\\chi`
  - triggers: `chi`
- `\\psi`, `\\Psi`
  - triggers: `psi`
- `\\omega`, `\\Omega`
  - triggers: `omega`

## Physics / Quantum
- `\\hbar`, `\\ell`
  - triggers: `hbar`, `ell`
- `\\langle #? \\vert` (bra)
  - triggers: `bra`
- `\\vert #? \\rangle` (ket)
  - triggers: `ket`
- `\\langle #? \\vert #? \\rangle` (braket)
  - triggers: `braket`

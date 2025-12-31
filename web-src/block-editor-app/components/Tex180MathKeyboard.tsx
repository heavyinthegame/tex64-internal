import React, { useEffect, useMemo, useState } from "react";
import { useMathField } from "@/lib/math/MathFieldContext";

type MathKeyboardTab = "analysis" | "algebra" | "sets" | "logic" | "arrows" | "greek";

type MathKey = {
  label: string;
  latex?: string;
  fallback?: string;
  shiftLabel?: string;
  shiftLatex?: string;
  shiftFallback?: string;
  displayLatex?: string;
  shiftDisplayLatex?: string;
};

const mathKeyboardFixedKeys: MathKey[] = [
  { label: "+", latex: "+", shiftLabel: "⊕", shiftLatex: "\\oplus " },
  { label: "−", latex: "-", shiftLabel: "⊖", shiftLatex: "\\ominus " },
  { label: "×", latex: "\\times ", shiftLabel: "⊗", shiftLatex: "\\otimes " },
  { label: "÷", latex: "\\div ", shiftLabel: "⊘", shiftLatex: "\\oslash " },
  { label: "·", latex: "\\cdot ", shiftLabel: "•", shiftLatex: "\\bullet " },
  { label: "=", latex: "=", shiftLabel: "≡", shiftLatex: "\\equiv " },
  { label: "≠", latex: "\\neq ", shiftLabel: "≈", shiftLatex: "\\approx " },
  { label: "≤", latex: "\\leq ", shiftLabel: "≦", shiftLatex: "\\leqq " },
  { label: "≥", latex: "\\geq ", shiftLabel: "≧", shiftLatex: "\\geqq " },
  { label: "<", latex: "<", shiftLabel: "≪", shiftLatex: "\\ll " },
  { label: ">", latex: ">", shiftLabel: "≫", shiftLatex: "\\gg " },
  { label: "±", latex: "\\pm ", shiftLabel: "∓", shiftLatex: "\\mp " },
  {
    label: "sum",
    latex: "\\sum ",
    shiftLabel: "prod",
    shiftLatex: "\\prod ",
    displayLatex: "\\sum",
    shiftDisplayLatex: "\\prod",
  },
  {
    label: "int",
    latex: "\\int ",
    shiftLabel: "int_ab",
    shiftLatex: "\\int_{#?}^{#?}",
    shiftFallback: "\\int_{}^{}",
    displayLatex: "\\int",
    shiftDisplayLatex: "\\int_{a}^{b}",
  },
  {
    label: "∞",
    latex: "\\infty ",
    shiftLabel: "ℵ0",
    shiftLatex: "\\aleph_0 ",
    displayLatex: "\\infty",
    shiftDisplayLatex: "\\aleph_0",
  },
  {
    label: "sqrt",
    latex: "\\sqrt{#?}",
    fallback: "\\sqrt{}",
    shiftLabel: "root",
    shiftLatex: "\\sqrt[#?]{#?}",
    shiftFallback: "\\sqrt[]{}",
    displayLatex: "\\sqrt{x}",
    shiftDisplayLatex: "\\sqrt[n]{x}",
  },
  {
    label: "frac",
    latex: "\\frac{#?}{#?}",
    fallback: "\\frac{}{}",
    shiftLabel: "dfrac",
    shiftLatex: "\\dfrac{#?}{#?}",
    shiftFallback: "\\dfrac{}{}",
    displayLatex: "\\frac{a}{b}",
    shiftDisplayLatex: "\\dfrac{a}{b}",
  },
  {
    label: "pow",
    latex: "^{#?}",
    fallback: "^{}",
    shiftLabel: "x^2",
    shiftLatex: "^{2}",
    displayLatex: "x^{n}",
    shiftDisplayLatex: "x^{2}",
  },
  {
    label: "sub",
    latex: "_{#?}",
    fallback: "_{}",
    shiftLabel: "x_0",
    shiftLatex: "_{0}",
    displayLatex: "x_{n}",
    shiftDisplayLatex: "x_{0}",
  },
  {
    label: "abs",
    latex: "\\left|#?\\right|",
    fallback: "\\left|\\right|",
    shiftLabel: "inner",
    shiftLatex: "\\left\\langle#?\\right\\rangle",
    shiftFallback: "\\left\\langle\\right\\rangle",
    displayLatex: "\\left|x\\right|",
    shiftDisplayLatex: "\\langle x, y \\rangle",
  },
  {
    label: "sin",
    latex: "\\sin ",
    shiftLabel: "arcsin",
    shiftLatex: "\\arcsin ",
    displayLatex: "\\sin",
    shiftDisplayLatex: "\\arcsin",
  },
  {
    label: "cos",
    latex: "\\cos ",
    shiftLabel: "arccos",
    shiftLatex: "\\arccos ",
    displayLatex: "\\cos",
    shiftDisplayLatex: "\\arccos",
  },
  {
    label: "tan",
    latex: "\\tan ",
    shiftLabel: "arctan",
    shiftLatex: "\\arctan ",
    displayLatex: "\\tan",
    shiftDisplayLatex: "\\arctan",
  },
  {
    label: "log",
    latex: "\\log ",
    shiftLabel: "log_b",
    shiftLatex: "\\log_{#?}",
    shiftFallback: "\\log_{}",
    displayLatex: "\\log",
    shiftDisplayLatex: "\\log_{b}",
  },
  { label: "ln", latex: "\\ln ", shiftLabel: "lg", shiftLatex: "\\lg ", displayLatex: "\\ln", shiftDisplayLatex: "\\lg" },
  {
    label: "exp",
    latex: "\\exp ",
    shiftLabel: "e^",
    shiftLatex: "e^{#?}",
    shiftFallback: "e^{}",
    displayLatex: "\\exp",
    shiftDisplayLatex: "e^{x}",
  },
  {
    label: "lim",
    latex: "\\lim ",
    shiftLabel: "lim→",
    shiftLatex: "\\lim_{#? \\to #?}",
    shiftFallback: "\\lim_{}",
    displayLatex: "\\lim",
    shiftDisplayLatex: "\\lim_{x \\to a}",
  },
  { label: "→", latex: "\\to ", shiftLabel: "⇒", shiftLatex: "\\Rightarrow " },
  {
    label: "∂",
    latex: "\\partial ",
    shiftLabel: "d",
    shiftLatex: "\\mathrm{d} ",
    displayLatex: "\\partial",
    shiftDisplayLatex: "\\mathrm{d}",
  },
  {
    label: "∇",
    latex: "\\nabla ",
    shiftLabel: "Δ",
    shiftLatex: "\\Delta ",
    displayLatex: "\\nabla",
    shiftDisplayLatex: "\\Delta",
  },
];

const mathKeyboardSets: Record<MathKeyboardTab, MathKey[]> = {
  analysis: [
    {
      label: "d/dx",
      latex: "\\frac{d}{d#?}#?",
      fallback: "\\frac{d}{d} ",
      shiftLabel: "d2/dx2",
      shiftLatex: "\\frac{d^2}{d#?^2}#?",
      shiftFallback: "\\frac{d^2}{d^2} ",
      displayLatex: "\\frac{d}{dx}",
      shiftDisplayLatex: "\\frac{d^2}{dx^2}",
    },
    {
      label: "∂/∂x",
      latex: "\\frac{\\partial}{\\partial #?}#?",
      fallback: "\\frac{\\partial}{\\partial} ",
      shiftLabel: "∂2/∂x2",
      shiftLatex: "\\frac{\\partial^2}{\\partial #?^2}#?",
      shiftFallback: "\\frac{\\partial^2}{\\partial^2} ",
      displayLatex: "\\frac{\\partial}{\\partial x}",
      shiftDisplayLatex: "\\frac{\\partial^2}{\\partial x^2}",
    },
    {
      label: "∮",
      latex: "\\oint ",
      shiftLabel: "∮_C",
      shiftLatex: "\\oint_{#?}",
      shiftFallback: "\\oint_{}",
      displayLatex: "\\oint",
      shiftDisplayLatex: "\\oint_{C}",
    },
    {
      label: "∬",
      latex: "\\iint ",
      shiftLabel: "∭",
      shiftLatex: "\\iiint ",
      displayLatex: "\\iint",
      shiftDisplayLatex: "\\iiint",
    },
    {
      label: "lim sup",
      latex: "\\limsup ",
      shiftLabel: "lim inf",
      shiftLatex: "\\liminf ",
      displayLatex: "\\limsup",
      shiftDisplayLatex: "\\liminf",
    },
    {
      label: "sup",
      latex: "\\sup ",
      shiftLabel: "inf",
      shiftLatex: "\\inf ",
      displayLatex: "\\sup",
      shiftDisplayLatex: "\\inf",
    },
    {
      label: "max",
      latex: "\\max ",
      shiftLabel: "min",
      shiftLatex: "\\min ",
      displayLatex: "\\max",
      shiftDisplayLatex: "\\min",
    },
    {
      label: "≈",
      latex: "\\approx ",
      shiftLabel: "∼",
      shiftLatex: "\\sim ",
      displayLatex: "\\approx",
      shiftDisplayLatex: "\\sim",
    },
    {
      label: "≃",
      latex: "\\simeq ",
      shiftLabel: "≅",
      shiftLatex: "\\cong ",
      displayLatex: "\\simeq",
      shiftDisplayLatex: "\\cong",
    },
    {
      label: "O",
      latex: "\\mathcal{O} ",
      shiftLabel: "o",
      shiftLatex: "\\mathrm{o} ",
      displayLatex: "\\mathcal{O}",
      shiftDisplayLatex: "\\mathrm{o}",
    },
    {
      label: "ℒ",
      latex: "\\mathcal{L} ",
      shiftLabel: "ℓ",
      shiftLatex: "\\ell ",
      displayLatex: "\\mathcal{L}",
      shiftDisplayLatex: "\\ell",
    },
    {
      label: "ℱ",
      latex: "\\mathcal{F} ",
      shiftLabel: "ℳ",
      shiftLatex: "\\mathcal{M} ",
      displayLatex: "\\mathcal{F}",
      shiftDisplayLatex: "\\mathcal{M}",
    },
  ],
  algebra: [
    {
      label: "⌊x⌋",
      latex: "\\left\\lfloor#?\\right\\rfloor",
      fallback: "\\left\\lfloor\\right\\rfloor",
      shiftLabel: "⌈x⌉",
      shiftLatex: "\\left\\lceil#?\\right\\rceil",
      shiftFallback: "\\left\\lceil\\right\\rceil",
      displayLatex: "\\lfloor x \\rfloor",
      shiftDisplayLatex: "\\lceil x \\rceil",
    },
    {
      label: "binom",
      latex: "\\binom{#?}{#?}",
      fallback: "\\binom{}{}",
      displayLatex: "\\binom{n}{k}",
    },
    {
      label: "cases",
      latex: "\\begin{cases}#?\\\\#?\\end{cases}",
      fallback: "\\begin{cases}\n  \\\\n\\end{cases}",
      displayLatex: "\\begin{cases} a \\\\ b \\end{cases}",
    },
    {
      label: "matrix",
      latex: "\\begin{matrix}#?\\\\#?\\end{matrix}",
      fallback: "\\begin{matrix}\n  & \\\\n  & \n\\end{matrix}",
      shiftLabel: "pmatrix",
      shiftLatex: "\\begin{pmatrix}#?\\\\#?\\end{pmatrix}",
      shiftFallback: "\\begin{pmatrix}\n  & \\\\n  & \n\\end{pmatrix}",
      displayLatex: "\\begin{matrix} a & b \\\\ c & d \\end{matrix}",
      shiftDisplayLatex: "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}",
    },
    {
      label: "bmatrix",
      latex: "\\begin{bmatrix}#?\\\\#?\\end{bmatrix}",
      fallback: "\\begin{bmatrix}\n  & \\\\n  & \n\\end{bmatrix}",
      shiftLabel: "vmatrix",
      shiftLatex: "\\begin{vmatrix}#?\\\\#?\\end{vmatrix}",
      shiftFallback: "\\begin{vmatrix}\n  & \\\\n  & \n\\end{vmatrix}",
      displayLatex: "\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}",
      shiftDisplayLatex: "\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}",
    },
    { label: "det", latex: "\\det ", shiftLabel: "adj", shiftLatex: "\\operatorname{adj} " },
    { label: "tr", latex: "\\operatorname{tr} ", shiftLabel: "diag", shiftLatex: "\\operatorname{diag} " },
    { label: "rank", latex: "\\operatorname{rank} ", shiftLabel: "null", shiftLatex: "\\operatorname{null} " },
    { label: "dim", latex: "\\dim ", shiftLabel: "deg", shiftLatex: "\\deg " },
    { label: "ker", latex: "\\ker ", shiftLabel: "span", shiftLatex: "\\operatorname{span} " },
    { label: "gcd", latex: "\\gcd ", shiftLabel: "lcm", shiftLatex: "\\operatorname{lcm} " },
    { label: "mod", latex: "\\bmod ", shiftLabel: "mod", shiftLatex: "\\pmod{#?}", shiftFallback: "\\pmod{}" },
    {
      label: "vec",
      latex: "\\vec{#?}",
      fallback: "\\vec{}",
      shiftLabel: "over→",
      shiftLatex: "\\overrightarrow{#?}",
      shiftFallback: "\\overrightarrow{}",
    },
    {
      label: "hat",
      latex: "\\hat{#?}",
      fallback: "\\hat{}",
      shiftLabel: "tilde",
      shiftLatex: "\\tilde{#?}",
      shiftFallback: "\\tilde{}",
    },
    {
      label: "bar",
      latex: "\\bar{#?}",
      fallback: "\\bar{}",
      shiftLabel: "overline",
      shiftLatex: "\\overline{#?}",
      shiftFallback: "\\overline{}",
    },
    {
      label: "dot",
      latex: "\\dot{#?}",
      fallback: "\\dot{}",
      shiftLabel: "ddot",
      shiftLatex: "\\ddot{#?}",
      shiftFallback: "\\ddot{}",
    },
    {
      label: "bold",
      latex: "\\mathbf{#?}",
      fallback: "\\mathbf{}",
      shiftLabel: "boldsym",
      shiftLatex: "\\boldsymbol{#?}",
      shiftFallback: "\\boldsymbol{}",
    },
    {
      label: "bb",
      latex: "\\mathbb{#?}",
      fallback: "\\mathbb{}",
      shiftLabel: "frak",
      shiftLatex: "\\mathfrak{#?}",
      shiftFallback: "\\mathfrak{}",
    },
    {
      label: "cal",
      latex: "\\mathcal{#?}",
      fallback: "\\mathcal{}",
      shiftLabel: "scr",
      shiftLatex: "\\mathscr{#?}",
      shiftFallback: "\\mathscr{}",
    },
    {
      label: "text",
      latex: "\\text{#?}",
      fallback: "\\text{}",
      shiftLabel: "rm",
      shiftLatex: "\\mathrm{#?}",
      shiftFallback: "\\mathrm{}",
    },
  ],
  sets: [
    { label: "∈", latex: "\\in ", shiftLabel: "∉", shiftLatex: "\\notin " },
    { label: "∋", latex: "\\ni ", shiftLabel: "∌", shiftLatex: "\\not\\ni " },
    { label: "⊂", latex: "\\subset ", shiftLabel: "⊆", shiftLatex: "\\subseteq " },
    { label: "⊃", latex: "\\supset ", shiftLabel: "⊇", shiftLatex: "\\supseteq " },
    { label: "⊊", latex: "\\subsetneq ", shiftLabel: "⊋", shiftLatex: "\\supsetneq " },
    { label: "∪", latex: "\\cup ", shiftLabel: "∩", shiftLatex: "\\cap " },
    { label: "⋃", latex: "\\bigcup ", shiftLabel: "⋂", shiftLatex: "\\bigcap " },
    { label: "∅", latex: "\\emptyset ", shiftLabel: "⌀", shiftLatex: "\\varnothing " },
    { label: "∖", latex: "\\setminus ", shiftLabel: "△", shiftLatex: "\\triangle " },
    { label: "{x|}", latex: "\\{#?\\mid#?\\}", fallback: "\\{\\mid\\}", displayLatex: "\\{x \\mid y\\}" },
    { label: "℘", latex: "\\mathcal{P} ", shiftLabel: "ℱ", shiftLatex: "\\mathcal{F} " },
    { label: "ℕ", latex: "\\mathbb{N} ", shiftLabel: "ℤ", shiftLatex: "\\mathbb{Z} " },
    { label: "ℚ", latex: "\\mathbb{Q} ", shiftLabel: "ℝ", shiftLatex: "\\mathbb{R} " },
    { label: "ℂ", latex: "\\mathbb{C} ", shiftLabel: "ℍ", shiftLatex: "\\mathbb{H} " },
    { label: "⟂", latex: "\\perp ", shiftLabel: "∥", shiftLatex: "\\parallel " },
  ],
  logic: [
    { label: "∀", latex: "\\forall ", shiftLabel: "∃", shiftLatex: "\\exists " },
    { label: "¬", latex: "\\neg ", shiftLabel: "¬¬", shiftLatex: "\\neg\\neg " },
    { label: "∧", latex: "\\land ", shiftLabel: "∨", shiftLatex: "\\lor " },
    { label: "⇒", latex: "\\Rightarrow ", shiftLabel: "⇔", shiftLatex: "\\Leftrightarrow " },
    { label: "⇐", latex: "\\Leftarrow " },
    { label: "⊢", latex: "\\vdash ", shiftLabel: "⊨", shiftLatex: "\\models " },
    { label: "⊥", latex: "\\bot ", shiftLabel: "⊤", shiftLatex: "\\top " },
    { label: "≡", latex: "\\equiv ", shiftLabel: "≢", shiftLatex: "\\not\\equiv " },
    { label: "⊕", latex: "\\oplus ", shiftLabel: "⊗", shiftLatex: "\\otimes " },
    { label: "∴", latex: "\\therefore ", shiftLabel: "∵", shiftLatex: "\\because " },
    { label: "□", latex: "\\Box ", shiftLabel: "◇", shiftLatex: "\\Diamond " },
    { label: "∃!", latex: "\\exists!", shiftLabel: "∄", shiftLatex: "\\not\\exists " },
    { label: "⊂", latex: "\\subset ", shiftLabel: "⊆", shiftLatex: "\\subseteq " },
  ],
  arrows: [
    { label: "←", latex: "\\leftarrow ", shiftLabel: "⇐", shiftLatex: "\\Leftarrow " },
    { label: "↔", latex: "\\leftrightarrow ", shiftLabel: "⇔", shiftLatex: "\\Leftrightarrow " },
    { label: "↦", latex: "\\mapsto ", shiftLabel: "⟼", shiftLatex: "\\longmapsto " },
    { label: "⟶", latex: "\\longrightarrow ", shiftLabel: "⟹", shiftLatex: "\\Longrightarrow " },
    { label: "⟵", latex: "\\longleftarrow ", shiftLabel: "⟸", shiftLatex: "\\Longleftarrow " },
    { label: "⟷", latex: "\\longleftrightarrow ", shiftLabel: "⟺", shiftLatex: "\\Longleftrightarrow " },
    { label: "↑", latex: "\\uparrow ", shiftLabel: "⇑", shiftLatex: "\\Uparrow " },
    { label: "↓", latex: "\\downarrow ", shiftLabel: "⇓", shiftLatex: "\\Downarrow " },
    { label: "↕", latex: "\\updownarrow ", shiftLabel: "⇕", shiftLatex: "\\Updownarrow " },
    { label: "↗", latex: "\\nearrow ", shiftLabel: "↘", shiftLatex: "\\searrow " },
    { label: "↖", latex: "\\nwarrow ", shiftLabel: "↙", shiftLatex: "\\swarrow " },
    { label: "↪", latex: "\\hookrightarrow ", shiftLabel: "↩", shiftLatex: "\\hookleftarrow " },
    { label: "↠", latex: "\\twoheadrightarrow ", shiftLabel: "↞", shiftLatex: "\\twoheadleftarrow " },
    { label: "⇝", latex: "\\rightsquigarrow ", shiftLabel: "⇜", shiftLatex: "\\leftsquigarrow " },
    { label: "⤳", latex: "\\curvearrowright ", shiftLabel: "⤲", shiftLatex: "\\curvearrowleft " },
    { label: "⇀", latex: "\\rightharpoonup ", shiftLabel: "⇁", shiftLatex: "\\rightharpoondown " },
    { label: "↼", latex: "\\leftharpoonup ", shiftLabel: "↽", shiftLatex: "\\leftharpoondown " },
    { label: "⇉", latex: "\\rightrightarrows ", shiftLabel: "⇇", shiftLatex: "\\leftleftarrows " },
  ],
  greek: [
    { label: "α", latex: "\\alpha ", shiftLabel: "Α", shiftLatex: "A " },
    { label: "β", latex: "\\beta ", shiftLabel: "Β", shiftLatex: "B " },
    { label: "γ", latex: "\\gamma ", shiftLabel: "Γ", shiftLatex: "\\Gamma " },
    { label: "δ", latex: "\\delta ", shiftLabel: "Δ", shiftLatex: "\\Delta " },
    { label: "ε", latex: "\\epsilon ", shiftLabel: "Ε", shiftLatex: "E " },
    { label: "ϵ", latex: "\\varepsilon ", shiftLabel: "Ε", shiftLatex: "E " },
    { label: "ζ", latex: "\\zeta ", shiftLabel: "Ζ", shiftLatex: "Z " },
    { label: "η", latex: "\\eta ", shiftLabel: "Η", shiftLatex: "H " },
    { label: "θ", latex: "\\theta ", shiftLabel: "Θ", shiftLatex: "\\Theta " },
    { label: "ϑ", latex: "\\vartheta ", shiftLabel: "Θ", shiftLatex: "\\Theta " },
    { label: "ι", latex: "\\iota ", shiftLabel: "Ι", shiftLatex: "I " },
    { label: "κ", latex: "\\kappa ", shiftLabel: "Κ", shiftLatex: "K " },
    { label: "λ", latex: "\\lambda ", shiftLabel: "Λ", shiftLatex: "\\Lambda " },
    { label: "μ", latex: "\\mu ", shiftLabel: "Μ", shiftLatex: "M " },
    { label: "ν", latex: "\\nu ", shiftLabel: "Ν", shiftLatex: "N " },
    { label: "ξ", latex: "\\xi ", shiftLabel: "Ξ", shiftLatex: "\\Xi " },
    { label: "π", latex: "\\pi ", shiftLabel: "Π", shiftLatex: "\\Pi " },
    { label: "ϖ", latex: "\\varpi ", shiftLabel: "Π", shiftLatex: "\\Pi " },
    { label: "ρ", latex: "\\rho ", shiftLabel: "Ρ", shiftLatex: "P " },
    { label: "ϱ", latex: "\\varrho ", shiftLabel: "Ρ", shiftLatex: "P " },
    { label: "σ", latex: "\\sigma ", shiftLabel: "Σ", shiftLatex: "\\Sigma " },
    { label: "ς", latex: "\\varsigma ", shiftLabel: "Σ", shiftLatex: "\\Sigma " },
    { label: "τ", latex: "\\tau ", shiftLabel: "Τ", shiftLatex: "T " },
    { label: "υ", latex: "\\upsilon ", shiftLabel: "Υ", shiftLatex: "\\Upsilon " },
    { label: "φ", latex: "\\phi ", shiftLabel: "Φ", shiftLatex: "\\Phi " },
    { label: "ϕ", latex: "\\varphi ", shiftLabel: "Φ", shiftLatex: "\\Phi " },
    { label: "χ", latex: "\\chi ", shiftLabel: "Χ", shiftLatex: "X " },
    { label: "ψ", latex: "\\psi ", shiftLabel: "Ψ", shiftLatex: "\\Psi " },
    { label: "ω", latex: "\\omega ", shiftLabel: "Ω", shiftLatex: "\\Omega " },
  ],
};

const resolveMathKey = (key: MathKey, shiftActive: boolean) => {
  if (shiftActive && (key.shiftLatex || key.shiftLabel)) {
    return {
      label: key.shiftLabel ?? key.label,
      latex: key.shiftLatex ?? key.latex,
      displayLatex: key.shiftDisplayLatex ?? key.displayLatex,
      fallback: key.shiftFallback ?? key.fallback,
    };
  }
  return {
    label: key.label,
    latex: key.latex,
    displayLatex: key.displayLatex,
    fallback: key.fallback,
  };
};

const buildMathKeyDisplayLatex = (key: ReturnType<typeof resolveMathKey>) => {
  const source = key.displayLatex ?? key.latex ?? key.fallback;
  if (!source) {
    return null;
  }
  const placeholders = ["x", "y", "z", "a", "b", "c"];
  let index = 0;
  return source.replace(/#\?/g, () => {
    const value = placeholders[index] ?? "x";
    index += 1;
    return value;
  });
};

const isShiftActiveKey = (event: KeyboardEvent) => event.key === "Shift";

export function Tex180MathKeyboard({ forceOpen = false }: { forceOpen?: boolean }) {
  const { insertToActive, openMathFieldId } = useMathField();
  const [activeTab, setActiveTab] = useState<MathKeyboardTab>("analysis");
  const [shiftHeld, setShiftHeld] = useState(false);
  const [mathLiveReady, setMathLiveReady] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isShiftActiveKey(event)) {
        setShiftHeld(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (isShiftActiveKey(event)) {
        setShiftHeld(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("keyup", handleKeyUp, { capture: true });
    };
  }, []);

  useEffect(() => {
    const checkReady = () => {
      const mathLiveGlobal = (window as any).MathLive;
      if (mathLiveGlobal?.convertLatexToMarkup) {
        setMathLiveReady(true);
      }
    };
    checkReady();
    window.addEventListener("mathlive-ready", checkReady, { once: true });
    return () => {
      window.removeEventListener("mathlive-ready", checkReady);
    };
  }, []);

  const isOpen = forceOpen ? true : !!openMathFieldId;

  const fixedKeys = useMemo(() => {
    return mathKeyboardFixedKeys.map((key) => resolveMathKey(key, shiftHeld));
  }, [shiftHeld]);

  const tabKeys = useMemo(() => {
    const keys = mathKeyboardSets[activeTab] ?? [];
    return keys.map((key) => resolveMathKey(key, shiftHeld));
  }, [activeTab, shiftHeld]);

  const renderKeyLabel = (key: ReturnType<typeof resolveMathKey>) => {
    const displayLatex = buildMathKeyDisplayLatex(key);
    const mathLiveGlobal = (window as any).MathLive;
    if (displayLatex && mathLiveReady && mathLiveGlobal?.convertLatexToMarkup) {
      try {
        const latexToRender = `\\displaystyle ${displayLatex}`;
        const markup = mathLiveGlobal.convertLatexToMarkup(latexToRender);
        return {
          hasMath: true,
          node: (
            <span
              className="math-keyboard-math"
              dangerouslySetInnerHTML={{ __html: markup }}
            />
          ),
        };
      } catch (_error) {
        return { hasMath: false, node: <span>{key.label}</span> };
      }
    }
    return { hasMath: false, node: <span>{key.label}</span> };
  };

  const handleInsert = (key: ReturnType<typeof resolveMathKey>) => {
    if (!key.latex) return;
    insertToActive(key.latex);
  };

  return (
    <div
      className={`math-keyboard-dock ${isOpen ? "is-open" : ""}`}
      aria-hidden={isOpen ? "false" : "true"}
      data-math-keyboard
    >
      <div className="math-keyboard-tabs" role="tablist" aria-label="数式キーボード">
        {(["greek", "analysis", "algebra", "sets", "logic", "arrows"] as MathKeyboardTab[]).map(
          (tab) => (
            <button
              key={tab}
              className={`math-keyboard-tab ${activeTab === tab ? "is-active" : ""}`}
              type="button"
              data-math-tab={tab}
              aria-selected={activeTab === tab ? "true" : "false"}
              onClick={() => setActiveTab(tab)}
            >
              {tab === "greek" ? "ギリシャ" : tab === "analysis" ? "解析" : tab === "algebra" ? "代数" : tab === "sets" ? "集合" : tab === "logic" ? "論理" : "矢印"}
            </button>
          ),
        )}
      </div>
      <div className="math-keyboard-grid">
        {tabKeys.map((key, index) => {
          const { node, hasMath } = renderKeyLabel(key);
          return (
            <button
              key={`${key.label}-${index}`}
              type="button"
              className={`math-keyboard-key${hasMath ? " has-math" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => handleInsert(key)}
            >
              {node}
            </button>
          );
        })}
      </div>
      <div className="math-keyboard-divider" />
      <div className="math-keyboard-fixed-grid">
        {fixedKeys.map((key, index) => {
          const { node, hasMath } = renderKeyLabel(key);
          return (
            <button
              key={`${key.label}-${index}`}
              type="button"
              className={`math-keyboard-key${hasMath ? " has-math" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => handleInsert(key)}
            >
              {node}
            </button>
          );
        })}
      </div>
    </div>
  );
}

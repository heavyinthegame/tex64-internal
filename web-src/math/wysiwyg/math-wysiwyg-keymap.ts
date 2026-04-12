import { mathKeyboardFixedKeys, mathKeyboardSets } from "../../app/math-keyboard-data.js";
import type { MathKey } from "../../app/types.js";

export const normalizeLatexKey = (value?: string | null) => (value ?? "").trim();

const EXCLUDED_COMMANDS = new Set([
  "left",
  "right",
  "begin",
  "end",
  "mathrm",
  "mathbf",
  "mathbb",
  "mathcal",
  "mathfrak",
  "mathit",
  "mathsf",
  "mathtt",
  "operatorname",
  "overline",
  "underline",
  "hat",
  "tilde",
  "vec",
  "bar",
  "dot",
  "ddot",
  "widehat",
  "widetilde",
  "text",
  "color",
  "bbox",
  "mbox",
  "phantom",
]);

export const extractCommand = (latex: string) => {
  const trimmed = latex.trim();
  const match = trimmed.match(/^\\([A-Za-z]+)(?![A-Za-z])/);
  if (!match) {
    return null;
  }
  const command = match[1];
  if (!command) {
    return null;
  }
  if (EXCLUDED_COMMANDS.has(command)) {
    return null;
  }
  return command;
};

const resolveShiftKey = (key: MathKey): MathKey | null => {
  const hasShift =
    key.shiftLabel ||
    key.shiftLatex ||
    key.shiftFallback ||
    key.shiftDisplayLatex ||
    key.shiftScriptKind ||
    key.shiftScriptValue !== undefined ||
    key.shiftScriptBase ||
    key.shiftScriptSubValue !== undefined ||
    key.shiftScriptSupValue !== undefined ||
    key.shiftTemplateKind ||
    key.shiftTemplateTarget !== undefined ||
    key.shiftTemplateSeparator !== undefined ||
    key.shiftTemplateScope !== undefined;
  if (!hasShift) {
    return null;
  }
  return {
    label: key.shiftLabel ?? key.label,
    latex: key.shiftLatex ?? key.latex,
    fallback: key.shiftFallback ?? key.fallback,
    displayLatex: key.shiftDisplayLatex ?? key.displayLatex,
    scriptKind: key.shiftScriptKind ?? key.scriptKind,
    scriptValue:
      key.shiftScriptValue !== undefined ? key.shiftScriptValue : key.scriptValue,
    scriptBase: key.shiftScriptBase ?? key.scriptBase,
    scriptSubValue:
      key.shiftScriptSubValue !== undefined
        ? key.shiftScriptSubValue
        : key.scriptSubValue,
    scriptSupValue:
      key.shiftScriptSupValue !== undefined
        ? key.shiftScriptSupValue
        : key.scriptSupValue,
    templateKind: key.shiftTemplateKind ?? key.templateKind,
    templateTarget:
      key.shiftTemplateTarget !== undefined
        ? key.shiftTemplateTarget
        : key.templateTarget,
    templateSeparator:
      key.shiftTemplateSeparator !== undefined
        ? key.shiftTemplateSeparator
        : key.templateSeparator,
    templateScope:
      key.shiftTemplateScope !== undefined
        ? key.shiftTemplateScope
        : key.templateScope,
  };
};

const buildSimpleVariant = (
  key: MathKey,
  latex: string,
  displayLatex: string
): MathKey => ({
  label: key.label ?? latex,
  latex,
  displayLatex,
  fallback: key.fallback,
});

const expandScriptVariants = (key: MathKey): MathKey[] => {
  const baseLatex = key.latex?.trim();
  if (!baseLatex) {
    return [key];
  }
  if (baseLatex.includes("#?")) {
    return [key];
  }
  const commandMatch = baseLatex.match(/^\\([A-Za-z]+)$/);
  if (!commandMatch) {
    return [key];
  }
  const command = commandMatch[1];
  if (!command || EXCLUDED_COMMANDS.has(command)) {
    return [key];
  }
  const baseDisplay = (key.displayLatex ?? baseLatex).trim();
  const subDisplay = `${baseDisplay}_{i}`;
  const supDisplay = `${baseDisplay}^{2}`;
  const subSupDisplay = `${baseDisplay}_{i}^{n}`;
  return [
    key,
    buildSimpleVariant(key, `${baseLatex}_{#?}`, subDisplay),
    buildSimpleVariant(key, `${baseLatex}^{#?}`, supDisplay),
    buildSimpleVariant(key, `${baseLatex}_{#?}^{#?}`, subSupDisplay),
  ];
};

export const collectKeyVariants = () => {
  const variants: MathKey[] = [];
  const allKeys = [
    ...mathKeyboardFixedKeys,
    ...Object.values(mathKeyboardSets).flat(),
  ];
  allKeys.forEach((key) => {
    const expanded = expandScriptVariants(key);
    expanded.forEach((entry) => variants.push(entry));
    const shifted = resolveShiftKey(key);
    if (shifted) {
      expandScriptVariants(shifted).forEach((entry) => variants.push(entry));
    }
  });
  return variants;
};

const buildKeyMap = () => {
  const map = new Map<string, MathKey>();
  const variants = collectKeyVariants();
  variants.forEach((key) => {
    const normalized = normalizeLatexKey(key.latex);
    if (!normalized) {
      return;
    }
    if (!map.has(normalized)) {
      map.set(normalized, key);
    }
  });
  return map;
};

const KEY_BY_LATEX = buildKeyMap();

export const getKeyByLatex = (
  latex: string,
  label: string,
  displayLatex?: string
): MathKey => {
  const normalized = normalizeLatexKey(latex);
  const existing = KEY_BY_LATEX.get(normalized);
  if (existing) {
    return existing;
  }
  return {
    label,
    latex,
    displayLatex: displayLatex ?? latex,
  };
};

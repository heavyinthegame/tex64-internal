import { DEFAULT_WYSIWYG_PACKS, WYSIWYG_PACKS } from "../math-wysiwyg-packs.js";

export type MathWysiwygSettings = {
  autoSuggest: boolean;
  enabledPacks: string[];
};

const MATH_WYSIWYG_AUTO_KEY = "tex64.math-wysiwyg.autoSuggest";
const MATH_WYSIWYG_PACKS_KEY = "tex64.math-wysiwyg.packs";

const normalizePacks = (value: unknown): string[] => {
  const allowed = new Set<string>(WYSIWYG_PACKS.map((pack) => pack.id));
  const input = Array.isArray(value) ? value : [];
  const normalized = input.filter((id) => typeof id === "string" && allowed.has(id));
  if (normalized.length === 0) {
    return [...DEFAULT_WYSIWYG_PACKS];
  }
  if (!normalized.includes("core")) {
    normalized.unshift("core");
  }
  return Array.from(new Set(normalized));
};

export const loadMathWysiwygSettings = (
  defaults: MathWysiwygSettings
): MathWysiwygSettings => {
  if (typeof localStorage === "undefined") {
    return defaults;
  }
  let autoSuggest = defaults.autoSuggest;
  let packs = defaults.enabledPacks;
  try {
    const storedAuto = localStorage.getItem(MATH_WYSIWYG_AUTO_KEY);
    if (storedAuto === "true") {
      autoSuggest = true;
    } else if (storedAuto === "false") {
      autoSuggest = false;
    }
    const storedPacks = localStorage.getItem(MATH_WYSIWYG_PACKS_KEY);
    if (storedPacks) {
      packs = normalizePacks(JSON.parse(storedPacks));
    } else {
      packs = normalizePacks(packs);
    }
  } catch {
    packs = normalizePacks(packs);
  }
  return { autoSuggest, enabledPacks: packs };
};

export const saveMathWysiwygAutoSuggest = (value: boolean) => {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(MATH_WYSIWYG_AUTO_KEY, value ? "true" : "false");
  } catch {
    // ignore
  }
};

export const saveMathWysiwygPacks = (value: string[]) => {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    const packs = normalizePacks(value);
    localStorage.setItem(MATH_WYSIWYG_PACKS_KEY, JSON.stringify(packs));
  } catch {
    // ignore
  }
};

export const ensureMathWysiwygPacks = (value: string[]) => normalizePacks(value);

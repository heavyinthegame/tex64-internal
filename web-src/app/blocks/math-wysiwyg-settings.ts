export type MathWysiwygSettings = {
  autoSuggest: boolean;
};

const MATH_WYSIWYG_AUTO_KEY = "tex64.math-wysiwyg.autoSuggest";

export const loadMathWysiwygSettings = (
  defaults: MathWysiwygSettings
): MathWysiwygSettings => {
  if (typeof localStorage === "undefined") {
    return defaults;
  }
  let autoSuggest = defaults.autoSuggest;
  try {
    const storedAuto = localStorage.getItem(MATH_WYSIWYG_AUTO_KEY);
    if (storedAuto === "true") {
      autoSuggest = true;
    } else if (storedAuto === "false") {
      autoSuggest = false;
    }
  } catch {
    // ignore
  }
  return { autoSuggest };
};

import {
  loadMathWysiwygSettings,
} from "../math-wysiwyg-settings.js";
import type { BlockInputRuntime, MathWysiwygSettingsState } from "./runtime.js";

export type BlockWysiwygSettingsOps = {
  applyMathWysiwygSettings: () => void;
};

export const loadInitialMathWysiwygSettings = (): MathWysiwygSettingsState => {
  return loadMathWysiwygSettings({ autoSuggest: true });
};

export const createBlockWysiwygSettingsOps = (runtime: BlockInputRuntime): BlockWysiwygSettingsOps => {
  const applyMathWysiwygSettings = () => {
    runtime.state.mathWysiwygApi?.updateConfig({
      autoSuggest: runtime.state.mathWysiwygSettings.autoSuggest,
    });
  };

  return { applyMathWysiwygSettings };
};

import { loadMathWysiwygSettings, } from "../math-wysiwyg-settings.js";
export const loadInitialMathWysiwygSettings = () => {
    return loadMathWysiwygSettings({ autoSuggest: true });
};
export const createBlockWysiwygSettingsOps = (runtime) => {
    const applyMathWysiwygSettings = () => {
        var _a;
        (_a = runtime.state.mathWysiwygApi) === null || _a === void 0 ? void 0 : _a.updateConfig({
            autoSuggest: runtime.state.mathWysiwygSettings.autoSuggest,
        });
    };
    return { applyMathWysiwygSettings };
};

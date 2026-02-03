export const clampNumber = (value, min, max, fallback) => {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    const rounded = Math.round(value);
    return Math.min(max, Math.max(min, rounded));
};
export const loadGhostCompletionConfig = (params) => {
    var _a, _b;
    const storedDebounce = Number.parseFloat((_a = localStorage.getItem(params.debounceKey)) !== null && _a !== void 0 ? _a : "");
    const storedMaxChars = Number.parseFloat((_b = localStorage.getItem(params.maxCharsKey)) !== null && _b !== void 0 ? _b : "");
    return {
        debounceMs: clampNumber(storedDebounce, params.debounceRange.min, params.debounceRange.max, params.defaults.debounceMs),
        maxChars: clampNumber(storedMaxChars, params.maxCharsRange.min, params.maxCharsRange.max, params.defaults.maxChars),
    };
};
export const saveGhostCompletionConfig = (params) => {
    localStorage.setItem(params.debounceKey, String(params.debounceMs));
    localStorage.setItem(params.maxCharsKey, String(params.maxChars));
};

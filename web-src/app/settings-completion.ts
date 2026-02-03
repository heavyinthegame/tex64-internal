export const clampNumber = (value: number, min: number, max: number, fallback: number) => {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  return Math.min(max, Math.max(min, rounded));
};

export const loadGhostCompletionConfig = (params: {
  debounceKey: string;
  maxCharsKey: string;
  debounceRange: { min: number; max: number };
  maxCharsRange: { min: number; max: number };
  defaults: { debounceMs: number; maxChars: number };
}) => {
  const storedDebounce = Number.parseFloat(localStorage.getItem(params.debounceKey) ?? "");
  const storedMaxChars = Number.parseFloat(localStorage.getItem(params.maxCharsKey) ?? "");
  return {
    debounceMs: clampNumber(
      storedDebounce,
      params.debounceRange.min,
      params.debounceRange.max,
      params.defaults.debounceMs
    ),
    maxChars: clampNumber(
      storedMaxChars,
      params.maxCharsRange.min,
      params.maxCharsRange.max,
      params.defaults.maxChars
    ),
  };
};

export const saveGhostCompletionConfig = (params: {
  debounceKey: string;
  maxCharsKey: string;
  debounceMs: number;
  maxChars: number;
}) => {
  localStorage.setItem(params.debounceKey, String(params.debounceMs));
  localStorage.setItem(params.maxCharsKey, String(params.maxChars));
};

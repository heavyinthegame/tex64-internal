export const applyMonacoTheme = (monaco: {
  editor?: {
    defineTheme?: (name: string, theme: { base: string; inherit: boolean; rules: unknown[]; colors: Record<string, string> }) => void;
    setTheme?: (name: string) => void;
  };
}) => {
  const themeName = "tex64-deep-slate";
  const themeColors: Record<string, string> = {
    "editor.background": "#1A1D23",
    "editor.foreground": "#CDD1D9",
    "editorLineNumber.foreground": "#5C6370",
    "editorLineNumber.activeForeground": "#CDD1D9",
    "editorCursor.foreground": "#5C9CFF",
    "editor.selectionBackground": "#2F3642",
    "editor.inactiveSelectionBackground": "#252B35",
    "editor.selectionHighlightBackground": "rgba(92, 156, 255, 0.15)",
    "editor.lineHighlightBackground": "#1F2329",
    "editor.lineHighlightBorder": "#282C34",
    "editorIndentGuide.background": "#383E49",
    "editorIndentGuide.activeBackground": "#565C68",
    "editorWhitespace.foreground": "#383E49",
    "editorGutter.background": "#1A1D23",
    "editorWidget.background": "#262A32",
    "editorWidget.border": "#454C59",
    "editorHoverWidget.background": "#1F2633",
    "editorHoverWidget.border": "#5D6D8A",
    "editor.hoverHighlightBackground": "rgba(216, 172, 95, 0.24)",
    "editorSuggestWidget.background": "#262A32",
    "editorSuggestWidget.border": "#454C59",
    "editorSuggestWidget.foreground": "#CDD1D9",
    "editorSuggestWidget.selectedBackground": "rgba(92, 156, 255, 0.2)",
    "editorSuggestWidget.highlightForeground": "#5C9CFF",
    "editorBracketMatch.background": "rgba(92, 156, 255, 0.15)",
    "editorBracketMatch.border": "#5C9CFF",
    "editor.findMatchBackground": "rgba(92, 156, 255, 0.25)",
    "editor.findMatchHighlightBackground": "rgba(92, 156, 255, 0.15)",
    "editor.findRangeHighlightBackground": "rgba(92, 156, 255, 0.1)",
    "editor.wordHighlightBackground": "rgba(216, 172, 95, 0.12)",
    "editor.wordHighlightStrongBackground": "rgba(216, 172, 95, 0.18)",
    "editorError.foreground": "#D56A6A",
    "editorError.border": "#00000000",
    "editorOverviewRuler.border": "#00000000",
    "editorOverviewRuler.findMatchForeground": "#5C9CFF",
    "editorOverviewRuler.errorForeground": "#D56A6A",
    "editorMarkerNavigationError.background": "rgba(213, 106, 106, 0.1)",
    "editorGutter.errorForeground": "#C55A5A",
    "editorWarning.foreground": "#B89E52",
    "editorOverviewRuler.background": "#1A1D23",
    "scrollbar.shadow": "#000000",
    "scrollbarSlider.background": "rgba(255, 255, 255, 0.12)",
    "scrollbarSlider.hoverBackground": "rgba(255, 255, 255, 0.2)",
    "scrollbarSlider.activeBackground": "rgba(255, 255, 255, 0.28)",
    "editorRuler.foreground": "#383E49",
  };
  monaco.editor?.defineTheme?.(themeName, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: themeColors,
  });
  monaco.editor?.setTheme?.(themeName);
  return themeName;
};

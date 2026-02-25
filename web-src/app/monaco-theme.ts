export const applyMonacoTheme = (monaco: {
  editor?: {
    defineTheme?: (name: string, theme: { base: string; inherit: boolean; rules: unknown[]; colors: Record<string, string> }) => void;
    setTheme?: (name: string) => void;
  };
}) => {
  const themeName = "tex64-vscode-dark-plus";
  const tokenRules = [
    { token: "comment", foreground: "6A9955" },
    { token: "keyword", foreground: "C586C0" },
    { token: "type", foreground: "4EC9B0" },
    { token: "variable", foreground: "4FC1FF" },
    { token: "string", foreground: "DCDCAA" },
    { token: "number", foreground: "B5CEA8" },
    { token: "operator", foreground: "D4D4D4" },
    { token: "delimiter", foreground: "DCDCAA" },
  ];
  const themeColors: Record<string, string> = {
    "editor.background": "#1E1E1E",
    "editor.foreground": "#D4D4D4",
    "editorLineNumber.foreground": "#858585",
    "editorLineNumber.activeForeground": "#C6C6C6",
    "editorCursor.foreground": "#AEAFAD",
    "editor.selectionBackground": "#264F78",
    "editor.inactiveSelectionBackground": "#3A3D41",
    "editor.selectionHighlightBackground": "#ADD6FF26",
    "editor.lineHighlightBackground": "#2A2D2E",
    "editor.lineHighlightBorder": "#00000000",
    "editorIndentGuide.background": "#404040",
    "editorIndentGuide.activeBackground": "#707070",
    "editorWhitespace.foreground": "#404040",
    "editorGutter.background": "#1E1E1E",
    "editorWidget.background": "#252526",
    "editorWidget.border": "#454545",
    "editorHoverWidget.background": "#252526",
    "editorHoverWidget.border": "#454545",
    "editor.hoverHighlightBackground": "#264F7840",
    "editorSuggestWidget.background": "#252526",
    "editorSuggestWidget.border": "#454545",
    "editorSuggestWidget.foreground": "#D4D4D4",
    "editorSuggestWidget.selectedBackground": "#04395E",
    "editorSuggestWidget.highlightForeground": "#18A3FF",
    "editorBracketMatch.background": "#0064001A",
    "editorBracketMatch.border": "#888888",
    "editor.findMatchBackground": "#515C6A",
    "editor.findMatchHighlightBackground": "#EA5C0055",
    "editor.findRangeHighlightBackground": "#3A3D4166",
    "editor.wordHighlightBackground": "#575757B8",
    "editor.wordHighlightStrongBackground": "#004972B8",
    "editorError.foreground": "#F48771",
    "editorError.border": "#00000000",
    "editorOverviewRuler.border": "#00000000",
    "editorOverviewRuler.findMatchForeground": "#A0A0A0CC",
    "editorOverviewRuler.errorForeground": "#E51400CC",
    "editorMarkerNavigationError.background": "#F48771",
    "editorGutter.errorForeground": "#E51400",
    "editorWarning.foreground": "#CCA700",
    "editorOverviewRuler.background": "#00000000",
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": "#79797966",
    "scrollbarSlider.hoverBackground": "#646464B3",
    "scrollbarSlider.activeBackground": "#BFBFBF66",
    "editorRuler.foreground": "#5A5A5A",
  };
  monaco.editor?.defineTheme?.(themeName, {
    base: "vs-dark",
    inherit: true,
    rules: tokenRules,
    colors: themeColors,
  });
  monaco.editor?.setTheme?.(themeName);
  return themeName;
};

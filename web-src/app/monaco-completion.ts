import type { IndexEntry } from "./types.js";
import { dedupeByKey, pickCitationEntries } from "./index-utils.js";

export type CompletionState = { registered: boolean };

export const registerCompletionProvider = (
  monaco: {
    languages?: {
      register?: (config: { id: string }) => void;
      registerCompletionItemProvider?: (
        languageId: string,
        provider: {
          triggerCharacters?: string[];
          provideCompletionItems: (
            model: { getLineContent: (lineNumber: number) => string },
            position: { lineNumber: number; column: number }
          ) => { suggestions: unknown[] };
        }
      ) => void;
      CompletionItemKind?: { Reference?: number; Value?: number };
    };
    Range?: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
  },
  deps: {
    getActiveFilePath: () => string | null;
    getIndexLabels: () => IndexEntry[];
    getIndexCitations: () => IndexEntry[];
  },
  state: CompletionState
) => {
  if (state.registered || !monaco.languages?.registerCompletionItemProvider) {
    return;
  }
  monaco.languages.register?.({ id: "latex" });
  monaco.languages.register?.({ id: "bibtex" });

  const provideItems = (
    model: { getLineContent: (lineNumber: number) => string },
    position: { lineNumber: number; column: number }
  ) => {
    const activePath = deps.getActiveFilePath();
    if (!activePath || !activePath.endsWith(".tex")) {
      return { suggestions: [] };
    }
    const line = model.getLineContent(position.lineNumber);
    const linePrefix = line.slice(0, Math.max(position.column - 1, 0));
    const refMatch = linePrefix.match(/\\ref\{([^}]*)$/);
    const citeMatch = linePrefix.match(/\\cite\{([^}]*)$/);

    let entries: IndexEntry[] = [];
    let partial = "";

    if (refMatch) {
      entries = dedupeByKey(deps.getIndexLabels());
      partial = refMatch[1] ?? "";
    } else if (citeMatch) {
      entries = pickCitationEntries(deps.getIndexCitations());
      const raw = citeMatch[1] ?? "";
      const parts = raw.split(",");
      partial = parts.length > 0 ? parts[parts.length - 1].trimStart() : "";
    } else {
      return { suggestions: [] };
    }

    const range = monaco.Range
      ? new monaco.Range(
          position.lineNumber,
          position.column - partial.length,
          position.lineNumber,
          position.column
        )
      : undefined;

    const kind =
      monaco.languages?.CompletionItemKind?.Reference ??
      monaco.languages?.CompletionItemKind?.Value ??
      17;

    const suggestions = entries.map((entry) => ({
      label: entry.key,
      kind,
      insertText: entry.key,
      range,
      detail: entry.path,
    }));

    return { suggestions };
  };

  ["latex", "plaintext"].forEach((languageId) => {
    monaco.languages?.registerCompletionItemProvider?.(languageId, {
      triggerCharacters: ["{", ",", "\\"],
      provideCompletionItems: provideItems,
    });
  });

  state.registered = true;
};

import { dedupeByKey, pickCitationEntries } from "./index-utils.js";
export const registerCompletionProvider = (monaco, deps, state) => {
    var _a, _b, _c, _d, _e;
    if (state.registered || !((_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.registerCompletionItemProvider)) {
        return;
    }
    (_c = (_b = monaco.languages).register) === null || _c === void 0 ? void 0 : _c.call(_b, { id: "latex" });
    (_e = (_d = monaco.languages).register) === null || _e === void 0 ? void 0 : _e.call(_d, { id: "bibtex" });
    const provideItems = (model, position) => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const activePath = deps.getActiveFilePath();
        if (!activePath || !activePath.endsWith(".tex")) {
            return { suggestions: [] };
        }
        const line = model.getLineContent(position.lineNumber);
        const linePrefix = line.slice(0, Math.max(position.column - 1, 0));
        const refMatch = linePrefix.match(/\\ref\{([^}]*)$/);
        const citeMatch = linePrefix.match(/\\cite\{([^}]*)$/);
        let entries = [];
        let partial = "";
        if (refMatch) {
            entries = dedupeByKey(deps.getIndexLabels());
            partial = (_a = refMatch[1]) !== null && _a !== void 0 ? _a : "";
        }
        else if (citeMatch) {
            entries = pickCitationEntries(deps.getIndexCitations());
            const raw = (_b = citeMatch[1]) !== null && _b !== void 0 ? _b : "";
            const parts = raw.split(",");
            partial = parts.length > 0 ? parts[parts.length - 1].trimStart() : "";
        }
        else {
            return { suggestions: [] };
        }
        const range = monaco.Range
            ? new monaco.Range(position.lineNumber, position.column - partial.length, position.lineNumber, position.column)
            : undefined;
        const kind = (_h = (_e = (_d = (_c = monaco.languages) === null || _c === void 0 ? void 0 : _c.CompletionItemKind) === null || _d === void 0 ? void 0 : _d.Reference) !== null && _e !== void 0 ? _e : (_g = (_f = monaco.languages) === null || _f === void 0 ? void 0 : _f.CompletionItemKind) === null || _g === void 0 ? void 0 : _g.Value) !== null && _h !== void 0 ? _h : 17;
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
        var _a, _b;
        (_b = (_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.registerCompletionItemProvider) === null || _b === void 0 ? void 0 : _b.call(_a, languageId, {
            triggerCharacters: ["{", ",", "\\"],
            provideCompletionItems: provideItems,
        });
    });
    state.registered = true;
};

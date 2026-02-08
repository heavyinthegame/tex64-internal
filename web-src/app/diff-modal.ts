import { buildLineDiff } from "./diff.js";
import type { AppContext } from "./context.js";

export type DiffContext =
  | { type: "block" }
  | { type: "aiApply"; proposalId: string }
  | null;

export type DiffModalApi = {
  showDiffModal: (
    original: string,
    modified: string,
    lineOffset?: number,
    options?: { title?: string; fileName?: string; submitLabel?: string }
  ) => void;
  closeDiffModal: () => void;
  resetDiffEditor: () => void;
  getDiffContext: () => DiffContext;
  setDiffContext: (context: DiffContext) => void;
};

type DiffModalDeps = {
  getMonacoApi: () => Record<string, unknown> | null;
  getActiveFilePath: () => string | null;
};

export const initDiffModal = (context: AppContext, deps: DiffModalDeps): DiffModalApi => {
  const { diffModal, diffTitle, diffModalSubmit, blockDiffContainer, diffSummary, diffFileName } =
    context.dom;

  const defaultDiffSubmitLabel =
    diffModalSubmit instanceof HTMLButtonElement
      ? diffModalSubmit.textContent ?? "確定"
      : "確定";

  let diffEditor: unknown = null;
  let diffOriginalModel: { setValue?: (value: string) => void; dispose?: () => void } | null =
    null;
  let diffModifiedModel: { setValue?: (value: string) => void; dispose?: () => void } | null =
    null;
  let diffContext: DiffContext = null;

  const renderDiffSummary = (before: string, after: string) => {
    if (!(diffSummary instanceof HTMLElement)) {
      return;
    }
    diffSummary.textContent = "";
    const beforeText = before.trimEnd();
    const afterText = after.trimEnd();
    const beforeLines = beforeText.length ? beforeText.split(/\r?\n/) : [""];
    const afterLines = afterText.length ? afterText.split(/\r?\n/) : [""];
    const diffLines = buildLineDiff(beforeLines, afterLines);
    let adds = 0;
    let dels = 0;
    diffLines.forEach((entry) => {
      if (entry.type === "add") {
        adds += 1;
      } else if (entry.type === "del") {
        dels += 1;
      }
    });
    if (adds === 0 && dels === 0) {
      diffSummary.textContent = "変更なし";
      return;
    }
    const add = document.createElement("span");
    add.className = "diff-summary-item is-add";
    add.textContent = `+${adds}`;
    const del = document.createElement("span");
    del.className = "diff-summary-item is-del";
    del.textContent = `-${dels}`;
    diffSummary.append(add, del);
  };

  const renderDiffHeader = () => {
    if (diffTitle instanceof HTMLElement) {
      diffTitle.textContent = "変更内容の確認";
    }
    if (diffFileName instanceof HTMLElement) {
      const activePath = deps.getActiveFilePath();
      const fileName = activePath ? activePath.split(/[/\\]/).pop() ?? activePath : "未保存";
      diffFileName.textContent = fileName;
    }
  };

  const setDiffHeader = (options: {
    title?: string;
    fileName?: string;
    submitLabel?: string;
  }) => {
    if (diffTitle instanceof HTMLElement && options.title) {
      diffTitle.textContent = options.title;
    }
    if (diffFileName instanceof HTMLElement) {
      diffFileName.textContent = options.fileName ?? "";
    }
    if (diffModalSubmit instanceof HTMLButtonElement && options.submitLabel) {
      diffModalSubmit.textContent = options.submitLabel;
    }
  };

  const countLines = (text: string) => {
    if (!text) return 1;
    return text.split(/\r?\n/).length;
  };

  const countLineBreaks = (text: string) => text.match(/\r?\n/g)?.length ?? 0;

  const buildDiffPreviewContext = (
    model: {
      getValue: () => string;
      getPositionAt: (offset: number) => { lineNumber: number; column: number };
      getLineCount?: () => number;
    },
    startOffset: number,
    endOffset: number,
    replacement: string,
    contextLineCount = 3
  ) => {
    const originalText = model.getValue();
    const totalLines =
      typeof model.getLineCount === "function" ? model.getLineCount() : countLines(originalText);
    const startPos = model.getPositionAt(startOffset);
    const endPos = model.getPositionAt(endOffset);
    let startLine = startPos.lineNumber;
    let endLine = endPos.lineNumber;
    if (endOffset > startOffset && endPos.column === 1) {
      endLine = Math.max(startLine, endLine - 1);
    }
    const contextStartLine = Math.max(1, startLine - contextLineCount);
    const contextEndLine = Math.min(totalLines, endLine + contextLineCount);
    const originalLines = originalText.split(/\r?\n/);
    const originalSlice = originalLines.slice(contextStartLine - 1, contextEndLine).join("\n");
    const originalSegment = originalText.slice(startOffset, endOffset);
    const lineDelta = countLineBreaks(replacement) - countLineBreaks(originalSegment);
    const modifiedText =
      originalText.slice(0, startOffset) + replacement + originalText.slice(endOffset);
    const modifiedTotalLines = totalLines + lineDelta;
    const modifiedEndLine = Math.min(modifiedTotalLines, contextEndLine + lineDelta);
    const modifiedLines = modifiedText.split(/\r?\n/);
    const modifiedSlice = modifiedLines
      .slice(contextStartLine - 1, Math.max(contextStartLine, modifiedEndLine))
      .join("\n");
    return {
      original: originalSlice,
      modified: modifiedSlice,
      lineOffset: contextStartLine - 1,
    };
  };

  const applyDiffLineNumberOffset = (offset: number, original: string, modified: string) => {
    if (!diffEditor) return;
    const maxLine = offset + Math.max(countLines(original), countLines(modified));
    const minChars = Math.max(2, String(maxLine).length);
    const lineNumbers = (lineNumber: number) => String(lineNumber + offset);
    const options = { lineNumbers, lineNumbersMinChars: minChars };
    const editorAny = diffEditor as {
      getOriginalEditor?: () => { updateOptions?: (opts: unknown) => void };
      getModifiedEditor?: () => { updateOptions?: (opts: unknown) => void };
      updateOptions?: (opts: unknown) => void;
    };
    editorAny.getOriginalEditor?.()?.updateOptions?.(options);
    editorAny.getModifiedEditor?.()?.updateOptions?.(options);
    editorAny.updateOptions?.(options);
  };

  const resetDiffEditor = () => {
    diffOriginalModel?.dispose?.();
    diffModifiedModel?.dispose?.();
    diffOriginalModel = null;
    diffModifiedModel = null;
    if (diffEditor) {
      const diffEditorAny = diffEditor as {
        setModel?: (model: { original: unknown; modified: unknown } | null) => void;
        dispose?: () => void;
      };
      diffEditorAny.setModel?.(null);
      diffEditorAny.dispose?.();
      diffEditor = null;
    }
    if (blockDiffContainer instanceof HTMLElement) {
      blockDiffContainer.innerHTML = "";
    }
  };

  const showDiffModal = (
    original: string,
    modified: string,
    lineOffset = 0,
    options?: { title?: string; fileName?: string; submitLabel?: string }
  ) => {
    const monacoApi = deps.getMonacoApi();
    if (!monacoApi) return;
    const monacoApiAny = monacoApi as {
      editor: {
        createDiffEditor: (el: HTMLElement, options: unknown) => unknown;
        createModel: (val: string, lang: string) => unknown;
      };
    };
    const container = blockDiffContainer;
    if (!container) return;

    if (!diffContext) {
      diffContext = { type: "block" };
    }
    if (diffModal) {
      diffModal.classList.add("is-open");
      diffModal.setAttribute("aria-hidden", "false");
    }

    if (!diffEditor) {
      container.innerHTML = "";
      diffEditor = monacoApiAny.editor.createDiffEditor(container, {
        originalEditable: false,
        readOnly: true,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: false,
        renderIndicators: true,
        renderMarginRevertIcon: false,
        diffWordWrap: "off",
        wordWrap: "off",
        hideUnchangedRegions: {
          enabled: true,
          contextLineCount: 3,
          minimumLineCount: 1,
        },
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
        renderOverviewRuler: false,
        overviewRulerBorder: false,
        occurrencesHighlight: false,
        selectionHighlight: false,
        lineNumbers: "on",
        fontSize: 12,
        lineHeight: 20,
        fontFamily: '"SF Mono", "Hiragino Kaku Gothic ProN", "Hiragino Sans", Menlo, Monaco, "Courier New", monospace',
      });
    } else {
      const diffEditorAny = diffEditor as {
        getDomNode?: () => HTMLElement | null;
        getContainerDomNode?: () => HTMLElement | null;
        layout?: () => void;
      };
      const diffNode = diffEditorAny.getDomNode?.() ?? diffEditorAny.getContainerDomNode?.() ?? null;
      if (diffNode && !container.contains(diffNode)) {
        container.innerHTML = "";
        container.appendChild(diffNode);
      }
      diffEditorAny.layout?.();
    }

    renderDiffHeader();
    if (options) {
      setDiffHeader(options);
    }
    if (diffModalSubmit instanceof HTMLButtonElement) {
      diffModalSubmit.textContent = defaultDiffSubmitLabel;
    }
    renderDiffSummary(original, modified);

    const diffEditorAny = diffEditor as {
      setModel?: (model: { original: unknown; modified: unknown }) => void;
      getModel?: () => { original?: unknown; modified?: unknown } | null;
    };

    diffOriginalModel?.dispose?.();
    diffModifiedModel?.dispose?.();
    diffOriginalModel = monacoApiAny.editor.createModel(original, "latex");
    diffModifiedModel = monacoApiAny.editor.createModel(modified, "latex");
    diffEditorAny.setModel?.({
      original: diffOriginalModel,
      modified: diffModifiedModel,
    });
    applyDiffLineNumberOffset(lineOffset, original, modified);
    if (typeof (diffEditor as any).layout === "function") {
      (diffEditor as any).layout();
    }
  };

  const closeDiffModal = () => {
    if (diffModal) {
      diffModal.classList.remove("is-open");
      diffModal.setAttribute("aria-hidden", "true");
    }
    if (diffSummary instanceof HTMLElement) {
      diffSummary.textContent = "";
    }
    if (diffFileName instanceof HTMLElement) {
      diffFileName.textContent = "";
    }
    if (diffTitle instanceof HTMLElement) {
      diffTitle.textContent = "変更内容の確認";
    }
    if (diffModalSubmit instanceof HTMLButtonElement) {
      diffModalSubmit.textContent = defaultDiffSubmitLabel;
    }
    diffContext = null;
    resetDiffEditor();
  };

  return {
    showDiffModal,
    closeDiffModal,
    resetDiffEditor,
    getDiffContext: () => diffContext,
    setDiffContext: (contextValue) => {
      diffContext = contextValue;
    },
  };
};

import { createLatexBlockDetector, resolveMathCellAtOffset } from "./detect.js";
import { getInnerContent, parseBlockContext } from "./context.js";
import type {
  BlockContext,
  DetectedBlockSnapshot,
  DetectedLatexBlock,
  MathEditCell,
} from "./types.js";
import type { BlockEditMode, BlockType } from "../types.js";

type EditorModel = {
  getValue: () => string;
  getOffsetAt: (pos: { lineNumber: number; column: number }) => number;
  getPositionAt: (offset: number) => { lineNumber: number; column: number };
  getVersionId?: () => number;
};

type EditorLike = {
  getModel?: () => EditorModel;
  deltaDecorations?: (oldDecorations: string[], newDecorations: unknown[]) => string[];
};

type EditorGroup = { editor?: EditorLike | null };

type BlockDraft = { snippet: string; content: unknown };

type BlockAutoDetectDeps = {
  envRegistry: {
    isEnvDisabled: (name: string) => boolean;
    isTableEnvName: (name: string) => boolean;
    isMathEnvName: (name: string) => boolean;
  };
  enableTableBlocks: boolean;
  getActiveGroup: () => EditorGroup;
  getActiveBlockContext: () => BlockContext | null;
  setActiveBlockContext: (context: BlockContext | null) => void;
  getActiveMathEditCell: () => MathEditCell | null;
  setActiveMathEditCell: (cell: MathEditCell | null) => void;
  getActiveBlockEditMode: () => BlockEditMode;
  setActiveBlockEditMode: (mode: BlockEditMode) => void;
  setActiveBlockType: (type: BlockType) => void;
  setActiveBlockOriginalSnippet: (snippet: string | null) => void;
  setDetectedBlockSnapshot: (snapshot: DetectedBlockSnapshot | null) => void;
  setCurrentBlockDraft: (draft: BlockDraft | null) => void;
  setAutoDetectedUi: (enabled: boolean, lineNumber?: number) => void;
  setTableEditMode: (mode: "grid" | "raw") => void;
  setMathInputValue: (value: string) => void;
  setTableRawValue: (value: string) => void;
  isMathInputFocused: () => boolean;
};

export type BlockAutoDetectApi = {
  syncDetectedBlockAtPosition: (
    position: { lineNumber: number; column: number } | null | undefined,
    options?: { force?: boolean; allowTabSwitch?: boolean }
  ) => DetectedLatexBlock | null;
  handleCursorPositionChange: (position: { lineNumber: number; column: number }) => void;
  clearDetectedBlockState: (options?: { force?: boolean }) => void;
};

export const initBlockAutoDetection = (
  deps: BlockAutoDetectDeps
): BlockAutoDetectApi => {
  let currentDetectedBlock: DetectedLatexBlock | null = null;
  let blockDetectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let blockHighlightDecorations: string[] = [];

  const blockDetector = createLatexBlockDetector({
    isEnvDisabled: deps.envRegistry.isEnvDisabled,
    isTableEnvName: deps.envRegistry.isTableEnvName,
    isMathEnvName: deps.envRegistry.isMathEnvName,
    enableTableBlocks: deps.enableTableBlocks,
  });

  const shouldUpdateDetectedBlock = (detected: DetectedLatexBlock) =>
    !currentDetectedBlock ||
    currentDetectedBlock.start !== detected.start ||
    currentDetectedBlock.end !== detected.end ||
    currentDetectedBlock.fullMatch !== detected.fullMatch;

  const highlightDetectedBlock = (
    start: number,
    end: number,
    context: BlockContext | null,
    type: BlockType,
    cursorLineNumber?: number
  ) => {
    const activeGroup = deps.getActiveGroup();
    if (!activeGroup.editor || !activeGroup.editor.deltaDecorations) return;
    const model = activeGroup.editor.getModel?.();
    if (!model) return;
    let highlightStart = start;
    let highlightEnd = start;
    let showInline = false;
    if (type === "math" && context) {
      const innerStart = start + context.prefix.length;
      const innerEnd = end - context.suffix.length;
      if (innerEnd > innerStart) {
        highlightStart = innerStart;
        highlightEnd = innerEnd;
        showInline = true;
      }
    }
    const startPos = model.getPositionAt(highlightStart);
    const endPos = model.getPositionAt(highlightEnd);
    const glyphLine = cursorLineNumber ?? startPos.lineNumber;
    const decorations: Array<{ range: unknown; options: Record<string, unknown> }> = [];
    if (showInline) {
      decorations.push({
        range: {
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column,
        },
        options: {
          inlineClassName: "detected-block-highlight",
        },
      });
    }
    decorations.push({
      range: {
        startLineNumber: glyphLine,
        startColumn: 1,
        endLineNumber: glyphLine,
        endColumn: 1,
      },
      options: {
        glyphMarginClassName: "detected-block-glyph",
      },
    });
    blockHighlightDecorations = activeGroup.editor.deltaDecorations(
      blockHighlightDecorations,
      decorations
    );
  };

  const clearBlockHighlight = () => {
    const activeGroup = deps.getActiveGroup();
    if (!activeGroup.editor || !activeGroup.editor.deltaDecorations) return;
    blockHighlightDecorations = activeGroup.editor.deltaDecorations(
      blockHighlightDecorations,
      []
    );
  };

  const syncMathEditCellForDetected = (
    detected: DetectedLatexBlock,
    cursorOffset?: number
  ) => {
    if (detected.type !== "math") {
      deps.setActiveMathEditCell(null);
      return;
    }
    if (deps.isMathInputFocused()) {
      return;
    }
    const context = deps.getActiveBlockContext();
    const detectedInner = context
      ? getInnerContent(context, { trim: false })
      : detected.content;
    const innerStart = detected.start + (context ? context.prefix.length : 0);
    const innerOffset = Math.max(
      0,
      Math.min(
        detectedInner.length,
        (typeof cursorOffset === "number" ? cursorOffset : innerStart) - innerStart
      )
    );
    const cellRange = resolveMathCellAtOffset(detectedInner, innerOffset);
    const raw = detectedInner.slice(cellRange.start, cellRange.end);
    const value = raw.slice(
      cellRange.leading.length,
      Math.max(cellRange.leading.length, raw.length - cellRange.trailing.length)
    );
    const activeMathEditCell = deps.getActiveMathEditCell();
    const sameCell =
      activeMathEditCell &&
      activeMathEditCell.context === context &&
      activeMathEditCell.range.start === cellRange.start &&
      activeMathEditCell.range.end === cellRange.end &&
      activeMathEditCell.inner === detectedInner;
    if (sameCell) {
      return;
    }
    deps.setActiveMathEditCell(
      context ? { context, inner: detectedInner, range: cellRange } : null
    );
    deps.setMathInputValue(value);
  };

  const applyDetectedBlock = (
    detected: DetectedLatexBlock,
    text: string,
    model: EditorModel,
    force = false,
    allowTabSwitch = true,
    cursorLineNumber?: number,
    cursorOffset?: number
  ) => {
    if (!force && !shouldUpdateDetectedBlock(detected)) {
      if (detected.type === "math") {
        syncMathEditCellForDetected(detected, cursorOffset);
      }
      return;
    }
    currentDetectedBlock = detected;
    if (
      allowTabSwitch &&
      !document.querySelector('.panel[data-panel="blocks"].is-active')
    ) {
      const blocksTab = document.querySelector<HTMLButtonElement>('.tab[data-tab="blocks"]');
      blocksTab?.click();
    }
    deps.setActiveBlockType(detected.type);
    deps.setActiveBlockEditMode("detected");
    deps.setCurrentBlockDraft(null);
    const snippet = detected.fullMatch ?? text.slice(detected.start, detected.end);
    deps.setActiveBlockOriginalSnippet(snippet);
    const context = snippet
      ? parseBlockContext(snippet, { isTableEnvName: deps.envRegistry.isTableEnvName })
      : null;
    deps.setActiveBlockContext(context);
    deps.setDetectedBlockSnapshot({
      type: detected.type,
      start: detected.start,
      end: detected.end,
      snippet,
      context,
      modelVersion: typeof model.getVersionId === "function" ? model.getVersionId() : 0,
    });
    const startPos = model.getPositionAt(detected.start);
    deps.setAutoDetectedUi(true, startPos.lineNumber);
    if (detected.type === "math") {
      syncMathEditCellForDetected(detected, cursorOffset);
      deps.setTableEditMode("grid");
    } else {
      deps.setActiveMathEditCell(null);
      const detectedInner = context
        ? getInnerContent(context, { trim: false })
        : detected.content;
      deps.setTableEditMode("raw");
      deps.setTableRawValue(detectedInner);
    }
    highlightDetectedBlock(detected.start, detected.end, context, detected.type, cursorLineNumber);
  };

  const clearDetectedBlockState = (options?: { force?: boolean }) => {
    if (!currentDetectedBlock && !options?.force) {
      return;
    }
    currentDetectedBlock = null;
    deps.setDetectedBlockSnapshot(null);
    if (deps.getActiveBlockEditMode() === "detected") {
      deps.setActiveBlockEditMode("none");
      deps.setActiveBlockContext(null);
      deps.setActiveBlockOriginalSnippet(null);
    }
    deps.setActiveMathEditCell(null);
    deps.setAutoDetectedUi(false);
    deps.setTableEditMode("grid");
    clearBlockHighlight();
  };

  const syncDetectedBlockAtPosition: BlockAutoDetectApi["syncDetectedBlockAtPosition"] = (
    position,
    options
  ) => {
    const activeGroup = deps.getActiveGroup();
    if (!activeGroup.editor || !position) {
      return null;
    }
    const model = activeGroup.editor.getModel?.();
    if (!model) {
      return null;
    }
    const text = model.getValue();
    const offset = model.getOffsetAt(position);
    const detected = blockDetector.detectLatexBlockAtOffset(text, offset);
    const force = options?.force ?? false;
    const allowTabSwitch = options?.allowTabSwitch ?? false;
    if (detected) {
      applyDetectedBlock(
        detected,
        text,
        model,
        force,
        allowTabSwitch,
        position?.lineNumber,
        offset
      );
      return detected;
    }
    clearDetectedBlockState();
    return null;
  };

  const handleCursorPositionChange: BlockAutoDetectApi["handleCursorPositionChange"] = (
    position
  ) => {
    const activeGroup = deps.getActiveGroup();
    if (!activeGroup.editor) return;
    if (blockDetectionDebounceTimer) {
      clearTimeout(blockDetectionDebounceTimer);
    }
    blockDetectionDebounceTimer = setTimeout(() => {
      syncDetectedBlockAtPosition(position, { allowTabSwitch: false });
    }, 150);
  };

  return {
    syncDetectedBlockAtPosition,
    handleCursorPositionChange,
    clearDetectedBlockState,
  };
};

import { createLatexBlockDetector, resolveMathCellAtOffset } from "./detect.js";
import { getInnerContent, parseBlockContext } from "./context.js";
export const initBlockAutoDetection = (deps) => {
    let currentDetectedBlock = null;
    let blockDetectionDebounceTimer = null;
    let blockHighlightDecorations = [];
    const blockDetector = createLatexBlockDetector({
        isEnvDisabled: deps.envRegistry.isEnvDisabled,
        isTableEnvName: deps.envRegistry.isTableEnvName,
        isMathEnvName: deps.envRegistry.isMathEnvName,
        enableTableBlocks: deps.enableTableBlocks,
    });
    const shouldUpdateDetectedBlock = (detected) => !currentDetectedBlock ||
        currentDetectedBlock.start !== detected.start ||
        currentDetectedBlock.end !== detected.end ||
        currentDetectedBlock.fullMatch !== detected.fullMatch;
    const highlightDetectedBlock = (start, end, context, type, cursorLineNumber) => {
        var _a, _b;
        const activeGroup = deps.getActiveGroup();
        if (!activeGroup.editor || !activeGroup.editor.deltaDecorations)
            return;
        const model = (_b = (_a = activeGroup.editor).getModel) === null || _b === void 0 ? void 0 : _b.call(_a);
        if (!model)
            return;
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
        const glyphLine = cursorLineNumber !== null && cursorLineNumber !== void 0 ? cursorLineNumber : startPos.lineNumber;
        const decorations = [];
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
        blockHighlightDecorations = activeGroup.editor.deltaDecorations(blockHighlightDecorations, decorations);
    };
    const clearBlockHighlight = () => {
        const activeGroup = deps.getActiveGroup();
        if (!activeGroup.editor || !activeGroup.editor.deltaDecorations)
            return;
        blockHighlightDecorations = activeGroup.editor.deltaDecorations(blockHighlightDecorations, []);
    };
    const syncMathEditCellForDetected = (detected, cursorOffset) => {
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
        const innerOffset = Math.max(0, Math.min(detectedInner.length, (typeof cursorOffset === "number" ? cursorOffset : innerStart) - innerStart));
        const cellRange = resolveMathCellAtOffset(detectedInner, innerOffset);
        const raw = detectedInner.slice(cellRange.start, cellRange.end);
        const value = raw.slice(cellRange.leading.length, Math.max(cellRange.leading.length, raw.length - cellRange.trailing.length));
        const activeMathEditCell = deps.getActiveMathEditCell();
        const sameCell = activeMathEditCell &&
            activeMathEditCell.context === context &&
            activeMathEditCell.range.start === cellRange.start &&
            activeMathEditCell.range.end === cellRange.end &&
            activeMathEditCell.inner === detectedInner;
        if (sameCell) {
            return;
        }
        deps.setActiveMathEditCell(context ? { context, inner: detectedInner, range: cellRange } : null);
        deps.setMathInputValue(value);
    };
    const applyDetectedBlock = (detected, text, model, force = false, allowTabSwitch = true, cursorLineNumber, cursorOffset) => {
        var _a;
        if (!force && !shouldUpdateDetectedBlock(detected)) {
            if (detected.type === "math") {
                syncMathEditCellForDetected(detected, cursorOffset);
            }
            return;
        }
        currentDetectedBlock = detected;
        if (allowTabSwitch &&
            !document.querySelector('.panel[data-panel="blocks"].is-active')) {
            const blocksTab = document.querySelector('.tab[data-tab="blocks"]');
            blocksTab === null || blocksTab === void 0 ? void 0 : blocksTab.click();
        }
        deps.setActiveBlockType(detected.type);
        deps.setActiveBlockEditMode("detected");
        deps.setCurrentBlockDraft(null);
        const snippet = (_a = detected.fullMatch) !== null && _a !== void 0 ? _a : text.slice(detected.start, detected.end);
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
        }
        else {
            deps.setActiveMathEditCell(null);
            const detectedInner = context
                ? getInnerContent(context, { trim: false })
                : detected.content;
            deps.setTableEditMode("raw");
            deps.setTableRawValue(detectedInner);
        }
        highlightDetectedBlock(detected.start, detected.end, context, detected.type, cursorLineNumber);
    };
    const clearDetectedBlockState = (options) => {
        if (!currentDetectedBlock && !(options === null || options === void 0 ? void 0 : options.force)) {
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
    const syncDetectedBlockAtPosition = (position, options) => {
        var _a, _b, _c, _d;
        const activeGroup = deps.getActiveGroup();
        if (!activeGroup.editor || !position) {
            return null;
        }
        const model = (_b = (_a = activeGroup.editor).getModel) === null || _b === void 0 ? void 0 : _b.call(_a);
        if (!model) {
            return null;
        }
        const text = model.getValue();
        const offset = model.getOffsetAt(position);
        const detected = blockDetector.detectLatexBlockAtOffset(text, offset);
        const force = (_c = options === null || options === void 0 ? void 0 : options.force) !== null && _c !== void 0 ? _c : false;
        const allowTabSwitch = (_d = options === null || options === void 0 ? void 0 : options.allowTabSwitch) !== null && _d !== void 0 ? _d : false;
        if (detected) {
            applyDetectedBlock(detected, text, model, force, allowTabSwitch, position === null || position === void 0 ? void 0 : position.lineNumber, offset);
            return detected;
        }
        clearDetectedBlockState();
        return null;
    };
    const handleCursorPositionChange = (position) => {
        const activeGroup = deps.getActiveGroup();
        if (!activeGroup.editor)
            return;
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

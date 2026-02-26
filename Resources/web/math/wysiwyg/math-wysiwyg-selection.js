import { canUseMathfieldInternalApi, getMathfieldInternalModel, } from "../mathfield-private-adapter.js";
const PLACEHOLDER_TOKEN_REGEX = /\\placeholder(?:\[[^\]]*\])?\{(?:[^{}]|\\.)*\}/g;
const getLiteralPlaceholderRanges = (mathfieldApi, lastOffset) => {
    if (typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.getValue) !== "function") {
        return [];
    }
    if (lastOffset === null || !Number.isFinite(lastOffset) || lastOffset <= 0) {
        return [];
    }
    let latex = "";
    try {
        const value = mathfieldApi.getValue(0, lastOffset, "latex");
        if (typeof value === "string") {
            latex = value;
        }
    }
    catch {
        return [];
    }
    if (!latex || !latex.includes("\\placeholder")) {
        return [];
    }
    const ranges = [];
    const seen = new Set();
    let match = PLACEHOLDER_TOKEN_REGEX.exec(latex);
    while (match) {
        const startIndex = match.index;
        const endIndex = startIndex + match[0].length;
        const start = indexToOffsetInRange(mathfieldApi, 0, lastOffset, startIndex, "floor");
        const end = indexToOffsetInRange(mathfieldApi, 0, lastOffset, endIndex, "ceil");
        if (Number.isFinite(start) &&
            Number.isFinite(end) &&
            start >= 0 &&
            end > start &&
            !(start <= 0 && end >= lastOffset)) {
            const key = `${start}:${end}`;
            if (!seen.has(key)) {
                seen.add(key);
                ranges.push({ start, end });
            }
        }
        match = PLACEHOLDER_TOKEN_REGEX.exec(latex);
    }
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    return ranges;
};
export const getInternalSelectionRanges = (mathfieldApi) => {
    if (!canUseMathfieldInternalApi(mathfieldApi)) {
        return getLiteralPlaceholderRanges(mathfieldApi, typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.lastOffset) === "number" ? mathfieldApi.lastOffset : null);
    }
    const model = getMathfieldInternalModel(mathfieldApi);
    if (!model || !Array.isArray(model.atoms) || typeof model.offsetOf !== "function") {
        const lastOffsetFallback = typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.lastOffset) === "number"
            ? mathfieldApi.lastOffset
            : typeof (model === null || model === void 0 ? void 0 : model.lastOffset) === "number"
                ? model.lastOffset
                : null;
        return getLiteralPlaceholderRanges(mathfieldApi, lastOffsetFallback);
    }
    const lastOffset = typeof mathfieldApi.lastOffset === "number"
        ? mathfieldApi.lastOffset
        : typeof model.lastOffset === "number"
            ? model.lastOffset
            : null;
    const ranges = [];
    const seen = new Set();
    for (const atom of model.atoms) {
        if (!atom || typeof atom !== "object")
            continue;
        const type = atom.type;
        let start = null;
        let end = null;
        if (type === "prompt") {
            if (typeof model.getBranchRange === "function") {
                const offset = model.offsetOf(atom);
                const range = model.getBranchRange(offset, "body");
                if (Array.isArray(range) && range.length >= 2) {
                    start = Number(range[0]);
                    end = Number(range[1]);
                }
            }
        }
        else if (type === "placeholder") {
            const offset = model.offsetOf(atom);
            start = Number(offset) - 1;
            end = Number(offset);
        }
        if (start === null || end === null)
            continue;
        if (!Number.isFinite(start) || !Number.isFinite(end))
            continue;
        if (start < 0 || end < 0)
            continue;
        if (lastOffset !== null && start <= 0 && end >= lastOffset)
            continue;
        const key = `${start}:${end}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        ranges.push({ start, end });
    }
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    if (ranges.length > 0) {
        return ranges;
    }
    return getLiteralPlaceholderRanges(mathfieldApi, lastOffset);
};
export const setSelectionRange = (mathfieldApi, start, end) => {
    if (typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.setSelectionRange) === "function") {
        mathfieldApi.setSelectionRange(start, end);
        return;
    }
    if (typeof mathfieldApi.setSelection === "function") {
        mathfieldApi.setSelection(start, end);
        return;
    }
    if ("selection" in mathfieldApi) {
        mathfieldApi.selection = [start, end];
        return;
    }
    if (typeof mathfieldApi.position === "number") {
        mathfieldApi.position = end;
    }
};
export const resolveScopeRange = (mathfieldApi, cursorOffset) => {
    if (canUseMathfieldInternalApi(mathfieldApi)) {
        const model = getMathfieldInternalModel(mathfieldApi);
        if (model && typeof model.getCellRange === "function") {
            const range = model.getCellRange(cursorOffset);
            if (Array.isArray(range) && range.length >= 2) {
                return { start: Number(range[0]), end: Number(range[1]) };
            }
        }
        if (model && typeof model.getSiblingsRange === "function") {
            const range = model.getSiblingsRange(cursorOffset);
            if (Array.isArray(range) && range.length >= 2) {
                return { start: Number(range[0]), end: Number(range[1]) };
            }
        }
    }
    const lastOffset = typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.lastOffset) === "number" ? mathfieldApi.lastOffset : cursorOffset;
    return { start: 0, end: lastOffset };
};
export const offsetToIndexInRange = (mathfieldApi, rangeStart, offset) => {
    if (typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.getValue) !== "function") {
        return offset - rangeStart;
    }
    try {
        const prefix = mathfieldApi.getValue(rangeStart, offset, "latex");
        return typeof prefix === "string" ? prefix.length : 0;
    }
    catch {
        return Math.max(0, offset - rangeStart);
    }
};
export const indexToOffsetInRange = (mathfieldApi, rangeStart, rangeEnd, targetIndex, bias = "ceil") => {
    if (typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.getValue) !== "function") {
        return rangeStart + targetIndex;
    }
    let rangeText = "";
    try {
        rangeText = mathfieldApi.getValue(rangeStart, rangeEnd, "latex");
    }
    catch {
        return rangeStart + targetIndex;
    }
    const rangeLength = typeof rangeText === "string" ? rangeText.length : 0;
    if (targetIndex <= 0) {
        return rangeStart;
    }
    if (targetIndex >= rangeLength) {
        return rangeEnd;
    }
    let low = rangeStart;
    let high = rangeEnd;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const length = offsetToIndexInRange(mathfieldApi, rangeStart, mid);
        if (length < targetIndex) {
            low = mid + 1;
        }
        else {
            high = mid;
        }
    }
    if (bias === "ceil") {
        return low;
    }
    const mappedLength = offsetToIndexInRange(mathfieldApi, rangeStart, low);
    if (mappedLength <= targetIndex) {
        return low;
    }
    return Math.max(rangeStart, low - 1);
};

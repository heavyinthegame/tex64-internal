const hasSupportedInternalVersion = (mathfieldApi: any) => {
  const version =
    (mathfieldApi && typeof mathfieldApi.version === "string"
      ? mathfieldApi.version
      : (window as any)?.MathLive?.version) ?? null;
  if (version && typeof version === "string") {
    return version.startsWith("0.108.");
  }
  return true;
};

export const getInternalSelectionRanges = (
  mathfieldApi: any
): Array<{ start: number; end: number }> => {
  if (!hasSupportedInternalVersion(mathfieldApi)) {
    return [];
  }
  const internal = mathfieldApi?._mathfield;
  const model = internal?.model;
  if (!model || !Array.isArray(model.atoms) || typeof model.offsetOf !== "function") {
    return [];
  }
  const lastOffset =
    typeof mathfieldApi.lastOffset === "number"
      ? mathfieldApi.lastOffset
      : typeof model.lastOffset === "number"
      ? model.lastOffset
      : null;
  const ranges: Array<{ start: number; end: number }> = [];
  const seen = new Set<string>();
  for (const atom of model.atoms) {
    if (!atom || typeof atom !== "object") continue;
    const type = atom.type;
    let start: number | null = null;
    let end: number | null = null;
    if (type === "prompt") {
      if (typeof model.getBranchRange === "function") {
        const offset = model.offsetOf(atom);
        const range = model.getBranchRange(offset, "body");
        if (Array.isArray(range) && range.length >= 2) {
          start = Number(range[0]);
          end = Number(range[1]);
        }
      }
    } else if (type === "placeholder") {
      const offset = model.offsetOf(atom);
      start = Number(offset) - 1;
      end = Number(offset);
    }
    if (start === null || end === null) continue;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 0 || end < 0) continue;
    if (lastOffset !== null && start <= 0 && end >= lastOffset) continue;
    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranges.push({ start, end });
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  return ranges;
};

export const setSelectionRange = (mathfieldApi: any, start: number, end: number) => {
  if (typeof mathfieldApi?.setSelectionRange === "function") {
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

export const resolveScopeRange = (mathfieldApi: any, cursorOffset: number) => {
  if (hasSupportedInternalVersion(mathfieldApi)) {
    const internal = mathfieldApi?._mathfield;
    const model = internal?.model;
    if (model) {
      if (typeof model.getCellRange === "function") {
        const range = model.getCellRange(cursorOffset);
        if (Array.isArray(range) && range.length >= 2) {
          return { start: Number(range[0]), end: Number(range[1]) };
        }
      }
      if (typeof model.getSiblingsRange === "function") {
        const range = model.getSiblingsRange(cursorOffset);
        if (Array.isArray(range) && range.length >= 2) {
          return { start: Number(range[0]), end: Number(range[1]) };
        }
      }
    }
  }
  const lastOffset =
    typeof mathfieldApi?.lastOffset === "number" ? mathfieldApi.lastOffset : cursorOffset;
  return { start: 0, end: lastOffset };
};

export const offsetToIndexInRange = (
  mathfieldApi: any,
  rangeStart: number,
  offset: number
) => {
  if (typeof mathfieldApi?.getValue !== "function") {
    return offset - rangeStart;
  }
  try {
    const prefix = mathfieldApi.getValue(rangeStart, offset, "latex");
    return typeof prefix === "string" ? prefix.length : 0;
  } catch {
    return Math.max(0, offset - rangeStart);
  }
};

export const indexToOffsetInRange = (
  mathfieldApi: any,
  rangeStart: number,
  rangeEnd: number,
  targetIndex: number
) => {
  if (typeof mathfieldApi?.getValue !== "function") {
    return rangeStart + targetIndex;
  }
  let rangeText: unknown = "";
  try {
    rangeText = mathfieldApi.getValue(rangeStart, rangeEnd, "latex");
  } catch {
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
    } else {
      high = mid;
    }
  }
  return low;
};

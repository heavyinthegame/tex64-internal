type ScriptKind = "sub" | "sup" | "subsup";

type ScriptRange = {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
};

type AtomInfo = {
  baseStart: number;
  baseEnd: number;
  sub?: ScriptRange;
  sup?: ScriptRange;
};

type ApplyScriptOptions = {
  placeholder: string;
  base?: string | null;
  subValue?: string | null;
  supValue?: string | null;
};

type ApplyScriptResult = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

type PlaceholderRange = {
  start: number;
  end: number;
};

type TemplateApplyOptions = {
  placeholder: string;
  baseMode: "wrap" | "after";
  baseIndex?: number;
  baseSeparator?: string;
  baseScope?: "selection-or-atom" | "selection";
};

const PLACEHOLDER_LATEX = "\\placeholder{}";
const MULTI_ARG_COMMANDS = new Set(["frac", "dfrac", "tfrac", "binom", "dbinom", "tbinom"]);

const isAsciiLetter = (value: string) => /[A-Za-z]/.test(value);
const isDigit = (value: string) => /[0-9]/.test(value);

const isEscaped = (text: string, index: number) => {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    count += 1;
  }
  return count % 2 === 1;
};

const findMatchingBraceLeft = (text: string, closeIndex: number) => {
  if (closeIndex < 0 || text[closeIndex] !== "}" || isEscaped(text, closeIndex)) {
    return null;
  }
  let depth = 0;
  for (let i = closeIndex; i >= 0; i -= 1) {
    const char = text[i];
    if (char === "}" && !isEscaped(text, i)) {
      depth += 1;
      continue;
    }
    if (char === "{" && !isEscaped(text, i)) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return null;
};

const findMatchingBracketLeft = (text: string, closeIndex: number) => {
  if (closeIndex < 0 || text[closeIndex] !== "]" || isEscaped(text, closeIndex)) {
    return null;
  }
  let depth = 0;
  for (let i = closeIndex; i >= 0; i -= 1) {
    const char = text[i];
    if (char === "]" && !isEscaped(text, i)) {
      depth += 1;
      continue;
    }
    if (char === "[" && !isEscaped(text, i)) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return null;
};

const readCommandLeftOf = (text: string, index: number) => {
  let i = index - 1;
  if (i < 0 || !isAsciiLetter(text[i])) {
    return null;
  }
  const end = i + 1;
  while (i >= 0 && isAsciiLetter(text[i])) {
    i -= 1;
  }
  if (i >= 0 && text[i] === "\\" && !isEscaped(text, i)) {
    const name = text.slice(i + 1, end);
    return { start: i, end, name };
  }
  return null;
};

const readCommandAt = (text: string, index: number) => {
  if (index < 0 || text[index] !== "\\") {
    return null;
  }
  const next = text[index + 1];
  if (!next) {
    return null;
  }
  if (isAsciiLetter(next)) {
    let end = index + 2;
    while (end < text.length && isAsciiLetter(text[end])) {
      end += 1;
    }
    return { start: index, end };
  }
  return { start: index, end: Math.min(text.length, index + 2) };
};

const isLeftRightToken = (text: string, index: number, kind: "left" | "right") => {
  const token = kind === "left" ? "\\left" : "\\right";
  if (!text.startsWith(token, index)) {
    return false;
  }
  const next = text[index + token.length];
  return !next || !isAsciiLetter(next);
};

const findMatchingLeftToken = (text: string, rightIndex: number) => {
  let depth = 0;
  for (let i = rightIndex; i >= 0; i -= 1) {
    if (text[i] !== "\\") {
      continue;
    }
    if (isLeftRightToken(text, i, "right")) {
      depth += 1;
      continue;
    }
    if (isLeftRightToken(text, i, "left")) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return null;
};

const findLeftRightBaseStart = (text: string, baseEnd: number) => {
  for (let i = baseEnd - 1; i >= 0; i -= 1) {
    if (text[i] !== "\\") {
      continue;
    }
    if (!isLeftRightToken(text, i, "right")) {
      continue;
    }
    const delimiterStart = i + "\\right".length;
    if (delimiterStart >= baseEnd) {
      continue;
    }
    let delimiterEnd = delimiterStart + 1;
    if (text[delimiterStart] === "\\") {
      const command = readCommandAt(text, delimiterStart);
      delimiterEnd = command ? command.end : delimiterEnd;
    }
    if (delimiterEnd !== baseEnd) {
      continue;
    }
    return findMatchingLeftToken(text, i);
  }
  return null;
};

const findBaseStart = (text: string, baseEnd: number) => {
  if (baseEnd <= 0) {
    return null;
  }
  const lastIndex = baseEnd - 1;
  const lastChar = text[lastIndex];
  if (!lastChar || /\s/.test(lastChar)) {
    return null;
  }

  const leftRightStart = findLeftRightBaseStart(text, baseEnd);
  if (leftRightStart !== null) {
    return leftRightStart;
  }

  if (lastChar === "}" && !isEscaped(text, lastIndex)) {
    const groupStart = findMatchingBraceLeft(text, lastIndex);
    if (groupStart === null) {
      return null;
    }
    let baseStart = groupStart;
    const command = readCommandLeftOf(text, groupStart);
    if (command) {
      baseStart = command.start;
    } else {
      let resolved = false;
      if (
        groupStart > 0 &&
        text[groupStart - 1] === "]" &&
        !isEscaped(text, groupStart - 1)
      ) {
        const bracketEnd = groupStart - 1;
        const bracketStart = findMatchingBracketLeft(text, bracketEnd);
        if (bracketStart !== null) {
          const optionalCommand = readCommandLeftOf(text, bracketStart);
          if (optionalCommand && optionalCommand.name === "sqrt") {
            baseStart = optionalCommand.start;
            resolved = true;
          }
        }
      }
      if (
        !resolved &&
        groupStart > 0 &&
        text[groupStart - 1] === "}" &&
        !isEscaped(text, groupStart - 1)
      ) {
        const prevGroupEnd = groupStart - 1;
        const prevGroupStart = findMatchingBraceLeft(text, prevGroupEnd);
        if (prevGroupStart !== null) {
          const multiCommand = readCommandLeftOf(text, prevGroupStart);
          if (multiCommand && MULTI_ARG_COMMANDS.has(multiCommand.name)) {
            baseStart = multiCommand.start;
          }
        }
      }
    }
    return baseStart;
  }

  if (isAsciiLetter(lastChar)) {
    const command = readCommandLeftOf(text, baseEnd);
    if (command) {
      return command.start;
    }
    return lastIndex;
  }

  if (isDigit(lastChar)) {
    let start = lastIndex;
    while (start > 0 && isDigit(text[start - 1])) {
      start -= 1;
    }
    return start;
  }

  return lastIndex;
};

const readScriptEndingAt = (text: string, endIndex: number) => {
  const closeIndex = endIndex - 1;
  if (closeIndex < 0 || text[closeIndex] !== "}" || isEscaped(text, closeIndex)) {
    const tokenStart = findBaseStart(text, endIndex);
    if (tokenStart === null) {
      return null;
    }
    const scriptIndex = tokenStart - 1;
    if (scriptIndex < 0 || isEscaped(text, scriptIndex)) {
      return null;
    }
    const scriptChar = text[scriptIndex];
    if (scriptChar !== "_" && scriptChar !== "^") {
      return null;
    }
    return {
      kind: scriptChar === "_" ? "sub" : "sup",
      range: {
        start: scriptIndex,
        end: endIndex,
        contentStart: tokenStart,
        contentEnd: endIndex,
      },
    };
  }
  const openIndex = findMatchingBraceLeft(text, closeIndex);
  if (openIndex === null) {
    return null;
  }
  const scriptIndex = openIndex - 1;
  if (scriptIndex < 0 || isEscaped(text, scriptIndex)) {
    return null;
  }
  const scriptChar = text[scriptIndex];
  if (scriptChar !== "_" && scriptChar !== "^") {
    return null;
  }
  return {
    kind: scriptChar === "_" ? "sub" : "sup",
    range: {
      start: scriptIndex,
      end: closeIndex + 1,
      contentStart: openIndex + 1,
      contentEnd: closeIndex,
    },
  };
};

const findAtomLeftOfCursor = (text: string, cursor: number): AtomInfo | null => {
  if (cursor <= 0) {
    return null;
  }
  let baseEnd = cursor;
  let sub: ScriptRange | undefined;
  let sup: ScriptRange | undefined;
  for (let i = 0; i < 2; i += 1) {
    const script = readScriptEndingAt(text, baseEnd);
    if (!script) {
      break;
    }
    if (script.kind === "sub" && !sub) {
      sub = script.range;
    } else if (script.kind === "sup" && !sup) {
      sup = script.range;
    }
    baseEnd = script.range.start;
  }
  const baseStart = findBaseStart(text, baseEnd);
  if (baseStart === null) {
    return null;
  }
  return { baseStart, baseEnd, sub, sup };
};

const findAtomRangeLeftOfCursor = (text: string, cursor: number) => {
  const atom = findAtomLeftOfCursor(text, cursor);
  if (!atom) {
    return null;
  }
  const atomEnd = Math.max(
    atom.baseEnd,
    atom.sub?.end ?? atom.baseEnd,
    atom.sup?.end ?? atom.baseEnd
  );
  return { start: atom.baseStart, end: atomEnd };
};

const insertAt = (text: string, index: number, value: string) =>
  text.slice(0, index) + value + text.slice(index);

const buildTemplate = (template: string, placeholder: string) => {
  const parts = template.split("#?");
  if (parts.length === 1) {
    return { text: template, placeholders: [] as PlaceholderRange[] };
  }
  const placeholders: PlaceholderRange[] = [];
  let text = parts[0] ?? "";
  for (let i = 1; i < parts.length; i += 1) {
    const start = text.length;
    text += placeholder;
    const end = text.length;
    placeholders.push({ start, end });
    text += parts[i] ?? "";
  }
  return { text, placeholders };
};

const normalizeScriptValue = (value?: string | null) =>
  value && value.length > 0 ? value : null;

const buildScriptSegment = (kind: "sub" | "sup", placeholder: string, value: string | null) => {
  const marker = kind === "sub" ? "_" : "^";
  if (value) {
    const hasPlaceholder = value.includes("#?");
    if (hasPlaceholder) {
      const template = buildTemplate(value, placeholder);
      const text = `${marker}{${template.text}}`;
      if (template.placeholders.length > 0) {
        const focus = template.placeholders[0];
        const start = marker.length + 1 + focus.start;
        const end = marker.length + 1 + focus.end;
        return { text, selectionStart: start, selectionEnd: end };
      }
      return { text, selectionStart: text.length, selectionEnd: text.length };
    }
    const text = `${marker}{${value}}`;
    return { text, selectionStart: text.length, selectionEnd: text.length };
  }
  const text = `${marker}{${placeholder}}`;
  if (placeholder.length > 0) {
    const start = marker.length + 1;
    return { text, selectionStart: start, selectionEnd: start + placeholder.length };
  }
  const cursor = marker.length + 1;
  return { text, selectionStart: cursor, selectionEnd: cursor };
};

// Apply scripts by editing the LaTeX string so MathLive/textarea stay consistent.
const applyScriptToText = (
  text: string,
  selection: { start: number; end: number },
  kind: ScriptKind,
  options: ApplyScriptOptions
): ApplyScriptResult => {
  let start = selection.start;
  let end = selection.end;
  if (start > end) {
    [start, end] = [end, start];
  }

  let cursor = end;
  if (start !== end) {
    const selected = text.slice(start, end);
    text = text.slice(0, start) + `{${selected}}` + text.slice(end);
    cursor = start + selected.length + 2;
  }

  const placeholder = options.placeholder;
  const baseInsert = normalizeScriptValue(options.base);
  const subValue = normalizeScriptValue(options.subValue);
  const supValue = normalizeScriptValue(options.supValue);
  let atom = findAtomLeftOfCursor(text, cursor);
  if (!atom && baseInsert) {
    text = insertAt(text, cursor, baseInsert);
    cursor += baseInsert.length;
    atom = findAtomLeftOfCursor(text, cursor);
  }

  if (!atom) {
    const basePlaceholder = placeholder.length > 0 ? placeholder : "{}";
    let scriptText = "";
    if (kind === "sub") {
      scriptText = buildScriptSegment("sub", placeholder, subValue).text;
    } else if (kind === "sup") {
      scriptText = buildScriptSegment("sup", placeholder, supValue).text;
    } else {
      const subSegment = buildScriptSegment("sub", placeholder, subValue);
      const supSegment = buildScriptSegment("sup", placeholder, supValue);
      scriptText = subSegment.text + supSegment.text;
    }
    const insertion = basePlaceholder + scriptText;
    text = insertAt(text, cursor, insertion);
    if (placeholder.length > 0) {
      return {
        text,
        selectionStart: cursor,
        selectionEnd: cursor + placeholder.length,
      };
    }
    return {
      text,
      selectionStart: cursor + 1,
      selectionEnd: cursor + 1,
    };
  }

  if (kind === "sub") {
    if (atom.sub) {
      return { text, selectionStart: atom.sub.contentEnd, selectionEnd: atom.sub.contentEnd };
    }
    const insertPos = atom.sup ? atom.sup.start : atom.baseEnd;
    const segment = buildScriptSegment("sub", placeholder, subValue);
    text = insertAt(text, insertPos, segment.text);
    return {
      text,
      selectionStart: insertPos + segment.selectionStart,
      selectionEnd: insertPos + segment.selectionEnd,
    };
  }

  if (kind === "sup") {
    if (atom.sup) {
      return { text, selectionStart: atom.sup.contentEnd, selectionEnd: atom.sup.contentEnd };
    }
    const insertPos = atom.sub ? atom.sub.end : atom.baseEnd;
    const segment = buildScriptSegment("sup", placeholder, supValue);
    text = insertAt(text, insertPos, segment.text);
    return {
      text,
      selectionStart: insertPos + segment.selectionStart,
      selectionEnd: insertPos + segment.selectionEnd,
    };
  }

  if (atom.sub && atom.sup) {
    return { text, selectionStart: atom.sub.contentEnd, selectionEnd: atom.sub.contentEnd };
  }

  if (!atom.sub && atom.sup) {
    const insertPos = atom.sup.start;
    const segment = buildScriptSegment("sub", placeholder, subValue);
    text = insertAt(text, insertPos, segment.text);
    return {
      text,
      selectionStart: insertPos + segment.selectionStart,
      selectionEnd: insertPos + segment.selectionEnd,
    };
  }

  if (!atom.sup && atom.sub) {
    const insertPos = atom.sub.end;
    const segment = buildScriptSegment("sup", placeholder, supValue);
    text = insertAt(text, insertPos, segment.text);
    return {
      text,
      selectionStart: insertPos + segment.selectionStart,
      selectionEnd: insertPos + segment.selectionEnd,
    };
  }

  const insertPos = atom.baseEnd;
  const subSegment = buildScriptSegment("sub", placeholder, subValue);
  const supSegment = buildScriptSegment("sup", placeholder, supValue);
  text = insertAt(text, insertPos, subSegment.text + supSegment.text);
  return {
    text,
    selectionStart: insertPos + subSegment.selectionStart,
    selectionEnd: insertPos + subSegment.selectionEnd,
  };
};

const applyTemplateToText = (
  text: string,
  selection: { start: number; end: number },
  template: string,
  options: TemplateApplyOptions
): ApplyScriptResult => {
  let start = selection.start;
  let end = selection.end;
  if (start > end) {
    [start, end] = [end, start];
  }

  const hasSelection = start !== end;
  const cursor = end;
  const baseScope = options.baseScope ?? "selection";
  const canUseAtom = baseScope !== "selection";
  const baseRange = hasSelection
    ? { start, end }
    : canUseAtom
      ? findAtomRangeLeftOfCursor(text, cursor)
      : null;
  const baseText = baseRange ? text.slice(baseRange.start, baseRange.end) : null;

  let templateText = "";
  let placeholders: PlaceholderRange[] = [];

  if (options.baseMode === "wrap") {
    const parts = template.split("#?");
    const placeholderCount = Math.max(0, parts.length - 1);
    const targetIndex =
      placeholderCount === 0
        ? null
        : Math.max(0, Math.min(options.baseIndex ?? 0, placeholderCount - 1));

    templateText = parts[0] ?? "";
    for (let i = 0; i < placeholderCount; i += 1) {
      const useBase = baseText && targetIndex !== null && i === targetIndex;
      const insertValue = useBase ? baseText : options.placeholder;
      const startIndex = templateText.length;
      templateText += insertValue;
      const endIndex = templateText.length;
      if (!useBase) {
        placeholders.push({ start: startIndex, end: endIndex });
      }
      templateText += parts[i + 1] ?? "";
    }
  } else {
    const built = buildTemplate(template, options.placeholder);
    templateText = built.text;
    placeholders = built.placeholders;
    if (baseText) {
      templateText += (options.baseSeparator ?? "") + baseText;
    }
  }

  const insertStart = baseRange ? baseRange.start : cursor;
  const insertEnd = baseRange ? baseRange.end : cursor;
  const nextText = text.slice(0, insertStart) + templateText + text.slice(insertEnd);

  if (placeholders.length > 0) {
    const focus = placeholders[0];
    return {
      text: nextText,
      selectionStart: insertStart + focus.start,
      selectionEnd: insertStart + focus.end,
    };
  }
  const cursorPos = insertStart + templateText.length;
  return { text: nextText, selectionStart: cursorPos, selectionEnd: cursorPos };
};

const getMathFieldSelectionRange = (mathField: any) => {
  const selection = mathField?.selection;
  if (selection) {
    if (Array.isArray(selection)) {
      if (selection.length === 2 && typeof selection[0] === "number") {
        return { start: selection[0], end: selection[1] };
      }
      if (Array.isArray(selection[0])) {
        const [start, end] = selection[0];
        return { start, end };
      }
    }
    if (selection.ranges && Array.isArray(selection.ranges) && selection.ranges.length > 0) {
      const [start, end] = selection.ranges[0];
      return { start, end };
    }
  }
  if (typeof mathField?.position === "number") {
    return { start: mathField.position, end: mathField.position };
  }
  return { start: 0, end: 0 };
};

const offsetToIndex = (mathField: any, offset: number) => {
  if (typeof mathField?.getValue !== "function") {
    return offset;
  }
  try {
    const prefix = mathField.getValue(0, offset, "latex");
    return typeof prefix === "string" ? prefix.length : 0;
  } catch {
    return Math.max(0, offset);
  }
};

const indexToOffset = (mathField: any, targetIndex: number) => {
  if (typeof mathField?.getValue !== "function") {
    return targetIndex;
  }
  let fullValue: unknown = "";
  try {
    fullValue = mathField.getValue("latex");
  } catch {
    return targetIndex;
  }
  const fullLength = typeof fullValue === "string" ? fullValue.length : 0;
  const lastOffset = typeof mathField.lastOffset === "number" ? mathField.lastOffset : fullLength;
  if (targetIndex <= 0) {
    return 0;
  }
  if (targetIndex >= fullLength) {
    return lastOffset;
  }
  let low = 0;
  let high = lastOffset;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const length = offsetToIndex(mathField, mid);
    if (length < targetIndex) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
};


export {
  PLACEHOLDER_LATEX,
  applyScriptToText,
  applyTemplateToText,
  getMathFieldSelectionRange,
  indexToOffset,
  offsetToIndex,
};
export type { ScriptKind };

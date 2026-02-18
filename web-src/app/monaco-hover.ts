import type { IndexEntry } from "./types.js";
import { pickCitationEntries } from "./index-utils.js";

export type HoverState = { registered: boolean };

type StableHoverAnchor = {
  filePath: string;
  startLineNumber: number;
  endLineNumber: number;
  startColumn: number;
  endColumn: number;
  tokenKey: string;
  updatedAt: number;
};

type CommandKeyMatch = {
  command: string;
  key: string;
  startIndex: number;
  endIndex: number;
};

type FileExcerptResult =
  | { ok: true; path: string; startLine: number; lines: string[]; truncated?: boolean }
  | { ok: false; error?: string };

type FilePreviewResult = { ok: boolean; dataUrl?: string | null; error?: string };

const getCursorIndex = (position: { lineNumber: number; column: number }) =>
  Math.max(0, (position.column ?? 1) - 1);

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findCommandMatchAt = (
  line: string,
  cursorIndex: number,
  regex: RegExp,
  extractKey: (match: RegExpExecArray, cursorIndex: number) => {
    command: string;
    key: string;
    startIndex: number;
    endIndex: number;
  } | null
) => {
  regex.lastIndex = 0;
  let match = regex.exec(line);
  while (match) {
    const extracted = extractKey(match, cursorIndex);
    if (extracted) {
      return extracted;
    }
    match = regex.exec(line);
  }
  return null;
};

const extractSingleKey = (match: RegExpExecArray, cursorIndex: number): CommandKeyMatch | null => {
  const command = match[1] ?? "";
  const content = match[2] ?? "";
  const braceIndex = match[0].indexOf("{");
  if (braceIndex < 0 || typeof match.index !== "number") {
    return null;
  }
  const contentStart = match.index + braceIndex + 1;
  const contentEnd = contentStart + content.length;
  if (cursorIndex < contentStart || cursorIndex > contentEnd) {
    return null;
  }
  const key = content.trim();
  if (!key) {
    return null;
  }
  const leading = content.match(/^\s*/)?.[0]?.length ?? 0;
  return {
    command,
    key,
    startIndex: contentStart + leading,
    endIndex: contentStart + leading + key.length,
  };
};

const extractCiteKey = (match: RegExpExecArray, cursorIndex: number): CommandKeyMatch | null => {
  const command = match[1] ?? "";
  const content = match[2] ?? "";
  const braceIndex = match[0].indexOf("{");
  if (braceIndex < 0 || typeof match.index !== "number") {
    return null;
  }
  const contentStart = match.index + braceIndex + 1;
  const contentEnd = contentStart + content.length;
  if (cursorIndex < contentStart || cursorIndex > contentEnd) {
    return null;
  }
  const offset = cursorIndex - contentStart;
  const beforeComma = content.lastIndexOf(",", Math.max(0, offset - 1));
  const afterComma = content.indexOf(",", offset);
  const segStart = beforeComma >= 0 ? beforeComma + 1 : 0;
  const segEnd = afterComma >= 0 ? afterComma : content.length;
  const segment = content.slice(segStart, segEnd);
  const leading = segment.match(/^\s*/)?.[0]?.length ?? 0;
  const key = segment.trim();
  if (!key) {
    return null;
  }
  return {
    command,
    key,
    startIndex: contentStart + segStart + leading,
    endIndex: contentStart + segStart + leading + key.length,
  };
};

const extractCommaSeparatedKey = (
  command: string,
  content: string,
  contentStart: number,
  cursorIndex: number
): CommandKeyMatch | null => {
  const contentEnd = contentStart + content.length;
  if (cursorIndex < contentStart || cursorIndex > contentEnd) {
    return null;
  }
  const offset = cursorIndex - contentStart;
  const beforeComma = content.lastIndexOf(",", Math.max(0, offset - 1));
  const afterComma = content.indexOf(",", offset);
  const segStart = beforeComma >= 0 ? beforeComma + 1 : 0;
  const segEnd = afterComma >= 0 ? afterComma : content.length;
  const segment = content.slice(segStart, segEnd);
  const leading = segment.match(/^\s*/)?.[0]?.length ?? 0;
  const key = segment.trim();
  if (!key) {
    return null;
  }
  return {
    command,
    key,
    startIndex: contentStart + segStart + leading,
    endIndex: contentStart + segStart + leading + key.length,
  };
};

const extractPackageKey = (match: RegExpExecArray, cursorIndex: number): CommandKeyMatch | null => {
  const command = (match[1] ?? "usepackage").trim();
  const content = match[2] ?? "";
  const braceIndex = match[0].indexOf("{");
  if (braceIndex < 0 || typeof match.index !== "number") {
    return null;
  }
  const contentStart = match.index + braceIndex + 1;
  return extractCommaSeparatedKey(command, content, contentStart, cursorIndex);
};

const extractDocumentClassKey = (match: RegExpExecArray, cursorIndex: number): CommandKeyMatch | null => {
  const command = "documentclass";
  const content = match[1] ?? "";
  const braceIndex = match[0].indexOf("{");
  if (braceIndex < 0 || typeof match.index !== "number") {
    return null;
  }
  const contentStart = match.index + braceIndex + 1;
  const key = content.trim();
  if (!key) {
    return null;
  }
  const contentEnd = contentStart + content.length;
  if (cursorIndex < contentStart || cursorIndex > contentEnd) {
    return null;
  }
  const leading = content.match(/^\s*/)?.[0]?.length ?? 0;
  return {
    command,
    key,
    startIndex: contentStart + leading,
    endIndex: contentStart + leading + key.length,
  };
};

const KNOWN_PACKAGE_HINTS: Record<string, string> = {
  amsmath: "AMS Math",
  amssymb: "AMS Symbols",
  graphicx: "Graphics",
  hyperref: "Hyperlinks",
  geometry: "Page geometry",
  xcolor: "Color",
  mathtools: "Math tools",
  biblatex: "Bibliography",
  cleveref: "Cross-reference",
};

const buildPackageHoverMarkdown = (
  pkgName: string,
  commandName: "usepackage" | "RequirePackage" | "documentclass"
) => {
  const normalized = pkgName.trim();
  if (!normalized) {
    return null;
  }
  const hint = KNOWN_PACKAGE_HINTS[normalized.toLowerCase()];
  const encoded = encodeURIComponent(normalized);
  const lines = [
    `\`${normalized}\``,
    hint ? `${hint}` : null,
    `[CTAN](https://ctan.org/pkg/${encoded})`,
    `\`texdoc ${normalized}\``,
  ].filter(Boolean);
  const syntax =
    commandName === "documentclass"
      ? "\\documentclass[options]{class}"
      : commandName === "RequirePackage"
        ? "\\RequirePackage[options]{package}"
        : "\\usepackage[options]{package}";
  return [`\`\`\`tex\n${syntax}\n\`\`\``, ...lines].join("\n");
};

const renderExcerpt = (payload: { startLine: number; lines: string[]; highlightLine?: number }) => {
  const start = Math.max(1, payload.startLine);
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (lines.length === 0) {
    return "```tex\n(抜粋なし)\n```";
  }
  const endLine = start + lines.length - 1;
  const width = Math.max(String(start).length, String(endLine).length);
  const body = lines
    .map((line, idx) => {
      const lineNo = start + idx;
      const marker = payload.highlightLine === lineNo ? "▶" : " ";
      const padded = String(lineNo).padStart(width, " ");
      return `${marker}${padded} | ${line}`;
    })
    .join("\n");
  return `\`\`\`tex\n${body}\n\`\`\``;
};

const sliceExcerptAroundLine = (payload: {
  startLine: number;
  lines: string[];
  targetLine: number;
  radius?: number;
  maxLines?: number;
}) => {
  const startLine = Number.isFinite(payload.startLine) ? Math.max(1, payload.startLine) : 1;
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const targetLine = Number.isFinite(payload.targetLine) ? Math.max(1, payload.targetLine) : 1;
  const radius = Number.isFinite(payload.radius)
    ? Math.min(80, Math.max(0, Math.floor(payload.radius ?? 0)))
    : 5;
  const maxLines = Number.isFinite(payload.maxLines)
    ? Math.min(200, Math.max(3, Math.floor(payload.maxLines ?? 0)))
    : 18;
  if (lines.length === 0) {
    return { startLine, lines: [] as string[] };
  }
  const idx = targetLine - startLine;
  if (idx < 0 || idx >= lines.length) {
    return { startLine, lines: lines.slice(0, maxLines) };
  }
  let begin = Math.max(0, idx - radius);
  let end = Math.min(lines.length, idx + radius + 1);
  if (end - begin > maxLines) {
    const half = Math.floor(maxLines / 2);
    begin = Math.max(0, idx - half);
    end = Math.min(lines.length, begin + maxLines);
    begin = Math.max(0, end - maxLines);
  }
  return { startLine: startLine + begin, lines: lines.slice(begin, end) };
};

const findFirstUnescapedPercent = (line: string) => {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "%") {
      continue;
    }
    if (i > 0 && line[i - 1] === "\\") {
      continue;
    }
    return i;
  }
  return -1;
};

const stripCommentTail = (line: string) => {
  const commentIndex = findFirstUnescapedPercent(line);
  return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
};

type MathMatchResult = {
  latex: string;
  startLineNumber: number;
  endLineNumber: number;
  startIndex: number;
  endIndex: number;
};

const findInlineMathAt = (
  line: string,
  cursorIndex: number
): { latex: string; startIndex: number; endIndex: number } | null => {
  if (!line) {
    return null;
  }
  line = stripCommentTail(line);

  const regexPairs: Array<{ regex: RegExp; openLen: number; closeLen: number }> = [
    { regex: /\\\((.+?)\\\)/g, openLen: 2, closeLen: 2 },
  ];
  for (const entry of regexPairs) {
    entry.regex.lastIndex = 0;
    let match = entry.regex.exec(line);
    while (match) {
      const raw = match[0] ?? "";
      const latex = match[1] ?? "";
      const index = match.index ?? -1;
      if (index >= 0 && raw) {
        const startIndex = index + entry.openLen;
        const endIndex = startIndex + latex.length;
        if (cursorIndex >= startIndex && cursorIndex <= endIndex) {
          const trimmed = latex.trim();
          if (trimmed) {
            return { latex: trimmed, startIndex, endIndex };
          }
        }
      }
      match = entry.regex.exec(line);
    }
  }

  const dollarIndices: number[] = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "$") {
      continue;
    }
    if (i > 0 && line[i - 1] === "\\") {
      continue;
    }
    if (i + 1 < line.length && line[i + 1] === "$") {
      continue;
    }
    if (i > 0 && line[i - 1] === "$") {
      continue;
    }
    dollarIndices.push(i);
  }
  for (let j = 0; j + 1 < dollarIndices.length; j += 2) {
    const open = dollarIndices[j];
    const close = dollarIndices[j + 1];
    if (cursorIndex < open + 1 || cursorIndex > close) {
      continue;
    }
    const latex = line.slice(open + 1, close);
    const trimmed = latex.trim();
    if (!trimmed) {
      continue;
    }
    return { latex: trimmed, startIndex: open + 1, endIndex: close };
  }

  return null;
};

const isEscapedAt = (text: string, index: number) => {
  let slashCount = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (text[i] !== "\\") {
      break;
    }
    slashCount += 1;
  }
  return slashCount % 2 === 1;
};

const getModelLineCount = (model: { getLineCount?: () => number }, fallback: number) => {
  const count = model.getLineCount?.();
  if (!Number.isFinite(count)) {
    return fallback;
  }
  return Math.max(fallback, Math.floor(count ?? fallback));
};

type MathScanWindow = {
  startLineNumber: number;
  endLineNumber: number;
  lines: string[];
  lineOffsets: number[];
  text: string;
};

const buildMathScanWindow = (
  model: { getLineContent: (lineNumber: number) => string; getLineCount?: () => number },
  centerLineNumber: number,
  options?: { radius?: number }
): MathScanWindow => {
  const lineCount = getModelLineCount(model, centerLineNumber);
  const radius = Number.isFinite(options?.radius) ? Math.max(20, Math.floor(options?.radius ?? 0)) : 320;
  const startLineNumber = Math.max(1, centerLineNumber - radius);
  const endLineNumber = Math.min(lineCount, centerLineNumber + radius);
  const lines: string[] = [];
  const lineOffsets: number[] = [];
  let text = "";
  for (let line = startLineNumber; line <= endLineNumber; line += 1) {
    lineOffsets.push(text.length);
    const content = stripCommentTail(model.getLineContent(line) ?? "");
    lines.push(content);
    text += content;
    if (line < endLineNumber) {
      text += "\n";
    }
  }
  return {
    startLineNumber,
    endLineNumber,
    lines,
    lineOffsets,
    text,
  };
};

const offsetToLineIndex = (window: MathScanWindow, absoluteOffset: number) => {
  const clamped = Math.max(0, Math.min(window.text.length, absoluteOffset));
  let lineIndex = 0;
  while (
    lineIndex + 1 < window.lineOffsets.length &&
    window.lineOffsets[lineIndex + 1] <= clamped
  ) {
    lineIndex += 1;
  }
  const lineStart = window.lineOffsets[lineIndex] ?? 0;
  const lineText = window.lines[lineIndex] ?? "";
  const index = Math.max(0, Math.min(lineText.length, clamped - lineStart));
  return {
    lineNumber: window.startLineNumber + lineIndex,
    index,
  };
};

const pickSmallestMathRange = (ranges: Array<MathMatchResult | null>) => {
  const filtered = ranges.filter((entry): entry is MathMatchResult => Boolean(entry));
  if (filtered.length === 0) {
    return null;
  }
  return filtered.sort((a, b) => {
    const aSpan = (a.endLineNumber - a.startLineNumber) * 10_000 + (a.endIndex - a.startIndex);
    const bSpan = (b.endLineNumber - b.startLineNumber) * 10_000 + (b.endIndex - b.startIndex);
    return aSpan - bSpan;
  })[0];
};

const findDelimitedMathAt = (
  window: MathScanWindow,
  cursorOffset: number,
  openToken: string,
  closeToken: string
): MathMatchResult | null => {
  if (!window.text || !openToken || !closeToken) {
    return null;
  }
  const pairs: Array<{ startOffset: number; endOffset: number }> = [];
  if (openToken === closeToken) {
    const markers: number[] = [];
    let markerPos = window.text.indexOf(openToken);
    while (markerPos >= 0) {
      if (!isEscapedAt(window.text, markerPos)) {
        markers.push(markerPos);
      }
      markerPos = window.text.indexOf(openToken, markerPos + openToken.length);
    }
    for (let i = 0; i + 1 < markers.length; i += 2) {
      const startOffset = markers[i];
      const endOffset = markers[i + 1] + closeToken.length;
      if (endOffset > startOffset) {
        pairs.push({ startOffset, endOffset });
      }
    }
  } else {
    const events: Array<{ offset: number; kind: "open" | "close" }> = [];
    let openPos = window.text.indexOf(openToken);
    while (openPos >= 0) {
      if (!isEscapedAt(window.text, openPos) && (openToken !== "\\[" || window.text[openPos - 1] !== "\\")) {
        events.push({ offset: openPos, kind: "open" });
      }
      openPos = window.text.indexOf(openToken, openPos + openToken.length);
    }
    let closePos = window.text.indexOf(closeToken);
    while (closePos >= 0) {
      if (!isEscapedAt(window.text, closePos) && (closeToken !== "\\]" || window.text[closePos - 1] !== "\\")) {
        events.push({ offset: closePos, kind: "close" });
      }
      closePos = window.text.indexOf(closeToken, closePos + closeToken.length);
    }
    events.sort((a, b) => a.offset - b.offset || (a.kind === "open" ? -1 : 1));
    const stack: number[] = [];
    for (const event of events) {
      if (event.kind === "open") {
        stack.push(event.offset);
        continue;
      }
      const startOffset = stack.pop();
      if (typeof startOffset !== "number") {
        continue;
      }
      const endOffset = event.offset + closeToken.length;
      if (endOffset > startOffset) {
        pairs.push({ startOffset, endOffset });
      }
    }
  }
  if (pairs.length === 0) {
    return null;
  }
  const hit =
    pairs
      .filter((pair) => cursorOffset >= pair.startOffset && cursorOffset <= pair.endOffset)
      .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset))[0] ?? null;
  if (!hit) {
    return null;
  }
  const latex = window.text.slice(hit.startOffset, hit.endOffset).trim();
  if (!latex) {
    return null;
  }
  const start = offsetToLineIndex(window, hit.startOffset);
  const end = offsetToLineIndex(window, hit.endOffset);
  return {
    latex,
    startLineNumber: start.lineNumber,
    endLineNumber: end.lineNumber,
    startIndex: start.index,
    endIndex: end.index,
  };
};

const MATH_ENVIRONMENTS = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "alignat",
  "alignat*",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "flalign",
  "flalign*",
  "eqnarray",
  "eqnarray*",
  "math",
  "displaymath",
  "split",
  "cases",
  "matrix",
  "pmatrix",
  "bmatrix",
  "vmatrix",
  "Vmatrix",
  "smallmatrix",
]);

const findEnvironmentMathAt = (window: MathScanWindow, cursorOffset: number): MathMatchResult | null => {
  if (!window.text) {
    return null;
  }
  const tokenRegex = /\\(begin|end)\{([A-Za-z*@]+)\}/g;
  const stack: Array<{ env: string; startOffset: number }> = [];
  const pairs: Array<{ startOffset: number; endOffset: number }> = [];
  tokenRegex.lastIndex = 0;
  let token = tokenRegex.exec(window.text);
  while (token) {
    const action = token[1] ?? "";
    const env = token[2] ?? "";
    const startOffset = token.index ?? -1;
    if (startOffset >= 0 && MATH_ENVIRONMENTS.has(env)) {
      const tokenEnd = startOffset + (token[0]?.length ?? 0);
      if (action === "begin") {
        stack.push({ env, startOffset });
      } else if (action === "end") {
        let matchIndex = -1;
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i]?.env === env) {
            matchIndex = i;
            break;
          }
        }
        if (matchIndex >= 0) {
          const begin = stack.splice(matchIndex, 1)[0];
          if (tokenEnd > begin.startOffset) {
            pairs.push({ startOffset: begin.startOffset, endOffset: tokenEnd });
          }
        }
      }
    }
    token = tokenRegex.exec(window.text);
  }
  if (pairs.length === 0) {
    return null;
  }
  const hit =
    pairs
      .filter((pair) => cursorOffset >= pair.startOffset && cursorOffset <= pair.endOffset)
      .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset))[0] ?? null;
  if (!hit) {
    return null;
  }
  const latex = window.text.slice(hit.startOffset, hit.endOffset).trim();
  if (!latex) {
    return null;
  }
  const start = offsetToLineIndex(window, hit.startOffset);
  const end = offsetToLineIndex(window, hit.endOffset);
  return {
    latex,
    startLineNumber: start.lineNumber,
    endLineNumber: end.lineNumber,
    startIndex: start.index,
    endIndex: end.index,
  };
};

const findMathAt = (
  model: { getLineContent: (lineNumber: number) => string; getLineCount?: () => number },
  position: { lineNumber: number; column: number },
  effectiveLine: string,
  cursorIndex: number
): MathMatchResult | null => {
  const inline = findInlineMathAt(effectiveLine, cursorIndex);
  if (inline) {
    return {
      latex: inline.latex,
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startIndex: inline.startIndex,
      endIndex: inline.endIndex,
    };
  }

  const window = buildMathScanWindow(model, position.lineNumber);
  const lineIdx = position.lineNumber - window.startLineNumber;
  if (lineIdx < 0 || lineIdx >= window.lines.length) {
    return null;
  }
  const currentLine = window.lines[lineIdx] ?? "";
  const boundedCursorIndex = Math.max(0, Math.min(cursorIndex, currentLine.length));
  const cursorOffset = (window.lineOffsets[lineIdx] ?? 0) + boundedCursorIndex;

  return pickSmallestMathRange([
    findDelimitedMathAt(window, cursorOffset, "\\[", "\\]"),
    findDelimitedMathAt(window, cursorOffset, "$$", "$$"),
    findEnvironmentMathAt(window, cursorOffset),
  ]);
};

let stableHoverAnchor: StableHoverAnchor | null = null;
const STABLE_HOVER_ANCHOR_TTL_MS = 12000;

const rememberStableHoverAnchor = (payload: {
  filePath: string;
  startLineNumber: number;
  endLineNumber?: number;
  startIndex: number;
  endIndex: number;
  tokenKey: string;
}) => {
  const startColumn = Math.max(1, payload.startIndex + 1);
  const endColumn = Math.max(startColumn, payload.endIndex + 1);
  const startLineNumber = Math.max(1, Math.floor(payload.startLineNumber));
  const normalizedEndLine = Number.isFinite(payload.endLineNumber)
    ? Math.max(startLineNumber, Math.floor(payload.endLineNumber ?? startLineNumber))
    : startLineNumber;
  stableHoverAnchor = {
    filePath: payload.filePath,
    startLineNumber,
    endLineNumber: normalizedEndLine,
    startColumn,
    endColumn,
    tokenKey: payload.tokenKey,
    updatedAt: Date.now(),
  };
};

const getStableHoverAnchor = (payload: {
  filePath: string;
  lineNumber: number;
  column: number;
}) => {
  const anchor = stableHoverAnchor;
  if (!anchor) {
    return null;
  }
  if (anchor.filePath !== payload.filePath) {
    return null;
  }
  if (
    payload.lineNumber < anchor.startLineNumber ||
    payload.lineNumber > anchor.endLineNumber
  ) {
    return null;
  }
  if (Date.now() - anchor.updatedAt > STABLE_HOVER_ANCHOR_TTL_MS) {
    return null;
  }
  const column = Math.max(1, payload.column);
  if (anchor.startLineNumber === anchor.endLineNumber) {
    return column >= anchor.startColumn && column <= anchor.endColumn ? anchor : null;
  }
  if (payload.lineNumber === anchor.startLineNumber) {
    return column >= anchor.startColumn ? anchor : null;
  }
  if (payload.lineNumber === anchor.endLineNumber) {
    return column <= anchor.endColumn ? anchor : null;
  }
  return anchor;
};

export const shouldKeepStableHover = (payload: {
  filePath: string;
  lineNumber: number;
  column: number;
}) => {
  return Boolean(getStableHoverAnchor(payload));
};

export const getStableHoverTokenKey = (payload: {
  filePath: string;
  lineNumber: number;
  column: number;
}) => {
  return getStableHoverAnchor(payload)?.tokenKey ?? null;
};

const stripMathDelimiters = (latex: string) => {
  const value = latex.trim();
  if (!value) {
    return "";
  }
  if (value.startsWith("\\(") && value.endsWith("\\)") && value.length > 4) {
    return value.slice(2, -2).trim();
  }
  if (value.startsWith("\\[") && value.endsWith("\\]") && value.length > 4) {
    return value.slice(2, -2).trim();
  }
  if (value.startsWith("$$") && value.endsWith("$$") && value.length > 4) {
    return value.slice(2, -2).trim();
  }
  if (value.startsWith("$") && value.endsWith("$") && !value.startsWith("$$") && value.length > 2) {
    return value.slice(1, -1).trim();
  }
  return value;
};

const normalizeLatexForMathLive = (latex: string) => {
  let value = latex.trim();
  if (!value) {
    return value;
  }

  // MathLive has weak support for alignat/flalign; map them to aligned for stable hover previews.
  value = value.replace(/\\begin\{alignat\*?\}\s*\{[^}]*\}/g, "\\begin{aligned}");
  value = value.replace(/\\end\{alignat\*?\}/g, "\\end{aligned}");

  const hadFlalign = /\\begin\{flalign\*?\}/.test(value) || /\\end\{flalign\*?\}/.test(value);
  if (hadFlalign) {
    value = value.replace(/\\begin\{flalign\*?\}/g, "\\begin{aligned}");
    value = value.replace(/\\end\{flalign\*?\}/g, "\\end{aligned}");
    // flalign commonly uses redundant && anchors that degrade in MathLive; collapse to aligned-style anchors.
    value = value.replace(/&&+/g, "&");
    value = value.replace(/&\s*(\\\\)/g, "$1");
    value = value.replace(/&\s*$/gm, "");
  }

  return value;
};

const sanitizeGeneratedMathHtml = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+=(["']).*?\1/gi, "")
    .replace(/\shref=(["'])\s*javascript:[\s\S]*?\1/gi, "")
    .trim();

const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
const DOUBLE_BAR_TOKENS = new Set(["∥", "‖", "||", "\\|", "\\Vert", "\\lVert", "\\rVert"]);
const INVISIBLE_MATH_SPACING = /^[\s\u00a0\u2009\u200a\u2062]+$/;

const normalizeMathMlNodes = (root: Element) => {
  const doc = root.ownerDocument;
  if (!doc) {
    return;
  }
  for (const node of Array.from(root.querySelectorAll("mo, mi, mtext"))) {
    const rawText = node.textContent ?? "";
    const collapsed = rawText.replace(/\u2062/g, "").replace(/\s+/g, "").trim();
    if (!collapsed && INVISIBLE_MATH_SPACING.test(rawText)) {
      node.remove();
      continue;
    }
    if (!DOUBLE_BAR_TOKENS.has(collapsed)) {
      continue;
    }
    const row = doc.createElementNS(MATHML_NS, "mrow");
    const left = doc.createElementNS(MATHML_NS, "mo");
    left.textContent = "|";
    const right = doc.createElementNS(MATHML_NS, "mo");
    right.textContent = "|";
    row.append(left, right);
    node.replaceWith(row);
  }
};

const normalizeMathMlForSvg = (mathMl: string) => {
  if (typeof document === "undefined" || typeof XMLSerializer === "undefined") {
    return null;
  }
  const source = mathMl.replace(/&nbsp;/gi, "&#160;");
  const host = document.createElement("div");
  host.innerHTML = source;
  let root = host.querySelector("math");
  if (!root) {
    host.innerHTML = `<math xmlns="${MATHML_NS}" display="block">${source}</math>`;
    root = host.querySelector("math");
  }
  if (!root) {
    return null;
  }
  normalizeMathMlNodes(root);
  const serialized = new XMLSerializer().serializeToString(root).trim();
  return serialized || null;
};

const buildMathPreviewHtml = (latex: string) => {
  const MathLiveGlobal = (window as any).MathLive;
  const convertToMathMl = MathLiveGlobal?.convertLatexToMathMl;
  const stripped = stripMathDelimiters(latex);
  if (!stripped) {
    return null;
  }
  const normalized = normalizeLatexForMathLive(stripped);
  if (!normalized) {
    return null;
  }
  try {
    const renderLatex =
      /^\\begin\{/.test(normalized) || /^\\displaystyle\b/.test(normalized)
        ? normalized
        : `\\displaystyle ${normalized}`;
    if (typeof convertToMathMl !== "function") {
      return null;
    }
    const mathMlRaw = convertToMathMl(renderLatex);
    if (typeof mathMlRaw !== "string" || !mathMlRaw.trim()) {
      return null;
    }
    const sanitized = sanitizeGeneratedMathHtml(mathMlRaw);
    if (!sanitized) {
      return null;
    }
    const renderRoot = normalizeMathMlForSvg(sanitized);
    if (!renderRoot) {
      return null;
    }

    const padX = 6;
    const padY = 4;
    let width = 240;
    let height = 92;
    try {
      const probeHost = document.createElement("div");
      probeHost.style.position = "fixed";
      probeHost.style.left = "-10000px";
      probeHost.style.top = "-10000px";
      probeHost.style.pointerEvents = "none";
      probeHost.style.opacity = "0";
      probeHost.style.whiteSpace = "nowrap";
      probeHost.style.margin = "0";
      probeHost.style.padding = "0";
      const probeInner = document.createElement("div");
      probeInner.style.display = "inline-block";
      probeInner.style.margin = "0";
      probeInner.style.padding = "0";
      probeInner.style.lineHeight = "1.15";
      probeInner.innerHTML = renderRoot;
      probeHost.appendChild(probeInner);
      document.body.appendChild(probeHost);
      const rect = probeInner.getBoundingClientRect();
      probeHost.remove();
      if (rect.width > 1 && rect.height > 1) {
        width = Math.max(34, Math.min(360, Math.ceil(rect.width) + padX * 2));
        height = Math.max(30, Math.min(140, Math.ceil(rect.height) + padY * 2));
      }
    } catch {
      // Keep fallback size when DOM measurement fails.
    }

    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<foreignObject x="0" y="0" width="${width}" height="${height}">`,
      `<div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;align-items:center;justify-content:center;width:${width}px;height:${height}px;background:rgba(39,54,84,0.98);color:rgba(247,250,255,0.99);font-family:'STIX Two Math','Cambria Math','Latin Modern Math','Times New Roman',serif;padding:${padY}px ${padX}px;box-sizing:border-box;overflow:hidden;">`,
      renderRoot,
      `</div>`,
      `</foreignObject>`,
      `</svg>`,
    ].join("");
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}#tex64-math`;
    const escaped = dataUrl.replace(/"/g, "&quot;");
    return `<div class="tex64-hover-preview tex64-hover-preview-math" data-tex64-preview="math"><img src="${escaped}" alt="" /></div>`;
  } catch {
    return null;
  }
};

const buildImagePreviewHtml = (dataUrl: string) => {
  const withMarker = dataUrl.includes("#tex64-image") ? dataUrl : `${dataUrl}#tex64-image`;
  const escaped = withMarker.replace(/"/g, "&quot;");
  return `<div class="tex64-hover-preview tex64-hover-preview-image" data-tex64-preview="image"><img src="${escaped}" alt="" /></div>`;
};

const createHtmlHoverContent = (html: string) =>
  ({
    value: html,
    supportHtml: true,
    isTrusted: true,
  }) as any;

const extractBibEntryText = (text: string, citeKey: string) => {
  if (!text || !citeKey) {
    return null;
  }
  const escaped = escapeRegExp(citeKey.trim());
  const headerRegex = new RegExp(`@\\w+\\s*\\{\\s*${escaped}\\s*,`, "i");
  const match = headerRegex.exec(text);
  if (!match || typeof match.index !== "number") {
    return null;
  }
  const openBraceIndex = text.indexOf("{", match.index);
  if (openBraceIndex < 0) {
    return null;
  }
  let depth = 0;
  let endIndex = -1;
  for (let i = openBraceIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        endIndex = i;
        break;
      }
    }
  }
  if (endIndex < 0) {
    return null;
  }
  return text.slice(match.index, endIndex + 1);
};

const parseBibFields = (entryText: string) => {
  const fields: Record<string, string> = {};
  if (!entryText) {
    return fields;
  }
  const firstComma = entryText.indexOf(",");
  if (firstComma < 0) {
    return fields;
  }
  let i = firstComma + 1;
  const len = entryText.length;
  const skipSpace = () => {
    while (i < len && /[\s,]/.test(entryText[i])) {
      i += 1;
    }
  };
  const readName = () => {
    const start = i;
    while (i < len && /[A-Za-z]/.test(entryText[i])) {
      i += 1;
    }
    return entryText.slice(start, i);
  };
  const readValue = () => {
    skipSpace();
    if (i >= len) {
      return "";
    }
    const ch = entryText[i];
    if (ch === "{") {
      i += 1;
      let depth = 1;
      const start = i;
      while (i < len && depth > 0) {
        const c = entryText[i];
        if (c === "{") {
          depth += 1;
        } else if (c === "}") {
          depth -= 1;
        }
        i += 1;
      }
      const raw = entryText.slice(start, Math.max(start, i - 1));
      return raw;
    }
    if (ch === "\"") {
      i += 1;
      const start = i;
      while (i < len) {
        const c = entryText[i];
        if (c === "\\" && i + 1 < len) {
          i += 2;
          continue;
        }
        if (c === "\"") {
          break;
        }
        i += 1;
      }
      const raw = entryText.slice(start, i);
      if (entryText[i] === "\"") {
        i += 1;
      }
      return raw;
    }
    const start = i;
    while (i < len && entryText[i] !== "," && entryText[i] !== "\n") {
      i += 1;
    }
    return entryText.slice(start, i);
  };
  while (i < len) {
    skipSpace();
    const name = readName();
    if (!name) {
      break;
    }
    skipSpace();
    if (entryText[i] !== "=") {
      break;
    }
    i += 1;
    const value = readValue()
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^{|}$/g, "")
      .trim();
    if (value) {
      fields[name.toLowerCase()] = value;
    }
    skipSpace();
    if (entryText[i] === ",") {
      i += 1;
    }
  }
  return fields;
};

const resolveGraphicsCandidates = (
  activeFilePath: string,
  rawPath: string,
  workspaceFiles: string[]
) => {
  const normalizePosixPath = (value: string) => {
    const parts = value.split("/").filter(Boolean);
    const stack = [];
    for (const part of parts) {
      if (part === ".") {
        continue;
      }
      if (part === "..") {
        if (stack.length > 0 && stack[stack.length - 1] !== "..") {
          stack.pop();
        } else {
          stack.push("..");
        }
        continue;
      }
      stack.push(part);
    }
    return stack.join("/");
  };

  const normalized = rawPath.trim().split("\\").join("/");
  if (!normalized) {
    return [];
  }
  const activeDir = activeFilePath.split("\\").join("/").split("/").slice(0, -1).join("/");
  const base = normalized.startsWith("/") ? normalized.replace(/^\/+/, "") : normalized;
  const resolved = normalizePosixPath(activeDir ? `${activeDir}/${base}` : base);
  const hasExt = (resolved.split("/").pop() ?? "").includes(".");
  const allowedExts = ["png", "jpg", "jpeg", "pdf", "svg", "eps", "tif", "tiff"];
  const candidates = [];
  if (hasExt) {
    candidates.push(resolved);
  } else {
    candidates.push(resolved);
    allowedExts.forEach((ext) => candidates.push(`${resolved}.${ext}`));
  }
  const workspaceSet = new Set(workspaceFiles.map((p) => p.split("\\").join("/")));
  return candidates.filter((candidate) => workspaceSet.has(candidate));
};

const resolveTexIncludeCandidates = (
  activeFilePath: string,
  rawPath: string,
  workspaceFiles: string[]
) => {
  const normalizePosixPath = (value: string) => {
    const parts = value.split("/").filter(Boolean);
    const stack = [];
    for (const part of parts) {
      if (part === ".") {
        continue;
      }
      if (part === "..") {
        if (stack.length > 0 && stack[stack.length - 1] !== "..") {
          stack.pop();
        } else {
          stack.push("..");
        }
        continue;
      }
      stack.push(part);
    }
    return stack.join("/");
  };

  const normalized = rawPath.trim().split("\\").join("/");
  if (!normalized) {
    return [];
  }
  const activeDir = activeFilePath.split("\\").join("/").split("/").slice(0, -1).join("/");
  const base = normalized.startsWith("/") ? normalized.replace(/^\/+/, "") : normalized;
  const resolved = normalizePosixPath(activeDir ? `${activeDir}/${base}` : base);
  const hasExt = (resolved.split("/").pop() ?? "").includes(".");
  const candidates = hasExt ? [resolved] : [resolved, `${resolved}.tex`];
  const workspaceSet = new Set(workspaceFiles.map((p) => p.split("\\").join("/")));
  return candidates.filter((candidate) => workspaceSet.has(candidate));
};

const isPreviewableImagePath = (pathValue: string) => {
  const ext = (pathValue.split("/").pop() ?? "").split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "tif", "tiff", "ico"].includes(ext);
};

export const registerHoverProvider = (
  monaco: {
    languages?: {
      [key: string]: unknown;
      registerHoverProvider?: (
        languageId: string,
        provider: {
          provideHover: (
            model: {
              getLineContent: (lineNumber: number) => string;
              getLineCount?: () => number;
            },
            position: { lineNumber: number; column: number }
          ) => unknown;
        }
      ) => void;
    };
    Range?: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
  },
  deps: {
    getActiveFilePath: () => string | null;
    getWorkspaceFiles: () => string[];
    getIndexLabels: () => IndexEntry[];
    getIndexCitations: () => IndexEntry[];
    requestFilePreview?: (
      path: string
    ) => Promise<FilePreviewResult>;
    requestFileExcerpt?: (
      path: string,
      line: number,
      options?: { radius?: number; maxLines?: number }
    ) => Promise<FileExcerptResult>;
  },
  state: HoverState
) => {
  if (state.registered || typeof monaco.languages?.registerHoverProvider !== "function") {
    return;
  }

  const hoverResultCache = new Map<string, unknown>();
  const previewRequestCache = new Map<string, Promise<FilePreviewResult>>();
  const MAX_HOVER_CACHE_SIZE = 512;

  const rememberHoverResult = <T>(key: string, value: T): T => {
    hoverResultCache.set(key, value as unknown);
    if (hoverResultCache.size > MAX_HOVER_CACHE_SIZE) {
      const firstKey = hoverResultCache.keys().next().value;
      if (typeof firstKey === "string") {
        hoverResultCache.delete(firstKey);
      }
    }
    return value;
  };

  const getCachedHoverResult = (key: string) => (hoverResultCache.has(key) ? hoverResultCache.get(key) : null);

  const buildHoverTokenKey = (payload: {
    activePath: string;
    lineNumber: number;
    endLineNumber?: number;
    startIndex: number;
    endIndex: number;
    kind: string;
    extra?: string;
  }) =>
    [
      payload.activePath,
      String(payload.lineNumber),
      String(payload.endLineNumber ?? payload.lineNumber),
      `${payload.startIndex}:${payload.endIndex}`,
      payload.kind,
      payload.extra ?? "",
    ].join("|");

  const createAnchorRange = (
    lineNumber: number,
    startIndex: number,
    endIndex?: number,
    endLineNumber?: number
  ) => {
    if (!monaco.Range) {
      return undefined;
    }
    const startColumn = Math.max(1, startIndex + 1);
    const endColumn = Math.max(startColumn + 1, (typeof endIndex === "number" ? endIndex : startIndex + 1) + 1);
    const safeEndLine = Number.isFinite(endLineNumber)
      ? Math.max(lineNumber, Math.floor(endLineNumber ?? lineNumber))
      : lineNumber;
    return new monaco.Range(lineNumber, startColumn, safeEndLine, endColumn);
  };

  const getOrCreatePreviewRequest = (path: string) => {
    const cached = previewRequestCache.get(path);
    if (cached) {
      return cached;
    }
    const requestPreview = deps.requestFilePreview;
    if (typeof requestPreview !== "function") {
      return Promise.resolve({ ok: false, error: "preview unavailable" } as FilePreviewResult);
    }
    const pending = requestPreview(path)
      .then((result) => {
        if (!(result?.ok && typeof result.dataUrl === "string" && result.dataUrl)) {
          previewRequestCache.delete(path);
        }
        return result;
      })
      .catch((error) => {
        previewRequestCache.delete(path);
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error ?? "preview failed"),
        } as FilePreviewResult;
      });
    previewRequestCache.set(path, pending);
    return pending;
  };

  const provideHover = (
    model: { getLineContent: (lineNumber: number) => string; getLineCount?: () => number },
    position: { lineNumber: number; column: number }
  ) => {
    const activePath = deps.getActiveFilePath();
    if (!activePath || !activePath.endsWith(".tex")) {
      return null;
    }
    const line = model.getLineContent(position.lineNumber);
    const cursorIndex = getCursorIndex(position);
    const commentIndex = findFirstUnescapedPercent(line);
    if (commentIndex >= 0 && cursorIndex >= commentIndex) {
      return null;
    }
    const effectiveLine = commentIndex >= 0 ? line.slice(0, commentIndex) : line;

    const mathMatch = findMathAt(model, position, effectiveLine, cursorIndex);
    if (mathMatch) {
      const tokenKey = buildHoverTokenKey({
        activePath,
        lineNumber: mathMatch.startLineNumber,
        endLineNumber: mathMatch.endLineNumber,
        startIndex: mathMatch.startIndex,
        endIndex: mathMatch.endIndex,
        kind: "math",
        extra: mathMatch.latex.slice(0, 180),
      });
      rememberStableHoverAnchor({
        filePath: activePath,
        startLineNumber: mathMatch.startLineNumber,
        endLineNumber: mathMatch.endLineNumber,
        startIndex: mathMatch.startIndex,
        endIndex: mathMatch.endIndex,
        tokenKey,
      });
      const cached = getCachedHoverResult(tokenKey);
      if (cached) {
        return cached;
      }
      const html = buildMathPreviewHtml(mathMatch.latex);
      if (!html) {
        return null;
      }
      const range = createAnchorRange(
        mathMatch.startLineNumber,
        mathMatch.startIndex,
        mathMatch.endIndex,
        mathMatch.endLineNumber
      );
      return rememberHoverResult(tokenKey, {
        contents: [createHtmlHoverContent(html)],
        range,
      });
    }

    const packageMatch = findCommandMatchAt(
      effectiveLine,
      cursorIndex,
      /\\(usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]+)\}/g,
      extractPackageKey
    );
    if (packageMatch) {
      const tokenKey = buildHoverTokenKey({
        activePath,
        lineNumber: position.lineNumber,
        startIndex: packageMatch.startIndex,
        endIndex: packageMatch.endIndex,
        kind: packageMatch.command,
        extra: packageMatch.key,
      });
      rememberStableHoverAnchor({
        filePath: activePath,
        startLineNumber: position.lineNumber,
        startIndex: packageMatch.startIndex,
        endIndex: packageMatch.endIndex,
        tokenKey,
      });
      const cached = getCachedHoverResult(tokenKey);
      if (cached) {
        return cached;
      }
      const packageCommand = packageMatch.command === "RequirePackage" ? "RequirePackage" : "usepackage";
      const value = buildPackageHoverMarkdown(packageMatch.key, packageCommand);
      if (!value) {
        return null;
      }
      const range = createAnchorRange(position.lineNumber, packageMatch.startIndex, packageMatch.endIndex);
      return rememberHoverResult(tokenKey, { contents: [{ value }], range });
    }

    const classMatch = findCommandMatchAt(
      effectiveLine,
      cursorIndex,
      /\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/g,
      extractDocumentClassKey
    );
    if (classMatch) {
      const tokenKey = buildHoverTokenKey({
        activePath,
        lineNumber: position.lineNumber,
        startIndex: classMatch.startIndex,
        endIndex: classMatch.endIndex,
        kind: "documentclass",
        extra: classMatch.key,
      });
      rememberStableHoverAnchor({
        filePath: activePath,
        startLineNumber: position.lineNumber,
        startIndex: classMatch.startIndex,
        endIndex: classMatch.endIndex,
        tokenKey,
      });
      const cached = getCachedHoverResult(tokenKey);
      if (cached) {
        return cached;
      }
      const value = buildPackageHoverMarkdown(classMatch.key, "documentclass");
      if (!value) {
        return null;
      }
      const range = createAnchorRange(position.lineNumber, classMatch.startIndex, classMatch.endIndex);
      return rememberHoverResult(tokenKey, { contents: [{ value }], range });
    }

    const refMatch = findCommandMatchAt(
      effectiveLine,
      cursorIndex,
      /\\(eqref|ref|pageref|autoref|cref|Cref|namecref|Namecref|nameref|Nameref)\{([^}]+)\}/g,
      extractSingleKey
    );
    if (refMatch) {
      const tokenKey = buildHoverTokenKey({
        activePath,
        lineNumber: position.lineNumber,
        startIndex: refMatch.startIndex,
        endIndex: refMatch.endIndex,
        kind: refMatch.command,
        extra: refMatch.key,
      });
      rememberStableHoverAnchor({
        filePath: activePath,
        startLineNumber: position.lineNumber,
        startIndex: refMatch.startIndex,
        endIndex: refMatch.endIndex,
        tokenKey,
      });
      const cached = getCachedHoverResult(tokenKey);
      if (cached) {
        return cached;
      }
      const entries = deps.getIndexLabels().filter((entry) => entry.key === refMatch.key);
      const seen = new Set<string>();
      const deduped = entries
        .filter((entry) => {
          const token = `${entry.path}:${entry.line}`;
          if (seen.has(token)) {
            return false;
          }
          seen.add(token);
          return true;
        })
        .sort((a, b) => {
          if (a.path !== b.path) {
            return a.path.localeCompare(b.path, "ja");
          }
          return a.line - b.line;
        });
      const primary = deduped.length > 0 ? deduped[0] : null;
      const range = createAnchorRange(position.lineNumber, refMatch.startIndex, refMatch.endIndex);
      if (!primary) {
        return null;
      }

      if (
        typeof deps.requestFileExcerpt === "function" &&
        typeof primary.path === "string" &&
        Number.isFinite(primary.line)
      ) {
        const pending = deps
          .requestFileExcerpt(primary.path, primary.line, { radius: 48, maxLines: 220 })
          .then((excerpt) => {
            const contents: any[] = [{ value: `\`${primary.path}:${primary.line}\`` }];
            const snippet = excerpt?.ok && Array.isArray((excerpt as any).lines)
              ? (() => {
                  const slice = sliceExcerptAroundLine({
                    startLine: (excerpt as any).startLine ?? primary.line,
                    lines: (excerpt as any).lines,
                    targetLine: primary.line,
                    radius: 1,
                    maxLines: 4,
                  });
                  return renderExcerpt({
                    startLine: slice.startLine,
                    lines: slice.lines,
                    highlightLine: primary.line,
                  });
                })()
              : null;
            if (snippet) {
              contents.push({ value: snippet });
            }
            return { contents, range };
          });
        return rememberHoverResult(tokenKey, pending);
      }

      return rememberHoverResult(tokenKey, {
        contents: [{ value: `\`${primary.path}:${primary.line}\`` }],
        range,
      });
    }

    const citeMatch = findCommandMatchAt(
      effectiveLine,
      cursorIndex,
      /\\(cite|citet|citep|citeauthor|citeyear|autocite|parencite|textcite|footcite|supercite)(?:\[[^\]]*\])*\{([^}]+)\}/g,
      extractCiteKey
    );
    if (citeMatch) {
      const tokenKey = buildHoverTokenKey({
        activePath,
        lineNumber: position.lineNumber,
        startIndex: citeMatch.startIndex,
        endIndex: citeMatch.endIndex,
        kind: citeMatch.command,
        extra: citeMatch.key,
      });
      rememberStableHoverAnchor({
        filePath: activePath,
        startLineNumber: position.lineNumber,
        startIndex: citeMatch.startIndex,
        endIndex: citeMatch.endIndex,
        tokenKey,
      });
      const cached = getCachedHoverResult(tokenKey);
      if (cached) {
        return cached;
      }
      const entries = pickCitationEntries(deps.getIndexCitations()).filter(
        (entry) => entry.key === citeMatch.key
      );
      const primary = entries.length > 0 ? entries[0] : null;
      const range = createAnchorRange(position.lineNumber, citeMatch.startIndex, citeMatch.endIndex);
      if (!primary) {
        return null;
      }

      if (
        typeof deps.requestFileExcerpt === "function" &&
        typeof primary.path === "string" &&
        primary.path.endsWith(".bib") &&
        Number.isFinite(primary.line)
      ) {
        const pending = deps
          .requestFileExcerpt(primary.path, primary.line, { radius: 120, maxLines: 260 })
          .then((excerpt) => {
            const excerptLines = excerpt?.ok ? (excerpt as any).lines : null;
            const startLine = excerpt?.ok ? (excerpt as any).startLine : null;
            const text =
              excerpt?.ok && Array.isArray(excerptLines) ? excerptLines.join("\n") : "";
            const entryText = extractBibEntryText(text, citeMatch.key);
            const fields = entryText ? parseBibFields(entryText) : {};
            const title = fields.title || "";
            const author = fields.author || "";
            const year = fields.year || "";
            const where =
              typeof primary.path === "string" && Number.isFinite(primary.line)
                ? `\`${primary.path}:${primary.line}\``
                : "";
            const summaryParts = [title, author, year].filter(Boolean);

            const contents: any[] = [];
            if (where) contents.push({ value: where });
            if (summaryParts.length > 0) {
              contents.push({ value: summaryParts.join("\n") });
            }
            if (contents.length === 0) {
              return null;
            }
            return { contents, range };
          });
        return rememberHoverResult(tokenKey, pending);
      }

      return rememberHoverResult(tokenKey, {
        contents: [{ value: `\`${primary.path}:${primary.line}\`` }],
        range,
      });
    }

    const graphicsHit = findCommandMatchAt(
      effectiveLine,
      cursorIndex,
      /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g,
      (match, cursorIdx) => {
        const content = match[1] ?? "";
        const braceIndex = match[0].indexOf("{");
        if (braceIndex < 0 || typeof match.index !== "number") {
          return null;
        }
        const contentStart = match.index + braceIndex + 1;
        const contentEnd = contentStart + content.length;
        if (cursorIdx < contentStart || cursorIdx > contentEnd) {
          return null;
        }
        const trimmed = content.trim();
        if (!trimmed) {
          return null;
        }
        const leading = content.match(/^\s*/)?.[0]?.length ?? 0;
        return {
          command: "includegraphics",
          key: trimmed,
          startIndex: contentStart + leading,
          endIndex: contentStart + leading + trimmed.length,
        };
      }
    );
    if (graphicsHit) {
      const tokenKey = buildHoverTokenKey({
        activePath,
        lineNumber: position.lineNumber,
        startIndex: graphicsHit.startIndex,
        endIndex: graphicsHit.endIndex,
        kind: "includegraphics",
        extra: graphicsHit.key,
      });
      rememberStableHoverAnchor({
        filePath: activePath,
        startLineNumber: position.lineNumber,
        startIndex: graphicsHit.startIndex,
        endIndex: graphicsHit.endIndex,
        tokenKey,
      });
      const cached = getCachedHoverResult(tokenKey);
      if (cached) {
        return cached;
      }
      const candidates = resolveGraphicsCandidates(
        activePath,
        graphicsHit.key,
        deps.getWorkspaceFiles()
      );
      if (candidates.length === 0) {
        return null;
      }
      const range = createAnchorRange(position.lineNumber, graphicsHit.startIndex, graphicsHit.endIndex);
      const value = candidates.map((p) => `- ${p}`).join("\n");

      const previewTarget =
        candidates.find((path) => isPreviewableImagePath(path)) ?? null;
      if (previewTarget) {
        const pending = getOrCreatePreviewRequest(previewTarget).then((preview) => {
          if (preview?.ok && typeof preview.dataUrl === "string" && preview.dataUrl) {
            return {
              contents: [createHtmlHoverContent(buildImagePreviewHtml(preview.dataUrl))],
              range,
            } as any;
          }
          hoverResultCache.delete(tokenKey);
          return {
            contents: [{ value }],
            range,
          };
        });
        return rememberHoverResult(tokenKey, pending);
      }

      return rememberHoverResult(tokenKey, {
        contents: [{ value }],
        range,
      });
    }

    const includeHit = findCommandMatchAt(
      effectiveLine,
      cursorIndex,
      /\\(input|include)\{([^}]+)\}/g,
      extractSingleKey
    );
    if (includeHit) {
      const tokenKey = buildHoverTokenKey({
        activePath,
        lineNumber: position.lineNumber,
        startIndex: includeHit.startIndex,
        endIndex: includeHit.endIndex,
        kind: includeHit.command || "include",
        extra: includeHit.key,
      });
      rememberStableHoverAnchor({
        filePath: activePath,
        startLineNumber: position.lineNumber,
        startIndex: includeHit.startIndex,
        endIndex: includeHit.endIndex,
        tokenKey,
      });
      const cached = getCachedHoverResult(tokenKey);
      if (cached) {
        return cached;
      }
      const candidates = resolveTexIncludeCandidates(activePath, includeHit.key, deps.getWorkspaceFiles());
      if (candidates.length === 0) {
        return null;
      }
      const previewPath = candidates[0] ?? "";
      const range = createAnchorRange(position.lineNumber, includeHit.startIndex, includeHit.endIndex);
      const locations = candidates.map((p) => `- ${p}`).join("\n");

      if (candidates.length > 0 && typeof deps.requestFileExcerpt === "function") {
        const pending = deps.requestFileExcerpt(previewPath, 1, { radius: 8, maxLines: 18 }).then((excerpt) => {
          const contents: any[] = [{ value: `\`${previewPath}:1\`` }];
          if (excerpt?.ok && Array.isArray((excerpt as any).lines)) {
            const slice = sliceExcerptAroundLine({
              startLine: (excerpt as any).startLine ?? 1,
              lines: (excerpt as any).lines,
              targetLine: 1,
              radius: 1,
              maxLines: 4,
            });
            contents.push({
              value: renderExcerpt({
                startLine: slice.startLine,
                lines: slice.lines,
                highlightLine: 1,
              }),
            });
          }
          return { contents, range };
        });
        return rememberHoverResult(tokenKey, pending);
      }

      return rememberHoverResult(tokenKey, {
        contents: [{ value: locations }],
        range,
      });
    }

    return null;
  };

  ["latex", "plaintext"].forEach((languageId) => {
    monaco.languages?.registerHoverProvider?.(languageId, { provideHover });
  });

  state.registered = true;
};

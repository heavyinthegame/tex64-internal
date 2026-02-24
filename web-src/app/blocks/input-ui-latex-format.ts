const ALIGNED_ENV_BEGIN = "\\begin{aligned}";
const ALIGNED_ENV_END = "\\end{aligned}";

const isEscapedAt = (text: string, index: number) => {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    count += 1;
  }
  return count % 2 === 1;
};

const hasUnescapedAmpersand = (text: string) => {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "&" && !isEscapedAt(text, i)) {
      return true;
    }
  }
  return false;
};

const hasLineBreak = (text: string) => {
  for (let i = 0; i < text.length - 1; i += 1) {
    if (text[i] === "\\" && text[i + 1] === "\\" && !isEscapedAt(text, i)) {
      return true;
    }
  }
  return false;
};

export const shouldWrapAligned = (text: string) => {
  if (!text) {
    return false;
  }
  if (text.includes("\\begin{") || text.includes("\\end{")) {
    return false;
  }
  return hasUnescapedAmpersand(text) || hasLineBreak(text);
};

export const wrapAligned = (text: string) => `${ALIGNED_ENV_BEGIN}\n${text}\n${ALIGNED_ENV_END}`;

export const unwrapAligned = (text: string) => {
  const start = text.indexOf(ALIGNED_ENV_BEGIN);
  const end = text.lastIndexOf(ALIGNED_ENV_END);
  if (start === -1 || end === -1) {
    return { value: text, didUnwrap: false };
  }
  const before = text.slice(0, start).trim();
  const after = text.slice(end + ALIGNED_ENV_END.length).trim();
  if (before || after) {
    return { value: text, didUnwrap: false };
  }
  let inner = text.slice(start + ALIGNED_ENV_BEGIN.length, end);
  if (inner.startsWith("\n")) {
    inner = inner.slice(1);
  }
  if (inner.endsWith("\n")) {
    inner = inner.slice(0, -1);
  }
  return { value: inner, didUnwrap: true };
};

const splitAlignedRows = (text: string) => {
  const rows: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && text[i + 1] === "\\" && !isEscapedAt(text, i)) {
      rows.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += text[i];
  }
  rows.push(current);
  return rows;
};

const isEmptyAlignedRow = (row: string) => {
  const cleaned = row.replace(/\\placeholder\{\}/g, "").replace(/\s+/g, "");
  return cleaned === "" || cleaned === "&";
};

export const stripEmptyAlignedRows = (text: string) => {
  const rows = splitAlignedRows(text);
  if (rows.length <= 1) {
    return text;
  }
  const hasNonEmpty = rows.some((row) => !isEmptyAlignedRow(row));
  return hasNonEmpty ? text : "";
};

export const normalizeMatrixSyntax = (value: string) => {
  if (!value) {
    return value;
  }
  const isEscapedAt = (text: string, index: number) => {
    let slashCount = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
      slashCount += 1;
    }
    return slashCount % 2 === 1;
  };
  const parseTopLevelBracedCells = (body: string) => {
    const cells: string[] = [];
    let i = 0;
    while (i < body.length) {
      while (i < body.length && /\s/.test(body[i] ?? "")) {
        i += 1;
      }
      if (i >= body.length) {
        break;
      }
      if (body[i] !== "{" || isEscapedAt(body, i)) {
        return null;
      }
      const start = i + 1;
      let depth = 0;
      let closed = false;
      for (; i < body.length; i += 1) {
        const ch = body[i];
        if (ch === "{" && !isEscapedAt(body, i)) {
          depth += 1;
          continue;
        }
        if (ch === "}" && !isEscapedAt(body, i)) {
          depth -= 1;
          if (depth === 0) {
            cells.push(body.slice(start, i).trim());
            i += 1;
            closed = true;
            break;
          }
        }
      }
      if (!closed) {
        return null;
      }
    }
    return cells;
  };
  const inferMatrixShape = (cellCount: number) => {
    if (!Number.isFinite(cellCount) || cellCount < 4) {
      return null;
    }
    let bestRows = 0;
    let bestCols = 0;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (let rows = 2; rows * rows <= cellCount; rows += 1) {
      if (cellCount % rows !== 0) {
        continue;
      }
      const cols = cellCount / rows;
      if (cols < 2) {
        continue;
      }
      const diff = Math.abs(cols - rows);
      if (diff < bestDiff) {
        bestRows = rows;
        bestCols = cols;
        bestDiff = diff;
      }
    }
    if (bestRows > 0 && bestCols > 0) {
      return { rows: bestRows, cols: bestCols };
    }
    return null;
  };
  return value.replace(
    /\\begin\{(matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix)\}([\s\S]*?)\\end\{\1\}/g,
    (match, env: string, body: string) => {
      if (body.includes("&") || body.includes("\\\\")) {
        return match;
      }
      const cells = parseTopLevelBracedCells(body);
      if (!cells || cells.length <= 1) {
        return match;
      }
      const filtered = cells.filter((cell) => cell.length > 0);
      if (filtered.length !== cells.length) {
        return match;
      }
      const shape = inferMatrixShape(filtered.length);
      if (!shape) {
        return match;
      }
      const rows: string[] = [];
      for (let r = 0; r < shape.rows; r += 1) {
        const row = filtered.slice(r * shape.cols, (r + 1) * shape.cols);
        rows.push(row.join("&"));
      }
      return `\\begin{${env}}${rows.join("\\\\")}\\end{${env}}`;
    }
  );
};

const restoreAlignedMarkerEnvs = (value: string) =>
  value.replace(/\\begin\{aligned\}([\s\S]*?)\\end\{aligned\}/g, (match, body: string) => {
    if (body.includes("\\txalnat")) {
      const cleaned = body.replace(/\\txalnat/g, "").trim();
      return `\\begin{alignat*}{2}${cleaned}\\end{alignat*}`;
    }
    if (body.includes("\\txflaln")) {
      const cleaned = body.replace(/\\txflaln/g, "").trim();
      return `\\begin{flalign*}${cleaned}\\end{flalign*}`;
    }
    if (body.includes("\\txarrcf")) {
      const cleaned = body.replace(/\\txarrcf/g, "").trim();
      return `\\begin{array}{@{}>r<{}c@{|}l<{}@{}}${cleaned}\\end{array}`;
    }
    return match;
  });

const isEscapedAtFormat = (text: string, index: number) => {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
};

const findBalancedBraceEndFormat = (text: string, start: number) => {
  if (text[start] !== "{") {
    return -1;
  }
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{" && !isEscapedAtFormat(text, i)) {
      depth += 1;
      continue;
    }
    if (ch === "}" && !isEscapedAtFormat(text, i)) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
};

const replaceCommandWithBraceArgs = (
  value: string,
  command: string,
  argCount: number,
  mapper: (args: string[]) => string
) => {
  const needle = `\\${command}`;
  if (!value.includes(needle)) {
    return value;
  }
  let output = "";
  for (let i = 0; i < value.length; ) {
    if (!value.startsWith(needle, i)) {
      output += value[i];
      i += 1;
      continue;
    }
    let cursor = i + needle.length;
    const args: string[] = [];
    let ok = true;
    for (let argIndex = 0; argIndex < argCount; argIndex += 1) {
      while (cursor < value.length && /\s/.test(value[cursor] ?? "")) {
        cursor += 1;
      }
      if (value[cursor] !== "{") {
        ok = false;
        break;
      }
      const end = findBalancedBraceEndFormat(value, cursor);
      if (end < 0) {
        ok = false;
        break;
      }
      args.push(value.slice(cursor + 1, end));
      cursor = end + 1;
    }
    if (!ok) {
      output += value[i];
      i += 1;
      continue;
    }
    output += mapper(args);
    i = cursor;
  }
  return output;
};

const restoreArrayMarkerEnvs = (value: string) =>
  replaceCommandWithBraceArgs(value, "txarrayc", 2, (args) => {
    const colspec = args[0] ?? "";
    const body = args[1] ?? "";
    return `\\begin{array}{${colspec}}${body}\\end{array}`;
  });

const restoreAlignatBegin = (value: string) => {
  const endMatches = [...value.matchAll(/\\end\{(alignat\*?)\}/g)];
  if (endMatches.length === 0) {
    return value;
  }
  const endMatch = endMatches[endMatches.length - 1];
  const env = endMatch[1];
  const endToken = endMatch[0];
  const endIndex = endMatch.index ?? value.length;
  const beforeEnd = value.slice(0, endIndex);
  if (new RegExp(`\\\\begin\\{${env.replace("*", "\\*")}\\}`).test(beforeEnd)) {
    return value;
  }
  let body = beforeEnd.trim();
  let colspec = "{2}";
  const colspecMatch = body.match(/^\{(\d+)\}/);
  if (colspecMatch) {
    colspec = `{${colspecMatch[1]}}`;
    body = body.slice(colspecMatch[0].length).trim();
  }
  const trailing = value.slice(endIndex + endToken.length);
  return `\\begin{${env}}${colspec}${body}\\end{${env}}${trailing}`;
};

const restoreFlalignBegin = (value: string) => {
  const endMatches = [...value.matchAll(/\\end\{(flalign\*?)\}/g)];
  if (endMatches.length === 0) {
    return value;
  }
  const endMatch = endMatches[endMatches.length - 1];
  const env = endMatch[1];
  const endToken = endMatch[0];
  const endIndex = endMatch.index ?? value.length;
  const beforeEnd = value.slice(0, endIndex);
  if (new RegExp(`\\\\begin\\{${env.replace("*", "\\*")}\\}`).test(beforeEnd)) {
    return value;
  }
  const body = beforeEnd.trim();
  const trailing = value.slice(endIndex + endToken.length);
  return `\\begin{${env}}${body}\\end{${env}}${trailing}`;
};

export const restoreUnsupportedEnvBegins = (value: string) => {
  if (!value) {
    return value;
  }
  const restoredProxy = restoreAlignedMarkerEnvs(restoreArrayMarkerEnvs(value));
  return restoreFlalignBegin(restoreAlignatBegin(restoredProxy));
};

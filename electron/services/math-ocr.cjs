const path = require("path");
const fsp = require("fs/promises");

const DEFAULT_CONFIG = {
  encoder: "encoder.onnx",
  decoder: "decoder.onnx",
  tokenizer: "tokenizer.json",
  encoderInput: "pixel_values",
  encoderOutput: "last_hidden_state",
  decoderInputTokens: "input_ids",
  decoderInputContext: "encoder_hidden_states",
  decoderOutput: "logits",
  bosToken: 1,
  eosToken: 2,
  padToken: 0,
  decoderStartToken: 2,
  maxSeqLen: 512,
  decodeStrategy: "greedy",
  filterThres: 0.9,
  topP: 0.9,
  temperature: 1.0,
  channels: 3,
};

const FALLBACK_MIN_CONFIDENCE = 70;
const PIX2TEX_EARLY_ACCEPT_SCORE = 90;
const FALLBACK_EARLY_ACCEPT_CONFIDENCE = 88;
const MAX_DECODE_CANDIDATES = 8;
const MAX_FALLBACK_IMAGE_CANDIDATES = 6;

const buildIdToToken = (tokenizer) => {
  const vocab = tokenizer?.model?.vocab ?? tokenizer?.vocab ?? {};
  const idToToken = [];
  Object.entries(vocab).forEach(([token, id]) => {
    const index = Number(id);
    if (!Number.isNaN(index)) {
      idToToken[index] = token;
    }
  });
  return idToToken;
};

const decodeTokens = (tokens, idToToken) => {
  const text = tokens.map((id) => idToToken[id] ?? "").join("");
  return text
    .replace(/<pad>|<s>|<\/s>|<unk>|<mask>/g, "")
    .replace(/Ġ/g, " ")
    .replace(/▁/g, " ")
    .trim();
};

const postProcessLatex = (value) => {
  if (!value) return "";
  const textReg = /(\\(?:operatorname|mathrm|text|mathbf)\s?\*? {.*?})/g;
  const matches = Array.from(value.matchAll(textReg)).map((match) =>
    match[1].replace(/ /g, "")
  );
  let result = value.replace(textReg, () => matches.shift() ?? "");
  const letter = "[a-zA-Z]";
  const noletter = "[\\W_\\^\\d]";
  while (true) {
    const prev = result;
    result = result.replace(
      new RegExp(`(?!\\\\ )(${noletter})\\s+?(${noletter})`, "g"),
      "$1$2"
    );
    result = result.replace(
      new RegExp(`(?!\\\\ )(${noletter})\\s+?(${letter})`, "g"),
      "$1$2"
    );
    result = result.replace(
      new RegExp(`(${letter})\\s+?(${noletter})`, "g"),
      "$1$2"
    );
    if (result === prev) {
      break;
    }
  }
  return result;
};

const fixMatrixSeparators = (value) => {
  if (!value) return value;
  return value.replace(
    /\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}/g,
    (match, body) => {
      if (body.includes("&") || body.includes("\\\\")) {
        return match;
      }
      const cells = [];
      let i = 0;
      let valid = true;
      while (i < body.length) {
        const ch = body[i];
        if (ch === "{") {
          let depth = 0;
          const start = i + 1;
          for (; i < body.length; i += 1) {
            const inner = body[i];
            if (inner === "{") depth += 1;
            if (inner === "}") {
              depth -= 1;
              if (depth === 0) {
                cells.push(body.slice(start, i).trim());
                i += 1;
                break;
              }
            }
          }
          if (depth !== 0) {
            valid = false;
            break;
          }
          continue;
        }
        if (!/\s/.test(ch)) {
          const start = i;
          while (i < body.length && !/\s/.test(body[i])) {
            i += 1;
          }
          cells.push(body.slice(start, i).trim());
          continue;
        }
        i += 1;
      }
      if (!valid) {
        return match;
      }
      const filtered = cells.filter((cell) => cell.length > 0);
      if (filtered.length === 0) {
        return match;
      }
      const size = Math.sqrt(filtered.length);
      const n = Math.round(size);
      if (!Number.isFinite(size) || n * n !== filtered.length) {
        return match;
      }
      const rows = [];
      for (let r = 0; r < n; r += 1) {
        const row = filtered.slice(r * n, (r + 1) * n);
        rows.push(row.join("&"));
      }
      return `\\begin{matrix}${rows.join("\\\\")}\\end{matrix}`;
    }
  );
};

const splitMatrixRows = (text) => {
  const rows = [];
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && text[i + 1] === "\\") {
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

const stripOuterBraces = (text) => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return trimmed;
  }
  let depth = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0 && i < trimmed.length - 1) {
      return trimmed;
    }
  }
  return trimmed.slice(1, -1).trim();
};

const matrixBodyToBinom = (body) => {
  const rows = splitMatrixRows(body).map((row) => row.trim()).filter(Boolean);
  if (rows.length === 2 && rows.every((row) => !row.includes("&"))) {
    return `\\binom{${stripOuterBraces(rows[0])}}{${stripOuterBraces(rows[1])}}`;
  }
  if (rows.length === 1 && !rows[0].includes("&")) {
    const cells = [];
    let i = 0;
    let valid = true;
    while (i < rows[0].length) {
      const ch = rows[0][i];
      if (ch === "{") {
        let depth = 0;
        const start = i + 1;
        for (; i < rows[0].length; i += 1) {
          const inner = rows[0][i];
          if (inner === "{") depth += 1;
          if (inner === "}") {
            depth -= 1;
            if (depth === 0) {
              cells.push(rows[0].slice(start, i).trim());
              i += 1;
              break;
            }
          }
        }
        if (depth !== 0) {
          valid = false;
          break;
        }
        continue;
      }
      if (!/\s/.test(ch)) {
        const start = i;
        while (i < rows[0].length && !/\s/.test(rows[0][i])) {
          i += 1;
        }
        cells.push(rows[0].slice(start, i).trim());
        continue;
      }
      i += 1;
    }
    if (!valid) {
      return null;
    }
    if (cells.length === 2) {
      return `\\binom{${stripOuterBraces(cells[0])}}{${stripOuterBraces(cells[1])}}`;
    }
  }
  return null;
};

const cleanMatrixBody = (body) => {
  if (!body) return "";
  let cleaned = body;
  cleaned = cleaned.replace(/\{\s*([A-Za-z0-9.+\-*/=]{1,3})\s*\}/g, "$1");
  cleaned = cleaned.replace(/\s+/g, "");
  cleaned = cleaned.replace(/\\\\+$/g, "");
  return cleaned;
};

const parseMatrixShape = (body) => {
  const normalizedBody = cleanMatrixBody(body);
  if (!normalizedBody) {
    return null;
  }
  if (/\\begin\{/.test(normalizedBody) || /\\end\{/.test(normalizedBody)) {
    return null;
  }
  const rows = splitMatrixRows(normalizedBody).map((row) => row.trim()).filter(Boolean);
  if (rows.length < 2) {
    return null;
  }
  const colCounts = rows.map((row) => row.split("&").length);
  const expectedCols = colCounts[0];
  if (!Number.isFinite(expectedCols) || expectedCols < 2) {
    return null;
  }
  if (!colCounts.every((count) => count === expectedCols)) {
    return null;
  }
  return { rows: rows.length, cols: expectedCols, body: rows.join("\\\\") };
};

const matrixBodyToFraction = (body) => {
  const rows = splitMatrixRows(body).map((row) => row.trim()).filter(Boolean);
  if (rows.length !== 2) {
    return null;
  }
  if (rows.some((row) => row.includes("&"))) {
    return null;
  }
  const left = stripOuterBraces(rows[0]);
  const right = stripOuterBraces(rows[1]);
  const atomReg = /^\\?[A-Za-z]+(?:_[{]?[A-Za-z0-9]+[}]?)?$/;
  if (atomReg.test(left) && atomReg.test(right)) {
    return null;
  }
  return `\\frac{${left}}{${right}}`;
};

const normalizeFractionMatrices = (value) => {
  if (!value) return value;
  const replaceWithFraction = (match, body) => {
    const result = matrixBodyToFraction(body);
    return result ? result : match;
  };
  let output = value.replace(
    /\\left\[\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\\right\]/g,
    replaceWithFraction
  );
  output = output.replace(
    /\[\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\]/g,
    (match, body) => replaceWithFraction(match, body)
  );
  output = output.replace(
    /\\left\(\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\\right\)/g,
    (match, body) => replaceWithFraction(match, body)
  );
  output = output.replace(
    /\(\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\)/g,
    (match, body) => replaceWithFraction(match, body)
  );
  return output;
};

const normalizeMatrixDelimiters = (value) => {
  if (!value) return value;
  const toMatrix = (env) => (_match, body) => {
    const cleaned = cleanMatrixBody(body);
    return `\\begin{${env}}${cleaned}\\end{${env}}`;
  };
  let output = value;
  output = output.replace(
    /\\left\(\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\\right\)/g,
    toMatrix("pmatrix")
  );
  output = output.replace(
    /\(\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\)/g,
    toMatrix("pmatrix")
  );
  output = output.replace(
    /\\left\[\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\\right\]/g,
    toMatrix("bmatrix")
  );
  output = output.replace(
    /\[\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\]/g,
    toMatrix("bmatrix")
  );
  return output;
};

const repairMatrixNoise = (value) => {
  if (!value) return value;
  const matches = Array.from(
    value.matchAll(/\\begin\{(matrix|pmatrix|bmatrix)\}([\s\S]*?)\\end\{\1\}/g)
  );
  if (matches.length < 2) {
    return value;
  }
  let best = null;
  for (const match of matches) {
    const shape = parseMatrixShape(match[2]);
    if (!shape) continue;
    const area = shape.rows * shape.cols;
    if (!best || area > best.area) {
      best = {
        area,
        body: shape.body,
      };
    }
  }
  if (!best) {
    return value;
  }
  if (/^\s*\\begin\{(?:matrix|pmatrix|bmatrix)\}[\s\S]*\\end\{(?:matrix|pmatrix|bmatrix)\}\s*$/.test(value)) {
    return `\\begin{pmatrix}${best.body}\\end{pmatrix}`;
  }
  return value;
};

const simplifyNestedMatrixWrapper = (value) => {
  if (!value) return value;
  const pattern =
    /^\\begin\{(?:bmatrix|matrix)\}([\s\S]*?)\\\\\s*\{?\s*\\begin\{(pmatrix|bmatrix|matrix)\}([\s\S]*?)\\end\{\2\}\s*\}?\s*\\end\{(?:bmatrix|matrix)\}$/;
  const match = value.trim().match(pattern);
  if (!match) {
    return value;
  }
  const outerFirstRow = cleanMatrixBody(match[1]);
  const innerEnv = match[2];
  const innerBodyRaw = match[3];
  const innerBody = cleanMatrixBody(innerBodyRaw);
  const innerRows = splitMatrixRows(innerBody).map((row) => row.trim()).filter(Boolean);
  if (innerRows.length < 2) {
    return value;
  }
  const innerFirstRow = innerRows[0];
  if (!outerFirstRow || !innerFirstRow || outerFirstRow !== innerFirstRow) {
    return value;
  }
  const targetEnv = innerEnv === "pmatrix" ? "pmatrix" : "pmatrix";
  return `\\begin{${targetEnv}}${innerRows.join("\\\\")}\\end{${targetEnv}}`;
};

const normalizeBinom = (value) => {
  if (!value) return value;
  const replaceWithBinom = (match, body) => {
    const result = matrixBodyToBinom(body);
    return result ? result : match;
  };
  let output = value.replace(
    /\\left\(\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\\right\)/g,
    replaceWithBinom
  );
  output = output.replace(
    /\(\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\)/g,
    (match, body) => replaceWithBinom(match, body)
  );
  return output;
};

const repairBrokenFractionParentheses = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(
    /\\frac\{\(([^{}]+)\}\{([^{}]+)\)\}/g,
    "\\left(\\frac{$1}{$2}\\right)"
  );
  output = output.replace(
    /\\frac\{\(([^{}]+)\}\{([^{}]+)\}\)/g,
    "\\left(\\frac{$1}{$2}\\right)"
  );
  output = output.replace(
    /\\frac\{\[([^{}]+)\}\{([^{}]+)\]\}/g,
    "\\left[\\frac{$1}{$2}\\right]"
  );
  output = output.replace(
    /\\frac\{\[([^{}]+)\}\{([^{}]+)\}\]/g,
    "\\left[\\frac{$1}{$2}\\right]"
  );
  return output;
};

const normalizeOperatorNames = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(
    /\\operatorname\*?\{(sin|cos|tan|cot|sec|csc|log|ln|exp|max|min|det|dim|lim)\}/g,
    (_match, name) => `\\${name}`
  );
  output = output.replace(/\\operatorname\*?\{det\}/g, "\\det");
  output = output.replace(/\\operatorname\*?\{lim\}/g, "\\lim");
  output = output.replace(/\\geq/g, "\\ge");
  output = output.replace(/\\leq/g, "\\le");
  output = output.replace(/\\neq/g, "\\ne");
  return output;
};

const normalizeLimitCommands = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(/\\varlimsup(_\{[^}]*\\to[^}]*\})/g, "\\lim$1");
  output = output.replace(/\\varliminf(_\{[^}]*\\to[^}]*\})/g, "\\lim$1");
  return output;
};

const stripArrayFormattingCommands = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(/\\arraycolsep=[^\\]+/g, "");
  output = output.replace(/\\def\\arraystretch\{[^}]+\}/g, "");
  return output.trim();
};

const normalizeCompactBinom = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(/\\binom([A-Za-z0-9])([A-Za-z0-9])/g, "\\binom{$1}{$2}");
  return output;
};

const normalizeBinomWrappedInMatrix = (value) => {
  if (!value) return value;
  const trimmed = value.trim();
  const wrapped = trimmed.match(
    /^\\begin\{(?:bmatrix|matrix|pmatrix)\}([\s\S]*)\\end\{(?:bmatrix|matrix|pmatrix)\}$/
  );
  if (!wrapped) {
    return value;
  }
  let body = cleanMatrixBody(wrapped[1]);
  if (body.startsWith("{") && body.endsWith("}")) {
    body = body.slice(1, -1).trim();
  }
  const binom = body.match(/^\\binom\{?([A-Za-z0-9])\}?\{?([A-Za-z0-9])\}?$/);
  if (!binom) {
    return value;
  }
  return `\\binom{${binom[1]}}{${binom[2]}}`;
};

const unwrapBoxedExpression = (value) => {
  if (!value) return value;
  let output = value.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = output
      .replace(/^\\boxed\{([\s\S]+)\}$/, "$1")
      .replace(/^\\fbox\{([\s\S]+)\}$/, "$1")
      .trim();
    if (next === output) break;
    output = next;
  }
  return output;
};

const stripEdgeBarDelimiters = (value) => {
  if (!value) return value;
  let output = value.trim();
  output = output.replace(
    /^\\left\[\s*\\\|([\s\S]+?)\\right\]$/,
    "$1"
  );
  output = output.replace(
    /^\\left\[\s*\|([\s\S]+?)\\right\]$/,
    "$1"
  );
  output = output.replace(
    /^\\left\|\s*([\s\S]+?)\\right\|$/,
    "$1"
  );
  return output.trim();
};

const collapseEmptyFractions = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(/\\frac\{([^{}]+)\}\{\s*\}/g, "$1");
  output = output.replace(/\\frac\{\s*\}\{([^{}]+)\}/g, "$1");
  return output;
};

const stripRedundantOuterRoundDelimiters = (value) => {
  if (!value) return value;
  let output = value.trim();
  const patterns = [
    [/^\\left\(\s*([\s\S]+?)\s*\\right\)$/, "$1"],
    [/^\\biggl\(\s*([\s\S]+?)\s*\\biggr\)$/, "$1"],
    [/^\\Biggl\(\s*([\s\S]+?)\s*\\Biggr\)$/, "$1"],
    [/^\\bigg\(\s*([\s\S]+?)\s*\\bigg\)$/, "$1"],
    [/^\\Bigg\(\s*([\s\S]+?)\s*\\Bigg\)$/, "$1"],
    [/^\\bigl\(\s*([\s\S]+?)\s*\\bigr\)$/, "$1"],
    [/^\\Bigl\(\s*([\s\S]+?)\s*\\Bigr\)$/, "$1"],
    [/^\(\s*([\s\S]+?)\s*\)$/, "$1"],
  ];
  for (let i = 0; i < 2; i += 1) {
    let changed = false;
    for (const [pattern, replacement] of patterns) {
      const next = output.replace(pattern, replacement).trim();
      if (next === output) {
        continue;
      }
      if (/\\begin\{(?:matrix|pmatrix|bmatrix|vmatrix|Vmatrix)\}/.test(next)) {
        continue;
      }
      output = next;
      changed = true;
    }
    if (!changed) break;
  }
  return output;
};

const removeSpacingCommands = (value) => {
  if (!value) return value;
  let output = value;
  output = output.replace(/\\(?:,|!|;|:|\s)/g, "");
  output = output.replace(/\\+$/g, "");
  output = output.replace(/\s+/g, " ");
  return output.trim();
};

const stripRedundantOuterSquareDelimiters = (value) => {
  if (!value) return value;
  let output = value.trim();
  const patterns = [
    [/^\\left\[\s*([\s\S]+?)\s*\\right\]$/, "$1"],
    [/^\\biggl\[\s*([\s\S]+?)\s*\\biggr\]$/, "$1"],
    [/^\\Biggl\[\s*([\s\S]+?)\s*\\Biggr\]$/, "$1"],
    [/^\\bigg\[\s*([\s\S]+?)\s*\\bigg\]$/, "$1"],
    [/^\\Bigg\[\s*([\s\S]+?)\s*\\Bigg\]$/, "$1"],
    [/^\\bigl\[\s*([\s\S]+?)\s*\\bigr\]$/, "$1"],
    [/^\\Bigl\[\s*([\s\S]+?)\s*\\Bigr\]$/, "$1"],
    [/^\[\s*([\s\S]+?)\s*\]$/, "$1"],
  ];
  for (let i = 0; i < 3; i += 1) {
    let changed = false;
    for (const [pattern, replacement] of patterns) {
      const next = output.replace(pattern, replacement).trim();
      if (next !== output) {
        output = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return output;
};

const normalizeDecodedLatex = (value) => {
  if (!value) return "";
  let output = postProcessLatex(value);
  output = stripArrayFormattingCommands(output);
  output = unwrapBoxedExpression(output);
  output = repairBrokenFractionParentheses(output);
  output = fixMatrixSeparators(output);
  output = normalizeFractionMatrices(output);
  output = normalizeBinom(output);
  output = normalizeCompactBinom(output);
  output = normalizeBinomWrappedInMatrix(output);
  output = normalizeMatrixDelimiters(output);
  output = repairMatrixNoise(output);
  output = simplifyNestedMatrixWrapper(output);
  output = normalizeOperatorNames(output);
  output = normalizeLimitCommands(output);
  output = stripEdgeBarDelimiters(output);
  output = collapseEmptyFractions(output);
  output = stripRedundantOuterSquareDelimiters(output);
  output = stripRedundantOuterRoundDelimiters(output);
  output = removeSpacingCommands(output);
  return output.trim();
};

const normalizeFallbackText = (value) => {
  if (!value) return "";
  let cleaned = value.replace(/\s+/g, "");
  cleaned = cleaned.replace(/[^A-Za-z0-9=+\-*/()^_{}]/g, "");
  if (!cleaned) return "";
  if (!cleaned.includes("^")) {
    cleaned = cleaned.replace(/([A-Za-z\\)])([0-9]+)$/, (_match, prefix, digits) =>
      digits.length === 1 ? `${prefix}^${digits}` : `${prefix}^{${digits}}`
    );
  }
  return cleaned;
};

const isSimpleFormula = (value) =>
  /^[A-Za-z0-9=+\-*/()^_{}]+$/.test(value) && value.length <= 24;

const looksLikeGarbage = (value) => {
  if (!value) return true;
  const trimmed = value.trim();
  if (trimmed.length > 300) return true;
  if ((trimmed.match(/\\pi/g) ?? []).length > 8) return true;
  if (trimmed.includes("\\begin{array}")) return true;
  if ((trimmed.match(/[A-Za-z0-9]/g) ?? []).length === 0) return true;
  return false;
};

const countUnbalanced = (text, openChar, closeChar) => {
  let balance = 0;
  let penalty = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === openChar) {
      balance += 1;
    } else if (ch === closeChar) {
      if (balance > 0) {
        balance -= 1;
      } else {
        penalty += 1;
      }
    }
  }
  return penalty + balance;
};

const hasMismatchedEnvironments = (value) => {
  if (!value) return false;
  const beginMatches = value.match(/\\begin\{([^}]+)\}/g) ?? [];
  const endMatches = value.match(/\\end\{([^}]+)\}/g) ?? [];
  if (beginMatches.length !== endMatches.length) {
    return true;
  }
  const balance = new Map();
  const beginReg = /\\begin\{([^}]+)\}/g;
  const endReg = /\\end\{([^}]+)\}/g;
  for (const match of value.matchAll(beginReg)) {
    const key = match[1];
    balance.set(key, (balance.get(key) ?? 0) + 1);
  }
  for (const match of value.matchAll(endReg)) {
    const key = match[1];
    balance.set(key, (balance.get(key) ?? 0) - 1);
  }
  for (const count of balance.values()) {
    if (count !== 0) {
      return true;
    }
  }
  return false;
};

const isLikelyInvalidLatex = (value) => {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (looksLikeGarbage(trimmed)) return true;
  if (/\\frac\{[^{}]+\}\{\s*\}/.test(trimmed)) return true;
  if (/\\frac\{\s*\}\{[^{}]+\}/.test(trimmed)) return true;
  if (countUnbalanced(trimmed, "{", "}") > 0) return true;
  if (countUnbalanced(trimmed, "(", ")") > 2) return true;
  const leftCount = (trimmed.match(/\\left/g) ?? []).length;
  const rightCount = (trimmed.match(/\\right/g) ?? []).length;
  if (Math.abs(leftCount - rightCount) > 0) return true;
  if (hasMismatchedEnvironments(trimmed)) return true;
  return false;
};

const scoreLatexCandidate = (value) => {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return -1000;
  let score = 100;
  if ((trimmed.match(/[A-Za-z0-9]/g) ?? []).length === 0) score -= 60;
  if (trimmed.length < 2) score -= 40;
  if (trimmed.length > 260) score -= 80;
  if ((trimmed.match(/\\pi/g) ?? []).length > 8) score -= 30;
  if (trimmed.includes("\\begin{array}")) score -= 30;
  if (/\\frac\{[^{}]+\}\{\s*\}/.test(trimmed)) score -= 34;
  if (/\\frac\{\s*\}\{[^{}]+\}/.test(trimmed)) score -= 34;
  if (trimmed.includes("<unk>") || trimmed.includes("�")) score -= 60;
  score -= countUnbalanced(trimmed, "{", "}") * 14;
  score -= countUnbalanced(trimmed, "(", ")") * 8;
  const leftCount = (trimmed.match(/\\left/g) ?? []).length;
  const rightCount = (trimmed.match(/\\right/g) ?? []).length;
  score -= Math.abs(leftCount - rightCount) * 10;
  if (hasMismatchedEnvironments(trimmed)) score -= 18;
  if (/[\\](?:frac|sqrt|sum|int|lim|alpha|beta|gamma|theta|sin|cos|tan)\b/.test(trimmed)) {
    score += 8;
  }
  return score;
};

const normalizeFallbackImageCandidates = (primaryImageDataUrl, extraCandidates) => {
  const seen = new Set();
  const result = [];
  const push = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed.startsWith("data:image/")) return;
    if (trimmed.length < 64) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    result.push(trimmed);
  };
  push(primaryImageDataUrl);
  if (Array.isArray(extraCandidates)) {
    for (const candidate of extraCandidates) {
      push(candidate);
      if (result.length >= MAX_FALLBACK_IMAGE_CANDIDATES) {
        break;
      }
    }
  }
  return result.slice(0, MAX_FALLBACK_IMAGE_CANDIDATES);
};

const scoreFallbackCandidate = (text, confidence) => {
  if (!text) return -1000;
  let score = typeof confidence === "number" ? confidence : 0;
  if (!isSimpleFormula(text)) score -= 35;
  if (text.length > 24) score -= 24;
  if (text.length < 2) score -= 22;
  if (text.includes("=")) score += 7;
  if (text.includes("^")) score += 6;
  if (text.includes("_")) score += 4;
  score += clamp(scoreLatexCandidate(text) * 0.28, -30, 34);
  return score;
};

const decodeImageDataUrl = (value) => {
  if (typeof value !== "string") return null;
  const match = value.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  if (!match) return null;
  return Buffer.from(match[1], "base64");
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const softmax = (values) => {
  let max = -Infinity;
  values.forEach((value) => {
    if (value > max) max = value;
  });
  const exps = values.map((value) => Math.exp(value - max));
  const sum = exps.reduce((acc, value) => acc + value, 0);
  return exps.map((value) => value / sum);
};

const buildEntries = (logits) => {
  const entries = new Array(logits.length);
  for (let i = 0; i < logits.length; i += 1) {
    entries[i] = { value: logits[i], index: i };
  }
  entries.sort((a, b) => b.value - a.value);
  return entries;
};

const filterTopK = (logits, thres) => {
  const entries = buildEntries(logits);
  const k = Math.max(1, Math.floor((1 - thres) * logits.length));
  const filtered = new Array(logits.length).fill(-Infinity);
  for (let i = 0; i < Math.min(k, entries.length); i += 1) {
    filtered[entries[i].index] = entries[i].value;
  }
  return filtered;
};

const filterTopP = (logits, thres) => {
  const entries = buildEntries(logits);
  const probs = softmax(entries.map((entry) => entry.value));
  const remove = new Array(entries.length).fill(false);
  const cutoff = 1 - thres;
  let cumulative = 0;
  for (let i = 0; i < entries.length; i += 1) {
    cumulative += probs[i];
    if (cumulative > cutoff) {
      remove[i] = true;
    }
  }
  for (let i = remove.length - 1; i >= 1; i -= 1) {
    remove[i] = remove[i - 1];
  }
  remove[0] = false;
  const filtered = new Array(logits.length).fill(-Infinity);
  for (let i = 0; i < entries.length; i += 1) {
    if (!remove[i]) {
      filtered[entries[i].index] = entries[i].value;
    }
  }
  return filtered;
};

const createRng = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const sampleFromProbs = (probs, rng = Math.random) => {
  const target = rng();
  let cumulative = 0;
  for (let i = 0; i < probs.length; i += 1) {
    cumulative += probs[i];
    if (target <= cumulative) {
      return i;
    }
  }
  return probs.length - 1;
};

const buildDecodeCandidates = (config) => {
  const candidates = [];
  const seen = new Set();
  const baseFilter = clamp(
    Number.isFinite(config.filterThres) ? config.filterThres : config.topP ?? 0.9,
    0,
    1
  );
  const baseTemp =
    Number.isFinite(config.temperature) && config.temperature > 0
      ? config.temperature
      : 1;
  const baseStrategy = config.decodeStrategy || "greedy";
  const push = (strategy, filterThres, temperature, seedOffset) => {
    const key = `${strategy}:${filterThres.toFixed(4)}:${temperature.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ strategy, filterThres, temperature, seedOffset });
  };

  push(baseStrategy, baseFilter, baseTemp, 0);
  push("greedy", clamp(baseFilter, 0.82, 0.99), 1, 5);
  if (baseStrategy !== "greedy") {
    push("greedy", baseFilter, 1, 11);
  }
  push(
    "top_p",
    clamp(baseFilter + 0.04, 0.85, 0.995),
    clamp(baseTemp + 0.1, 0.75, 1.6),
    37
  );
  push(
    "top_p",
    clamp(baseFilter - 0.04, 0.78, 0.98),
    clamp(baseTemp - 0.1, 0.65, 1.25),
    53
  );
  push(
    "top_p",
    clamp(baseFilter + 0.07, 0.9, 0.998),
    clamp(baseTemp + 0.24, 0.9, 1.95),
    67
  );
  push(
    "top_k",
    clamp(baseFilter + 0.03, 0.88, 0.995),
    clamp(baseTemp + 0.2, 0.8, 1.8),
    71
  );
  push(
    "top_k",
    clamp(baseFilter - 0.03, 0.8, 0.98),
    clamp(baseTemp + 0.04, 0.72, 1.4),
    89
  );
  return candidates.slice(0, MAX_DECODE_CANDIDATES);
};

class MathOcrService {
  constructor({ appPath, userDataPath }) {
    this.appPath = appPath;
    this.userDataPath = userDataPath;
    this.basePath = path.join(appPath, "Resources", "math-ocr");
    this.config = null;
    this.idToToken = [];
    this.encoderSession = null;
    this.decoderSession = null;
    this.ort = null;
    this.loading = null;
    this.tesseractWorker = null;
    this.tesseractLoading = null;
  }

  async ensureLoaded() {
    if (this.encoderSession && this.decoderSession) {
      return;
    }
    if (this.loading) {
      await this.loading;
      return;
    }
    this.loading = (async () => {
      const configPath = path.join(this.basePath, "config.json");
      const rawConfig = await fsp.readFile(configPath, "utf8").catch(() => null);
      if (!rawConfig) {
        throw new Error(
          "Math OCR model is not installed. See Resources/math-ocr/README.md."
        );
      }
      const parsed = JSON.parse(rawConfig);
      this.config = { ...DEFAULT_CONFIG, ...parsed };
      this.ort = require("onnxruntime-node");

      const tokenizerPath = path.join(this.basePath, this.config.tokenizer);
      const tokenizer = JSON.parse(await fsp.readFile(tokenizerPath, "utf8"));
      this.idToToken = buildIdToToken(tokenizer);

      const encoderPath = path.join(this.basePath, this.config.encoder);
      const decoderPath = path.join(this.basePath, this.config.decoder);
      this.encoderSession = await this.ort.InferenceSession.create(encoderPath, {
        executionProviders: ["cpu"],
      });
      this.decoderSession = await this.ort.InferenceSession.create(decoderPath, {
        executionProviders: ["cpu"],
      });
      const decoderOutput = this.decoderSession.outputMetadata?.find(
        (meta) => meta?.name === this.config.decoderOutput
      );
      if (decoderOutput?.shape && decoderOutput.shape.length < 2) {
        throw new Error(
          "Math OCR decoder.onnx is incompatible (training wrapper export detected). Re-export with scripts/pix2tex/export-onnx.py."
        );
      }
    })();
    await this.loading;
  }

  async ensureTesseractWorker() {
    if (this.tesseractWorker) {
      return this.tesseractWorker;
    }
    if (this.tesseractLoading) {
      await this.tesseractLoading;
      return this.tesseractWorker;
    }
    this.tesseractLoading = (async () => {
      const { createWorker } = require("tesseract.js");
      const langPath = path.join(
        this.appPath,
        "Resources",
        "web",
        "tesseract",
        "tessdata"
      );
      const worker = await createWorker("eng", undefined, {
        langPath,
        gzip: true,
        errorHandler: () => {},
        logger: () => {},
      });
      await worker.setParameters({
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789=+-*/()^_{}",
        tessedit_pageseg_mode: "7",
      });
      this.tesseractWorker = worker;
    })();
    await this.tesseractLoading;
    this.tesseractLoading = null;
    return this.tesseractWorker;
  }

  async recognizeFallback(imageDataUrl) {
    if (!imageDataUrl) {
      return { text: "", confidence: null };
    }
    const worker = await this.ensureTesseractWorker();
    if (!worker) {
      return { text: "", confidence: null };
    }
    const decoded = decodeImageDataUrl(imageDataUrl);
    const imageInput = decoded ?? imageDataUrl;
    const result = await worker.recognize(imageInput);
    const text = normalizeFallbackText(result?.data?.text ?? "");
    const confidence =
      typeof result?.data?.confidence === "number" ? result.data.confidence : null;
    return { text, confidence };
  }

  async runEncoder(floatData, width, height, config) {
    const channels = Number.isFinite(config.channels) ? config.channels : 1;
    const imageTensor = new this.ort.Tensor(
      "float32",
      floatData,
      [1, channels, height, width]
    );
    const encoderFeeds = {
      [config.encoderInput]: imageTensor,
    };
    const encoderOutputs = await this.encoderSession.run(encoderFeeds);
    const context = encoderOutputs[config.encoderOutput];
    if (!context) {
      throw new Error("Math OCR encoder output is missing.");
    }
    return context;
  }

  async decodeWithContext(context, config, width, height, decodeCandidate) {
    const bosToken = config.bosToken;
    const decoderStartToken = Number.isFinite(config.decoderStartToken)
      ? config.decoderStartToken
      : bosToken;
    const eosToken = config.eosToken;
    const maxSeqLen = config.maxSeqLen;
    const minTokens = Math.max(5, Math.round(width / 90));
    const seedOffset = Number.isFinite(decodeCandidate?.seedOffset)
      ? decodeCandidate.seedOffset
      : 0;
    const rng = createRng((width * 1000 + height + seedOffset) >>> 0);
    const strategy = decodeCandidate?.strategy || config.decodeStrategy || "greedy";
    const filterThres = clamp(
      Number.isFinite(decodeCandidate?.filterThres)
        ? decodeCandidate.filterThres
        : Number.isFinite(config.filterThres)
          ? config.filterThres
          : config.topP ?? 0.9,
      0,
      1
    );
    const temperature =
      Number.isFinite(decodeCandidate?.temperature) && decodeCandidate.temperature > 0
        ? decodeCandidate.temperature
        : Number.isFinite(config.temperature) && config.temperature > 0
          ? config.temperature
          : 1;

    const tokens = [decoderStartToken];
    for (let step = 0; step < maxSeqLen; step += 1) {
      const trimmed = tokens.slice(-maxSeqLen);
      const tokenTensor = new this.ort.Tensor(
        "int64",
        BigInt64Array.from(trimmed.map((value) => BigInt(value))),
        [1, trimmed.length]
      );
      const decoderFeeds = {
        [config.decoderInputTokens]: tokenTensor,
        [config.decoderInputContext]: context,
      };
      const decoderOutputs = await this.decoderSession.run(decoderFeeds);
      const logitsTensor = decoderOutputs[config.decoderOutput];
      if (!logitsTensor?.data) {
        throw new Error("Math OCR decoder output is missing.");
      }
      const logits = logitsTensor.data;
      const vocabSize = logits.length / trimmed.length;
      const offset = (trimmed.length - 1) * vocabSize;
      let nextToken = 0;

      if (strategy === "top_k" || strategy === "top_p") {
        const slice = Array.from(logits.slice(offset, offset + vocabSize));
        const filtered =
          strategy === "top_k"
            ? filterTopK(slice, filterThres)
            : filterTopP(slice, filterThres);
        const scaled = filtered.map((value) => value / temperature);
        const probs = softmax(scaled);
        nextToken = sampleFromProbs(probs, rng);
      } else {
        let maxValue = -Infinity;
        let secondValue = -Infinity;
        let maxIndex = 0;
        let secondIndex = 0;
        for (let i = 0; i < vocabSize; i += 1) {
          const value = logits[offset + i];
          if (value > maxValue) {
            secondValue = maxValue;
            secondIndex = maxIndex;
            maxValue = value;
            maxIndex = i;
          } else if (value > secondValue) {
            secondValue = value;
            secondIndex = i;
          }
        }
        nextToken = maxIndex;
        if (nextToken === eosToken && tokens.length < minTokens && secondIndex !== eosToken) {
          nextToken = secondIndex;
        }
      }

      tokens.push(nextToken);
      if (nextToken === eosToken) {
        break;
      }
    }

    const decoded = decodeTokens(tokens, this.idToToken);
    return normalizeDecodedLatex(decoded);
  }

  async recognize(payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("Math OCR payload is missing.");
    }
    const { data, width, height, imageDataUrl, fallbackImageDataUrls } = payload;
    if (!data || !width || !height) {
      throw new Error("Math OCR payload is invalid.");
    }
    const floatData = data instanceof ArrayBuffer
      ? new Float32Array(data)
      : data instanceof Float32Array
        ? data
        : ArrayBuffer.isView(data)
          ? new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4)
          : null;
    if (!floatData) {
      throw new Error("Math OCR input buffer is invalid.");
    }

    let config = DEFAULT_CONFIG;
    let latex = "";
    let pix2texError = null;

    try {
      await this.ensureLoaded();
      config = this.config ?? DEFAULT_CONFIG;
    } catch (error) {
      pix2texError =
        error instanceof Error ? error : new Error("Math OCR model initialization failed.");
    }

    if (!pix2texError) {
      try {
        const context = await this.runEncoder(floatData, width, height, config);
        const decodeCandidates = buildDecodeCandidates(config);
        let bestCandidate = { latex: "", score: -Infinity, invalid: true };
        let firstDecodeError = null;
        const seenDecoded = new Set();

        for (const candidate of decodeCandidates) {
          try {
            const decodedLatex = await this.decodeWithContext(
              context,
              config,
              width,
              height,
              candidate
            );
            const normalizedLatex = normalizeDecodedLatex(
              typeof decodedLatex === "string" ? decodedLatex : ""
            );
            const trimmed = normalizedLatex.trim();
            if (!trimmed || seenDecoded.has(trimmed)) {
              continue;
            }
            seenDecoded.add(trimmed);
            const score = scoreLatexCandidate(trimmed);
            const invalid = isLikelyInvalidLatex(trimmed);
            if (
              score > bestCandidate.score ||
              (score === bestCandidate.score && bestCandidate.invalid && !invalid)
            ) {
              bestCandidate = { latex: trimmed, score, invalid };
            }
            if (!invalid && score >= PIX2TEX_EARLY_ACCEPT_SCORE) {
              break;
            }
          } catch (error) {
            if (!firstDecodeError) {
              firstDecodeError =
                error instanceof Error ? error : new Error("Math OCR decode failed.");
            }
          }
        }

        latex = bestCandidate.latex;
        if (!latex && firstDecodeError) {
          throw firstDecodeError;
        }
      } catch (error) {
        pix2texError = error instanceof Error ? error : new Error("Math OCR failed.");
      }
    }

    const fallbackImageCandidates = normalizeFallbackImageCandidates(
      imageDataUrl,
      fallbackImageDataUrls
    );
    const shouldTryFallback =
      fallbackImageCandidates.length > 0 &&
      (pix2texError || !latex || looksLikeGarbage(latex) || isLikelyInvalidLatex(latex));

    if (shouldTryFallback) {
      let bestFallback = { text: "", confidence: null, score: -Infinity };
      for (const candidateImage of fallbackImageCandidates) {
        const fallback = await this.recognizeFallback(candidateImage).catch(() => ({
          text: "",
          confidence: null,
        }));
        const fallbackText = fallback.text;
        if (!fallbackText) {
          continue;
        }
        const fallbackConfidence = fallback.confidence;
        const fallbackScore = scoreFallbackCandidate(fallbackText, fallbackConfidence);
        if (fallbackScore > bestFallback.score) {
          bestFallback = {
            text: fallbackText,
            confidence: fallbackConfidence,
            score: fallbackScore,
          };
        }
        if (
          isSimpleFormula(fallbackText) &&
          typeof fallbackConfidence === "number" &&
          fallbackConfidence >= FALLBACK_EARLY_ACCEPT_CONFIDENCE
        ) {
          break;
        }
      }
      const fallbackText = bestFallback.text;
      const fallbackConfidence = bestFallback.confidence;
      const confidentEnough =
        typeof fallbackConfidence === "number" &&
        fallbackConfidence >= FALLBACK_MIN_CONFIDENCE;
      const fallbackAddsScript =
        (fallbackText.includes("^") && !latex.includes("^")) ||
        (fallbackText.includes("_") && !latex.includes("_"));
      const shouldPreferFallback =
        !latex ||
        pix2texError ||
        looksLikeGarbage(latex) ||
        isLikelyInvalidLatex(latex) ||
        (fallbackAddsScript && fallbackText.length >= latex.length);
      if (
        fallbackText &&
        confidentEnough &&
        isSimpleFormula(fallbackText) &&
        shouldPreferFallback
      ) {
        return { latex: fallbackText };
      }
    }

    if (pix2texError && !latex) {
      throw pix2texError;
    }
    if (!latex) {
      throw new Error("Math OCR result was empty.");
    }
    return { latex };
  }
}

module.exports = {
  MathOcrService,
};

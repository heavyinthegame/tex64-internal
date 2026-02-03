const DEFAULT_LATEX_SYMBOL_EXTENSIONS = new Set([
  "tex",
  "bib",
  "sty",
  "cls",
  "ltx",
  "dtx",
]);
const LATEX_REF_COMMANDS = [
  "ref",
  "eqref",
  "pageref",
  "autoref",
  "cref",
  "Cref",
  "namecref",
  "labelcref",
  "cpageref",
  "Cpageref",
];
const LATEX_REF_RANGE_COMMANDS = [
  "crefrange",
  "Crefrange",
  "cpagerefrange",
  "Cpagerefrange",
];
const LATEX_CITE_COMMANDS = [
  "cite",
  "citet",
  "citep",
  "citealp",
  "citeauthor",
  "citeyear",
  "citeyearpar",
  "Cite",
  "Citet",
  "Citep",
  "Citealp",
  "Citeauthor",
  "Citeyear",
  "Citeyearpar",
  "nocite",
  "parencite",
  "Parencite",
  "textcite",
  "Textcite",
  "footcite",
  "Footcite",
  "autocite",
  "Autocite",
  "smartcite",
  "Smartcite",
  "supercite",
  "Supercite",
  "cites",
  "Cites",
  "parencites",
  "Parencites",
  "textcites",
  "Textcites",
];

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const splitLineComment = (line) => {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "%") {
      continue;
    }
    let slashCount = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) {
      slashCount += 1;
    }
    if (slashCount % 2 === 0) {
      return { code: line.slice(0, i), comment: line.slice(i) };
    }
  }
  return { code: line, comment: "" };
};

const replaceKeyInList = (value, from, to) => {
  if (typeof value !== "string") {
    return { text: value, count: 0 };
  }
  let count = 0;
  const parts = value.split(",");
  const updated = parts.map((part) => {
    const trimmed = part.trim();
    if (trimmed !== from) {
      return part;
    }
    count += 1;
    const leading = part.match(/^\s*/)?.[0] ?? "";
    const trailing = part.match(/\s*$/)?.[0] ?? "";
    return `${leading}${to}${trailing}`;
  });
  return { text: updated.join(","), count };
};

const LABEL_PATTERN = /(\\label\*?)\{([^}]*)\}/g;
const REF_PATTERN = new RegExp(
  `(\\\\(?:${LATEX_REF_COMMANDS.join("|")})\\*?)\\{([^}]*)\\}`,
  "g"
);
const REF_RANGE_PATTERN = new RegExp(
  `(\\\\(?:${LATEX_REF_RANGE_COMMANDS.join("|")})\\*?)\\{([^}]*)\\}\\{([^}]*)\\}`,
  "g"
);
const CITE_PATTERN = new RegExp(
  `(\\\\(?:${LATEX_CITE_COMMANDS.join("|")})\\*?(?:\\[[^\\]]*\\])*)\\{([^}]*)\\}`,
  "g"
);
const BIBITEM_PATTERN = /(\\bibitem\*?(?:\[[^\]]*\])?)\{([^}]*)\}/g;

const renameLatexInText = (content, { from, to, renameLabels, renameCites }) => {
  let totalCount = 0;
  const lines = content.split(/\r?\n/);
  const updatedLines = lines.map((line) => {
    const { code, comment } = splitLineComment(line);
    let text = code;
    if (renameLabels) {
      text = text.replace(LABEL_PATTERN, (match, prefix, keys) => {
        const result = replaceKeyInList(keys, from, to);
        if (result.count === 0) {
          return match;
        }
        totalCount += result.count;
        return `${prefix}{${result.text}}`;
      });
      text = text.replace(REF_RANGE_PATTERN, (match, prefix, first, second) => {
        const firstResult = replaceKeyInList(first, from, to);
        const secondResult = replaceKeyInList(second, from, to);
        const count = firstResult.count + secondResult.count;
        if (count === 0) {
          return match;
        }
        totalCount += count;
        return `${prefix}{${firstResult.text}}{${secondResult.text}}`;
      });
      text = text.replace(REF_PATTERN, (match, prefix, keys) => {
        const result = replaceKeyInList(keys, from, to);
        if (result.count === 0) {
          return match;
        }
        totalCount += result.count;
        return `${prefix}{${result.text}}`;
      });
    }
    if (renameCites) {
      text = text.replace(CITE_PATTERN, (match, prefix, keys) => {
        const result = replaceKeyInList(keys, from, to);
        if (result.count === 0) {
          return match;
        }
        totalCount += result.count;
        return `${prefix}{${result.text}}`;
      });
      text = text.replace(BIBITEM_PATTERN, (match, prefix, keys) => {
        const result = replaceKeyInList(keys, from, to);
        if (result.count === 0) {
          return match;
        }
        totalCount += result.count;
        return `${prefix}{${result.text}}`;
      });
    }
    return text + comment;
  });
  return { text: updatedLines.join("\n"), count: totalCount };
};

const renameBibEntryKey = (content, from, to) => {
  const pattern = new RegExp(
    `(^\\s*@\\w+\\s*\\{\\s*)${escapeRegex(from)}(\\s*,)`,
    "gmi"
  );
  let count = 0;
  const text = content.replace(pattern, (_match, prefix, suffix) => {
    count += 1;
    return `${prefix}${to}${suffix}`;
  });
  return { text, count };
};

module.exports = {
  DEFAULT_LATEX_SYMBOL_EXTENSIONS,
  renameBibEntryKey,
  renameLatexInText,
};

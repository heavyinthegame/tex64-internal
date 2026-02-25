type MonacoLanguageApi = {
  languages?: {
    register?: (config: { id: string }) => void;
    setLanguageConfiguration?: (
      languageId: string,
      configuration: {
        comments?: { lineComment?: string };
        brackets?: string[][];
        autoClosingPairs?: Array<{ open: string; close: string; notIn?: string[] }>;
        surroundingPairs?: Array<{ open: string; close: string }>;
      }
    ) => void;
    setMonarchTokensProvider?: (
      languageId: string,
      languageDef: unknown
    ) => void;
  };
};

const LATEX_MONARCH = {
  defaultToken: "",
  tokenPostfix: ".tex",
  brackets: [
    { open: "{", close: "}", token: "delimiter.curly" },
    { open: "[", close: "]", token: "delimiter.square" },
    { open: "(", close: ")", token: "delimiter.parenthesis" },
  ],
  tokenizer: {
    root: [
      [/%.*$/, "comment"],
      [
        /(\\(?:begin|end))(\s*)(\{)([^}]+)(\})/,
        ["keyword", "white", "delimiter", "type", "delimiter"],
      ],
      [/(\\(?:begin|end))(\s*)(\{)([^}]*)$/, ["keyword", "white", "delimiter", "type"]],
      [
        /(\\(?:documentclass|usepackage))(\s*)(\[)([^\]]*)(\])(\s*)(\{)([^}]+)(\})/,
        ["keyword", "white", "delimiter", "string", "delimiter", "white", "delimiter", "type", "delimiter"],
      ],
      [
        /(\\(?:documentclass|usepackage))(\s*)(\{)([^}]+)(\})/,
        ["keyword", "white", "delimiter", "type", "delimiter"],
      ],
      [
        /(\\(?:newcommand|renewcommand|providecommand)\*?)(\s*)(\{)(\\[a-zA-Z@]+)(\})/,
        ["keyword", "white", "delimiter", "variable", "delimiter"],
      ],
      [
        /(\\(?:label|ref|eqref|autoref|cref|Cref))(\s*)(\{)([^}]+)(\})/,
        ["keyword", "white", "delimiter", "variable", "delimiter"],
      ],
      [
        /(\\(?:cite|citet|citep|citeauthor|citeyear|autocite|parencite|textcite|footcite|supercite))(\s*)(\{)([^}]+)(\})/,
        ["keyword", "white", "delimiter", "variable", "delimiter"],
      ],
      [
        /(\\(?:bibliography|bibliographystyle))(\s*)(\{)([^}]+)(\})/,
        ["keyword", "white", "delimiter", "type", "delimiter"],
      ],
      [
        /(\\(?:input|include|includegraphics|graphicspath))(\s*)(\{)([^}]+)(\})/,
        ["keyword", "white", "delimiter", "string", "delimiter"],
      ],
      [/\\[a-zA-Z@]+/, "variable"],
      [/\\./, "variable"],
      [/#\d+/, "number"],
      [/[a-zA-Z@][\w:-]*(?=\s*=)/, "variable"],
      [/=/, "operator"],
      [/\$\$|\$|\\\(|\\\)|\\\[|\\\]/, "string"],
      [/[{}[\]()]/, "delimiter"],
      [/[&^_~]/, "operator"],
      [/\d+(\.\d+)?/, "number"],
    ],
  },
};

const BIBTEX_MONARCH = {
  defaultToken: "",
  tokenPostfix: ".bib",
  brackets: [
    { open: "{", close: "}", token: "delimiter.curly" },
    { open: "(", close: ")", token: "delimiter.parenthesis" },
  ],
  tokenizer: {
    root: [
      [/%.*$/, "comment"],
      [/(@)([a-zA-Z_]+)/, ["operator", "keyword"]],
      [/([a-zA-Z_][\w:-]*)(\s*)(=)/, ["variable", "white", "operator"]],
      [/(\{)([^,\s]+)(,)/, ["delimiter", "type", "delimiter"]],
      [/"[^"]*"/, "string"],
      [/[{}()]/, "delimiter"],
      [/#/, "operator"],
      [/\d+/, "number"],
      [/[a-zA-Z_][\w-]*/, "identifier"],
    ],
  },
};

export const registerTexLanguages = (monaco: MonacoLanguageApi) => {
  monaco.languages?.register?.({ id: "latex" });
  monaco.languages?.register?.({ id: "bibtex" });

  monaco.languages?.setLanguageConfiguration?.("latex", {
    comments: { lineComment: "%" },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "$", close: "$" },
    ],
  });

  monaco.languages?.setLanguageConfiguration?.("bibtex", {
    comments: { lineComment: "%" },
    brackets: [
      ["{", "}"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
    ],
  });

  monaco.languages?.setMonarchTokensProvider?.("latex", LATEX_MONARCH);
  monaco.languages?.setMonarchTokensProvider?.("bibtex", BIBTEX_MONARCH);
};

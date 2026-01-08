const path = require("path");
const fsp = require("fs/promises");
const { normalizeRelativePath } = require("./workspace.cjs");

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".tex64",
  ".swiftpm",
  "node_modules",
  "DerivedData",
  "build",
  "Resources",
  "tex64.xcodeproj",
]);

class IndexerService {
  constructor() {
    this.isIndexing = false;
    this.pendingRootPath = null;
  }

  requestIndex(rootPath, callback) {
    this.pendingRootPath = rootPath;
    if (this.isIndexing) {
      return;
    }
    this.isIndexing = true;

    const run = async () => {
      while (this.pendingRootPath) {
        const target = this.pendingRootPath;
        this.pendingRootPath = null;
        const snapshot = await this.buildIndex(target);
        callback(snapshot);
      }
      this.isIndexing = false;
    };

    run();
  }

  async buildIndex(rootPath) {
    const labelRegex = /\\label\{([^}]+)\}/g;
    const refRegex = /\\ref\{([^}]+)\}/g;
    const citeRegex = /\\cite\{([^}]+)\}/g;
    const bibRegex = /@\w+\s*\{\s*([^,\s]+)/g;
    const sectionRegex =
      /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{([^}]+)\}/g;
    const beginEnvRegex = /\\begin\{(figure\*?|table\*?)\}/g;
    const endEnvRegex = /\\end\{(figure\*?|table\*?)\}/g;
    const captionRegex = /\\caption\*?\{([^}]+)\}/g;
    const todoRegex = /\\todo\{([^}]+)\}/g;
    const todoTextRegex = /^\s*(?:%+\s*)?TODO[:：]?\s*(.+)/i;

    const labels = [];
    const references = [];
    const citations = [];
    const sections = [];
    const figures = [];
    const tables = [];
    const todos = [];

    const walk = async (dirPath) => {
      const entries = await fsp.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        const absPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await walk(absPath);
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (ext !== ".tex" && ext !== ".bib") {
          continue;
        }
        const content = await fsp.readFile(absPath, "utf8").catch(() => null);
        if (content === null) {
          continue;
        }
        const relPath = normalizeRelativePath(path.relative(rootPath, absPath));
        const lines = content.split(/\r?\n/);
        if (ext === ".tex") {
          const envStack = [];
          lines.forEach((line, index) => {
            const lineNumber = index + 1;
            if (line.trim().startsWith("%")) {
              return;
            }
            this.matchAll(labelRegex, line, (match) => {
              labels.push({ key: match[1], path: relPath, line: lineNumber });
            });
            this.matchAll(citeRegex, line, (match) => {
              const keys = match[1]
                .split(",")
                .map((key) => key.trim())
                .filter(Boolean);
              keys.forEach((key) => {
                citations.push({ key, path: relPath, line: lineNumber });
              });
            });
            this.matchAll(refRegex, line, (match) => {
              references.push({ key: match[1], path: relPath, line: lineNumber });
            });
            this.matchAll(sectionRegex, line, (match) => {
              const command = match[1];
              const title = match[2];
              sections.push({
                title,
                path: relPath,
                line: lineNumber,
                level: this.sectionLevel(command),
              });
            });
            this.matchAll(beginEnvRegex, line, (match) => {
              envStack.push(match[1].replace("*", ""));
            });
            this.matchAll(endEnvRegex, line, (match) => {
              const env = match[1].replace("*", "");
              const idx = envStack.lastIndexOf(env);
              if (idx >= 0) {
                envStack.splice(idx, 1);
              }
            });
            this.matchAll(captionRegex, line, (match) => {
              const title = match[1];
              const currentEnv = envStack[envStack.length - 1];
              if (currentEnv === "figure") {
                figures.push({ key: title, path: relPath, line: lineNumber });
              } else if (currentEnv === "table") {
                tables.push({ key: title, path: relPath, line: lineNumber });
              }
            });
            this.matchAll(todoRegex, line, (match) => {
              todos.push({ key: match[1], path: relPath, line: lineNumber });
            });
            const todoTextMatch = line.match(todoTextRegex);
            if (todoTextMatch) {
              todos.push({ key: todoTextMatch[1], path: relPath, line: lineNumber });
            }
          });
        } else if (ext === ".bib") {
          lines.forEach((line, index) => {
            const lineNumber = index + 1;
            this.matchAll(bibRegex, line, (match) => {
              citations.push({ key: match[1], path: relPath, line: lineNumber });
            });
          });
        }
      }
    };

    await walk(rootPath);

    return {
      labels: this.dedupeSymbols(labels),
      references: this.dedupeSymbols(references),
      citations: this.dedupeSymbols(citations),
      sections: this.dedupeSections(sections),
      figures: this.dedupeSymbols(figures),
      tables: this.dedupeSymbols(tables),
      todos: this.dedupeSymbols(todos),
    };
  }

  matchAll(regex, text, handler) {
    regex.lastIndex = 0;
    let match = regex.exec(text);
    while (match) {
      handler(match);
      match = regex.exec(text);
    }
  }

  dedupeSymbols(symbols) {
    const seen = new Set();
    const result = [];
    for (const symbol of symbols) {
      const token = `${symbol.key}|${symbol.path}|${symbol.line}`;
      if (seen.has(token)) {
        continue;
      }
      seen.add(token);
      result.push(symbol);
    }
    return result;
  }

  dedupeSections(sections) {
    const seen = new Set();
    const result = [];
    for (const section of sections) {
      const token = `${section.title}|${section.path}|${section.line}|${section.level}`;
      if (seen.has(token)) {
        continue;
      }
      seen.add(token);
      result.push(section);
    }
    return result;
  }

  sectionLevel(command) {
    switch (command) {
      case "part":
        return 1;
      case "chapter":
        return 2;
      case "section":
        return 3;
      case "subsection":
        return 4;
      case "subsubsection":
        return 5;
      case "paragraph":
        return 6;
      case "subparagraph":
        return 7;
      default:
        return 3;
    }
  }
}

module.exports = {
  IndexerService,
};

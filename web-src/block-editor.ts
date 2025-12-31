window.addEventListener("DOMContentLoaded", () => {
  type BlockType =
    | "paragraph"
    | "heading"
    | "list"
    | "mathBlock"
    | "mathEnv"
    | "figure"
    | "table"
    | "code"
    | "raw"
    | "abstract"
    | "toc"
    | "slideFrame"
    | "columnBreak";

  type AnchorKind = "label" | "hash" | "context";

  type BlockAnchor = {
    kind: AnchorKind;
    value: string;
  };

  type BlockMeta = {
    envName?: string;
    headingCommand?: string;
    innerStart?: number;
    innerEnd?: number;
    titleStart?: number;
    titleEnd?: number;
    listType?: string;
    indent?: string;
    optionalArg?: string;
    safeStructured?: boolean;
  };

  type BlockParsed = {
    title?: string;
    body?: string;
    items?: string[];
    figure?: {
      imagePath: string;
      caption?: string;
      label?: string;
      width?: string;
      placement?: string;
    };
    table?: {
      alignment: string;
      body: string;
      caption?: string;
      label?: string;
    };
  };

  type BlockEntry = {
    id: string;
    type: BlockType;
    title: string;
    snippet: string;
    start: number;
    end: number;
    anchor: BlockAnchor;
    fingerprint: string;
    meta: BlockMeta;
    parsed?: BlockParsed;
  };

  type BridgeWindow = Window & {
    tex180Bridge?: {
      postMessage: (payload: { type: string; [key: string]: unknown }) => void;
      onMessage?: (handler: (message: { type?: string; payload?: unknown }) => void) => void;
    };
    webkit?: { messageHandlers?: { tex180?: { postMessage: (payload: unknown) => void } } };
  };

  const bridgeWindow = window as BridgeWindow;

  const app = document.getElementById("block-editor-app");
  const fileLabel = document.getElementById("block-editor-file");
  const listBody = document.getElementById("block-editor-list");
  const listCount = document.getElementById("block-editor-count");
  const panel = document.getElementById("block-editor-panel");
  const emptyState = document.getElementById("block-editor-empty");
  const panelTitle = document.getElementById("block-editor-block-title");
  const panelMeta = document.getElementById("block-editor-block-meta");
  const panelBadges = document.getElementById("block-editor-panel-badges");
  const form = document.getElementById("block-editor-form");
  const diffView = document.getElementById("block-editor-diff");
  const statusView = document.getElementById("block-editor-status");
  const applyButton = document.getElementById("block-editor-apply");
  const cancelButton = document.getElementById("block-editor-cancel");
  const syncButton = document.getElementById("block-editor-sync");
  const closeButton = document.getElementById("block-editor-close");

  const mathKeyboardDock = document.getElementById("math-keyboard-dock");
  const mathKeyboardTabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".math-keyboard-tab")
  );
  const mathKeyboardGrid = document.getElementById("math-keyboard-grid");
  const mathKeyboardFixedGrid = document.getElementById("math-keyboard-fixed-grid");
  const mathKeyboardShiftButton = document.getElementById("math-keyboard-shift");

  let currentFilePath = "";
  let currentContent = "";
  let blocks: BlockEntry[] = [];
  let activeBlockId: string | null = null;
  let activeAnchor: BlockAnchor | null = null;
  let activeDraftSnippet = "";
  let pendingRequestId: string | null = null;
  let activeMathInput: HTMLElement | null = null;
  let currentMathValue = "";

  const MATH_ENVS = new Set([
    "equation",
    "equation*",
    "align",
    "align*",
    "gather",
    "gather*",
    "multline",
    "multline*",
  ]);

  const LIST_ENVS = new Set(["itemize", "enumerate", "description"]);

  const THEOREM_ENVS = new Set([
    "definition",
    "theorem",
    "lemma",
    "proof",
    "corollary",
    "proposition",
    "example",
    "remark",
    "law",
    "block",
    "alertblock",
    "quote",
  ]);

  const SLIDE_ENVS = new Set(["frame", "columns"]);

  const CODE_ENVS = new Set(["lstlisting", "verbatim", "code"]);

  const HEADING_COMMANDS = [
    "chapter",
    "section",
    "subsection",
    "subsubsection",
    "paragraph",
    "subparagraph",
  ];

  const blockTypeLabel = (type: BlockType) => {
    switch (type) {
      case "heading":
        return "見出し";
      case "paragraph":
        return "本文";
      case "list":
        return "リスト";
      case "mathBlock":
        return "数式";
      case "mathEnv":
        return "定理";
      case "figure":
        return "図";
      case "table":
        return "表";
      case "code":
        return "コード";
      case "abstract":
        return "Abstract";
      case "toc":
        return "目次";
      case "slideFrame":
        return "スライド";
      case "columnBreak":
        return "カラム";
      default:
        return "Raw";
    }
  };

  const setStatus = (message: string) => {
    if (statusView) {
      statusView.textContent = message;
    }
  };

  const postToNative = (payload: { type: string; [key: string]: unknown }) => {
    const handler = bridgeWindow.tex180Bridge ?? bridgeWindow.webkit?.messageHandlers?.tex180;
    if (!handler || typeof handler.postMessage !== "function") {
      setStatus("ネイティブ連携が利用できません。");
      return false;
    }
    handler.postMessage(payload);
    return true;
  };

  const buildHash = (value: string) => {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  };

  const normalizeSnippet = (value: string) => value.replace(/\s+/g, " ").trim();

  const extractAnchor = (snippet: string): BlockAnchor => {
    const labelMatch = snippet.match(/\\label\{([^}]+)\}/);
    if (labelMatch) {
      return { kind: "label", value: labelMatch[1].trim() };
    }
    const normalized = normalizeSnippet(snippet).replace(/\s+/g, "");
    return { kind: "hash", value: buildHash(normalized) };
  };

  const buildFingerprint = (snippet: string) => buildHash(normalizeSnippet(snippet));

  const getLineInfo = (content: string, offset: number) => {
    const safeOffset = Math.max(0, Math.min(offset, content.length));
    const slice = content.slice(0, safeOffset);
    const lines = slice.split(/\n/);
    const lineNumber = lines.length;
    const column = lines[lines.length - 1]?.length + 1;
    return { lineNumber, column };
  };

  const buildCommentRanges = (content: string) => {
    const ranges: Array<[number, number]> = [];
    let offset = 0;
    const lines = content.split(/\n/);
    lines.forEach((line, index) => {
      let escaped = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === "\\") {
          escaped = !escaped;
          continue;
        }
        if (ch === "%" && !escaped) {
          ranges.push([offset + i, offset + line.length]);
          break;
        }
        escaped = false;
      }
      offset += line.length;
      if (index < lines.length - 1) {
        offset += 1;
      }
    });
    return ranges;
  };

  const isInComment = (ranges: Array<[number, number]>, index: number) => {
    for (const [start, end] of ranges) {
      if (index >= start && index < end) {
        return true;
      }
    }
    return false;
  };

  const readGroup = (content: string, start: number, openChar = "{", closeChar = "}") => {
    if (content[start] !== openChar) {
      return null;
    }
    let depth = 0;
    for (let i = start; i < content.length; i += 1) {
      const ch = content[i];
      if (ch === openChar) depth += 1;
      if (ch === closeChar) depth -= 1;
      if (depth === 0) {
        return { content: content.slice(start + 1, i), end: i + 1 };
      }
    }
    return null;
  };

  const skipWhitespace = (content: string, start: number) => {
    let cursor = start;
    while (cursor < content.length && /\s/.test(content[cursor])) {
      cursor += 1;
    }
    return cursor;
  };

  const findNextMatch = (regex: RegExp, content: string, start: number, commentRanges: Array<[number, number]>) => {
    regex.lastIndex = start;
    let match = regex.exec(content);
    while (match) {
      if (!isInComment(commentRanges, match.index)) {
        return match;
      }
      match = regex.exec(content);
    }
    return null;
  };

  const findMatchingEnd = (
    content: string,
    envName: string,
    startIndex: number,
    commentRanges: Array<[number, number]>
  ) => {
    const escaped = envName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const beginRegex = new RegExp(`\\\\begin\\{${escaped}\\}`, "g");
    const endRegex = new RegExp(`\\\\end\\{${escaped}\\}`, "g");
    let depth = 1;
    let searchPos = startIndex;

    while (searchPos < content.length) {
      beginRegex.lastIndex = searchPos;
      endRegex.lastIndex = searchPos;
      const nextBegin = beginRegex.exec(content);
      const nextEnd = endRegex.exec(content);
      const beginIndex = nextBegin ? nextBegin.index : -1;
      const endIndex = nextEnd ? nextEnd.index : -1;

      if (endIndex === -1) {
        return null;
      }

      if (beginIndex !== -1 && beginIndex < endIndex) {
        if (!isInComment(commentRanges, beginIndex)) {
          depth += 1;
        }
        searchPos = beginIndex + (nextBegin?.[0].length ?? 0);
      } else {
        if (!isInComment(commentRanges, endIndex)) {
          depth -= 1;
        }
        searchPos = endIndex + (nextEnd?.[0].length ?? 0);
        if (depth === 0) {
          return { index: endIndex, end: searchPos };
        }
      }
    }
    return null;
  };

  const parseListItems = (content: string, commentRanges: Array<[number, number]>) => {
    const items: string[] = [];
    const itemRegex = /\\item\b/g;
    let match = findNextMatch(itemRegex, content, 0, commentRanges);
    while (match) {
      const start = match.index + match[0].length;
      const next = findNextMatch(itemRegex, content, start, commentRanges);
      const end = next ? next.index : content.length;
      const itemText = content.slice(start, end).trim();
      if (itemText) {
        items.push(itemText);
      }
      if (!next) {
        break;
      }
      match = next;
    }
    return items.length ? items : null;
  };

  const parseBlocks = (content: string) => {
    const commentRanges = buildCommentRanges(content);
    const blocksParsed: BlockEntry[] = [];
    let pos = 0;

    const headingRegex = new RegExp(`\\\\(${HEADING_COMMANDS.join("|")})\\*?`, "g");
    const beginRegex = /\\begin\{([^}]+)\}/g;
    const tocRegex = /\\tableofcontents/g;
    const columnRegex = /\\column\b/g;

    while (pos < content.length) {
      const headingMatch = findNextMatch(headingRegex, content, pos, commentRanges);
      const envMatch = findNextMatch(beginRegex, content, pos, commentRanges);
      const tocMatch = findNextMatch(tocRegex, content, pos, commentRanges);
      const columnMatch = findNextMatch(columnRegex, content, pos, commentRanges);

      const candidates = [headingMatch, envMatch, tocMatch, columnMatch].filter(Boolean) as RegExpMatchArray[];
      if (candidates.length === 0) {
        const tail = content.slice(pos);
        if (tail.trim()) {
          const snippet = tail;
          blocksParsed.push({
            id: buildHash(`${pos}-${snippet.length}`),
            type: "raw",
            title: "本文",
            snippet,
            start: pos,
            end: content.length,
            anchor: extractAnchor(snippet),
            fingerprint: buildFingerprint(snippet),
            meta: {},
          });
        }
        break;
      }

      const nextMatch = candidates.reduce((prev, current) =>
        current.index < prev.index ? current : prev
      );

      if (nextMatch.index > pos) {
        const between = content.slice(pos, nextMatch.index);
        if (between.trim()) {
          const simpleParagraph = !between.match(/\\[A-Za-z]+|\\begin\{|\\end\{/);
          blocksParsed.push({
            id: buildHash(`${pos}-${between.length}`),
            type: simpleParagraph ? "paragraph" : "raw",
            title: simpleParagraph ? between.trim().slice(0, 30) : "本文",
            snippet: between,
            start: pos,
            end: nextMatch.index,
            anchor: extractAnchor(between),
            fingerprint: buildFingerprint(between),
            meta: {},
          });
        }
        pos = nextMatch.index;
      }

      if (headingMatch && nextMatch === headingMatch) {
        const command = headingMatch[1];
        const raw = content.slice(headingMatch.index);
        const afterCommand = headingMatch.index + headingMatch[0].length;
        let cursor = skipWhitespace(content, afterCommand);
        if (content[cursor] === "[") {
          const group = readGroup(content, cursor, "[", "]");
          if (group) {
            cursor = group.end;
          }
        }
        cursor = skipWhitespace(content, cursor);
        const titleGroup = readGroup(content, cursor, "{", "}");
        if (!titleGroup) {
          pos = headingMatch.index + headingMatch[0].length;
          continue;
        }
        const snippet = content.slice(headingMatch.index, titleGroup.end);
        const title = titleGroup.content.trim();
        const titleStart = cursor + 1 - headingMatch.index;
        const titleEnd = titleStart + titleGroup.content.length;
        blocksParsed.push({
          id: buildHash(`${headingMatch.index}-${snippet.length}`),
          type: "heading",
          title: title || "見出し",
          snippet,
          start: headingMatch.index,
          end: titleGroup.end,
          anchor: extractAnchor(snippet),
          fingerprint: buildFingerprint(snippet),
          meta: {
            headingCommand: command,
            titleStart,
            titleEnd,
          },
          parsed: { title },
        });
        pos = titleGroup.end;
        continue;
      }

      if (envMatch && nextMatch === envMatch) {
        const envName = envMatch[1];
        const beginIndex = envMatch.index;
        let cursor = skipWhitespace(content, beginIndex + envMatch[0].length);
        let optionalArg: string | undefined;
        if (content[cursor] === "[") {
          const group = readGroup(content, cursor, "[", "]");
          if (group) {
            optionalArg = group.content.trim();
            cursor = group.end;
          }
        } else if (content[cursor] === "{") {
          const group = readGroup(content, cursor, "{", "}");
          if (group) {
            optionalArg = group.content.trim();
            cursor = group.end;
          }
        }
        cursor = skipWhitespace(content, cursor);

        const endMatch = findMatchingEnd(content, envName, cursor, commentRanges);
        if (!endMatch) {
          pos = beginIndex + envMatch[0].length;
          continue;
        }
        const snippet = content.slice(beginIndex, endMatch.end);
        const innerStart = cursor - beginIndex;
        const innerEnd = endMatch.index - beginIndex;
        const inner = content.slice(cursor, endMatch.index);
        const indentMatch = content.slice(beginIndex).match(/^[\t ]*/);
        const indent = indentMatch ? indentMatch[0] : "";

        let type: BlockType = "raw";
        const meta: BlockMeta = {
          envName,
          innerStart,
          innerEnd,
          indent,
          optionalArg,
        };
        const parsed: BlockParsed = {};

        if (MATH_ENVS.has(envName)) {
          type = "mathBlock";
          parsed.body = inner.trim();
        } else if (LIST_ENVS.has(envName)) {
          type = "list";
          const items = parseListItems(inner, buildCommentRanges(inner));
          parsed.items = items ?? undefined;
          meta.listType = envName;
          meta.safeStructured = !!items;
        } else if (envName === "figure") {
          type = "figure";
          const includeMatch = inner.match(/\\includegraphics(?:\[([^\]]*)\])?\{([^}]+)\}/);
          if (includeMatch) {
            const widthMatch = includeMatch[1]?.match(/width\s*=\s*([^,\]]+)/);
            parsed.figure = {
              imagePath: includeMatch[2]?.trim() ?? "",
              width: widthMatch?.[1]?.trim(),
              caption: inner.match(/\\caption\{([^}]+)\}/)?.[1]?.trim(),
              label: inner.match(/\\label\{([^}]+)\}/)?.[1]?.trim(),
              placement: content.slice(beginIndex, cursor).match(/\\begin\{figure\}\[([^\]]+)\]/)?.[1],
            };
            meta.safeStructured = true;
          } else {
            meta.safeStructured = false;
          }
        } else if (envName === "table") {
          type = "table";
          const tabularMatch = inner.match(/\\begin\{tabular\}\{([^}]*)\}([\s\S]*?)\\end\{tabular\}/);
          if (tabularMatch) {
            parsed.table = {
              alignment: tabularMatch[1] ?? "",
              body: tabularMatch[2]?.trim() ?? "",
              caption: inner.match(/\\caption\{([^}]+)\}/)?.[1]?.trim(),
              label: inner.match(/\\label\{([^}]+)\}/)?.[1]?.trim(),
            };
            meta.safeStructured = true;
          } else {
            meta.safeStructured = false;
          }
        } else if (CODE_ENVS.has(envName)) {
          type = "code";
          parsed.body = inner;
        } else if (envName === "abstract") {
          type = "abstract";
          parsed.body = inner.trim();
        } else if (SLIDE_ENVS.has(envName)) {
          type = "slideFrame";
          parsed.title = optionalArg;
          parsed.body = inner.trim();
          meta.safeStructured = true;
        } else if (THEOREM_ENVS.has(envName)) {
          type = "mathEnv";
          parsed.title = optionalArg;
          parsed.body = inner.trim();
          meta.safeStructured = true;
        } else {
          type = "raw";
        }

        const title =
          parsed.title ||
          (type === "mathBlock" ? envName : null) ||
          (type === "figure" ? parsed.figure?.caption : null) ||
          (type === "table" ? parsed.table?.caption : null) ||
          envName;

        blocksParsed.push({
          id: buildHash(`${beginIndex}-${snippet.length}`),
          type,
          title: (title || envName || "ブロック").trim(),
          snippet,
          start: beginIndex,
          end: endMatch.end,
          anchor: extractAnchor(snippet),
          fingerprint: buildFingerprint(snippet),
          meta,
          parsed,
        });
        pos = endMatch.end;
        continue;
      }

      if (tocMatch && nextMatch === tocMatch) {
        const snippet = tocMatch[0];
        blocksParsed.push({
          id: buildHash(`${tocMatch.index}-${snippet.length}`),
          type: "toc",
          title: "\tableofcontents",
          snippet,
          start: tocMatch.index,
          end: tocMatch.index + snippet.length,
          anchor: extractAnchor(snippet),
          fingerprint: buildFingerprint(snippet),
          meta: {},
        });
        pos = tocMatch.index + snippet.length;
        continue;
      }

      if (columnMatch && nextMatch === columnMatch) {
        const columnGroup = readGroup(content, columnMatch.index + columnMatch[0].length, "{", "}");
        const end = columnGroup ? columnGroup.end : columnMatch.index + columnMatch[0].length;
        const snippet = content.slice(columnMatch.index, end);
        blocksParsed.push({
          id: buildHash(`${columnMatch.index}-${snippet.length}`),
          type: "columnBreak",
          title: "\column",
          snippet,
          start: columnMatch.index,
          end,
          anchor: extractAnchor(snippet),
          fingerprint: buildFingerprint(snippet),
          meta: {},
        });
        pos = end;
        continue;
      }

      pos += 1;
    }

    return blocksParsed;
  };

  const buildLineDiff = (beforeLines: string[], afterLines: string[]) => {
    const rows = beforeLines.length;
    const cols = afterLines.length;
    const table = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(0));
    for (let i = 1; i <= rows; i += 1) {
      for (let j = 1; j <= cols; j += 1) {
        if (beforeLines[i - 1] === afterLines[j - 1]) {
          table[i][j] = table[i - 1][j - 1] + 1;
        } else {
          table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
        }
      }
    }
    const diff: { type: "add" | "del" | "same"; line: string }[] = [];
    let i = rows;
    let j = cols;
    while (i > 0 && j > 0) {
      if (beforeLines[i - 1] === afterLines[j - 1]) {
        diff.push({ type: "same", line: beforeLines[i - 1] });
        i -= 1;
        j -= 1;
      } else if (table[i - 1][j] >= table[i][j - 1]) {
        diff.push({ type: "del", line: beforeLines[i - 1] });
        i -= 1;
      } else {
        diff.push({ type: "add", line: afterLines[j - 1] });
        j -= 1;
      }
    }
    while (i > 0) {
      diff.push({ type: "del", line: beforeLines[i - 1] });
      i -= 1;
    }
    while (j > 0) {
      diff.push({ type: "add", line: afterLines[j - 1] });
      j -= 1;
    }
    return diff.reverse();
  };

  const buildDiffPreview = (before: string, after: string) => {
    const beforeText = before.trimEnd();
    const afterText = after.trimEnd();
    if (beforeText === afterText) {
      return "変更なし";
    }
    const beforeLines = beforeText.length ? beforeText.split(/\r?\n/) : [""];
    const afterLines = afterText.length ? afterText.split(/\r?\n/) : [""];
    const diffLines = buildLineDiff(beforeLines, afterLines);
    const header = "差分（-削除 / +追加）";
    const body = diffLines
      .map((entry) => {
        const prefix = entry.type === "add" ? "+" : entry.type === "del" ? "-" : " ";
        return `${prefix} ${entry.line}`;
      })
      .join("\n");
    return `${header}\n${body}`;
  };

  const updateDiff = (snippet: string) => {
    activeDraftSnippet = snippet;
    if (diffView) {
      diffView.textContent = buildDiffPreview(getActiveBlock()?.snippet ?? "", snippet);
    }
    if (applyButton instanceof HTMLButtonElement) {
      const changed = (getActiveBlock()?.snippet ?? "") !== snippet;
      applyButton.disabled = !changed || pendingRequestId !== null;
    }
  };

  const getActiveBlock = () => blocks.find((block) => block.id === activeBlockId) ?? null;

  const renderBlockList = () => {
    if (!(listBody instanceof HTMLElement)) {
      return;
    }
    listBody.innerHTML = "";
    if (listCount) {
      listCount.textContent = String(blocks.length);
    }
    if (blocks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "block-editor-empty";
      empty.textContent = "ブロックが見つかりません。";
      listBody.appendChild(empty);
      return;
    }

    blocks.forEach((block) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "block-item";
      item.dataset.blockId = block.id;
      item.dataset.blockType = block.type;
      if (block.id === activeBlockId) {
        item.classList.add("is-active");
      }

      const title = document.createElement("div");
      title.className = "block-item-title";
      title.textContent = blockTypeLabel(block.type);

      const meta = document.createElement("div");
      meta.className = "block-item-meta";
      const info = getLineInfo(currentContent, block.start);
      meta.textContent = `${block.title} · 行 ${info.lineNumber}`;

      item.append(title, meta);
      item.addEventListener("click", () => {
        selectBlock(block.id);
      });

      listBody.appendChild(item);
    });
  };

  const setPanelVisible = (visible: boolean) => {
    if (panel) {
      panel.setAttribute("aria-hidden", visible ? "false" : "true");
    }
    if (emptyState) {
      emptyState.style.display = visible ? "none" : "block";
    }
  };

  const clearPanel = () => {
    if (form) {
      form.innerHTML = "";
    }
    if (panelBadges) {
      panelBadges.innerHTML = "";
    }
    updateDiff("");
    setStatus("");
  };

  const setBadge = (labels: string[]) => {
    if (!(panelBadges instanceof HTMLElement)) {
      return;
    }
    panelBadges.innerHTML = "";
    labels.forEach((label) => {
      const badge = document.createElement("div");
      badge.className = "block-badge";
      badge.textContent = label;
      panelBadges.appendChild(badge);
    });
  };

  const replaceRangeInSnippet = (snippet: string, start: number | undefined, end: number | undefined, value: string) => {
    if (start === undefined || end === undefined || start > end) {
      return value;
    }
    return snippet.slice(0, start) + value + snippet.slice(end);
  };

  const updateHeadingSnippet = (block: BlockEntry, title: string) => {
    if (block.meta.titleStart !== undefined && block.meta.titleEnd !== undefined) {
      return replaceRangeInSnippet(block.snippet, block.meta.titleStart, block.meta.titleEnd, title);
    }
    const command = block.meta.headingCommand ?? "section";
    return `\\${command}{${title}}`;
  };

  const updateEnvBodySnippet = (block: BlockEntry, body: string) => {
    if (block.meta.innerStart !== undefined && block.meta.innerEnd !== undefined) {
      return replaceRangeInSnippet(block.snippet, block.meta.innerStart, block.meta.innerEnd, `\n${body}\n`);
    }
    const envName = block.meta.envName ?? "";
    return `\\begin{${envName}}\n${body}\n\\end{${envName}}`;
  };

  const updateFigureSnippet = (block: BlockEntry, figure: BlockParsed["figure"]) => {
    if (!figure) return block.snippet;
    let next = block.snippet;
    const includeRegex = /\\includegraphics(?:\[[^\]]*\])?\{[^}]*\}/;
    const includeLine = (() => {
      const widthPart = figure.width ? `[width=${figure.width}]` : "";
      const pathPart = figure.imagePath || "";
      return `\\includegraphics${widthPart}{${pathPart}}`;
    })();
    if (includeRegex.test(next)) {
      next = next.replace(includeRegex, includeLine);
    } else {
      return block.snippet;
    }

    const replaceCommand = (command: string, value?: string) => {
      const regex = new RegExp(`\\\\${command}\\{[^}]*\\}`);
      if (!value) {
        return;
      }
      if (regex.test(next)) {
        next = next.replace(regex, `\\${command}{${value}}`);
      } else {
        next = next.replace(/\\end\{figure\}/, `\\${command}{${value}}\n\\end{figure}`);
      }
    };

    replaceCommand("caption", figure.caption);
    replaceCommand("label", figure.label);
    return next;
  };

  const updateTableSnippet = (block: BlockEntry, table: BlockParsed["table"]) => {
    if (!table) return block.snippet;
    let next = block.snippet;
    const tabularRegex = /\\begin\{tabular\}\{([^}]*)\}([\s\S]*?)\\end\{tabular\}/;
    const match = next.match(tabularRegex);
    if (!match) {
      return block.snippet;
    }
    const tabularBody = `\\begin{tabular}{${table.alignment}}\n${table.body}\n\\end{tabular}`;
    next = next.replace(tabularRegex, tabularBody);
    const replaceCommand = (command: string, value?: string) => {
      const regex = new RegExp(`\\\\${command}\\{[^}]*\\}`);
      if (!value) {
        return;
      }
      if (regex.test(next)) {
        next = next.replace(regex, `\\${command}{${value}}`);
      } else {
        next = next.replace(/\\end\{table\}/, `\\${command}{${value}}\n\\end{table}`);
      }
    };
    replaceCommand("caption", table.caption);
    replaceCommand("label", table.label);
    return next;
  };

  const renderHeadingForm = (block: BlockEntry) => {
    if (!form) return;
    const field = document.createElement("div");
    field.className = "block-field";
    const label = document.createElement("label");
    label.textContent = "見出し";
    const input = document.createElement("input");
    input.value = block.parsed?.title ?? "";
    input.addEventListener("input", () => {
      updateDiff(updateHeadingSnippet(block, input.value.trim()));
    });
    field.append(label, input);
    form.appendChild(field);
    updateDiff(updateHeadingSnippet(block, input.value.trim()));
  };

  const renderTextAreaForm = (block: BlockEntry, labelText: string, initialValue: string, onChange: (value: string) => void) => {
    if (!form) return;
    const field = document.createElement("div");
    field.className = "block-field";
    const label = document.createElement("label");
    label.textContent = labelText;
    const textarea = document.createElement("textarea");
    textarea.value = initialValue;
    textarea.addEventListener("input", () => {
      onChange(textarea.value);
    });
    field.append(label, textarea);
    form.appendChild(field);
  };

  const renderListForm = (block: BlockEntry) => {
    if (!form) return;
    if (!block.meta.safeStructured || !block.parsed?.items) {
      renderTextAreaForm(block, "リスト（Raw）", block.snippet, (value) => updateDiff(value));
      updateDiff(block.snippet);
      return;
    }
    const items = block.parsed.items.slice();
    items.forEach((item, index) => {
      renderTextAreaForm(block, `項目 ${index + 1}`, item, (value) => {
        items[index] = value;
        const envName = block.meta.envName ?? "itemize";
        const indent = block.meta.indent ?? "";
        const itemIndent = indent + "  ";
        const body = items.map((text) => `${itemIndent}\\item ${text.trim()}`).join("\n");
        const snippet = `${indent}\\begin{${envName}}\n${body}\n${indent}\\end{${envName}}`;
        updateDiff(snippet);
      });
    });
    updateDiff(block.snippet);
  };

  const renderMathField = (block: BlockEntry) => {
    if (!form) return;
    const field = document.createElement("div");
    field.className = "block-field";
    const label = document.createElement("label");
    label.textContent = "数式";
    const container = document.createElement("div");
    container.className = "block-math-input";

    const mathfield = document.createElement("math-field") as any;
    mathfield.className = "block-math-field";
    container.appendChild(mathfield);

    const MathLiveGlobal = (window as any).MathLive;
    if (MathLiveGlobal?.MathfieldElement && !customElements.get("math-field")) {
      try {
        customElements.define("math-field", MathLiveGlobal.MathfieldElement);
      } catch (_error) {
        // already defined
      }
    }

    const applyMathFieldOptions = () => {
      if (typeof mathfield.setOptions !== "function") return;
      mathfield.setOptions({
        smartMode: false,
        defaultMode: "math",
        virtualKeyboardMode: "off",
        fontsDirectory: "mathlive/fonts",
        soundsDirectory: null,
        keypressSound: null,
        plonkSound: null,
        locale: "ja",
      });
    };
    applyMathFieldOptions();
    window.addEventListener(
      "mathlive-ready",
      () => {
        applyMathFieldOptions();
        if (typeof mathfield.value === "string") {
          mathfield.value = currentMathValue;
        }
      },
      { once: true }
    );

    const initial = block.parsed?.body ?? "";
    currentMathValue = initial;
    mathfield.value = initial;
    activeMathInput = mathfield;

    mathfield.addEventListener("input", (event: Event) => {
      const target = event.target as any;
      if (typeof target.value === "string") {
        currentMathValue = target.value;
      }
      updateDiff(updateEnvBodySnippet(block, currentMathValue.trim()));
    });

    mathfield.addEventListener("focus", () => {
      setMathKeyboardVisible(true);
    });

    mathfield.addEventListener("blur", () => {
      setMathKeyboardVisible(false);
    });

    field.append(label, container);
    form.appendChild(field);
    updateDiff(updateEnvBodySnippet(block, initial.trim()));
  };

  const renderMathEnvForm = (block: BlockEntry) => {
    if (!form) return;
    if (!block.meta.safeStructured) {
      renderTextAreaForm(block, "環境（Raw）", block.snippet, (value) => updateDiff(value));
      updateDiff(block.snippet);
      return;
    }
    const titleField = document.createElement("div");
    titleField.className = "block-field";
    const titleLabel = document.createElement("label");
    titleLabel.textContent = "タイトル（任意）";
    const titleInput = document.createElement("input");
    titleInput.value = block.parsed?.title ?? "";
    titleField.append(titleLabel, titleInput);

    const bodyField = document.createElement("div");
    bodyField.className = "block-field";
    const bodyLabel = document.createElement("label");
    bodyLabel.textContent = "本文";
    const bodyInput = document.createElement("textarea");
    bodyInput.value = block.parsed?.body ?? "";
    bodyField.append(bodyLabel, bodyInput);

    const rebuild = () => {
      const envName = block.meta.envName ?? "";
      const title = titleInput.value.trim();
      const braceTitle = ["frame", "block", "alertblock"].includes(envName);
      const titlePart = title ? (braceTitle ? `{${title}}` : `[${title}]`) : "";
      const snippet = `\\begin{${envName}}${titlePart}\n${bodyInput.value}\n\\end{${envName}}`;
      updateDiff(snippet);
    };

    titleInput.addEventListener("input", rebuild);
    bodyInput.addEventListener("input", rebuild);

    form.append(titleField, bodyField);
    rebuild();
  };

  const renderFigureForm = (block: BlockEntry) => {
    if (!form) return;
    if (!block.meta.safeStructured || !block.parsed?.figure) {
      renderTextAreaForm(block, "図（Raw）", block.snippet, (value) => updateDiff(value));
      updateDiff(block.snippet);
      return;
    }
    const figure = { ...block.parsed.figure };
    const addField = (labelText: string, value: string | undefined, onUpdate: (next: string) => void) => {
      const field = document.createElement("div");
      field.className = "block-field";
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("input");
      input.value = value ?? "";
      input.addEventListener("input", () => {
        onUpdate(input.value.trim());
        updateDiff(updateFigureSnippet(block, figure));
      });
      field.append(label, input);
      form.appendChild(field);
    };

    addField("画像パス", figure.imagePath, (next) => (figure.imagePath = next));
    addField("幅（任意）", figure.width, (next) => (figure.width = next));
    addField("キャプション", figure.caption, (next) => (figure.caption = next));
    addField("ラベル", figure.label, (next) => (figure.label = next));

    updateDiff(updateFigureSnippet(block, figure));
  };

  const renderTableForm = (block: BlockEntry) => {
    if (!form) return;
    if (!block.meta.safeStructured || !block.parsed?.table) {
      renderTextAreaForm(block, "表（Raw）", block.snippet, (value) => updateDiff(value));
      updateDiff(block.snippet);
      return;
    }
    const table = { ...block.parsed.table };
    const addField = (labelText: string, value: string | undefined, onUpdate: (next: string) => void) => {
      const field = document.createElement("div");
      field.className = "block-field";
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("input");
      input.value = value ?? "";
      input.addEventListener("input", () => {
        onUpdate(input.value);
        updateDiff(updateTableSnippet(block, table));
      });
      field.append(label, input);
      form.appendChild(field);
    };

    addField("列揃え", table.alignment, (next) => (table.alignment = next.trim()));
    addField("キャプション", table.caption, (next) => (table.caption = next.trim()));
    addField("ラベル", table.label, (next) => (table.label = next.trim()));
    renderTextAreaForm(block, "tabular 本文", table.body, (value) => {
      table.body = value;
      updateDiff(updateTableSnippet(block, table));
    });

    updateDiff(updateTableSnippet(block, table));
  };

  const renderRawForm = (block: BlockEntry) => {
    renderTextAreaForm(block, "Raw", block.snippet, (value) => updateDiff(value));
    updateDiff(block.snippet);
  };

  const renderColumnForm = (block: BlockEntry) => {
    const match = block.snippet.match(/\\column\{([^}]+)\}/);
    const width = match?.[1] ?? "";
    renderTextAreaForm(block, "幅", width, (value) => {
      const snippet = `\\column{${value.trim()}}`;
      updateDiff(snippet);
    });
  };

  const setMathKeyboardVisible = (visible: boolean) => {
    if (!mathKeyboardDock) return;
    mathKeyboardDock.classList.toggle("is-open", visible);
    mathKeyboardDock.setAttribute("aria-hidden", visible ? "false" : "true");
  };

  const selectBlock = (id: string) => {
    activeBlockId = id;
    const block = getActiveBlock();
    if (!block) {
      setPanelVisible(false);
      return;
    }
    activeAnchor = block.anchor;
    if (panelTitle) {
      panelTitle.textContent = `${blockTypeLabel(block.type)} / ${block.title}`;
    }
    if (panelMeta) {
      const info = getLineInfo(currentContent, block.start);
      panelMeta.textContent = `行 ${info.lineNumber} · ${block.meta.envName ?? block.meta.headingCommand ?? block.type}`;
    }
    setBadge([
      block.anchor.kind === "label" ? `label:${block.anchor.value}` : `hash:${block.anchor.value}`,
    ]);
    clearPanel();
    setPanelVisible(true);

    if (block.type !== "mathBlock") {
      setMathKeyboardVisible(false);
      activeMathInput = null;
    }
    if (block.type === "heading") {
      renderHeadingForm(block);
    } else if (block.type === "mathBlock") {
      renderMathField(block);
    } else if (block.type === "mathEnv" || block.type === "slideFrame") {
      renderMathEnvForm(block);
    } else if (block.type === "list") {
      renderListForm(block);
    } else if (block.type === "figure") {
      renderFigureForm(block);
    } else if (block.type === "table") {
      renderTableForm(block);
    } else if (block.type === "columnBreak") {
      renderColumnForm(block);
    } else if (block.type === "toc") {
      renderTextAreaForm(block, "目次", block.snippet, (value) => updateDiff(value));
      updateDiff(block.snippet);
    } else if (block.type === "abstract" || block.type === "code") {
      renderTextAreaForm(block, block.type === "code" ? "コード" : "Abstract", block.parsed?.body ?? "", (value) => {
        updateDiff(updateEnvBodySnippet(block, value));
      });
      updateDiff(updateEnvBodySnippet(block, block.parsed?.body ?? ""));
    } else {
      renderRawForm(block);
    }

    renderBlockList();
  };

  const syncBlocks = (content: string) => {
    currentContent = content;
    blocks = parseBlocks(content);
    renderBlockList();

    if (activeAnchor) {
      const match = blocks.find((block) => block.anchor.kind === activeAnchor?.kind && block.anchor.value === activeAnchor.value);
      if (match) {
        selectBlock(match.id);
        return;
      }
    }
    setPanelVisible(false);
  };

  const requestSync = () => {
    if (!currentFilePath) {
      setStatus("ファイルが選択されていません。");
      return;
    }
    const requestId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `sync-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    pendingRequestId = requestId;
    setStatus("再解析のために同期中...");
    postToNative({ type: "blockEditorRequestSync", requestId, path: currentFilePath });
  };

  const applyPatch = () => {
    const block = getActiveBlock();
    if (!block) {
      setStatus("ブロックが選択されていません。");
      return;
    }
    if (!activeDraftSnippet || activeDraftSnippet === block.snippet) {
      setStatus("変更がありません。");
      return;
    }
    const requestId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `apply-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    pendingRequestId = requestId;
    if (applyButton instanceof HTMLButtonElement) {
      applyButton.disabled = true;
    }
    setStatus("適用中...");
    postToNative({
      type: "blockEditorApplyPatch",
      requestId,
      path: currentFilePath,
      target: {
        start: block.start,
        end: block.end,
        snippet: block.snippet,
        fingerprint: block.fingerprint,
        anchor: block.anchor,
      },
      replacement: activeDraftSnippet,
    });
  };

  const handlePatchResult = (payload: { requestId: string; ok: boolean; error?: string; content?: string }) => {
    if (!payload || payload.requestId !== pendingRequestId) {
      return;
    }
    pendingRequestId = null;
    if (!payload.ok) {
      setStatus(payload.error ?? "適用に失敗しました。再解析してください。");
      return;
    }
    if (payload.content) {
      syncBlocks(payload.content);
    }
    setStatus("適用しました。");
  };

  const handleSyncResult = (payload: { requestId: string; content?: string; error?: string }) => {
    if (!payload || payload.requestId !== pendingRequestId) {
      return;
    }
    pendingRequestId = null;
    if (payload.error) {
      setStatus(payload.error);
      return;
    }
    if (payload.content !== undefined) {
      syncBlocks(payload.content);
      setStatus("再解析しました。");
    }
  };

  if (syncButton instanceof HTMLButtonElement) {
    syncButton.addEventListener("click", () => {
      requestSync();
    });
  }

  if (closeButton instanceof HTMLButtonElement) {
    closeButton.addEventListener("click", () => {
      window.close();
    });
  }

  if (applyButton instanceof HTMLButtonElement) {
    applyButton.addEventListener("click", () => {
      applyPatch();
    });
  }

  if (cancelButton instanceof HTMLButtonElement) {
    cancelButton.addEventListener("click", () => {
      const block = getActiveBlock();
      if (!block) {
        return;
      }
      updateDiff(block.snippet);
      setStatus("変更をリセットしました。");
    });
  }

  const handleBridgeMessage = (message: { type?: string; payload?: unknown }) => {
    if (!message?.type) {
      return;
    }
    switch (message.type) {
      case "blockEditorInit": {
        const payload = message.payload as { path?: string; content?: string };
        currentFilePath = payload?.path ?? "";
        currentContent = payload?.content ?? "";
        if (fileLabel) {
          fileLabel.textContent = currentFilePath || "未選択";
        }
        syncBlocks(currentContent);
        setStatus("読み込みました。");
        break;
      }
      case "blockEditorSyncResult": {
        handleSyncResult(message.payload as { requestId: string; content?: string; error?: string });
        break;
      }
      case "blockEditorPatchResult": {
        handlePatchResult(message.payload as { requestId: string; ok: boolean; error?: string; content?: string });
        break;
      }
      default:
        break;
    }
  };

  if (bridgeWindow.tex180Bridge?.onMessage) {
    bridgeWindow.tex180Bridge.onMessage(handleBridgeMessage);
  }

  if (app) {
    app.classList.add("is-ready");
  }

  // Math keyboard implementation (copied from tex180 main)
  type MathKeyboardTab = "analysis" | "algebra" | "sets" | "logic" | "arrows" | "greek";

  type MathKey = {
    label: string;
    latex?: string;
    fallback?: string;
    shiftLabel?: string;
    shiftLatex?: string;
    shiftFallback?: string;
    displayLatex?: string;
    shiftDisplayLatex?: string;
  };

  const mathKeyboardFixedKeys: MathKey[] = [
    { label: "+", latex: "+", shiftLabel: "⊕", shiftLatex: "\\oplus " },
    { label: "−", latex: "-", shiftLabel: "⊖", shiftLatex: "\\ominus " },
    { label: "×", latex: "\\times ", shiftLabel: "⊗", shiftLatex: "\\otimes " },
    { label: "÷", latex: "\\div ", shiftLabel: "⊘", shiftLatex: "\\oslash " },
    { label: "·", latex: "\\cdot ", shiftLabel: "•", shiftLatex: "\\bullet " },
    { label: "=", latex: "=", shiftLabel: "≡", shiftLatex: "\\equiv " },
    { label: "≠", latex: "\\neq ", shiftLabel: "≈", shiftLatex: "\\approx " },
    { label: "≤", latex: "\\leq ", shiftLabel: "≦", shiftLatex: "\\leqq " },
    { label: "≥", latex: "\\geq ", shiftLabel: "≧", shiftLatex: "\\geqq " },
    { label: "<", latex: "<", shiftLabel: "≪", shiftLatex: "\\ll " },
    { label: ">", latex: ">", shiftLabel: "≫", shiftLatex: "\\gg " },
    { label: "±", latex: "\\pm ", shiftLabel: "∓", shiftLatex: "\\mp " },
    {
      label: "sum",
      latex: "\\sum ",
      shiftLabel: "prod",
      shiftLatex: "\\prod ",
      displayLatex: "\\sum",
      shiftDisplayLatex: "\\prod",
    },
    {
      label: "int",
      latex: "\\int ",
      shiftLabel: "int_ab",
      shiftLatex: "\\int_{#?}^{#?}",
      shiftFallback: "\\int_{}^{}",
      displayLatex: "\\int",
      shiftDisplayLatex: "\\int_{a}^{b}",
    },
    {
      label: "∞",
      latex: "\\infty ",
      shiftLabel: "ℵ0",
      shiftLatex: "\\aleph_0 ",
      displayLatex: "\\infty",
      shiftDisplayLatex: "\\aleph_0",
    },
    {
      label: "sqrt",
      latex: "\\sqrt{#?}",
      fallback: "\\sqrt{}",
      shiftLabel: "root",
      shiftLatex: "\\sqrt[#?]{#?}",
      shiftFallback: "\\sqrt[]{}",
      displayLatex: "\\sqrt{x}",
      shiftDisplayLatex: "\\sqrt[n]{x}",
    },
    {
      label: "frac",
      latex: "\\frac{#?}{#?}",
      fallback: "\\frac{}{}",
      shiftLabel: "dfrac",
      shiftLatex: "\\dfrac{#?}{#?}",
      shiftFallback: "\\dfrac{}{}",
      displayLatex: "\\frac{a}{b}",
      shiftDisplayLatex: "\\dfrac{a}{b}",
    },
    {
      label: "pow",
      latex: "^{#?}",
      fallback: "^{}",
      shiftLabel: "x^2",
      shiftLatex: "^{2}",
      displayLatex: "x^{n}",
      shiftDisplayLatex: "x^{2}",
    },
    {
      label: "sub",
      latex: "_{#?}",
      fallback: "_{}",
      shiftLabel: "x_0",
      shiftLatex: "_{0}",
      displayLatex: "x_{n}",
      shiftDisplayLatex: "x_{0}",
    },
    {
      label: "abs",
      latex: "\\left|#?\\right|",
      fallback: "\\left|\\right|",
      shiftLabel: "inner",
      shiftLatex: "\\left\\langle#?\\right\\rangle",
      shiftFallback: "\\left\\langle\\right\\rangle",
      displayLatex: "\\left|x\\right|",
      shiftDisplayLatex: "\\langle x, y \\rangle",
    },
    {
      label: "sin",
      latex: "\\sin ",
      shiftLabel: "arcsin",
      shiftLatex: "\\arcsin ",
      displayLatex: "\\sin",
      shiftDisplayLatex: "\\arcsin",
    },
    {
      label: "cos",
      latex: "\\cos ",
      shiftLabel: "arccos",
      shiftLatex: "\\arccos ",
      displayLatex: "\\cos",
      shiftDisplayLatex: "\\arccos",
    },
    {
      label: "tan",
      latex: "\\tan ",
      shiftLabel: "arctan",
      shiftLatex: "\\arctan ",
      displayLatex: "\\tan",
      shiftDisplayLatex: "\\arctan",
    },
    {
      label: "log",
      latex: "\\log ",
      shiftLabel: "log_b",
      shiftLatex: "\\log_{#?}",
      shiftFallback: "\\log_{}",
      displayLatex: "\\log",
      shiftDisplayLatex: "\\log_{b}",
    },
    { label: "ln", latex: "\\ln ", shiftLabel: "lg", shiftLatex: "\\lg ", displayLatex: "\\ln", shiftDisplayLatex: "\\lg" },
    {
      label: "exp",
      latex: "\\exp ",
      shiftLabel: "e^",
      shiftLatex: "e^{#?}",
      shiftFallback: "e^{}",
      displayLatex: "\\exp",
      shiftDisplayLatex: "e^{x}",
    },
    {
      label: "lim",
      latex: "\\lim ",
      shiftLabel: "lim→",
      shiftLatex: "\\lim_{#? \\to #?}",
      shiftFallback: "\\lim_{}",
      displayLatex: "\\lim",
      shiftDisplayLatex: "\\lim_{x \\to a}",
    },
    { label: "→", latex: "\\to ", shiftLabel: "⇒", shiftLatex: "\\Rightarrow " },
    {
      label: "∂",
      latex: "\\partial ",
      shiftLabel: "d",
      shiftLatex: "\\mathrm{d} ",
      displayLatex: "\\partial",
      shiftDisplayLatex: "\\mathrm{d}",
    },
    {
      label: "∇",
      latex: "\\nabla ",
      shiftLabel: "Δ",
      shiftLatex: "\\Delta ",
      displayLatex: "\\nabla",
      shiftDisplayLatex: "\\Delta",
    },
  ];

  const mathKeyboardSets: Record<MathKeyboardTab, MathKey[]> = {
    analysis: [
      {
        label: "d/dx",
        latex: "\\frac{d}{d#?}#?",
        fallback: "\\frac{d}{d} ",
        shiftLabel: "d2/dx2",
        shiftLatex: "\\frac{d^2}{d#?^2}#?",
        shiftFallback: "\\frac{d^2}{d^2} ",
        displayLatex: "\\frac{d}{dx}",
        shiftDisplayLatex: "\\frac{d^2}{dx^2}",
      },
      {
        label: "∂/∂x",
        latex: "\\frac{\\partial}{\\partial #?}#?",
        fallback: "\\frac{\\partial}{\\partial} ",
        shiftLabel: "∂2/∂x2",
        shiftLatex: "\\frac{\\partial^2}{\\partial #?^2}#?",
        shiftFallback: "\\frac{\\partial^2}{\\partial^2} ",
        displayLatex: "\\frac{\\partial}{\\partial x}",
        shiftDisplayLatex: "\\frac{\\partial^2}{\\partial x^2}",
      },
      {
        label: "∮",
        latex: "\\oint ",
        shiftLabel: "∮_C",
        shiftLatex: "\\oint_{#?}",
        shiftFallback: "\\oint_{}",
        displayLatex: "\\oint",
        shiftDisplayLatex: "\\oint_{C}",
      },
      {
        label: "∬",
        latex: "\\iint ",
        shiftLabel: "∭",
        shiftLatex: "\\iiint ",
        displayLatex: "\\iint",
        shiftDisplayLatex: "\\iiint",
      },
      {
        label: "lim sup",
        latex: "\\limsup ",
        shiftLabel: "lim inf",
        shiftLatex: "\\liminf ",
        displayLatex: "\\limsup",
        shiftDisplayLatex: "\\liminf",
      },
      {
        label: "sup",
        latex: "\\sup ",
        shiftLabel: "inf",
        shiftLatex: "\\inf ",
        displayLatex: "\\sup",
        shiftDisplayLatex: "\\inf",
      },
      {
        label: "max",
        latex: "\\max ",
        shiftLabel: "min",
        shiftLatex: "\\min ",
        displayLatex: "\\max",
        shiftDisplayLatex: "\\min",
      },
      {
        label: "≈",
        latex: "\\approx ",
        shiftLabel: "∼",
        shiftLatex: "\\sim ",
        displayLatex: "\\approx",
        shiftDisplayLatex: "\\sim",
      },
      {
        label: "≃",
        latex: "\\simeq ",
        shiftLabel: "≅",
        shiftLatex: "\\cong ",
        displayLatex: "\\simeq",
        shiftDisplayLatex: "\\cong",
      },
      {
        label: "O",
        latex: "\\mathcal{O} ",
        shiftLabel: "o",
        shiftLatex: "\\mathrm{o} ",
        displayLatex: "\\mathcal{O}",
        shiftDisplayLatex: "\\mathrm{o}",
      },
      {
        label: "ℒ",
        latex: "\\mathcal{L} ",
        shiftLabel: "ℓ",
        shiftLatex: "\\ell ",
        displayLatex: "\\mathcal{L}",
        shiftDisplayLatex: "\\ell",
      },
      {
        label: "ℱ",
        latex: "\\mathcal{F} ",
        shiftLabel: "ℳ",
        shiftLatex: "\\mathcal{M} ",
        displayLatex: "\\mathcal{F}",
        shiftDisplayLatex: "\\mathcal{M}",
      },
    ],
    algebra: [
      {
        label: "⌊x⌋",
        latex: "\\left\\lfloor#?\\right\\rfloor",
        fallback: "\\left\\lfloor\\right\\rfloor",
        shiftLabel: "⌈x⌉",
        shiftLatex: "\\left\\lceil#?\\right\\rceil",
        shiftFallback: "\\left\\lceil\\right\\rceil",
        displayLatex: "\\lfloor x \\rfloor",
        shiftDisplayLatex: "\\lceil x \\rceil",
      },
      {
        label: "binom",
        latex: "\\binom{#?}{#?}",
        fallback: "\\binom{}{}",
        displayLatex: "\\binom{n}{k}",
      },
      {
        label: "cases",
        latex: "\\begin{cases}#?\\\\#?\\end{cases}",
        fallback: "\\begin{cases}\n  \\\\\n\\end{cases}",
        displayLatex: "\\begin{cases} a \\\\ b \\end{cases}",
      },
      {
        label: "matrix",
        latex: "\\begin{matrix}#?\\\\#?\\end{matrix}",
        fallback: "\\begin{matrix}\n  & \\\\\n  & \n\\end{matrix}",
        shiftLabel: "pmatrix",
        shiftLatex: "\\begin{pmatrix}#?\\\\#?\\end{pmatrix}",
        shiftFallback: "\\begin{pmatrix}\n  & \\\\\n  & \n\\end{pmatrix}",
        displayLatex: "\\begin{matrix} a & b \\\\ c & d \\end{matrix}",
        shiftDisplayLatex: "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}",
      },
      {
        label: "bmatrix",
        latex: "\\begin{bmatrix}#?\\\\#?\\end{bmatrix}",
        fallback: "\\begin{bmatrix}\n  & \\\\\n  & \n\\end{bmatrix}",
        shiftLabel: "vmatrix",
        shiftLatex: "\\begin{vmatrix}#?\\\\#?\\end{vmatrix}",
        shiftFallback: "\\begin{vmatrix}\n  & \\\\\n  & \n\\end{vmatrix}",
        displayLatex: "\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}",
        shiftDisplayLatex: "\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}",
      },
      { label: "det", latex: "\\det ", shiftLabel: "adj", shiftLatex: "\\operatorname{adj} " },
      { label: "tr", latex: "\\operatorname{tr} ", shiftLabel: "diag", shiftLatex: "\\operatorname{diag} " },
      { label: "rank", latex: "\\operatorname{rank} ", shiftLabel: "null", shiftLatex: "\\operatorname{null} " },
      { label: "dim", latex: "\\dim ", shiftLabel: "deg", shiftLatex: "\\deg " },
      { label: "ker", latex: "\\ker ", shiftLabel: "span", shiftLatex: "\\operatorname{span} " },
      {
        label: "gcd",
        latex: "\\gcd ",
        shiftLabel: "lcm",
        shiftLatex: "\\operatorname{lcm} ",
      },
      {
        label: "mod",
        latex: "\\bmod ",
        shiftLabel: "mod",
        shiftLatex: "\\pmod{#?}",
        shiftFallback: "\\pmod{}",
      },
      {
        label: "vec",
        latex: "\\vec{#?}",
        fallback: "\\vec{}",
        shiftLabel: "over→",
        shiftLatex: "\\overrightarrow{#?}",
        shiftFallback: "\\overrightarrow{}",
      },
      {
        label: "hat",
        latex: "\\hat{#?}",
        fallback: "\\hat{}",
        shiftLabel: "tilde",
        shiftLatex: "\\tilde{#?}",
        shiftFallback: "\\tilde{}",
      },
      {
        label: "bar",
        latex: "\\bar{#?}",
        fallback: "\\bar{}",
        shiftLabel: "overline",
        shiftLatex: "\\overline{#?}",
        shiftFallback: "\\overline{}",
      },
      {
        label: "dot",
        latex: "\\dot{#?}",
        fallback: "\\dot{}",
        shiftLabel: "ddot",
        shiftLatex: "\\ddot{#?}",
        shiftFallback: "\\ddot{}",
      },
      {
        label: "bold",
        latex: "\\mathbf{#?}",
        fallback: "\\mathbf{}",
        shiftLabel: "boldsym",
        shiftLatex: "\\boldsymbol{#?}",
        shiftFallback: "\\boldsymbol{}",
      },
      {
        label: "bb",
        latex: "\\mathbb{#?}",
        fallback: "\\mathbb{}",
        shiftLabel: "frak",
        shiftLatex: "\\mathfrak{#?}",
        shiftFallback: "\\mathfrak{}",
      },
      {
        label: "cal",
        latex: "\\mathcal{#?}",
        fallback: "\\mathcal{}",
        shiftLabel: "scr",
        shiftLatex: "\\mathscr{#?}",
        shiftFallback: "\\mathscr{}",
      },
      {
        label: "text",
        latex: "\\text{#?}",
        fallback: "\\text{}",
        shiftLabel: "rm",
        shiftLatex: "\\mathrm{#?}",
        shiftFallback: "\\mathrm{}",
      },
    ],
    sets: [
      { label: "∈", latex: "\\in ", shiftLabel: "∉", shiftLatex: "\\notin " },
      { label: "∋", latex: "\\ni ", shiftLabel: "∌", shiftLatex: "\\not\\ni " },
      { label: "⊂", latex: "\\subset ", shiftLabel: "⊆", shiftLatex: "\\subseteq " },
      { label: "⊃", latex: "\\supset ", shiftLabel: "⊇", shiftLatex: "\\supseteq " },
      { label: "⊊", latex: "\\subsetneq ", shiftLabel: "⊋", shiftLatex: "\\supsetneq " },
      { label: "∪", latex: "\\cup ", shiftLabel: "∩", shiftLatex: "\\cap " },
      { label: "⋃", latex: "\\bigcup ", shiftLabel: "⋂", shiftLatex: "\\bigcap " },
      { label: "∅", latex: "\\emptyset ", shiftLabel: "⌀", shiftLatex: "\\varnothing " },
      { label: "∖", latex: "\\setminus ", shiftLabel: "△", shiftLatex: "\\triangle " },
      {
        label: "{x|}",
        latex: "\\{#?\\mid#?\\}",
        fallback: "\\{\\mid\\}",
      },
      { label: "℘", latex: "\\mathcal{P} ", shiftLabel: "ℱ", shiftLatex: "\\mathcal{F} " },
      { label: "ℕ", latex: "\\mathbb{N} ", shiftLabel: "ℤ", shiftLatex: "\\mathbb{Z} " },
      { label: "ℚ", latex: "\\mathbb{Q} ", shiftLabel: "ℝ", shiftLatex: "\\mathbb{R} " },
      { label: "ℂ", latex: "\\mathbb{C} ", shiftLabel: "ℍ", shiftLatex: "\\mathbb{H} " },
      { label: "⟂", latex: "\\perp ", shiftLabel: "∥", shiftLatex: "\\parallel " },
    ],
    logic: [
      { label: "∀", latex: "\\forall ", shiftLabel: "∃", shiftLatex: "\\exists " },
      { label: "¬", latex: "\\neg ", shiftLabel: "¬¬", shiftLatex: "\\neg\\neg " },
      { label: "∧", latex: "\\land ", shiftLabel: "∨", shiftLatex: "\\lor " },
      { label: "⇒", latex: "\\Rightarrow ", shiftLabel: "⇔", shiftLatex: "\\Leftrightarrow " },
      { label: "⇐", latex: "\\Leftarrow " },
      { label: "⊢", latex: "\\vdash ", shiftLabel: "⊨", shiftLatex: "\\models " },
      { label: "⊥", latex: "\\bot ", shiftLabel: "⊤", shiftLatex: "\\top " },
      { label: "≡", latex: "\\equiv ", shiftLabel: "≢", shiftLatex: "\\not\\equiv " },
      { label: "⊕", latex: "\\oplus ", shiftLabel: "⊗", shiftLatex: "\\otimes " },
      { label: "∴", latex: "\\therefore ", shiftLabel: "∵", shiftLatex: "\\because " },
      { label: "□", latex: "\\Box ", shiftLabel: "◇", shiftLatex: "\\Diamond " },
      { label: "∃!", latex: "\\exists!", shiftLabel: "∄", shiftLatex: "\\not\\exists " },
      { label: "⊂", latex: "\\subset ", shiftLabel: "⊆", shiftLatex: "\\subseteq " },
    ],
    arrows: [
      { label: "←", latex: "\\leftarrow ", shiftLabel: "⇐", shiftLatex: "\\Leftarrow " },
      { label: "↔", latex: "\\leftrightarrow ", shiftLabel: "⇔", shiftLatex: "\\Leftrightarrow " },
      { label: "↦", latex: "\\mapsto ", shiftLabel: "⟼", shiftLatex: "\\longmapsto " },
      {
        label: "⟶",
        latex: "\\longrightarrow ",
        shiftLabel: "⟹",
        shiftLatex: "\\Longrightarrow ",
      },
      {
        label: "⟵",
        latex: "\\longleftarrow ",
        shiftLabel: "⟸",
        shiftLatex: "\\Longleftarrow ",
      },
      {
        label: "⟷",
        latex: "\\longleftrightarrow ",
        shiftLabel: "⟺",
        shiftLatex: "\\Longleftrightarrow ",
      },
      { label: "↑", latex: "\\uparrow ", shiftLabel: "⇑", shiftLatex: "\\Uparrow " },
      { label: "↓", latex: "\\downarrow ", shiftLabel: "⇓", shiftLatex: "\\Downarrow " },
      {
        label: "↕",
        latex: "\\updownarrow ",
        shiftLabel: "⇕",
        shiftLatex: "\\Updownarrow ",
      },
      { label: "↗", latex: "\\nearrow ", shiftLabel: "↘", shiftLatex: "\\searrow " },
      { label: "↖", latex: "\\nwarrow ", shiftLabel: "↙", shiftLatex: "\\swarrow " },
      {
        label: "↪",
        latex: "\\hookrightarrow ",
        shiftLabel: "↩",
        shiftLatex: "\\hookleftarrow ",
      },
      {
        label: "↠",
        latex: "\\twoheadrightarrow ",
        shiftLabel: "↞",
        shiftLatex: "\\twoheadleftarrow ",
      },
      {
        label: "⇝",
        latex: "\\rightsquigarrow ",
        shiftLabel: "⇜",
        shiftLatex: "\\leftsquigarrow ",
      },
      {
        label: "⤳",
        latex: "\\curvearrowright ",
        shiftLabel: "⤲",
        shiftLatex: "\\curvearrowleft ",
      },
      {
        label: "⇀",
        latex: "\\rightharpoonup ",
        shiftLabel: "⇁",
        shiftLatex: "\\rightharpoondown ",
      },
      {
        label: "↼",
        latex: "\\leftharpoonup ",
        shiftLabel: "↽",
        shiftLatex: "\\leftharpoondown ",
      },
      {
        label: "⇉",
        latex: "\\rightrightarrows ",
        shiftLabel: "⇇",
        shiftLatex: "\\leftleftarrows ",
      },
    ],
    greek: [
      { label: "α", latex: "\\alpha ", shiftLabel: "Α", shiftLatex: "A " },
      { label: "β", latex: "\\beta ", shiftLabel: "Β", shiftLatex: "B " },
      { label: "γ", latex: "\\gamma ", shiftLabel: "Γ", shiftLatex: "\\Gamma " },
      { label: "δ", latex: "\\delta ", shiftLabel: "Δ", shiftLatex: "\\Delta " },
      { label: "ε", latex: "\\epsilon ", shiftLabel: "Ε", shiftLatex: "E " },
      { label: "ϵ", latex: "\\varepsilon ", shiftLabel: "Ε", shiftLatex: "E " },
      { label: "ζ", latex: "\\zeta ", shiftLabel: "Ζ", shiftLatex: "Z " },
      { label: "η", latex: "\\eta ", shiftLabel: "Η", shiftLatex: "H " },
      { label: "θ", latex: "\\theta ", shiftLabel: "Θ", shiftLatex: "\\Theta " },
      { label: "ϑ", latex: "\\vartheta ", shiftLabel: "Θ", shiftLatex: "\\Theta " },
      { label: "ι", latex: "\\iota ", shiftLabel: "Ι", shiftLatex: "I " },
      { label: "κ", latex: "\\kappa ", shiftLabel: "Κ", shiftLatex: "K " },
      { label: "λ", latex: "\\lambda ", shiftLabel: "Λ", shiftLatex: "\\Lambda " },
      { label: "μ", latex: "\\mu ", shiftLabel: "Μ", shiftLatex: "M " },
      { label: "ν", latex: "\\nu ", shiftLabel: "Ν", shiftLatex: "N " },
      { label: "ξ", latex: "\\xi ", shiftLabel: "Ξ", shiftLatex: "\\Xi " },
      { label: "π", latex: "\\pi ", shiftLabel: "Π", shiftLatex: "\\Pi " },
      { label: "ϖ", latex: "\\varpi ", shiftLabel: "Π", shiftLatex: "\\Pi " },
      { label: "ρ", latex: "\\rho ", shiftLabel: "Ρ", shiftLatex: "P " },
      { label: "ϱ", latex: "\\varrho ", shiftLabel: "Ρ", shiftLatex: "P " },
      { label: "σ", latex: "\\sigma ", shiftLabel: "Σ", shiftLatex: "\\Sigma " },
      { label: "ς", latex: "\\varsigma ", shiftLabel: "Σ", shiftLatex: "\\Sigma " },
      { label: "τ", latex: "\\tau ", shiftLabel: "Τ", shiftLatex: "T " },
      { label: "υ", latex: "\\upsilon ", shiftLabel: "Υ", shiftLatex: "\\Upsilon " },
      { label: "φ", latex: "\\phi ", shiftLabel: "Φ", shiftLatex: "\\Phi " },
      { label: "ϕ", latex: "\\varphi ", shiftLabel: "Φ", shiftLatex: "\\Phi " },
      { label: "χ", latex: "\\chi ", shiftLabel: "Χ", shiftLatex: "X " },
      { label: "ψ", latex: "\\psi ", shiftLabel: "Ψ", shiftLatex: "\\Psi " },
      { label: "ω", latex: "\\omega ", shiftLabel: "Ω", shiftLatex: "\\Omega " },
    ],
  };

let mathLiveReady = false;
  let mathKeyboardNeedsRerender = false;
  let mathLiveCheckScheduled = false;
  let mathKeyboardShiftHeld = false;
  let mathKeyboardShiftLocked = false;
  let activeMathKeyboardTab: MathKeyboardTab = "analysis";

  const normalizeMathKeyboardTab = (tab?: string | null): MathKeyboardTab => {
    if (tab === "analysis" || tab === "algebra" || tab === "sets" || tab === "logic" || tab === "arrows" || tab === "greek") {
      return tab;
    }
    return "analysis";
  };

  const isMathKeyboardShiftActive = () => mathKeyboardShiftHeld || mathKeyboardShiftLocked;

  const markMathLiveReady = () => {
    if (mathLiveReady) {
      return;
    }
    mathLiveReady = true;
    mathLiveCheckScheduled = false;
    if (mathKeyboardNeedsRerender) {
      renderMathKeyboard(activeMathKeyboardTab);
      renderMathKeyboardFixed();
      mathKeyboardNeedsRerender = false;
    }
  };

  const ensureMathLiveReady = () => {
    if (mathLiveReady || mathLiveCheckScheduled) {
      return;
    }
    mathLiveCheckScheduled = true;
    const check = () => {
      if (mathLiveReady) {
        return;
      }
      const MathLiveGlobal = (window as any).MathLive;
      if (MathLiveGlobal?.renderToMarkup) {
        markMathLiveReady();
        return;
      }
      setTimeout(check, 120);
    };
    check();
    window.addEventListener("mathlive-ready", markMathLiveReady, { once: true });
  };

  const resolveMathKey = (key: MathKey, shiftActive: boolean): MathKey => {
    if (!shiftActive) {
      return key;
    }
    const hasShift = key.shiftLabel || key.shiftLatex || key.shiftFallback || key.shiftDisplayLatex;
    if (!hasShift) {
      return key;
    }
    return {
      label: key.shiftLabel ?? key.label,
      latex: key.shiftLatex ?? key.latex,
      fallback: key.shiftFallback ?? key.fallback,
      displayLatex: key.shiftDisplayLatex ?? key.displayLatex,
    };
  };

  const buildMathKeyDisplayLatex = (key: MathKey) => {
    const source = key.displayLatex ?? key.latex ?? key.fallback;
    if (!source) {
      return null;
    }
    const placeholders = ["x", "y", "z", "a", "b", "c"];
    let index = 0;
    return source.replace(/#\?/g, () => {
      const value = placeholders[index] ?? "x";
      index += 1;
      return value;
    });
  };

  const renderMathKeyLabel = (button: HTMLButtonElement, key: MathKey) => {
    const MathLiveGlobal = (window as any).MathLive;
    const displayLatex = buildMathKeyDisplayLatex(key);
    if (displayLatex && MathLiveGlobal?.renderToMarkup) {
      try {
        const wrapper = document.createElement("span");
        wrapper.className = "math-keyboard-math";
        wrapper.innerHTML = MathLiveGlobal.renderToMarkup(displayLatex, {
          defaultMode: "inline-math",
        });
        button.textContent = "";
        button.appendChild(wrapper);
        button.classList.add("has-math");
        button.setAttribute("aria-label", key.label);
        return;
      } catch (_error) {
        // fallback
      }
    }
    if (displayLatex) {
      mathKeyboardNeedsRerender = true;
      ensureMathLiveReady();
    }
    button.classList.remove("has-math");
    button.textContent = key.label;
    button.removeAttribute("aria-label");
  };

  const renderMathKeyboardKeys = (target: HTMLElement | null, keys: MathKey[]) => {
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const shiftActive = isMathKeyboardShiftActive();
    target.innerHTML = "";
    keys.forEach((key) => {
      const resolved = resolveMathKey(key, shiftActive);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "math-keyboard-key";
      renderMathKeyLabel(button, resolved);
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      button.addEventListener("click", () => {
        insertMathKey(resolved);
      });
      target.appendChild(button);
    });
  };

  const renderMathKeyboardFixed = () => {
    renderMathKeyboardKeys(mathKeyboardFixedGrid, mathKeyboardFixedKeys);
  };

  const updateMathKeyboardShiftState = () => {
    const isActive = isMathKeyboardShiftActive();
    if (mathKeyboardShiftButton instanceof HTMLButtonElement) {
      mathKeyboardShiftButton.classList.toggle("is-active", isActive);
      mathKeyboardShiftButton.setAttribute("aria-pressed", isActive ? "true" : "false");
    }
    if (mathKeyboardDock instanceof HTMLElement && mathKeyboardDock.classList.contains("is-open")) {
      renderMathKeyboard(activeMathKeyboardTab);
      renderMathKeyboardFixed();
    }
  };

  const renderMathKeyboard = (tab: MathKeyboardTab) => {
    const keys = mathKeyboardSets[tab] ?? [];
    renderMathKeyboardKeys(mathKeyboardGrid, keys);
  };

  const setMathKeyboardTab = (tab: MathKeyboardTab) => {
    activeMathKeyboardTab = tab;
    mathKeyboardTabs.forEach((button) => {
      const isActive = button.dataset.mathTab === tab;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    renderMathKeyboard(tab);
  };

  const insertMathKey = (key: MathKey) => {
    if (!activeMathInput) {
      return;
    }
    const mathField = activeMathInput as {
      insert?: (value: string, options?: Record<string, unknown>) => void;
      executeCommand?: (...args: unknown[]) => boolean;
      focus?: () => void;
      value?: string;
    };

    mathField.focus?.();

    if (typeof mathField.executeCommand === "function") {
      try {
        mathField.executeCommand("insert", key.latex);
        return;
      } catch (_error) {
        // fallback
      }
    }

    if (typeof mathField.insert === "function") {
      mathField.insert(key.latex ?? "", { focus: true, feedback: false });
      return;
    }

    const insertValue = key.fallback ?? key.latex ?? "";
    if ("value" in mathField && typeof mathField.value === "string") {
      mathField.value += insertValue;
    }
  };

  mathKeyboardTabs.forEach((button) => {
    button.addEventListener("click", () => {
      setMathKeyboardTab(normalizeMathKeyboardTab(button.dataset.mathTab));
    });
  });

  if (mathKeyboardShiftButton instanceof HTMLButtonElement) {
    mathKeyboardShiftButton.addEventListener("click", () => {
      mathKeyboardShiftLocked = !mathKeyboardShiftLocked;
      updateMathKeyboardShiftState();
    });
  }

  window.addEventListener("keydown", (event) => {
    if (event.key === "Shift" && !mathKeyboardShiftHeld) {
      mathKeyboardShiftHeld = true;
      updateMathKeyboardShiftState();
    }
  });

  window.addEventListener("keyup", (event) => {
    if (event.key === "Shift" && mathKeyboardShiftHeld) {
      mathKeyboardShiftHeld = false;
      updateMathKeyboardShiftState();
    }
  });

  renderMathKeyboard(activeMathKeyboardTab);
  renderMathKeyboardFixed();
  updateMathKeyboardShiftState();
});

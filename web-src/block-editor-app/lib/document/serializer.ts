/**
 * TeX Serializer
 * 
 * Converts structured Document model back to LaTeX source code.
 */

import type { 
  Document, 
  DocumentBlock, 
  InlineContent,
  HeadingLevel 
} from './types';

// ============================================================================
// Main Serialization
// ============================================================================

export function serializeDocument(doc: Document): string {
  const parts: string[] = [];

  // Add magic comment for latexmk / TeXShop to enforce XeLaTeX
  // parts.push('%!TEX program = xelatex'); // Removed for pdflatex compatibility
  parts.push(''); // Empty line after magic comment
  
  // Handle preamble
  let preamble = doc.metadata.preamble;
  if (!preamble) {
    preamble = generateDefaultPreamble(doc);
  }
  preamble = ensureUsePackage(preamble, "amsmath");
  
  // Ensure xeCJK for XeLaTeX and proper Japanese fonts
  if (!preamble.includes('xeCJK')) {
    preamble = ensureUsePackage(preamble, "xeCJK");
    // Insert font settings after xeCJK
    const fontSettings = `
\\setCJKmainfont[BoldFont=HaranoAjiGothic-Bold]{HaranoAjiGothic-Regular}
\\setCJKsansfont[BoldFont=HaranoAjiGothic-Bold]{HaranoAjiGothic-Regular}
\\setCJKmonofont{HaranoAjiGothic-Regular}
`;
    if (!preamble.includes('setCJKmainfont')) {
      preamble += fontSettings;
    }
  }
  
  // Extract document class for heading command adaptation
  const docClass = doc.metadata.documentClass || 
    (preamble.match(/\\documentclass(?:\[[^\]]*\])?\{(\w+)\}/)?.[1]) || 
    'article';
  
  // Update documentclass in preamble if user changed it in metadata
  if (doc.metadata.documentClass && doc.metadata.documentClass !== 'article') {
    preamble = preamble.replace(
      /\\documentclass(\[[^\]]*\])?\{article\}/,
      `\\documentclass$1{${doc.metadata.documentClass}}`
    );
  }
  
  parts.push(preamble);
  
  // Add theorem environments dynamically based on document class
  // Skip for beamer as it has its own block environments
  if (docClass !== 'beamer' && !preamble.includes('\\newtheorem{theorem}')) {
    const counter = (docClass === 'report' || docClass === 'book') ? 'chapter' : 'section';
    parts.push(`\\numberwithin{equation}{${counter}}`);
    parts.push(`\\newtheorem{theorem}{定理}[${counter}]`);
    parts.push('\\newtheorem{definition}[theorem]{定義}');
    parts.push('\\newtheorem{lemma}[theorem]{補題}');
    parts.push('\\newtheorem{example}[theorem]{例}');
    parts.push('\\newtheorem{law}[theorem]{法則}');
  }
  
  // Inject geometry if missing from preamble but present in metadata
  // Skip for beamer as it handles its own layout
  if (doc.metadata.marginSize && !preamble.includes('\\geometry') && doc.metadata.documentClass !== 'beamer') {
     if (!preamble.includes('\\usepackage{geometry}') && !preamble.includes('\\usepackage[margin=')) {
        parts.push('\\usepackage{geometry}');
     }
     parts.push(`\\geometry{margin=${doc.metadata.marginSize}}`);
  }
  
  // Standardize page numbering for book class (default has inconsistent header/footer)
  if (docClass === 'book') {
    parts.push('\\pagestyle{plain}');  // Consistent page numbers at bottom center
  }
  
  // XeLaTeX doesn't need CJK environment, just document
  parts.push('\\begin{document}\n');
  
  // Add title matter if present (only if any field has content)
  const hasTitle = doc.metadata.title?.trim();
  const hasAuthor = doc.metadata.author?.trim();
  const hasAffiliation = doc.metadata.affiliation?.trim();
  const hasStudentId = doc.metadata.studentId?.trim();
  
  if (hasTitle || hasAuthor || hasAffiliation || hasStudentId) {
    if (hasTitle) parts.push(`\\title{${wrapCjkInInlineMathSegments(doc.metadata.title || "")}}`);

    const authorLines: string[] = [];
    if (hasAffiliation) authorLines.push(wrapCjkInInlineMathSegments(doc.metadata.affiliation!));
    const nameLine = [hasStudentId ? doc.metadata.studentId : null, hasAuthor ? doc.metadata.author : null].filter(Boolean).join(" ").trim();
    if (nameLine) authorLines.push(wrapCjkInInlineMathSegments(nameLine));
    if (authorLines.length) {
      parts.push(`\\author{${authorLines.join(' \\\\ ')}}`);
    }

    if (doc.metadata.date?.trim()) {
      parts.push(`\\date{${wrapCjkInInlineMathSegments(doc.metadata.date)}}`);
    }
    
    // Beamer uses frame for title page
    if (docClass === 'beamer') {
      parts.push('\\begin{frame}');
      parts.push('\\titlepage');
      parts.push('\\end{frame}\n');
    } else {
      parts.push('\\maketitle\n');
    }
  }
  
  // For beamer, start the first content frame
  if (docClass === 'beamer') {
    parts.push('\\begin{frame}[allowframebreaks]');
  }
  
  // Add abstract if present
  if (doc.metadata.abstractText?.trim()) {
    parts.push('\\begin{abstract}');
    parts.push(wrapCjkInInlineMathSegments(doc.metadata.abstractText));
    parts.push('\\end{abstract}\n');
  }
  
  // Serialize blocks with document class context (docClass was extracted earlier during preamble processing)
  parts.push(doc.blocks.map(block => serializeBlock(block, docClass)).join('\n\n'));
  
  // For beamer, close the last frame
  if (docClass === 'beamer') {
    parts.push('\n\\end{frame}');
  }
  
  // Add acknowledgments if present (skip for beamer)
  if (doc.metadata.acknowledgments?.trim() && docClass !== 'beamer') {
    parts.push('\n\n\\section*{謝辞}');
    parts.push(wrapCjkInInlineMathSegments(doc.metadata.acknowledgments));
  }
  
  // Add references if present (skip for beamer)
  if (doc.metadata.references?.trim() && docClass !== 'beamer') {
    parts.push('\n\n\\begin{thebibliography}{99}');
    parts.push(wrapCjkInInlineMathSegments(doc.metadata.references));
    parts.push('\\end{thebibliography}');
  }
  
  parts.push('\n\\end{document}');
  
  let result = parts.join('\n');
  
  // Post-processing for Beamer: Remove empty frames caused by initialization logic
  if (docClass === 'beamer') {
    // Remove \begin{frame}\end{frame} pairs (with optional whitespace and options)
    result = result.replace(/\\begin\{frame\}(?:\[[^\]]*\])?\s*\\end\{frame\}/g, '');
  }
  
  return result;
}

// Strip MathLive placeholders to avoid LaTeX compile errors
function stripMathDelimiters(latex: string): string {
  if (!latex) return latex;
  const trimmed = latex.trim();
  if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.startsWith('$') && trimmed.endsWith('$') && trimmed.length > 2) {
    return trimmed.slice(1, -1).trim();
  }
  if (trimmed.startsWith('\\(') && trimmed.endsWith('\\)') && trimmed.length > 4) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.startsWith('\\[') && trimmed.endsWith('\\]') && trimmed.length > 4) {
    return trimmed.slice(2, -2).trim();
  }
  return latex;
}

function stripInsertionPlaceholders(latex: string): string {
  if (!latex) return latex;
  return latex.replace(/(^|[^\\])#\d+/g, "$1");
}

const EMPTY_STRUCTURE_REGEX = /\\(frac|sqrt|mathrm|text|mathbf|mathit|mathsf)\s*\{\s*\}\s*(?:\{\s*\})?/g;

function sanitizeMathLatex(latex: string): string {
  if (!latex) return latex;
  let stripped = stripMathDelimiters(latex);
  
  // Recursively remove empty structures until no more changes
  let prev;
  do {
    prev = stripped;
    stripped = stripped.replace(EMPTY_STRUCTURE_REGEX, '')
      .replace(/\\placeholder\b(\{[^}]*\})?/g, '')
      .replace(/\|\s*\|/g, '')
      .replace(/\{\s*\}/g, '');
  } while (prev !== stripped);

  return stripInsertionPlaceholders(stripped)
    .replace(/(^|[^\\])\$/g, "$1\\$")
    .trim();
}

function generateDefaultPreamble(doc: Document): string {
  const docClass = doc.metadata.documentClass || 'article';
  return `\\documentclass{${docClass}}
\\usepackage{xeCJK}
\\setCJKmainfont[BoldFont=HaranoAjiGothic-Bold]{HaranoAjiGothic-Regular}
\\setCJKsansfont[BoldFont=HaranoAjiGothic-Bold]{HaranoAjiGothic-Regular}
\\setCJKmonofont{HaranoAjiGothic-Regular}
\\usepackage{amsmath}
\\usepackage{amsthm}
\\usepackage{graphicx}

% Theorem environments
\\theoremstyle{definition}
\\newtheorem{definition}{定義}
\\newtheorem{theorem}{定理}
\\newtheorem{lemma}{補題}
\\newtheorem{corollary}{系}
\\newtheorem{proposition}{命題}
\\newtheorem{example}{例}
\\newtheorem{remark}{注意}
\\newtheorem*{proof}{証明}
`;
}

// ============================================================================
// Block Serialization
// ============================================================================

export function serializeBlock(block: DocumentBlock, docClass: string = 'article'): string {
  switch (block.type) {
    case 'paragraph':
      return serializeInlines(block.content.inlines);
      
    case 'heading':
      return serializeHeading(block.content.level, block.content.title, block.content.label, docClass);
      
    case 'list':
      return serializeList(block);
      
    case 'mathBlock':
      return serializeMathBlock(block);
      
    case 'mathEnv':
      return serializeMathEnv(block, docClass);
      
    case 'figure':
      return serializeFigure(block);
      
    case 'table':
      return serializeTable(block);
      
    case 'code':
      return serializeCode(block);
      
    case 'columnBreak':
      return serializeColumnBreak(block);
      
    case 'raw':
      return block.content.latex;

    case 'abstract':
      return `\\begin{abstract}\n${wrapCjkInInlineMathSegments(block.content.text)}\n\\end{abstract}`;
      
    case 'slideFrame':
      return serializeSlideFrame(block, docClass);

    case 'toc':
      return '\\tableofcontents';
      
    default:
      return '';
  }
}

function serializeHeading(level: HeadingLevel, title: string, label?: string, docClass: string = 'article'): string {
  // Adapt heading commands based on document class
  // article: section -> subsection -> subsubsection (no chapter)
  // report/book: chapter -> section -> subsection
  // beamer: level 1 = new frame with frametitle, level 2+ = inline bold text
  let command: string;
  
  if (docClass === 'beamer') {
    const safeTitle = wrapCjkInInlineMathSegments(title || "");
    if (level === 1) {
      // Level 1: new frame with frametitle
      return `\\end{frame}\n\n\\begin{frame}[allowframebreaks]\n\\frametitle{${safeTitle}}`;
    } else {
      // Level 2+: inline bold text within same frame
      return `\n\\textbf{${safeTitle}}\n`;
    }
  } else if (docClass === 'report' || docClass === 'book') {
    // report/book: chapter is top level
    const commands = ['chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'];
    command = commands[level - 1] || 'section';
  } else {
    // article and others: section is top level (no chapter)
    const commands = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'subparagraph'];
    command = commands[level - 1] || 'section';
  }
  
  const safeTitle = wrapCjkInInlineMathSegments(title || "");
  let result = `\\${command}{${safeTitle}}`;
  if (label) {
    result += `\n\\label{${label}}`;
  }
  return result;
}

function serializeColumnBreak(block: Extract<DocumentBlock, { type: 'columnBreak' }>): string {
  return `\\column{${block.content.width || '0.5\\textwidth'}}`;
}

function serializeCode(block: Extract<DocumentBlock, { type: 'code' }>): string {
  const { code, language, caption } = block.content;
  
  let result = '';
  if (language && language !== 'text') {
    result = `\\begin{lstlisting}[language=${language}]\n${code}\n\\end{lstlisting}`;
  } else {
    result = `\\begin{verbatim}\n${code}\n\\end{verbatim}`;
  }
  
  if (caption) {
    const safeCaption = wrapCjkInInlineMathSegments(caption);
    result = `\\begin{figure}[htbp]\n${result}\n\\caption{${safeCaption}}\n\\end{figure}`;
  }
  
  return result;
}

function serializeSlideFrame(block: Extract<DocumentBlock, { type: 'slideFrame' }>, docClass: string = 'beamer'): string {
  const { title, blocks } = block.content;
  
  let result = `\\begin{frame}`;
  if (title) {
    result += `{${wrapCjkInInlineMathSegments(title)}}`;
  }
  result += '\n';
  
  result += blocks.map(child => serializeBlock(child, docClass)).join('\n\n');
  
  result += '\n\\end{frame}';
  
  return result;
}

function serializeList(block: Extract<DocumentBlock, { type: 'list' }>): string {
  const env = block.content.listType;
  const items = block.content.items.map(item => 
    `  \\item ${serializeInlines(item.content)}`
  ).join('\n');
  
  return `\\begin{${env}}\n${items}\n\\end{${env}}`;
}

function serializeMathBlock(block: Extract<DocumentBlock, { type: 'mathBlock' }>): string {
  const { latex, environment = 'equation', numbered = true, label } = block.content;
  const env = numbered ? environment : `${environment}*`;
  const safeLatex = wrapCjkInMath(sanitizeMathLatex(latex || ""));
  const needsAlignedWrapper =
    environment === "equation" &&
    !!safeLatex &&
    !/\\begin\{/.test(safeLatex) &&
    (safeLatex.includes("\\\\") || /(^|[^\\])&/.test(safeLatex));
  const bodyLatex = needsAlignedWrapper
    ? `\\begin{aligned}\n${safeLatex}\n\\end{aligned}`
    : safeLatex;
  
  let result = `\\begin{${env}}\n${bodyLatex}\n`;
  if (label && numbered) {
    result += `\\label{${label}}\n`;
  }
  result += `\\end{${env}}`;
  
  return result;
}

function serializeMathEnv(block: Extract<DocumentBlock, { type: 'mathEnv' }>, docClass: string = 'article'): string {
  const { envType, inlines, displayMath, title, children } = block.content;
  
  let result = `\\begin{${envType}}`;
  if (title) {
    if (['frame', 'block', 'alertblock'].includes(envType)) {
      result += `{${wrapCjkInInlineMathSegments(title)}}`;
    } else {
      result += `[${wrapCjkInInlineMathSegments(title)}]`;
    }
  }
  result += `\n`;
  
  if (children && children.length > 0) {
    result += children.map(child => serializeBlock(child, docClass)).join('\n\n');
  } else { // Fallback
    if (inlines) {
      const textContent = serializeInlines(inlines);
      if (textContent.trim()) {
        result += textContent + `\n`;
      }
    }
    if (displayMath && displayMath.trim()) {
      result += `${wrapCjkInMath(sanitizeMathLatex(displayMath))}\n`;
    }
  }
  
  result += `\\end{${envType}}`;
  
  return result;
}

function serializeFigure(block: Extract<DocumentBlock, { type: 'figure' }>): string {
  const { imagePath, caption, label, width = '0.8\\textwidth', placement = 'htbp' } = block.content;
  
  let result = `\\begin{figure}[${placement}]\n`;
  result += `  \\centering\n`;
  result += `  \\includegraphics[width=${width}]{${imagePath}}\n`;
  if (caption) {
    result += `  \\caption{${wrapCjkInInlineMathSegments(caption)}}\n`;
  }
  if (label) {
    result += `  \\label{${label}}\n`;
  }
  result += `\\end{figure}`;
  
  return result;
}

function serializeTable(block: Extract<DocumentBlock, { type: 'table' }>): string {
  const { rows, caption, label, alignment } = block.content;
  
  if (rows.length === 0) return '';
  
  const cols = rows[0].length;
  const align = alignment || 'l'.repeat(cols);
  
  let result = `\\begin{table}[htbp]\n`;
  result += `  \\centering\n`;
  result += `  \\begin{tabular}{${align}}\n`;
  result += `    \\hline\n`;
  
  rows.forEach((row, i) => {
    const safeRow = row.map((cell) => wrapCjkInInlineMathSegments(cell || ""));
    result += `    ${safeRow.join(' & ')} \\\\\n`;
    if (i === 0) result += `    \\hline\n`;
  });
  
  result += `    \\hline\n`;
  result += `  \\end{tabular}\n`;
  
  if (caption) {
    result += `  \\caption{${wrapCjkInInlineMathSegments(caption)}}\n`;
  }
  if (label) {
    result += `  \\label{${label}}\n`;
  }
  result += `\\end{table}`;
  
  return result;
}

// ============================================================================
// Inline Serialization
// ============================================================================

function serializeInlines(inlines: InlineContent[]): string {
  return inlines.map(inline => {
    if (inline.type === 'text') {
      let text = inline.content;
      
      if (inline.formatting) {
        if (inline.formatting.bold) text = `\\textbf{${text}}`;
        if (inline.formatting.italic) text = `\\textit{${text}}`;
        if (inline.formatting.underline) text = `\\underline{${text}}`;
        if (inline.formatting.texttt) text = `\\texttt{${text}}`;
      }
      
      return text;
    } else if (inline.type === 'math') {
      const rawLatex = sanitizeMathLatex(inline.latex || "");
      // Skip empty inline math to avoid emitting `$$` which breaks layout/compilation
      if (!rawLatex.trim()) {
        return "";
      }
      if (rawLatex.startsWith('\\ce{')) {
        return `$\\ce{${rawLatex.slice(4, -1)}}$`; 
      }
      return `$${wrapCjkInMath(rawLatex)}$`;
    }
    
    return '';
  }).join('');
}

// Wrap Japanese characters inside math mode with \text{...}
// to ensure XeLaTeX renders them with text fonts (CJK-enabled preamble).
const CJK_REGEX = /[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
const TEXT_COMMANDS = new Set([
  "text",
  "textbf",
  "textit",
  "texttt",
  "textrm",
  "textsf",
  "textsc",
  "textnormal",
  "textup",
  "mbox",
]);

export function wrapCjkInMath(latex: string): string {
  if (!latex) return latex;
  if (!CJK_REGEX.test(latex)) return latex;

  const isCjk = (ch: string) => CJK_REGEX.test(ch);
  const groupStack: boolean[] = [];
  let textDepth = 0;

  let result = "";
  let i = 0;
  while (i < latex.length) {
    const ch = latex[i];

    if (ch === "\\") {
      const next = latex[i + 1];
      if (!next) {
        result += ch;
        i += 1;
        continue;
      }

      if (/[A-Za-z]/.test(next)) {
        let j = i + 1;
        while (j < latex.length && /[A-Za-z]/.test(latex[j])) {
          j += 1;
        }
        const cmd = latex.slice(i + 1, j);
        result += latex.slice(i, j);

        if (TEXT_COMMANDS.has(cmd)) {
          let k = j;
          while (k < latex.length && /\s/.test(latex[k])) {
            k += 1;
          }
          if (latex[k] === "{") {
            result += latex.slice(j, k + 1);
            groupStack.push(true);
            textDepth += 1;
            i = k + 1;
            continue;
          }
        }

        i = j;
        continue;
      }

      result += latex.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (ch === "{") {
      groupStack.push(false);
      result += ch;
      i += 1;
      continue;
    }

    if (ch === "}") {
      const wasText = groupStack.pop();
      if (wasText) textDepth -= 1;
      result += ch;
      i += 1;
      continue;
    }

    if (textDepth === 0 && isCjk(ch)) {
      let j = i + 1;
      while (j < latex.length && isCjk(latex[j])) {
        j += 1;
      }
      const segment = latex.slice(i, j);
      result += `\\text{${segment}}`;
      i = j;
      continue;
    }

    result += ch;
    i += 1;
  }

  return result;
}

function wrapCjkInInlineMathSegments(text: string): string {
  if (!text) return text;
  if (!CJK_REGEX.test(text)) return text;
  if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) return text;

  const isEscaped = (index: number) => {
    let backslashes = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
      backslashes += 1;
    }
    return backslashes % 2 === 1;
  };

  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("\\(", i)) {
      const end = text.indexOf("\\)", i + 2);
      if (end !== -1) {
        const content = text.slice(i + 2, end);
        result += `\\(${wrapCjkInMath(sanitizeMathLatex(content))}\\)`;
        i = end + 2;
        continue;
      }
    }

    if (text.startsWith("\\[", i)) {
      const end = text.indexOf("\\]", i + 2);
      if (end !== -1) {
        const content = text.slice(i + 2, end);
        result += `\\[${wrapCjkInMath(sanitizeMathLatex(content))}\\]`;
        i = end + 2;
        continue;
      }
    }

    if (text[i] === "$" && !isEscaped(i)) {
      const isDouble = text[i + 1] === "$";
      const delimiter = isDouble ? "$$" : "$";
      const start = i + delimiter.length;
      let j = start;
      while (j < text.length) {
        if (text.startsWith(delimiter, j) && !isEscaped(j)) {
          const content = text.slice(start, j);
          result += `${delimiter}${wrapCjkInMath(sanitizeMathLatex(content))}${delimiter}`;
          i = j + delimiter.length;
          break;
        }
        j += 1;
      }

      if (j >= text.length) {
        result += text[i];
        i += 1;
      }
      continue;
    }

    result += text[i];
    i += 1;
  }

  return result;
}

function ensureUsePackage(preamble: string, pkg: string): string {
  const pattern = new RegExp(String.raw`\\(usepackage|RequirePackage)(\[[^\]]*\])?\{[^}]*\b${pkg}\b[^}]*\}`, "m");
  if (pattern.test(preamble)) return preamble;

  const docclassMatch = preamble.match(/\\documentclass[^\n]*\n?/);
  if (docclassMatch) {
    return preamble.replace(docclassMatch[0], `${docclassMatch[0]}\\usepackage{${pkg}}\n`);
  }

  return `\\usepackage{${pkg}}\n${preamble}`;
}

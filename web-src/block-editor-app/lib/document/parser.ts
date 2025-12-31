/**
 * Simple TeX Parser
 * 
 * Converts LaTeX source to structured Document model.
 * Uses pattern matching for common constructs - not a full TeX parser.
 */

import type {
  Document,
  DocumentBlock,
  InlineContent,
  InlineText,
  ListType,
  MathBlockContent,
  MathEnvType,
} from './types';
import { nanoid } from 'nanoid';

// ============================================================================
// Parser Configuration
// ============================================================================

const HEADING_COMMANDS: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = {
  // For article class (default): section is top level = 1
  // For report/book class: chapter would be 1, but we serialize adaptively
  'chapter': 1,
  'section': 1,      // Changed: section is now level 1 (章)
  'subsection': 2,   // Changed: subsection is now level 2 (節)
  'subsubsection': 3, // Changed: subsubsection is now level 3 (項)
  'paragraph': 4,
  'subparagraph': 5
};

type MathEnvironment = NonNullable<MathBlockContent["environment"]>

const MATH_ENVIRONMENTS = [
  'equation', 'equation*',
  'align', 'align*',
  'gather', 'gather*',
  'multline', 'multline*'
] as const;

const LIST_ENVIRONMENTS: readonly ListType[] = ['itemize', 'enumerate', 'description'];

// Theorem-like environments that get rendered as mathEnv blocks
const MATH_ENV_TYPES: readonly MathEnvType[] = [
  'definition', 'theorem', 'lemma', 'proof', 'corollary', 'proposition', 'example', 'remark', 'law', 'block', 'alertblock', 'quote', 'frame', 'columns'
];

function isMathEnvironment(name: string): name is (typeof MATH_ENVIRONMENTS)[number] {
  return (MATH_ENVIRONMENTS as readonly string[]).includes(name)
}

function isListEnvironment(name: string): name is ListType {
  return (LIST_ENVIRONMENTS as readonly string[]).includes(name as string)
}

function isMathEnvType(name: string): name is MathEnvType {
  return (MATH_ENV_TYPES as readonly string[]).includes(name)
}

// Helper to parse mathEnv content into text/inline math and optional display math
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function parseMathEnvContent(content: string): { inlines: InlineContent[]; displayMath?: string } {
  // Check for display math environments (equation, align, etc.)
  const displayMathMatch = content.match(/\\begin\{(equation|equation\*|align|align\*|gather|gather\*|multline|multline\*)\}([\s\S]*?)\\end\{\1\}/);
  
  let textPart = content;
  let displayMath: string | undefined;
  
  if (displayMathMatch) {
    // Extract display math
    displayMath = displayMathMatch[2].trim();
    // Remove display math from text part
    textPart = content.replace(displayMathMatch[0], '').trim();
  }
  
  // Parse remaining text into inlines (text + inline math)
  const inlines = parseInlines(textPart);
  
  return { inlines, displayMath };
}

const INLINE_FORMATTERS: Record<string, 'bold' | 'italic' | 'texttt' | 'underline'> = {
  textbf: 'bold',
  textit: 'italic',
  texttt: 'texttt',
  underline: 'underline',
  emph: 'italic'
}

// ============================================================================
// Parsing Functions
// ============================================================================

const MAX_PARSE_TIME_MS = 3000; // 3 seconds max
const MAX_BLOCKS = 200; // Maximum blocks to parse

export function parseTeX(texContent: string): Document {
  const startTime = Date.now();
  
  try {
    // Safety check for very large content - just return raw
    if (texContent.length > 100000) {
      console.warn('Content too large, returning raw block');
      return {
        metadata: { documentClass: 'article' },
        blocks: [{ id: nanoid(), type: 'raw', content: { latex: texContent } }],
        layoutMode: 'flow'
      };
    }

    // Extract preamble and document body
    const { preamble, body, metadata } = extractPreambleAndBody(texContent);
    
    // Parse body into blocks with timeout
    const blocks = parseBody(body, startTime);
    
    return {
      metadata: {
        ...metadata,
        preamble
      },
      blocks,
      layoutMode: metadata.documentClass === 'beamer' ? 'slides' : 'flow'
    };
  } catch (error) {
    console.error('Parse error:', error);
    // Return minimal document with raw content
    return {
      metadata: {
        documentClass: 'article'
      },
      blocks: [{
        id: nanoid(),
        type: 'raw',
        content: { latex: texContent }
      }],
      layoutMode: 'flow'
    };
  }
}

function extractPreambleAndBody(texContent: string): { 
  preamble: string; 
  body: string; 
  metadata: { 
    title?: string; 
    author?: string; 
    documentClass?: string; 
    date?: string;
    marginSize?: string;
    acknowledgments?: string;
    references?: string;
  };
} {
  const beginDocMatch = texContent.match(/\\begin\{document\}/);
  const endDocMatch = texContent.match(/\\end\{document\}/);
  
  if (!beginDocMatch || !endDocMatch) {
    return {
      preamble: '',
      body: texContent,
      metadata: { documentClass: 'article' }
    };
  }
  
  const preamble = texContent.substring(0, beginDocMatch.index);
  const bodyStart = (beginDocMatch.index ?? 0) + beginDocMatch[0].length;
  let body = texContent.substring(bodyStart, endDocMatch.index);
  
  // Extract metadata from preamble first
  const documentClassMatch = preamble.match(/\\documentclass(?:\[.*?\])?\{(.*?)\}/);
  let titleMatch = preamble.match(/\\title\{(.*?)\}/);
  let authorMatch = preamble.match(/\\author\{(.*?)\}/);
  let dateMatch = preamble.match(/\\date\{(.*?)\}/);
  
  // If not found in preamble, try body (common in many templates)
  if (!titleMatch) {
    titleMatch = body.match(/\\title\{(.*?)\}/);
  }
  if (!authorMatch) {
    authorMatch = body.match(/\\author\{(.*?)\}/);
  }
  if (!dateMatch) {
    dateMatch = body.match(/\\date\{(.*?)\}/);
  }
  
  // Convert \today to actual date format
  let dateValue = dateMatch?.[1];
  if (dateValue === '\\today') {
    const now = new Date();
    dateValue = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  }
  
  // Extract acknowledgments section (謝辞)
  let acknowledgments: string | undefined;
  const ackSectionMatch = body.match(/\\section\*\{謝辞\}([\s\S]*?)(?=\\section|\\begin\{thebibliography\}|\\end\{document\}|$)/);
  if (ackSectionMatch) {
    acknowledgments = ackSectionMatch[1].trim();
    // Remove from body
    body = body.replace(/\\section\*\{謝辞\}[\s\S]*?(?=\\section|\\begin\{thebibliography\}|$)/, '');
  }
  
  // Extract geometry margin
  let marginSize: string | undefined;
  const geometryMatch = preamble.match(/\\geometry\{margin=([^}]+)\}/);
  if (geometryMatch) {
    marginSize = geometryMatch[1];
    // Remove from preamble but we need to mute 'preamble' which is const. Use a new variable or cast.
    // Actually, 'preamble' variable above is derived from substring.
    // Let's declare a mutable version.
  }
  let finalPreamble = preamble;
  if (geometryMatch) {
    finalPreamble = finalPreamble.replace(/\\geometry\{margin=[^}]+\}/g, '').trim();
  }
  
  // Extract bibliography/references
  let references: string | undefined;
  const biblioMatch = body.match(/\\begin\{thebibliography\}\{.*?\}([\s\S]*?)\\end\{thebibliography\}/);
  if (biblioMatch) {
    // Extract individual bibitem entries
    const bibitems = biblioMatch[1].match(/\\bibitem\{.*?\}[\s\S]*?(?=\\bibitem|\\end)/g);
    if (bibitems) {
      references = bibitems.map(item => {
        // Clean up the bibitem to just get the content
        return item.replace(/\\bibitem\{.*?\}\s*/, '').trim();
      }).join('\n');
    }
    // Remove from body
    body = body.replace(/\\begin\{thebibliography\}\{.*?\}[\s\S]*?\\end\{thebibliography\}/, '');
  }
  
  return {
    preamble: finalPreamble.trim(),
    body: body.trim(),
    metadata: {
      documentClass: documentClassMatch?.[1] ?? 'article',
      title: titleMatch?.[1],
      author: authorMatch?.[1],
      date: dateValue,
      marginSize,
      acknowledgments,
      references
    }
  };
}

function parseBody(body: string, startTime: number): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  let position = 0;
  let iterationCount = 0;
  const maxIterations = Math.min(body.length * 2, 50000); // Safety guard
  
  while (position < body.length && iterationCount < maxIterations && blocks.length < MAX_BLOCKS) {
    iterationCount++;
    const startPosition = position;
    
    // Check timeout every 100 iterations
    if (iterationCount % 100 === 0) {
      if (Date.now() - startTime > MAX_PARSE_TIME_MS) {
        console.warn('Parser timeout - returning partial result');
        break;
      }
    }
    
    // Skip whitespace
    const wsMatch = body.substring(position).match(/^\s+/);
    if (wsMatch) {
      position += wsMatch[0].length;
      continue;
    }
    
    const remaining = body.substring(position);
    
    // Try to match heading
    const headingResult = tryParseHeading(remaining);
    if (headingResult) {
      blocks.push(headingResult.block);
      position += headingResult.consumed;
      continue;
    }
    
    // Try to match environment (math, list, figure, etc.)
    const envResult = tryParseEnvironment(remaining);
    if (envResult) {
      if (envResult.block) {
        blocks.push(envResult.block);
      }
      position += envResult.consumed;
      continue;
    }
    
    // Try to match column break
    const colResult = tryParseColumnBreak(remaining);
    if (colResult) {
      blocks.push(colResult.block);
      position += colResult.consumed;
      continue;
    }

    // Try to match table of contents
    const tocResult = tryParseToc(remaining);
    if (tocResult) {
      blocks.push(tocResult.block);
      position += tocResult.consumed;
      continue;
    }
    
    // Try to match standalone commands like \\maketitle (skip these, no block created)
    const commandResult = tryParseStandaloneCommand(remaining);
    if (commandResult) {
      // These commands don't produce blocks; just consume them
      position += commandResult.consumed;
      continue;
    }
    
    // Try to match paragraph (plain text until next command/environment)
    const paraResult = tryParseParagraph(remaining);
    if (paraResult) {
      blocks.push(paraResult.block);
      position += paraResult.consumed;
      continue;
    }
    
    // If nothing matched, skip one character to avoid infinite loop
    position++;
    
    // Safety check: if we haven't made any progress, force skip
    if (position === startPosition) {
      position++;
    }
  }
  
  if (iterationCount >= maxIterations) {
    console.warn('Parser reached max iterations');
  }
  
  return blocks.length > 0 ? blocks : [createEmptyParagraph()];
}

// ============================================================================
// Block Parsers
// ============================================================================

// Commands that don't produce visible blocks but need to be consumed
const STANDALONE_COMMANDS = [
  'maketitle',
  // 'tableofcontents',  <-- Removed from here
  'newpage',
  'clearpage',
  'pagebreak',
  'vspace',
  'hspace',
  'noindent',
  'bigskip',
  'medskip',
  'smallskip',
  'vfill',
  'hfill',
  'centering',
  'raggedleft',
  'raggedright',
  'label',
  'ref',
  'qed',
  'caption',
  'includegraphics',
  'newtheorem',
  'theoremstyle',
  'usepackage',
  'bibliographystyle',
  'bibliography',
  // Title/author/date commands (when appearing in body)
  'title',
  'author',
  'date',
  'institute',
  // Beamer specific
  'usetheme',
  'usecolortheme',
  'usefonttheme',
  'titlepage',
  'frametitle',
  'framesubtitle',
  // Frontmatter/backmatter
  'frontmatter',
  'mainmatter',
  'backmatter',
  'appendix',
  // Other common
  'thanks',
  'footnote',
  'protect',
];

function tryParseStandaloneCommand(text: string): { consumed: number } | null {
  // Try matching commands with optional arguments like \vspace{1cm} or \vspace*{1cm}
  for (const cmd of STANDALONE_COMMANDS) {
    // Match \command, \command*, \command{arg}, or \command*{arg}
    const regex = new RegExp(`^\\\\${cmd}\\*?(?:\\{[^}]*\\})?(?:\\[[^\\]]*\\])?(?:\\{[^}]*\\})?`);
    const match = text.match(regex);
    if (match) {
      return { consumed: match[0].length };
    }
  }
  return null;
}

function tryParseHeading(text: string): { block: DocumentBlock; consumed: number } | null {
  for (const [cmd, level] of Object.entries(HEADING_COMMANDS)) {
    const regex = new RegExp(`^\\\\${cmd}\\{([^}]*)\\}`, 's');
    const match = text.match(regex);
    
    if (match) {
      return {
        block: {
          id: nanoid(),
          type: 'heading',
          content: {
            level,
            title: match[1].trim()
          }
        },
        consumed: match[0].length
      };
    }
  }
  
  return null;
}

function tryParseEnvironment(text: string): { block: DocumentBlock | null; consumed: number } | null {
  // Match \begin{envname} with optional argument like \begin{definition}[Title] or \begin{frame}{Title}
  const beginMatch = text.match(/^\\begin\{([^}]+)\}(?:(\[[^\]]*\])|(\{[^}]*\}))?/);
  if (!beginMatch) return null;
  
  const envName = beginMatch[1];
  // extract arg from either group 2 ([...]) or group 3 ({...})
  const rawArg = beginMatch[2] || beginMatch[3]; 
  const optionalArg = rawArg ? rawArg.slice(1, -1) : undefined;
  
  const endPattern = `\\end{${envName}}`;
  
  // Find matching \end{envname} - taking nesting into account
  let depth = 1;
  let searchPos = beginMatch[0].length;
  let endIndex = -1;
  
  const beginRegex = new RegExp(`\\\\begin\\{${envName.replace(/\*/g, '\\*')}\\}`, '');
  const endRegex = new RegExp(`\\\\end\\{${envName.replace(/\*/g, '\\*')}\\}`, '');
  
  while (depth > 0 && searchPos < text.length) {
    const nextBegin = text.substring(searchPos).match(beginRegex);
    const nextEnd = text.substring(searchPos).match(endRegex);
    
    const beginIndex = nextBegin ? (nextBegin.index ?? -1) + searchPos : -1;
    const endResultIndex = nextEnd ? (nextEnd.index ?? -1) + searchPos : -1;
    
    if (endResultIndex === -1) {
      // No closing tag found at all - incomplete environment
      return null;
    }
    
    if (beginIndex !== -1 && beginIndex < endResultIndex) {
      // Found nested begin before end
      depth++;
      searchPos = beginIndex + nextBegin![0].length;
    } else {
      // Found end
      depth--;
      if (depth === 0) {
        endIndex = endResultIndex;
      } else {
        searchPos = endResultIndex + nextEnd![0].length;
      }
    }
  }
  
  if (endIndex === -1) return null;
  
  const envContent = text.substring(beginMatch[0].length, endIndex).trim();
  const consumed = endIndex + endPattern.length;
  
  // Math environment (equation, align, etc.)
  if (isMathEnvironment(envName)) {
    return {
      block: {
        id: nanoid(),
        type: 'mathBlock',
        content: {
          latex: envContent,
          environment: envName.replace('*', '') as MathEnvironment,
          numbered: !envName.endsWith('*')
        }
      },
      consumed
    };
  }
  
  // Theorem-like environments (definition, theorem, lemma, proof, etc.)
  // Theorem-like environments (definition, theorem, lemma, proof, etc.)
  if (isMathEnvType(envName)) {
    // recursively parse the content to get children blocks
    const children = parseBody(envContent, Date.now());
    
    return {
      block: {
        id: nanoid(),
        type: 'mathEnv',
        content: {
          envType: envName,
          title: optionalArg,
          children: children,
          inlines: [], // Deprecated
        }
      },
      consumed
    };
  }
  
  // List environment
  if (isListEnvironment(envName)) {
    const items = parseListItems(envContent);
    return {
      block: {
        id: nanoid(),
        type: 'list',
        content: {
          listType: envName as ListType,
          items
        }
      },
      consumed
    };
  }

  if (envName === 'table') {
    const table = parseTable(envContent)
    return {
      block: {
        id: nanoid(),
        type: 'table',
        content: table
      },
      consumed
    }
  }

  // Figure environment
  if (envName === 'figure') {
    const { imagePath, caption } = parseFigure(envContent);
    return {
      block: {
        id: nanoid(),
        type: 'figure',
        content: { imagePath, caption }
      },
      consumed
    };
  }

  // Abstract environment - skip (handled by metadata)
  if (envName === 'abstract') {
    return { block: null, consumed }; // Skip but consume the content
  }
  
  // Bibliography environment - skip (should be in metadata)
  if (envName === 'thebibliography') {
    return { block: null, consumed }; // Skip but consume the content
  }
  
  // Acknowledgments environment - skip (should be in metadata)
  if (envName === 'acknowledgments' || envName === 'acknowledgement') {
    return { block: null, consumed }; // Skip but consume the content
  }
  
  // Code environment
  if (['lstlisting', 'verbatim', 'code'].includes(envName)) {
    // Extract language from optional argument if present (e.g. [language=Python])
    let language = '';
    if (optionalArg) {
      const langMatch = optionalArg.match(/language=([a-zA-Z0-9]+)/);
      if (langMatch) {
        language = langMatch[1];
      }
    }
    
    return {
      block: {
        id: nanoid(),
        type: 'code',
        content: {
          code: envContent,
          language: language || 'text'
        }
      },
      consumed
    };
  }

  // Unknown environment - treat as raw
  return {
    block: {
      id: nanoid(),
      type: 'raw',
      content: { latex: text.substring(0, consumed) }
    },
    consumed
  };
}

function tryParseColumnBreak(text: string): { block: DocumentBlock; consumed: number } | null {
  const match = text.match(/^\\column(?:\{([^}]*)\})?/);
  if (match) {
    return {
      block: {
        id: nanoid(),
        type: 'columnBreak',
        content: {
          width: match[1] || '0.5\\textwidth'
        }
      },
      consumed: match[0].length
    };
  }
  return null;
}

function tryParseToc(text: string): { block: DocumentBlock; consumed: number } | null {
  const match = text.match(/^\\tableofcontents/);
  if (match) {
    return {
      block: {
        id: nanoid(),
        type: 'toc',
        content: {}
      },
      consumed: match[0].length
    };
  }
  return null;
}

// Commands that signal the end of a paragraph
const PARAGRAPH_END_COMMANDS = [
  'begin', 'end', 'section', 'subsection', 'subsubsection', 
  'chapter', 'paragraph', 'subparagraph', 'maketitle', 
  'tableofcontents', 'newpage', 'clearpage', 'label', 
  'caption', 'ref', 'bibitem', 'item', 'column'
];

function isParagraphEndCommand(text: string, pos: number): boolean {
  for (const cmd of PARAGRAPH_END_COMMANDS) {
    if (text.substring(pos + 1, pos + 1 + cmd.length) === cmd) {
      const afterCmd = text[pos + 1 + cmd.length];
      // Verify it's a complete command (followed by { or non-alphanumeric)
      if (!afterCmd || afterCmd === '{' || afterCmd === '[' || afterCmd === '*' || /\s/.test(afterCmd) || !/[a-zA-Z]/.test(afterCmd)) {
        return true;
      }
    }
  }
  return false;
}

function tryParseParagraph(text: string): { block: DocumentBlock; consumed: number } | null {
  // Use a simple loop instead of complex regex to avoid catastrophic backtracking
  let endPos = 0;
  let i = 0;
  
  while (i < text.length) {
    // Check for backslash (potential command)
    if (text[i] === '\\') {
      if (isParagraphEndCommand(text, i)) {
        endPos = i;
        break;
      }
      // Skip the backslash and the next character (escaped character or command)
      i++;
      // Skip rest of command name if it's a letter
      while (i < text.length && /[a-zA-Z]/.test(text[i])) {
        i++;
      }
      continue;
    }
    i++;
  }
  
  // If we went through the whole text without finding an end command
  if (endPos === 0 && i >= text.length) {
    endPos = text.length;
  }
  
  // If nothing was consumed, return null
  if (endPos === 0) return null;
  
  const content = text.substring(0, endPos).trim();
  if (!content) return null;
  
  return {
    block: {
      id: nanoid(),
      type: 'paragraph',
      content: {
        inlines: parseInlines(content)
      }
    },
    consumed: endPos
  };
}

// ============================================================================
// Helper Parsers
// ============================================================================

function parseInlines(text: string, depth: number = 0): InlineContent[] {
  // Prevent deep recursion
  if (depth > 5) {
    return [{ type: 'text', content: text }]
  }
  
  const result: InlineContent[] = []
  let i = 0
  let iterations = 0
  const maxIterations = Math.min(text.length * 2, 5000)

  const pushText = (content: string, formatting?: InlineText["formatting"]) => {
    if (!content) return
    result.push({ id: nanoid(), type: 'text', content, formatting })
  }

  while (i < text.length && iterations < maxIterations) {
    iterations++
    const startI = i
    
    // Inline math with $
    if (text[i] === '$') {
      const end = text.indexOf('$', i + 1)
      if (end > i) {
        const latex = text.substring(i + 1, end)
        result.push({ id: nanoid(), type: 'math', latex })
        i = end + 1
        continue
      }
    }

    // Inline math with \( ... \)
    if (text.startsWith('\\(', i)) {
      const end = text.indexOf('\\)', i + 2)
      if (end > i) {
        const latex = text.substring(i + 2, end)
        result.push({ id: nanoid(), type: 'math', latex })
        i = end + 2
        continue
      }
    }

    // Chemical formula with \ce{...}
    if (text.startsWith('\\ce{', i)) {
      const group = readTeXGroup(text, i + 3) // skip \ce
      if (group) {
        // Keep the \ce command in the latex for rendering
        const latex = `\\ce{${group.content}}`
        result.push({ id: nanoid(), type: 'math', latex })
        i = group.nextIndex
        continue
      }
    }

    // Formatting commands e.g., \textbf{...}
    const formatMatch = text.substring(i).match(/^\\([a-zA-Z]+)\{/)
    if (formatMatch && INLINE_FORMATTERS[formatMatch[1]]) {
      const formatter = INLINE_FORMATTERS[formatMatch[1]]
      const group = readTeXGroup(text, i + formatMatch[0].length - 1)
      if (group) {
        const inner = parseInlines(group.content, depth + 1).map((inline) =>
          inline.type === 'text'
            ? {
                ...inline,
                formatting: { ...(inline.formatting || {}), [formatter]: true },
              }
            : inline,
        )
        result.push(...inner)
        i = group.nextIndex
        continue
      }
    }

    // Plain text until next special token
    const nextSpecial = findNextSpecial(text, i)
    const chunk = text.substring(i, nextSpecial === -1 ? text.length : nextSpecial)
    pushText(chunk)
    if (nextSpecial === -1) break
    i = nextSpecial
    
    // Safety: ensure progress
    if (i === startI) {
      i++
    }
  }

  return result.length ? result : [{ type: 'text', content: '' }]
}

function parseListItems(listContent: string): Array<{ id: string; content: InlineContent[] }> {
  const items: Array<{ id: string; content: InlineContent[] }> = [];
  
  // Split by \item - simpler and safer than regex
  const parts = listContent.split('\\item');
  
  for (let i = 1; i < parts.length; i++) {
    const itemText = parts[i].trim();
    if (itemText) {
      items.push({
        id: nanoid(),
        content: parseInlines(itemText.split('\n')[0].trim()) // Take first line only
      });
    }
  }
  
  return items.length > 0 ? items : [{ id: nanoid(), content: [{ type: 'text', content: '' }] }];
}

function parseFigure(figureContent: string): { imagePath: string; caption?: string } {
  const includeMatch = figureContent.match(/\\includegraphics(?:\[.*?\])?\{([^}]+)\}/);
  const captionMatch = figureContent.match(/\\caption\{([^}]+)\}/);
  
  return {
    imagePath: includeMatch?.[1] ?? '',
    caption: captionMatch?.[1]
  };
}

function parseTable(tableContent: string) {
  const caption = tableContent.match(/\\caption\{([^}]+)\}/)?.[1]
  const label = tableContent.match(/\\label\{([^}]+)\}/)?.[1]
  const tabularMatch = tableContent.match(/\\begin\{tabular\}\{([^}]*)\}([\s\S]*?)\\end\{tabular\}/)
  // Clean alignment string: remove @{...} and other modifiers
  const rawAlignment = tabularMatch?.[1] || ''
  const alignment = rawAlignment.replace(/@\{[^}]*\}/g, '').replace(/[^lcr]/g, '')
  const rows: string[][] = []

  if (tabularMatch) {
    let body = tabularMatch[2]
    // Remove booktabs commands explicitly (they appear as \\command in the string)
    const booktabsCommands = ['\\\\toprule', '\\\\midrule', '\\\\bottomrule', '\\\\hline']
    for (const cmd of booktabsCommands) {
      body = body.split(cmd).join('')
    }
    // Also remove \cmidrule{...} and \cline{...} with arguments
    body = body.replace(/\\\\cmidrule\{[^}]*\}/g, '')
    body = body.replace(/\\\\cline\{[^}]*\}/g, '')
    
    body
      .split(/\\\\/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .forEach((line) => {
        const cells = line
          .split("&")
          .map((cell) => cell.trim())
        
        if (cells.length > 0 && cells.some(c => c.length > 0)) {
          rows.push(cells)
        }
      })
  }

  return { rows: rows.length ? rows : [["", ""]], caption, label, alignment }
}

function createEmptyParagraph(): DocumentBlock {
  return {
    id: nanoid(),
    type: 'paragraph',
    content: {
      inlines: [{ type: 'text', content: '' }]
    }
  };
}

function readTeXGroup(text: string, braceIndex: number): { content: string; nextIndex: number } | null {
  if (text[braceIndex] !== '{') return null
  let depth = 0
  for (let i = braceIndex; i < text.length; i++) {
    if (text[i] === '{') depth++
    if (text[i] === '}') {
      depth--
      if (depth === 0) {
        return {
          content: text.substring(braceIndex + 1, i),
          nextIndex: i + 1,
        }
      }
    }
  }
  return null
}

function findNextSpecial(text: string, start: number) {
  const nextMath = text.indexOf('$', start)
  const nextCommand = text.indexOf('\\', start)
  const candidates = [nextMath, nextCommand].filter((v) => v >= 0)
  if (!candidates.length) return -1
  return Math.min(...candidates)
}

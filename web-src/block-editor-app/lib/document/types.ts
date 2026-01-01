/**
 * Document Model Types for Structured TeX Editor
 * 
 * This module defines the internal structured representation of TeX documents,
 * enabling Word/PowerPoint-like editing while maintaining TeX compatibility.
 */

// ============================================================================
// Block Types
// ============================================================================

export type BlockType =
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'mathBlock'
  | 'mathEnv'
  | 'inlineMath'
  | 'figure'
  | 'table'
  | 'code'
  | 'raw'
  | 'abstract'
  | 'slideFrame'
  | 'columnBreak'
  | 'toc'
  | 'pageBreak'
  | 'maketitle'
  | 'listoffigures'
  | 'listoftables'
  | 'appendix'
  | 'bibliography';

export type MathEnvType = 'definition' | 'theorem' | 'lemma' | 'proof' | 'corollary' | 'proposition' | 'example' | 'remark' | 'law' | 'block' | 'alertblock' | 'quote' | 'frame' | 'columns';

export type HeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=chapter, 1=section, 2=subsection, etc.
export type ListType = 'itemize' | 'enumerate' | 'description';

// ============================================================================
// Inline Content
// ============================================================================

export interface InlineText {
  id?: string;
  type: 'text';
  content: string;
  formatting?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    texttt?: boolean; // monospace
  };
}

export interface InlineMath {
  id?: string;
  type: 'math';
  latex: string;
}

export interface SoftBreak {
  id?: string;
  type: 'soft-break';
}

export type InlineContent = InlineText | InlineMath | SoftBreak;

// ============================================================================
// Block Content Definitions
// ============================================================================

export interface ParagraphContent {
  inlines: InlineContent[];
}

export interface HeadingContent {
  level: HeadingLevel;
  title: string;
  label?: string; // for \label{}
  command?: 'part' | 'chapter' | 'section' | 'subsection' | 'subsubsection' | 'paragraph' | 'subparagraph';
}

export interface ListItem {
  id: string;
  content: InlineContent[];
  nested?: ListBlock;
}

export interface ListContent {
  listType: ListType;
  items: ListItem[];
}

export interface MathBlockContent {
  latex: string;
  environment?: 'equation' | 'align' | 'gather' | 'multline';
  numbered?: boolean;
  label?: string;
}

export interface MathEnvContent {
  envType: MathEnvType;
  title?: string; // Optional title like "定理 1.1" or custom title
  children: DocumentBlock[]; // Nested blocks
  
  // Deprecated/Migration fields
  inlines?: InlineContent[]; 
  displayMath?: string; 
  label?: string;
}

export interface FigureContent {
  imagePath: string;
  caption?: string;
  label?: string;
  width?: string;
  placement?: string; // [htbp]
}

export interface TableContent {
  rows: string[][]; // Simple 2D array for now
  caption?: string;
  label?: string;
  alignment?: string; // column alignment like 'lrc'
}

export interface CodeContent {
  code: string;
  language?: string;
  caption?: string;
}

export interface RawContent {
  latex: string; // Unparsed LaTeX
}

export interface AbstractContent {
  text: string;
}

export interface SlideFrameContent {
  title?: string;
  blocks: DocumentBlock[];
}

export interface ColumnBreakContent {
  width?: string;
}

export interface PageBreakContent {
  type: 'newpage' | 'clearpage';
}

// ============================================================================
// Document Block (Union Type)
// ============================================================================

export interface BaseBlock {
  id: string;
  type: BlockType;
}

export interface ParagraphBlock extends BaseBlock {
  type: 'paragraph';
  content: ParagraphContent;
}

export interface HeadingBlock extends BaseBlock {
  type: 'heading';
  content: HeadingContent;
}

export interface ListBlock extends BaseBlock {
  type: 'list';
  content: ListContent;
}

export interface MathBlock extends BaseBlock {
  type: 'mathBlock';
  content: MathBlockContent;
}

export interface MathEnvBlock extends BaseBlock {
  type: 'mathEnv';
  content: MathEnvContent;
}

export interface FigureBlock extends BaseBlock {
  type: 'figure';
  content: FigureContent;
}

export interface TableBlock extends BaseBlock {
  type: 'table';
  content: TableContent;
}

export interface CodeBlock extends BaseBlock {
  type: 'code';
  content: CodeContent;
}

export interface RawBlock extends BaseBlock {
  type: 'raw';
  content: RawContent;
}

export interface AbstractBlock extends BaseBlock {
  type: 'abstract';
  content: AbstractContent;
}

export interface SlideFrameBlock extends BaseBlock {
  type: 'slideFrame';
  content: SlideFrameContent;
}

export interface ColumnBreakBlock extends BaseBlock {
  type: 'columnBreak';
  content: ColumnBreakContent;
}

export interface TocBlock extends BaseBlock {
  type: 'toc';
  content: Record<string, never>; // No content needed
}

export interface PageBreakBlock extends BaseBlock {
  type: 'pageBreak';
  content: PageBreakContent;
}

export interface MaketitleBlock extends BaseBlock {
  type: 'maketitle';
  content: Record<string, never>;
}

export type DocumentBlock =
  | ParagraphBlock
  | HeadingBlock
  | ListBlock
  | MathBlock
  | MathEnvBlock
  | FigureBlock
  | TableBlock
  | CodeBlock
  | RawBlock
  | AbstractBlock
  | SlideFrameBlock
  | ColumnBreakBlock
  | TocBlock
  | PageBreakBlock
  | MaketitleBlock
  | ListOfFiguresBlock
  | ListOfTablesBlock
  | AppendixBlock
  | BibliographyBlock;

export interface ListOfFiguresBlock extends BaseBlock {
  type: 'listoffigures';
  content: Record<string, never>;
}

export interface ListOfTablesBlock extends BaseBlock {
  type: 'listoftables';
  content: Record<string, never>;
}

export interface AppendixBlock extends BaseBlock {
  type: 'appendix';
  content: Record<string, never>;
}

export interface BibliographyBlock extends BaseBlock {
  type: 'bibliography';
  content: {
    file?: string; // for \bibliography{file}
  };
}

// ============================================================================
// Document Structure
// ============================================================================

export interface DocumentMetadata {
  title?: string;
  author?: string;
  affiliation?: string;
  studentId?: string;
  date?: string;
  documentClass?: string; // article, report, beamer, etc.
  preamble?: string; // Everything before \begin{document}
  marginSize?: string; // e.g. "1in", "25mm", "0.5in"
  references?: string; // Bibliography content
  acknowledgments?: string; // Acknowledgments section
  abstractText?: string; // Abstract content
}

export interface Document {
  metadata: DocumentMetadata;
  blocks: DocumentBlock[];
  layoutMode: 'flow' | 'slides'; // flow for article/report, slides for beamer
}

// ============================================================================
// Editor State
// ============================================================================

export interface EditorSelection {
  blockId: string;
  offset?: number; // For cursor position within inline content
}

export interface EditorState {
  document: Document;
  selection?: EditorSelection;
  history: Document[]; // For undo/redo
  historyIndex: number;
}

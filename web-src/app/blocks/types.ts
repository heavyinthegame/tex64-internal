import type { BlockApplyMode, BlockContent, BlockType } from "../types.js";

export type BlockContext = {
  type: "math" | "table";
  originalSnippet: string;
  prefix: string;
  suffix: string;
  envName?: string;
};

export type MathCellRange = {
  start: number;
  end: number;
  leading: string;
  trailing: string;
};

export type MathEditCell = {
  context: BlockContext;
  inner: string;
  range: MathCellRange;
};

export type DetectedBlockSnapshot = {
  type: BlockType;
  start: number;
  end: number;
  snippet: string;
  context: BlockContext | null;
  modelVersion: number;
};

export type PendingBlockApply = {
  mode: BlockApplyMode;
  draft: { snippet: string; content: BlockContent };
  detectedSnapshot?: DetectedBlockSnapshot | null;
  insertPosition?: { lineNumber: number; column: number } | null;
  insertRange?: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  } | null;
};

export type DetectedLatexBlock = {
  type: "math" | "table";
  content: string;
  start: number;
  end: number;
  envName?: string | null;
  inline?: boolean;
  fullMatch?: string;
};

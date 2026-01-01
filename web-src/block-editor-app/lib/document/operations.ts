/**
 * Document Operations - Helper functions for manipulating document blocks
 */

import type { Document, DocumentBlock, EditorState, MathEnvType, HeadingLevel, HeadingContent } from './types';
import { nanoid } from 'nanoid';

// ============================================================================
// Block Creation Helpers
// ============================================================================

export function createParagraphBlock(text: string = ''): DocumentBlock {
  return {
    id: nanoid(),
    type: 'paragraph',
    content: {
      inlines: text ? [{ type: 'text', content: text }] : []
    }
  };
}

export function createHeadingBlock(level: HeadingLevel, title: string): DocumentBlock {
  // Map level to command
  const commandMap: Record<number, HeadingContent['command']> = {
    0: 'chapter',
    1: 'section',
    2: 'subsection',
    3: 'subsubsection',
    4: 'paragraph',
    5: 'subparagraph',
    6: 'subparagraph',
  }
  return {
    id: nanoid(),
    type: 'heading',
    content: {
      level,
      title,
      command: commandMap[level] || 'section',
    }
  };
}

export function createListBlock(listType: 'itemize' | 'enumerate' = 'itemize'): DocumentBlock {
  return {
    id: nanoid(),
    type: 'list',
    content: {
      listType,
      items: [
        { id: nanoid(), content: [{ type: 'text', content: '' }] }
      ]
    }
  };
}

export function createMathBlock(latex: string = '', environment: 'equation' | 'align' = 'equation'): DocumentBlock {
  return {
    id: nanoid(),
    type: 'mathBlock',
    content: {
      latex,
      environment,
      numbered: true
    }
  };
}

export function createFigureBlock(imagePath = '', caption = ''): DocumentBlock {
  return {
    id: nanoid(),
    type: 'figure',
    content: {
      imagePath,
      caption,
      width: '0.8\\textwidth',
      placement: 'htbp'
    }
  }
}

export function createTableBlock(rows = 3, cols = 3): DocumentBlock {
  return {
    id: nanoid(),
    type: 'table',
    content: {
      rows: Array.from({ length: rows }).map((_, r) =>
        Array.from({ length: cols }).map((_, c) => (r === 0 ? `Header ${c + 1}` : ''))
      ),
      caption: '',
      alignment: 'l'.repeat(cols)
    }
  }
}

export function createAbstractBlock(text: string = ''): DocumentBlock {
  return {
    id: nanoid(),
    type: 'abstract',
    content: { text }
  }
}

export function createMathEnvBlock(
  envType: MathEnvType,
  content: string = ''
): DocumentBlock {
  return {
    id: nanoid(),
    type: 'mathEnv',
    content: {
      envType,
      children: [], // Initialize with empty children
      inlines: content ? [{ type: 'text', content }] : [],
      displayMath: undefined
    }
  }
}

export function createPageBreakBlock(type: 'newpage' | 'clearpage' = 'newpage'): DocumentBlock {
  return {
    id: nanoid(),
    type: 'pageBreak',
    content: { type }
  };
}

export function createMaketitleBlock(): DocumentBlock {
  return {
    id: nanoid(),
    type: 'maketitle',
    content: {}
  };
}

// ============================================================================
// Document Operations
// ============================================================================

export function addBlock(document: Document, block: DocumentBlock, afterBlockId?: string): Document {
  const blocks = [...document.blocks];
  
  if (afterBlockId) {
    const index = blocks.findIndex(b => b.id === afterBlockId);
    if (index !== -1) {
      blocks.splice(index + 1, 0, block);
    } else {
      blocks.push(block);
    }
  } else {
    blocks.push(block);
  }
  
  return { ...document, blocks };
}

export function removeBlock(document: Document, blockId: string): Document {
  return {
    ...document,
    blocks: document.blocks.filter(b => b.id !== blockId)
  };
}

export function updateBlock(document: Document, blockId: string, updates: Partial<DocumentBlock>): Document {
  return {
    ...document,
    blocks: document.blocks.map(b => {
      if (b.id === blockId) {
        // Type narrowing: updates must be compatible with the existing block type
        return { ...b, ...updates } as DocumentBlock;
      }
      return b;
    })
  };
}

export function moveBlock(document: Document, blockId: string, direction: 'up' | 'down'): Document {
  const blocks = [...document.blocks];
  const index = blocks.findIndex(b => b.id === blockId);
  
  if (index === -1) return document;
  
  const newIndex = direction === 'up' ? index - 1 : index + 1;
  
  if (newIndex < 0 || newIndex >= blocks.length) return document;
  
  [blocks[index], blocks[newIndex]] = [blocks[newIndex], blocks[index]];
  
  return { ...document, blocks };
}

// ============================================================================
// Editor State Operations
// ============================================================================

export function createEmptyDocument(): Document {
  return {
    metadata: {
      documentClass: 'article'
    },
    blocks: [createParagraphBlock()],
    layoutMode: 'flow'
  };
}

export function createInitialEditorState(): EditorState {
  return {
    document: createEmptyDocument(),
    history: [],
    historyIndex: -1
  };
}

export function addToHistory(state: EditorState, document: Document): EditorState {
  const history = state.history.slice(0, state.historyIndex + 1);
  history.push(document);
  
  return {
    ...state,
    document,
    history,
    historyIndex: history.length - 1
  };
}

export function undo(state: EditorState): EditorState {
  if (state.historyIndex <= 0) return state;
  
  const newIndex = state.historyIndex - 1;
  return {
    ...state,
    document: state.history[newIndex],
    historyIndex: newIndex
  };
}

export function redo(state: EditorState): EditorState {
  if (state.historyIndex >= state.history.length - 1) return state;
  
  const newIndex = state.historyIndex + 1;
  return {
    ...state,
    document: state.history[newIndex],
    historyIndex: newIndex
  };
}

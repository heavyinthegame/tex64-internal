import { Descendant, Text } from 'slate'
import type { DocumentBlock, InlineContent, ListType, MathEnvType, HeadingLevel, MathBlock } from '@/lib/document/types'
import { CustomElement, CustomText } from '@/types/slate'
import { nanoid } from 'nanoid'

type InlineSlateNode = CustomText | Extract<CustomElement, { type: 'inline-math' }>

const makeEmptyText = (): CustomText => ({ text: '' })

// --- Inline helpers --------------------------------------------------------

const toInlineNodes = (inlines: InlineContent[] = []): InlineSlateNode[] => {
  if (!inlines.length) return [makeEmptyText()]
  return inlines.map((inline) => {
    if (inline.type === 'math') {
      return {
        type: 'inline-math',
        id: inline.id,
        latex: inline.latex,
        children: [makeEmptyText()],
      } as InlineSlateNode
    }
    return {
      id: inline.id,
      text: inline.content,
      bold: inline.formatting?.bold,
      italic: inline.formatting?.italic,
      underline: inline.formatting?.underline,
      code: inline.formatting?.texttt,
    }
  })
}

const fromInlineNodes = (nodes: Descendant[]): InlineContent[] => {
  return nodes.map((child) => {
    if (typeof child !== 'object') {
      return { id: nanoid(), type: 'text', content: '' } as InlineContent
    }
    const inlineNode = child as CustomElement | CustomText
    if ((inlineNode as CustomElement).type === 'inline-math') {
      const mathNode = inlineNode as Extract<CustomElement, { type: 'inline-math' }>
      return {
        id: mathNode.id || nanoid(),
        type: 'math',
        latex: mathNode.latex || '',
      }
    }

    const textNode = inlineNode as CustomText
    return {
      id: textNode.id || nanoid(),
      type: 'text',
      content: textNode.text || '',
      formatting: {
        bold: textNode.bold || undefined,
        italic: textNode.italic || undefined,
        underline: textNode.underline || undefined,
        texttt: textNode.code || undefined,
      },
    }
  })
}

// --- To Slate Conversion ---------------------------------------------------

export function toSlate(blocks: DocumentBlock[]): Descendant[] {
  if (!blocks || blocks.length === 0) {
    return [{ type: 'paragraph', children: [makeEmptyText()] }]
  }
  return blocks.map(toSlateNode)
}

export function toSlateNode(block: DocumentBlock): CustomElement {
  switch (block.type) {
    case 'paragraph':
      return {
        type: 'paragraph',
        id: block.id,
        children: toInlineNodes(block.content.inlines),
      }
    case 'heading':
      return {
        type: 'heading',
        id: block.id,
        level: block.content.level,
        children: [{ text: block.content.title }],
      }
    case 'list':
      return {
        type: 'list',
        id: block.id,
        listType: block.content.listType,
        children: (block.content.items || []).map((item) => ({
          type: 'list-item',
          id: item.id,
          children: toInlineNodes(item.content),
        })),
      }
    case 'mathBlock':
      return {
        type: 'math-block',
        id: block.id,
        latex: block.content.latex || '',
        environment: block.content.environment,
        numbered: block.content.numbered,
        children: [makeEmptyText()],
      }
    case 'mathEnv':
      return {
        type: 'math-env',
        id: block.id,
        envType: block.content.envType,
        title: block.content.title,
        children: toSlate(block.content.children || []) as CustomElement[],
      }
    case 'figure':
      return {
        type: 'figure',
        id: block.id,
        imagePath: block.content.imagePath,
        caption: block.content.caption,
        label: block.content.label,
        width: block.content.width,
        placement: block.content.placement,
        children: [makeEmptyText()],
      }
    case 'table':
      return {
        type: 'table',
        id: block.id,
        rows: block.content.rows,
        caption: block.content.caption,
        label: block.content.label,
        alignment: block.content.alignment,
        children: [makeEmptyText()],
      }
    case 'abstract':
      return {
        type: 'abstract',
        id: block.id,
        children: toInlineNodes([{ type: 'text', content: block.content.text || '' }]),
      }
    case 'toc':
      return { type: 'toc', id: block.id, children: [makeEmptyText()] }
    case 'raw':
      return { type: 'raw', id: block.id, latex: block.content.latex, children: [makeEmptyText()] }
    case 'code':
      return {
        type: 'code',
        id: block.id,
        code: block.content.code,
        language: block.content.language,
        caption: block.content.caption,
        children: [makeEmptyText()],
      }
    case 'slideFrame':
      return {
        type: 'slide-frame',
        id: block.id,
        title: block.content.title,
        children: toSlate(block.content.blocks || []) as CustomElement[],
      }
    case 'columnBreak':
      return {
        type: 'column-break',
        id: block.id,
        width: block.content.width,
        children: [makeEmptyText()],
      }
    default:
      // Fallback to paragraph
      const fallbackBlock = block as { id?: string; content?: { inlines?: InlineContent[] } }
      return {
        type: 'paragraph',
        id: fallbackBlock.id || nanoid(),
        children: toInlineNodes(fallbackBlock.content?.inlines || []),
      }
  }
}

// --- From Slate Conversion -------------------------------------------------

// WeakMap cache to memoize fromSlateNode - prevents unnecessary re-renders
// by returning the same DocumentBlock object for the same Slate node reference
const fromSlateNodeCache = new WeakMap<CustomElement, DocumentBlock>()

export function fromSlate(nodes: Descendant[]): DocumentBlock[] {
  return nodes.map((node) => fromSlateNode(node as CustomElement))
}

export function fromSlateNode(node: CustomElement): DocumentBlock {
  // Check cache first - if node reference is the same, return cached block
  const cached = fromSlateNodeCache.get(node)
  if (cached) return cached

  // Create the block and cache it
  const block = fromSlateNodeUncached(node)
  fromSlateNodeCache.set(node, block)
  return block
}

function fromSlateNodeUncached(node: CustomElement): DocumentBlock {
  const id = (node as { id?: string }).id || nanoid()

  switch (node.type) {
    case 'paragraph':
      return {
        id,
        type: 'paragraph',
        content: { inlines: fromInlineNodes(node.children) },
      }
    case 'heading':
      {
        const rawLevel = typeof node.level === 'number' ? node.level : 1
        const level = Math.min(Math.max(rawLevel, 1), 6) as HeadingLevel
        return {
          id,
          type: 'heading',
          content: {
            level,
            title: (node.children?.map((c) => (Text.isText(c) ? c.text : '')).join('') || '').trim(),
          },
        }
      }
    case 'list':
      return {
        id,
        type: 'list',
        content: {
          listType: (node.listType as ListType) || 'itemize',
          items: (node.children || []).map((item) => {
            const listItem = item as Extract<CustomElement, { type: 'list-item' }>
            return {
              id: listItem.id || nanoid(),
              content: fromInlineNodes(listItem.children || []),
            }
          }),
        },
      }
    case 'math-block': {
      const mathNode = node as Extract<CustomElement, { type: 'math-block' }>
      return {
        id,
        type: 'mathBlock',
        content: {
          latex: (mathNode as { latex?: string }).latex || '',
          environment: (mathNode as { environment?: string }).environment,
          numbered: mathNode.numbered,
        },
      } as MathBlock
    }
    case 'math-env':
      return {
        id,
        type: 'mathEnv',
        content: {
          envType: node.envType as MathEnvType,
          title: node.title,
          children: fromSlate(node.children || []),
        },
      }
    case 'figure':
      return {
        id,
        type: 'figure',
        content: {
          imagePath: node.imagePath || '',
          caption: node.caption,
          label: node.label,
          width: node.width,
          placement: node.placement,
        },
      }
    case 'table':
      return {
        id,
        type: 'table',
        content: {
          rows: node.rows || [],
          caption: node.caption,
          label: node.label,
          alignment: node.alignment,
        },
      }
    case 'abstract':
      return {
        id,
        type: 'abstract',
        content: { text: node.children?.map((c) => (Text.isText(c) ? c.text : '')).join('') || '' },
      }
    case 'toc':
      return { id, type: 'toc', content: {} }
    case 'raw':
      return { id, type: 'raw', content: { latex: node.latex || '' } }
    case 'code':
      return {
        id,
        type: 'code',
        content: {
          code: node.code || '',
          language: node.language,
          caption: node.caption,
        },
      }
    case 'slide-frame':
      return {
        id,
        type: 'slideFrame',
        content: {
          title: node.title,
          blocks: fromSlate(node.children || []),
        },
      }
    case 'column-break':
      return {
        id,
        type: 'columnBreak',
        content: { width: node.width },
      }
    case 'inline-math':
      // Inline math shouldn't be top-level; wrap in paragraph to avoid data loss.
      return {
        id,
        type: 'paragraph',
        content: { inlines: fromInlineNodes([node]) },
      }
    default:
      return {
        id,
        type: 'paragraph',
        content: { inlines: fromInlineNodes(node.children || []) },
      }
  }
}

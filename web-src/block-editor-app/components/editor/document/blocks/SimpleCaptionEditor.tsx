"use client"

/**
 * InlineSlateEditor - 再利用可能なインラインSlateエディタ
 * 
 * キャプション、リスト項目、段落など、InlineContent[]を編集する
 * すべての入力欄で使用できる軽量コンポーネント。
 * 
 * メインエディタと同じ:
 * - InlineMathElement (数式)
 * - Leaf (テキストフォーマット)
 * を再利用することで、完全に同じ挙動を実現。
 */

import React, { useCallback, useMemo } from "react"
import { createEditor, Descendant } from "slate"
import { Slate, Editable, withReact, RenderElementProps, RenderLeafProps } from "slate-react"
import { withHistory } from "slate-history"
import type { InlineContent, InlineMath, InlineText } from "@/lib/document/types"
import { nanoid } from "nanoid"
import type { CustomText, InlineMathElement as SlateInlineMath, ParagraphElement } from "@/types/slate"

// Import shared components from main editor
import { InlineMathElement } from "@/components/editor/elements/InlineMathElement"
import { Leaf } from "@/components/editor/leafs/Leaf"

interface InlineSlateEditorProps {
  value: InlineContent[]
  placeholder?: string
  className?: string
  onChange: (value: InlineContent[]) => void
  onBlur?: () => void
  onFocusDom?: (el: HTMLElement) => void
  autoActivate?: boolean
}

// Convert InlineContent[] to Slate children
function inlineContentToSlateChildren(items: InlineContent[]): (CustomText | SlateInlineMath)[] {
  if (!items || items.length === 0) {
    return [{ text: "" }]
  }

  const children: (CustomText | SlateInlineMath)[] = []
  
  for (const item of items) {
    if (item.type === "text") {
      const textItem = item as InlineText
      children.push({
        id: item.id,
        text: textItem.content || "",
        bold: textItem.formatting?.bold,
        italic: textItem.formatting?.italic,
        code: textItem.formatting?.texttt,
      })
    } else if (item.type === "math") {
      const mathItem = item as InlineMath
      children.push({
        type: "inline-math",
        id: item.id || nanoid(),
        latex: mathItem.latex || "",
        children: [{ text: "" }],
      } as SlateInlineMath)
    }
  }

  if (children.length === 0) {
    children.push({ text: "" })
  }

  return children
}

// Convert Slate children to InlineContent[]
function slateChildrenToInlineContent(nodes: (CustomText | SlateInlineMath)[]): InlineContent[] {
  const result: InlineContent[] = []

  for (const node of nodes) {
    if ("type" in node && node.type === "inline-math") {
      result.push({
        id: node.id || nanoid(),
        type: "math",
        latex: node.latex || "",
      })
    } else if ("text" in node) {
      const textNode = node as CustomText
      if (textNode.text || nodes.length === 1) {
        result.push({
          id: textNode.id || nanoid(),
          type: "text",
          content: textNode.text || "",
          formatting: {
            bold: textNode.bold,
            italic: textNode.italic,
            texttt: textNode.code,
          },
        })
      }
    }
  }

  if (result.length === 0) {
    result.push({ id: nanoid(), type: "text", content: "" })
  }

  return result
}

export function InlineSlateEditor({
  value,
  placeholder,
  className,
  onChange,
  onBlur,
  onFocusDom,
  autoActivate,
}: InlineSlateEditorProps) {
  // Create editor with inline math support - stable instance
  const editor = useMemo(() => {
    const e = withHistory(withReact(createEditor()))
    
    const { isInline, isVoid } = e
    e.isInline = (element) => element.type === "inline-math" ? true : isInline(element)
    e.isVoid = (element) => element.type === "inline-math" ? true : isVoid(element)
    
    return e
  }, [])

  // Initial Slate value
  const initialValue = useMemo((): Descendant[] => [{
    type: "paragraph",
    id: nanoid(),
    children: inlineContentToSlateChildren(value),
  } as ParagraphElement], [])

  // Handle Slate changes - simple, no external sync needed
  const handleChange = useCallback((slateValue: Descendant[]) => {
    const firstNode = slateValue[0] as ParagraphElement | undefined
    if (firstNode?.children) {
      const inlineContent = slateChildrenToInlineContent(firstNode.children as (CustomText | SlateInlineMath)[])
      onChange(inlineContent)
    }
  }, [onChange])

  // Render element - reuse InlineMathElement for math
  const renderElement = useCallback((props: RenderElementProps) => {
    if (props.element.type === "inline-math") {
      return <InlineMathElement {...props} />
    }
    return <span {...props.attributes}>{props.children}</span>
  }, [])

  // Render leaf - reuse Leaf for text formatting
  const renderLeaf = useCallback((props: RenderLeafProps) => {
    return <Leaf {...props} />
  }, [])

  // Prevent Enter from creating new paragraphs
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault()
    }
    event.stopPropagation()
  }, [])

  return (
    <div 
      className={`relative leading-relaxed text-slate-800 ${className || ""}`}
      onFocus={() => onFocusDom?.(document.activeElement as HTMLElement)}
      onBlur={onBlur}
    >
      <Slate editor={editor} initialValue={initialValue} onChange={handleChange}>
        <Editable
          renderElement={renderElement}
          renderLeaf={renderLeaf}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="outline-none min-h-[24px]"
          autoFocus={autoActivate}
        />
      </Slate>
    </div>
  )
}

// Backward compatibility export
export { InlineSlateEditor as SimpleCaptionEditor }

import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { RenderElementProps, ReactEditor, useSlateStatic } from 'slate-react'
import { Transforms } from 'slate'
import { SimpleMathField } from '@/components/editor/document/blocks/SimpleMathField'
import type { InlineMathElement as SlateInlineMath } from '@/types/slate'
import { nanoid } from 'nanoid'
import katex from 'katex'


export const InlineMathElement = ({ attributes, children, element }: RenderElementProps) => {
  const editor = useSlateStatic()
  const mathElement = element as SlateInlineMath
  const latex = mathElement.latex || ''
  const [fallbackId] = useState(() => nanoid())
  const inlineId = mathElement.id || fallbackId
  
  // Track if we're in edit mode
  const [isEditing, setIsEditing] = useState(false)
  const containerRef = useRef<HTMLSpanElement>(null)
  const katexRef = useRef<HTMLSpanElement>(null)
  
  // Store size from KaTeX render to prevent size jump
  const [fixedSize, setFixedSize] = useState<{ width: number; height: number } | null>(null)
  
  // Store click ratio
  const [clickRatio, setClickRatio] = useState<number | undefined>(undefined)

  const handleUpdate = (newLatex: string) => {
    const path = ReactEditor.findPath(editor, mathElement)
    Transforms.setNodes(editor, { latex: newLatex } as Partial<SlateInlineMath>, { at: path })
  }

  const handleDelete = () => {
    const path = ReactEditor.findPath(editor, mathElement)
    Transforms.removeNodes(editor, { at: path })
  }

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Capture size before switching to edit mode
    if (katexRef.current) {
      const rect = katexRef.current.getBoundingClientRect()
      setFixedSize({ width: rect.width, height: rect.height })
    }
    setIsEditing(true)
  }

  const handleBlur = () => {
    // Small delay to allow click events to process
    setTimeout(() => {
      setIsEditing(false)
      setFixedSize(null)
    }, 100)
  }

  // Render KaTeX HTML - use colored placeholder for empty
  const katexHtml = (() => {
    if (!latex) {
      return `<span style="color: #9ca3af; font-style: italic;">数式</span>`
    }
    try {
      return katex.renderToString(latex, {
        throwOnError: false,
        displayMode: false,
        output: 'html',
        macros: {
          "\\placeholder": "{\\color{#e2e8f0}\\boxed{\\phantom{x}}}",
        }
      })
    } catch {
      return `<span style="color: red;">Error</span>`
    }
  })()

  return (
    <span {...attributes} contentEditable={false} className="inline-block align-middle mx-0.5">
      {isEditing ? (
        <span
          style={{
            display: 'inline-block',
            minWidth: fixedSize ? `${fixedSize.width}px` : undefined,
            minHeight: fixedSize ? `${fixedSize.height}px` : undefined,
            verticalAlign: 'middle',
          }}
        >
          <SimpleMathField
            asInline
            instanceId={inlineId}
            value={latex}
            onChange={handleUpdate}
            onDelete={handleDelete}
            onBlur={handleBlur}
            autoFocus
            style={{ verticalAlign: 'middle' }}
          />
        </span>
      ) : (
        <span
          ref={katexRef}
          onClick={handleClick}
          className="inline-block cursor-pointer hover:bg-blue-50 rounded transition-colors border border-slate-300 px-1"
          style={{ verticalAlign: 'middle' }}
          title="クリックして編集"
          data-math-instance={inlineId}
          dangerouslySetInnerHTML={{ __html: katexHtml }}
        />
      )}
      <span style={{ display: 'none' }}>{children}</span>
    </span>
  )
}

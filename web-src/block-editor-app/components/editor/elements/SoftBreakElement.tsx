import { useRef } from 'react'
import { RenderElementProps, ReactEditor, useSlateStatic } from 'slate-react'
import { Transforms, Editor } from 'slate'
import type { SoftBreakElement as SlateSoftBreak } from '@/types/slate'

export const SoftBreakElement = ({ attributes, children, element }: RenderElementProps) => {
  const editor = useSlateStatic()
  const breakElement = element as SlateSoftBreak
  const containerRef = useRef<HTMLSpanElement>(null)

  // Handle mouse down on element to position cursor correctly
  // Exactly the same logic as InlineMathElement
  const handleContainerMouseDown = (e: React.MouseEvent) => {
    // Get click position relative to element
    if (!containerRef.current) return
    
    const rect = containerRef.current.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const midpoint = rect.width / 2
    
    try {
      const path = ReactEditor.findPath(editor, breakElement)
      
      // If click is on the right half, place cursor AFTER the element
      // If click is on the left half, place cursor BEFORE the element
      if (clickX > midpoint) {
        // Place cursor after soft-break
        const afterPoint = Editor.after(editor, path)
        if (afterPoint) {
          e.preventDefault()
          e.stopPropagation()
          Transforms.select(editor, afterPoint)
          // Don't call ReactEditor.focus here - it causes scrolling
        }
      } else {
        // Place cursor before soft-break
        const beforePoint = Editor.before(editor, path)
        if (beforePoint) {
          e.preventDefault()
          e.stopPropagation()
          Transforms.select(editor, beforePoint)
          // Don't call ReactEditor.focus here - it causes scrolling
        }
      }
    } catch {
      // Path not found, let default behavior handle it
    }
  }

  // Structure exactly matches InlineMathElement
  return (
    <span {...attributes}>
      <span
        ref={containerRef}
        contentEditable={false}
        onMouseDown={handleContainerMouseDown}
        className="inline-block align-middle mx-0.5"
        style={{ userSelect: 'none' }}
      >
        {/* Line break symbol - styled similarly to inline-math */}
        <span 
          className="inline-block cursor-default rounded transition-colors border border-slate-300 px-1 bg-slate-50"
          style={{ verticalAlign: 'middle' }}
          title="改行 (\\)"
        >
          <span className="text-slate-400 text-xs">↵</span>
        </span>
      </span>
      
      {/* Actual line break for visual rendering - outside the container */}
      <br />
      
      {/* Required: Slate void elements must render children */}
      <span style={{ display: 'none' }}>{children}</span>
    </span>
  )
}

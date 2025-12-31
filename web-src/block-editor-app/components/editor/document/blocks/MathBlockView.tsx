"use client"

import { useState, useRef } from "react"
import { useLanguage } from "@/lib/i18n/LanguageContext"
import { AlignEditor } from "./AlignEditor"
import { SimpleMathField } from "./SimpleMathField"
import type { MathBlock } from "@/lib/document/types"
import type { MathfieldElement as MathfieldElementType } from "mathlive"
import katex from "katex"


interface MathBlockViewProps {
  block: MathBlock
  equationNumber?: string
  onUpdate: (updates: Partial<MathBlock>) => void
  onDelete?: () => void
}

const MULTI_LINE_ENVIRONMENTS = [
  'align', 'align*',
  'gather', 'gather*',
  'multline', 'multline*',
  'flalign', 'flalign*'
]

export function MathBlockView({ block, equationNumber, onUpdate, onDelete }: MathBlockViewProps) {
  const { language } = useLanguage()
  const environment = block.content.environment || "equation"
  const isMultiLine = MULTI_LINE_ENVIRONMENTS.includes(environment)
  
  // Track if we're in edit mode
  const [isEditing, setIsEditing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const katexRef = useRef<HTMLDivElement>(null)
  
  // Store size from KaTeX render to prevent size jump
  const [fixedHeight, setFixedHeight] = useState<number | null>(null)
  
  // Store click ratio for initial cursor positioning
  const [clickRatio, setClickRatio] = useState<number | undefined>(undefined)

  const handleUpdate = (newLatex: string) => {
    onUpdate({
      ...block,
      content: {
        ...block.content,
        latex: newLatex,
      },
    })
  }

  const focusMathFieldToEnd = (container: HTMLElement) => {
    const mathField = container.querySelector("math-field") as
      | (MathfieldElementType & { executeCommand?: (...args: unknown[]) => boolean })
      | null
    if (!mathField) return

    mathField.focus?.()
    requestAnimationFrame(() => {
      if (typeof mathField.executeCommand === "function") {
        const moved = mathField.executeCommand("moveToMathfieldEnd")
        if (!moved) {
          mathField.executeCommand(["moveToMathfieldEnd"])
        }
      }
    })
  }

  const handleClick = (e: React.MouseEvent) => {
    // Capture height before switching to edit mode
    if (katexRef.current) {
      const rect = katexRef.current.getBoundingClientRect()
      setFixedHeight(rect.height)
    }
    setIsEditing(true)
  }

  const handleBlur = () => {
    // Small delay to allow click events to process
    setTimeout(() => {
      setIsEditing(false)
      setFixedHeight(null)
    }, 150)
  }

  // Render KaTeX HTML for display mode - use colored placeholder for empty
  const latex = block.content.latex || ''
  const katexHtml = (() => {
    if (!latex) {
      return `<span style="color: #9ca3af; font-style: italic;">数式を入力</span>`
    }
    try {
      return katex.renderToString(latex, {
        throwOnError: false,
        displayMode: true,
        output: 'html',
      })
    } catch {
      return `<span style="color: red;">Error</span>`
    }
  })()

  return (
    <div className="bg-slate-50 rounded-lg" contentEditable={false}>
      <div className="p-3">
        <div className="w-full overflow-x-auto overflow-y-hidden flex items-center gap-3">
          <div className="flex-1 min-w-0">
            {isMultiLine ? (
              // AlignEditor always shows MathLive (complex multi-line editing)
              <AlignEditor
                latex={block.content.latex}
                onChange={handleUpdate}
              />
            ) : isEditing ? (
              // Edit mode: show MathLive with autoFocus
              <div
                ref={containerRef}
                className="w-full min-w-min bg-white border border-slate-200 rounded cursor-text hover:border-purple-300 focus-within:border-purple-400 transition-colors flex items-center box-border"
                style={{ minHeight: fixedHeight ? `${fixedHeight}px` : '60px', padding: '8px' }}
                onMouseDown={(e) => {
                  const target = e.target as HTMLElement
                  const path = (e.nativeEvent as MouseEvent).composedPath?.() || []
                  const clickedMathField =
                    !!target.closest?.("math-field") ||
                    path.some((node) => node instanceof HTMLElement && node.tagName === "MATH-FIELD")
                  if (clickedMathField) return
                  e.preventDefault()
                  focusMathFieldToEnd(e.currentTarget)
                }}
              >
                <SimpleMathField
                  value={block.content.latex}
                  onChange={handleUpdate}
                  onDelete={onDelete}
                  onBlur={handleBlur}
                  autoFocus
                  className="text-lg w-full"
                  style={{ margin: 0, padding: 0 }}
                />
              </div>
            ) : (
              // Display mode: show KaTeX (lightweight, no initialization cost)
              <div
                ref={katexRef}
                onClick={handleClick}
                className="w-full min-w-min min-h-[60px] bg-white border border-slate-200 rounded cursor-text hover:border-purple-300 transition-colors flex items-center box-border"
                style={{ justifyContent: 'flex-start', padding: '8px' }}
                dangerouslySetInnerHTML={{ __html: katexHtml }}
              />
            )}
          </div>
          {equationNumber && (
            <div className="flex-shrink-0 text-slate-500 font-medium text-sm select-none">
              ({equationNumber})
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

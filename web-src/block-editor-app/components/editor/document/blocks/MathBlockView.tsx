"use client"

import { useState, useRef, useEffect } from "react"
import { useLanguage } from "@/lib/i18n/LanguageContext"
import { AlignEditor } from "./AlignEditor"
import { SimpleMathField } from "./SimpleMathField"
import type { MathBlock } from "@/lib/document/types"
import type { MathfieldElement as MathfieldElementType } from "mathlive"
import katex from "katex"
import { Settings2, Check } from "lucide-react"


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

  // ... inside MathBlockView
  const [showSettings, setShowSettings] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)

  // Close settings when clicking outside
  useEffect(() => {
    if (showSettings) {
      const handleClickOutside = (e: MouseEvent) => {
        if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
          setShowSettings(false)
        }
      }
      document.addEventListener("mousedown", handleClickOutside)
      return () => document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [showSettings])


  return (
    <div className="bg-slate-50 rounded-lg relative group/math" contentEditable={false}>
      <div className="p-3">
        {/* Settings Trigger - Visible on Hover or when menu open */}
        <div className={`absolute top-2 right-2 z-10 ${showSettings ? 'opacity-100' : 'opacity-0 group-hover/math:opacity-100'} transition-opacity`}>
          <button
            onClick={(e) => { e.stopPropagation(); setShowSettings(!showSettings) }}
            className="p-1.5 rounded-md hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors"
          >
            <Settings2 className="w-4 h-4" />
          </button>
          
          {/* Settings Menu */}
          {showSettings && (
            <div 
              ref={settingsRef}
              className="absolute right-0 top-full mt-1 w-48 bg-white rounded-lg shadow-xl border border-slate-200 py-1 flex flex-col z-20"
            >
              <div className="px-3 py-1.5 text-xs font-semibold text-slate-500 border-b border-slate-100">
                数式設定
              </div>
              
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onUpdate({ ...block, content: { ...block.content, environment: "equation" } });
                  setShowSettings(false);
                }}
                className={`px-3 py-2 text-left text-sm hover:bg-slate-50 flex items-center justify-between ${environment === "equation" ? "text-indigo-600 bg-indigo-50" : "text-slate-700"}`}
              >
                <span>シンプル (Equation)</span>
                {environment === "equation" && <Check className="w-3.5 h-3.5" />}
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onUpdate({ ...block, content: { ...block.content, environment: "align" } });
                  setShowSettings(false);
                }}
                className={`px-3 py-2 text-left text-sm hover:bg-slate-50 flex items-center justify-between ${environment === "align" ? "text-indigo-600 bg-indigo-50" : "text-slate-700"}`}
              >
                <span>複数行 (Align)</span>
                {environment === "align" && <Check className="w-3.5 h-3.5" />}
              </button>

              <div className="my-1 border-t border-slate-100" />

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  // Toggle numbering implies switching between "env" and "env*"
                  // But our internal model uses `numbered` boolean or implied by env name
                  // For simplicity in this logical model, let's assume we map "equation" <-> "equation*" based on a boolean, 
                  // OR we just explicitly switch the string.
                  // The parser logic should handle this. Let's flip the `numbered` property if it exists, 
                  // or flip the environment string.
                  // If current ends with *, remove it. If not, add it.
                  const isStarred = environment.endsWith("*");
                  const base = isStarred ? environment.slice(0, -1) : environment;
                  const newEnv = isStarred ? base : `${base}*`;
                  onUpdate({ ...block, content: { ...block.content, environment: newEnv as any } });
                }}
                className="px-3 py-2 text-left text-sm hover:bg-slate-50 text-slate-700 flex items-center gap-2"
              >
                <div className={`w-4 h-4 rounded border flex items-center justify-center ${!environment.endsWith("*") ? "bg-indigo-500 border-indigo-500" : "border-slate-300"}`}>
                   {!environment.endsWith("*") && <Check className="w-3 h-3 text-white" />}
                </div>
                <span>番号を付ける</span>
              </button>
            </div>
          )}
        </div>

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
          {/* Equation number visualization (only if not starred) */}
          {!environment.endsWith("*") && (
            <div className="flex-shrink-0 text-slate-500 font-medium text-sm select-none">
              ({equationNumber || "?"})
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import katex from "katex"
import "katex/contrib/mhchem"
import { useMathField } from "@/lib/math/MathFieldContext"
import type { MathfieldElement as MathfieldElementType } from "mathlive"
import { wrapCjkInMath } from "@/lib/document/serializer"

interface MathCellInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

type InlineMathFieldElement = MathfieldElementType & {
  setValue?: (value: string) => void
  getValue?: (format?: string) => string
}

/**
 * An input that renders inline math ($...$) with KaTeX in preview mode.
 * When clicking on math, opens MathLive editor for WYSIWYG editing.
 */
export function MathCellInput({ value, onChange, placeholder, className }: MathCellInputProps) {
  const [editingMathIndex, setEditingMathIndex] = useState<number | null>(null)
  const [editingText, setEditingText] = useState(false)
  const previewRef = useRef<HTMLDivElement>(null)
  const textInputRef = useRef<HTMLTextAreaElement>(null)
  const mathFieldRef = useRef<InlineMathFieldElement | null>(null)
  const [mathLiveReady, setMathLiveReady] = useState(false)
  
  const { registerMathField, unregisterMathField, setActiveMathField } = useMathField()
  const instanceId = useMemo(() => `table-cell-${Math.random().toString(36).slice(2)}`, [])

  // Load MathLive on mount
  useEffect(() => {
    import("mathlive").then(() => setMathLiveReady(true)).catch(() => {})
  }, [])

  // Parse value into parts (text and math)
  const parts = useMemo(() => {
    const result: Array<{ type: 'text' | 'math'; content: string; startIndex: number }> = []
    let remaining = value
    let globalIndex = 0
    
    while (remaining.length > 0) {
      const mathMatch = remaining.match(/\$([^$]+)\$/)
      if (mathMatch && mathMatch.index !== undefined) {
        // Add text before math
        if (mathMatch.index > 0) {
          result.push({ type: 'text', content: remaining.slice(0, mathMatch.index), startIndex: globalIndex })
          globalIndex += mathMatch.index
        }
        // Add math
        result.push({ type: 'math', content: mathMatch[1], startIndex: globalIndex })
        globalIndex += mathMatch[0].length
        remaining = remaining.slice(mathMatch.index + mathMatch[0].length)
      } else {
        // Rest is text
        if (remaining) {
          result.push({ type: 'text', content: remaining, startIndex: globalIndex })
        }
        break
      }
    }
    return result
  }, [value])

  // Update a specific math part
  const updateMathPart = useCallback((partIndex: number, newLatex: string) => {
    const normalized = wrapCjkInMath(newLatex)
    let newValue = ''
    parts.forEach((part, i) => {
      if (i === partIndex) {
        newValue += `$${normalized}$`
      } else if (part.type === 'math') {
        newValue += `$${part.content}$`
      } else {
        newValue += part.content
      }
    })
    onChange(newValue)
    setEditingMathIndex(null)
  }, [parts, onChange])

  // Setup MathLive field
  const setupMathField = useCallback((el: InlineMathFieldElement | null, latex: string, partIndex: number) => {
    if (!el) {
      if (mathFieldRef.current) {
        unregisterMathField(instanceId)
      }
      mathFieldRef.current = null
      return
    }
    
    mathFieldRef.current = el
    
    // Configure MathLive
    const mathFieldWithOptions = el as unknown as { setOptions?: (options: Record<string, unknown>) => void }
    mathFieldWithOptions.setOptions?.({
      virtualKeyboardMode: "off",
      virtualKeyboards: "",
      readOnly: false,
      smartMode: false,
      defaultMode: "math",
    })
    
    el.style.setProperty("--caret-color", "#3b82f6")
    
    registerMathField(instanceId, el)
    setActiveMathField(instanceId)
    
    const normalizedLatex = wrapCjkInMath(latex || "")
    el.setValue?.(normalizedLatex)
    setTimeout(() => el.focus?.(), 50)

    const handleInput = () => {
      const raw = el.getValue?.("latex") || ""
      const normalized = wrapCjkInMath(raw)
      if (normalized !== raw) {
        el.setValue?.(normalized)
      }
    }

    const handleBlur = () => {
      const newValue = wrapCjkInMath(el.getValue?.("latex") || latex)
      updateMathPart(partIndex, newValue)
      unregisterMathField(instanceId)
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        const newValue = wrapCjkInMath(el.getValue?.("latex") || latex)
        updateMathPart(partIndex, newValue)
        unregisterMathField(instanceId)
      }
      if (e.key === "Escape") {
        setEditingMathIndex(null)
        unregisterMathField(instanceId)
      }
    }

    el.addEventListener("input", handleInput)
    el.addEventListener("blur", handleBlur)
    el.addEventListener("keydown", handleKeyDown as EventListener)

    return () => {
      el.removeEventListener("input", handleInput)
      el.removeEventListener("blur", handleBlur)
      el.removeEventListener("keydown", handleKeyDown as EventListener)
    }
  }, [instanceId, registerMathField, unregisterMathField, setActiveMathField, updateMathPart])

  useEffect(() => {
    const handleCommit = () => {
      if (editingMathIndex === null) return
      const el = mathFieldRef.current
      if (!el) return
      const raw = el.getValue?.("latex") || ""
      const normalized = wrapCjkInMath(raw)
      updateMathPart(editingMathIndex, normalized)
      unregisterMathField(instanceId)
    }

    window.addEventListener("math-field-commit", handleCommit as EventListener)
    return () => window.removeEventListener("math-field-commit", handleCommit as EventListener)
  }, [editingMathIndex, instanceId, unregisterMathField, updateMathPart])

  // Render preview with clickable math
  const renderPreview = () => {
    if (!value && placeholder) {
      return <span className="text-slate-400">{placeholder}</span>
    }

    return parts.map((part, index) => {
      if (part.type === 'math') {
        // Check if we're editing this math part
        if (editingMathIndex === index && mathLiveReady) {
          return (
            <span key={index} className="inline-flex items-center mx-0.5" onClick={(e) => e.stopPropagation()}>
              {/* @ts-expect-error Custom element provided by MathLive */}
              <math-field
                ref={(el: InlineMathFieldElement | null) => setupMathField(el, part.content, index)}
                virtual-keyboard-mode="off"
                contentEditable
                suppressContentEditableWarning
                style={{
                  display: "inline-block",
                  minWidth: "60px",
                  maxWidth: "200px",
                  fontSize: "14px",
                  background: "white",
                  border: "1px solid #a5b4fc",
                  borderRadius: "4px",
                  padding: "2px 6px",
                }}
              />
            </span>
          )
        }

        // Render KaTeX preview
        return (
          <MathPreview
            key={index}
            latex={part.content}
            onClick={() => setEditingMathIndex(index)}
          />
        )
      }

      // Text part
      return <span key={index}>{part.content}</span>
    })
  }

  // When editing text mode
  const handleTextCommit = () => {
    // Only update if changed
    if (value !== (textInputRef.current?.value ?? value)) {
      onChange(textInputRef.current?.value ?? value)
    }
    setEditingText(false)
  }

  // Effect to sync local value when prop changes externally (e.g. undo)
  const [localTextValue, setLocalTextValue] = useState(value)
  useEffect(() => {
    setLocalTextValue(value)
    // If editing, restore cursor to end to prevent jump to start on undo
    if (editingText && textInputRef.current) {
      const len = value.length
      requestAnimationFrame(() => {
        textInputRef.current?.setSelectionRange(len, len)
      })
    }
  }, [value, editingText])

  if (editingText) {
    return (
      <textarea
        ref={textInputRef}
        value={localTextValue}
        onChange={(e) => setLocalTextValue(e.target.value)}
        onBlur={handleTextCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault() // Prevent newline, confirm instead
            handleTextCommit()
          }
          if (e.key === 'Escape') {
            setLocalTextValue(value) // Revert
            setEditingText(false)
          }
           // Stop propagation to prevent Slate from catching Enter/Backspace
           e.stopPropagation()
        }}
        autoFocus
        rows={Math.max(1, Math.ceil(localTextValue.length / 40))} // Approximate rows or just let it wrap
        className={`w-full px-2 py-1 text-sm border border-indigo-300 rounded focus:outline-none focus:ring-1 focus:ring-indigo-400 resize-none overflow-hidden min-h-[30px] ${className || ""}`}
        placeholder={placeholder}
      />
    )
  }

  // Preview mode
  return (
    <div
      ref={previewRef}
      onClick={() => {
        // Only switch to text edit if not clicking on math
        if (editingMathIndex === null) {
          setEditingText(true)
        }
      }}
      className={`w-full px-2 py-1 text-sm cursor-text bg-white border border-slate-200 rounded min-h-[30px] transition-colors hover:border-slate-300 ${className || ""}`}
    >
      {renderPreview()}
    </div>
  )
}

// Clean placeholder commands from latex (MathLive adds these for empty spots)
function cleanPlaceholder(latex: string): string {
  if (!latex) return ''
  // Remove \placeholder commands and clean up empty pipes/braces
  return latex
    .replace(/(^|[^\\])#\d+/g, "$1")
    .replace(/\\placeholder\b(\{[^}]*\})?/g, '')
    .replace(/\|\s*\|/g, '')
    .replace(/\{\s*\}/g, '')
    .trim()
}

// Simple KaTeX preview component
function MathPreview({ latex, onClick }: { latex: string; onClick: () => void }) {
  const ref = useRef<HTMLSpanElement>(null)
  const cleanedLatex = cleanPlaceholder(wrapCjkInMath(latex))

  useEffect(() => {
    if (ref.current) {
      // Skip rendering if latex is empty or only whitespace
      if (!cleanedLatex) {
        ref.current.textContent = ''
        return
      }
      try {
        katex.render(cleanedLatex, ref.current, {
          throwOnError: false,
          displayMode: false,
        })
      } catch {
        if (ref.current) {
          ref.current.textContent = `$${cleanedLatex}$`
        }
      }
    }
  }, [cleanedLatex])

  // Don't render anything for empty latex
  if (!cleanedLatex) {
    return null
  }

  return (
    <span
      ref={ref}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="inline-flex items-center mx-0.5 px-1 py-0.5 rounded bg-indigo-50 border border-indigo-200 cursor-pointer hover:border-indigo-400 hover:bg-indigo-100 transition-all"
      title="クリックして編集"
    />
  )
}

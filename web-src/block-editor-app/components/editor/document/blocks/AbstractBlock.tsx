"use client"

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react"
import type { AbstractBlock } from "@/lib/document/types"
import katex from "katex"
import "katex/contrib/mhchem"
import { wrapCjkInMath } from "@/lib/document/serializer"

interface AbstractBlockViewProps {
  block: AbstractBlock
  onUpdate: (updates: Partial<AbstractBlock>) => void
}

// Parse text into segments (text and math)
interface TextSegment { type: "text"; content: string }
interface MathSegment { type: "math"; latex: string }
type Segment = TextSegment | MathSegment

function parseTextWithMath(text: string): Segment[] {
  const segments: Segment[] = []
  const regex = /\$([^$]+)\$/g
  let lastIndex = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) })
    }
    segments.push({ type: "math", latex: match[1] })
    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) })
  }

  return segments
}

function segmentsToText(segments: Segment[]): string {
  return segments.map(seg => 
    seg.type === "math" ? `$${seg.latex}$` : seg.content
  ).join("")
}

// Click to edit inline
function MathDisplay({ latex, onUpdate }: { latex: string; onUpdate: (newLatex: string) => void }) {
  const spanRef = useRef<HTMLSpanElement>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(latex)

  useEffect(() => {
    if (spanRef.current && !isEditing) {
      try {
        const safeLatex = wrapCjkInMath(latex)
        katex.render(safeLatex, spanRef.current, {
          throwOnError: false,
          displayMode: false,
        })
      } catch {
        if (spanRef.current) {
          spanRef.current.textContent = latex
        }
      }
    }
  }, [latex, isEditing])

  const handleSave = () => {
    setIsEditing(false)
    if (editValue !== latex) {
      onUpdate(editValue)
    }
  }

  if (isEditing) {
    return (
      <input
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleSave}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSave()
          if (e.key === "Escape") {
            setEditValue(latex)
            setIsEditing(false)
          }
        }}
        autoFocus
        className="inline-block px-1 py-0.5 text-sm font-mono bg-indigo-50 border border-indigo-300 rounded outline-none"
        style={{ minWidth: "60px" }}
        onClick={(e) => e.stopPropagation()}
      />
    )
  }

  return (
    <span
      ref={spanRef}
      onClick={(e) => {
        e.stopPropagation()
        setEditValue(latex)
        setIsEditing(true)
      }}
      className="inline-flex items-center mx-0.5 px-1 py-0.5 rounded bg-indigo-50 cursor-pointer hover:bg-indigo-100 transition-colors"
      title="クリックして編集"
    />
  )
}

export function AbstractBlockView({ block, onUpdate }: AbstractBlockViewProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [value, setValue] = useState(block.content.text)

  useEffect(() => {
    if (value !== block.content.text) {
      // Keep local state in sync when the underlying block changes externally
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValue(block.content.text)
    }
  }, [block.content.text, value])

  const segments = useMemo(() => parseTextWithMath(value || ""), [value])

  const handleBlur = () => {
    setIsEditing(false)
    onUpdate({ ...block, content: { text: value } })
  }

  const handleMathUpdate = useCallback((index: number, newLatex: string) => {
    const newSegments = [...segments]
    if (newSegments[index]?.type === "math") {
      newSegments[index] = { type: "math", latex: newLatex }
      const newText = segmentsToText(newSegments)
      setValue(newText)
      onUpdate({ ...block, content: { text: newText } })
    }
  }, [segments, block, onUpdate])

  if (isEditing) {
    return (
      <div className="bg-slate-50 rounded-lg">
        <div className="px-3 py-2 border-b border-slate-200 select-none">
          <span className="text-xs font-medium text-slate-500">📄 Abstract / 概要</span>
        </div>
        <div className="p-3">
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault() // Prevent newline, confirm instead
                handleBlur()
              }
              if (e.key === 'Escape') {
                setValue(block.content.text)
                setIsEditing(false)
              }
            }}
            className="w-full p-3 text-sm text-slate-700 leading-relaxed rounded-lg outline-none resize-none bg-white min-h-[100px]"
            autoFocus
            placeholder="概要を入力..."
          />
          <p className="text-xs text-slate-400 mt-2 select-none">💡 数式: $x^2$</p>
        </div>
      </div>
    )
  }

  return (
    <div 
      className="bg-slate-50 rounded-lg cursor-text"
      onClick={() => setIsEditing(true)}
      contentEditable={false}
    >
      <div className="px-3 py-2 border-b border-slate-200 select-none">
        <span className="text-xs font-medium text-slate-500">📄 Abstract / 概要</span>
      </div>
      <div className="p-3">
        <div className="text-sm text-slate-700 leading-relaxed">
          {segments.length > 0 ? (
            segments.map((seg, idx) => {
              if (seg.type === "math") {
                return <MathDisplay key={idx} latex={seg.latex} onUpdate={(newLatex) => handleMathUpdate(idx, newLatex)} />
              }
              return <span key={idx}>{seg.content}</span>
            })
          ) : (
            <span className="text-slate-400 italic">クリックして入力...</span>
          )}
        </div>
      </div>
    </div>
  )
}

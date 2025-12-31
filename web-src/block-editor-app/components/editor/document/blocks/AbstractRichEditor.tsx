"use client"

import React, { useEffect, useRef, useState } from "react"
import katex from "katex"
import "katex/contrib/mhchem"
import { wrapCjkInMath } from "@/lib/document/serializer"

interface AbstractRichEditorProps {
  value: string
  placeholder?: string
  className?: string
  onChange: (value: string) => void
}

// Rendered inline math using KaTeX for Abstract display - click to edit inline
function InlineMathDisplay({
  latex,
  onUpdate,
}: {
  latex: string
  onUpdate: (newLatex: string) => void
}) {
  const containerRef = useRef<HTMLSpanElement>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(latex)

  useEffect(() => {
    if (containerRef.current && !isEditing) {
      try {
        katex.render(wrapCjkInMath(latex || "x"), containerRef.current, {
          throwOnError: false,
          displayMode: false,
        })
      } catch {
        if (containerRef.current) {
          containerRef.current.textContent = latex || "x"
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
      />
    )
  }

  return (
    <span
      ref={containerRef}
      onClick={(e) => {
        e.stopPropagation()
        setEditValue(latex)
        setIsEditing(true)
      }}
      className="inline-flex items-center mx-0.5 px-1.5 py-0.5 rounded bg-indigo-50 border border-indigo-200 cursor-pointer hover:border-indigo-400 hover:bg-indigo-100 transition-all"
      title="クリックして編集"
    />
  )
}

// Parse text to extract math segments: $...$
interface Segment {
  type: "text" | "math"
  content: string
}

function parseTextWithMath(text: string): Segment[] {
  const segments: Segment[] = []
  const regex = /\$([^$]+)\$/g
  let lastIndex = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        content: text.slice(lastIndex, match.index)
      })
    }
    segments.push({
      type: "math",
      content: match[1]
    })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    segments.push({
      type: "text",
      content: text.slice(lastIndex)
    })
  }

  return segments
}

// Convert segments back to text
function segmentsToText(segments: Segment[]): string {
  return segments.map(seg => 
    seg.type === "math" ? `$${seg.content}$` : seg.content
  ).join("")
}

export function AbstractRichEditor({
  value,
  placeholder,
  className,
  onChange,
}: AbstractRichEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [isEditing, setIsEditing] = useState(false)

  const segments = parseTextWithMath(value)

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
  }

  const handleMathUpdate = (index: number, newLatex: string) => {
    const newSegments = [...segments]
    if (newSegments[index]?.type === "math") {
      newSegments[index] = { type: "math", content: newLatex }
      onChange(segmentsToText(newSegments))
    }
  }

  // Render preview mode (showing math rendered)
  const renderPreview = () => {
    if (!value.trim()) {
      return (
        <span className="text-slate-400">{placeholder || "テキストを入力..."}</span>
      )
    }

    return segments.map((seg, index) => {
      if (seg.type === "math") {
        return (
          <InlineMathDisplay
            key={index}
            latex={seg.content}
            onUpdate={(newLatex) => handleMathUpdate(index, newLatex)}
          />
        )
      }
      return (
        <span key={index} className="whitespace-pre-wrap">
          {seg.content}
        </span>
      )
    })
  }

  return (
    <div className="relative">
      {isEditing ? (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleTextChange}
          onBlur={() => setIsEditing(false)}
          autoFocus
          className={`w-full h-48 px-3 py-2 border border-indigo-300 rounded-lg focus:border-indigo-500 outline-none resize-none ${className || ""}`}
          placeholder={placeholder || "本研究の目的、手法、主な結果を簡潔に記述してください..."}
        />
      ) : (
        <div
          onClick={() => setIsEditing(true)}
          className={`w-full min-h-[12rem] px-3 py-2 border border-slate-300 rounded-lg cursor-text bg-white hover:border-slate-400 transition-colors leading-relaxed ${className || ""}`}
        >
          {renderPreview()}
        </div>
      )}

      <p className="text-xs text-slate-500 mt-2">
        クリックして編集。<code className="bg-slate-100 px-1 rounded">$...$</code> で数式を入力できます。
      </p>
    </div>
  )
}

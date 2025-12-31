"use client"

import React, { useEffect, useRef, useState, useCallback } from "react"
import type { HeadingBlock, HeadingLevel } from "@/lib/document/types"

interface HeadingBlockViewProps {
  block: HeadingBlock
  headingNumber?: string
  onUpdate: (updates: Partial<HeadingBlock>) => void
  onFocusInline?: (el: HTMLElement) => void
}

export function HeadingBlockView({ block, headingNumber, onUpdate, onFocusInline }: HeadingBlockViewProps) {
  const [isFocused, setIsFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync input value with block when not focused
  useEffect(() => {
    if (inputRef.current && !isFocused) {
      inputRef.current.value = block.content.title
    }
  }, [block.content.title, isFocused])

  const handleBlur = useCallback(() => {
    setIsFocused(false)
    const newValue = inputRef.current?.value || ""
    if (newValue !== block.content.title) {
      onUpdate({
        ...block,
        content: {
          ...block.content,
          title: newValue,
        },
      })
    }
  }, [block, onUpdate])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Stop propagation to prevent parent handlers from intercepting
    e.stopPropagation()
    
    // Check if IME is composing
    if (e.nativeEvent.isComposing) return
    if (e.key === "Enter") {
      e.preventDefault()
      inputRef.current?.blur()
    }
  }, [])

  const getHeadingClass = (level: HeadingLevel) => {
    const classes = {
      1: "text-3xl font-bold",
      2: "text-2xl font-bold",
      3: "text-xl font-semibold",
      4: "text-lg font-semibold",
      5: "text-base font-semibold",
      6: "text-sm font-semibold",
    }
    return classes[level]
  }

  const HeadingElement = `h${Math.min(block.content.level + 1, 6)}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6"

  return (
    <div className="flex items-center gap-2 p-2" contentEditable={false}>
      {React.createElement(
        HeadingElement,
        {
          className: `flex-1 text-slate-900 flex items-center gap-2 ${getHeadingClass(block.content.level)}`,
        },
        <>
          {headingNumber && (
            <span className="inline-flex items-center justify-center rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700 flex-shrink-0 select-none">
              {headingNumber}
            </span>
          )}
          <input
            ref={inputRef}
            type="text"
            defaultValue={block.content.title}
            onFocus={(e) => {
              setIsFocused(true)
              onFocusInline?.(e.currentTarget)
            }}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className={`flex-1 outline-none cursor-text px-1 py-0.5 rounded border border-transparent transition-colors bg-transparent ${
              isFocused 
                ? "border-indigo-300 bg-white shadow-sm" 
                : "hover:bg-slate-50"
            } ${getHeadingClass(block.content.level)}`}
          />
        </>,
      )}
    </div>
  )
}


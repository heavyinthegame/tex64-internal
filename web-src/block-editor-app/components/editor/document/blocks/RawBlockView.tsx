"use client"

import React, { useCallback } from "react"
import Editor from "@monaco-editor/react"
import { ReactEditor, useSlateStatic } from "slate-react"
import { Transforms } from "slate"
import type { RawElement } from "@/types/slate"

type RawBlockViewProps = {
  element: RawElement
  isSelected: boolean
}

export const RawBlockView = React.memo(function RawBlockView({ element, isSelected }: RawBlockViewProps) {
  const editor = useSlateStatic()

  const handleChange = useCallback(
    (value: string | undefined) => {
      const path = ReactEditor.findPath(editor, element)
      Transforms.setNodes(editor, { latex: value || "" } as any, { at: path })
    },
    [editor, element],
  )

  return (
    <div className={`rounded-lg border overflow-hidden transition-colors ${isSelected ? "border-indigo-400 ring-2 ring-indigo-100" : "border-slate-200"}`}>
      <div className="bg-slate-50 px-3 py-1 border-b border-slate-200 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Raw LaTeX</span>
      </div>
      <div className="h-40">
        <Editor
          height="100%"
          defaultLanguage="latex"
          defaultValue={element.latex}
          value={element.latex}
          onChange={handleChange}
          options={{
            minimap: { enabled: false },
            lineNumbers: "off",
            scrollBeyondLastLine: false,
            folding: false,
            fontSize: 13,
            fontFamily: "Menlo, Monaco, 'Courier New', monospace",
            padding: { top: 8, bottom: 8 },
            renderLineHighlight: "none",
          }}
        />
      </div>
    </div>
  )
})

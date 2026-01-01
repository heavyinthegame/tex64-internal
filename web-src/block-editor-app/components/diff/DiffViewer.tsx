"use client"

import React from "react"
import { DiffEditor } from "@monaco-editor/react"
import { X } from "lucide-react"

type DiffViewerProps = {
  original: string
  modified: string
  onClose: () => void
  isOpen: boolean
}

export function DiffViewer({ original, modified, onClose, isOpen }: DiffViewerProps) {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-8">
      <div className="w-full h-full max-w-7xl bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-bold text-slate-800">変更内容の確認</h2>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span className="w-3 h-3 rounded-full bg-red-400"></span>
              <span>変更前 ({original.length} chars)</span>
              <span className="mx-1">→</span>
              <span className="w-3 h-3 rounded-full bg-green-400"></span>
              <span>変更後 ({modified.length} chars)</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-200 rounded-lg transition-colors text-slate-500 hover:text-slate-800"
            title="閉じる"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Diff Editor */}
        <div className="flex-1 min-h-0 relative">
          <DiffEditor
            original={original}
            modified={modified}
            language="latex"
            theme="light"
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 13,
              fontFamily: "Menlo, Monaco, 'Courier New', monospace",
              padding: { top: 16, bottom: 16 },
            }}
          />
        </div>

        {/* Footer actions? (Maybe just close for now implies confirming visually, but typically this is just a viewer) */}
      </div>
    </div>
  )
}

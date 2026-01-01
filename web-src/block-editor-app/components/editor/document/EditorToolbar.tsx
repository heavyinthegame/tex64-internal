"use client"
import {
  Bold,
  Italic,
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  SquareFunction,
  Image as ImageIcon,
  Table as TableIcon,
  RotateCcw,
  RotateCw,
  Plus,
  ChevronDown,
  Lightbulb,
  BookOpen,
  ScrollText,
  CheckCircle,
  Divide,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useLanguage } from "@/lib/i18n/LanguageContext"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export type EditorStyle = "paragraph" | "chapter" | "section" | "subsection" | "subsubsection" | "bullet" | "numbered"

// Extended block types for math environments
export type MathEnvironmentType = "math" | "definition" | "theorem" | "lemma" | "proof" | "corollary" | "proposition" | "example" | "remark"

import { Editor, Transforms } from 'slate'
import { ReactEditor } from 'slate-react'
import { nanoid } from 'nanoid'
import type { InlineMathElement } from '@/types/slate'
import { useState, useRef, useEffect } from "react"

interface EditorToolbarProps {
  currentStyle: EditorStyle
  onStyleChange: (style: EditorStyle) => void
  onAddBlock: (
    type:
      | "paragraph"
      | "chapter"
      | "section"
      | "subsection"
      | "subsubsection"
      | "list-bullet"
      | "list-numbered"
      | "math"
      | "figure"
      | "table"
      | "abstract"
      | "pageBreak"
      | "maketitle"
      | "definition"
      | "theorem"
      | "lemma"
      | "proof"
      | "corollary"
      | "proposition"
      | "example"
      | "remark",
  ) => void
  onFormat: (format: "bold" | "italic" | "code") => void
  onInlineMath: () => void
  onUndo?: () => void
  onRedo?: () => void
  canUndo?: boolean
  canRedo?: boolean
  slateEditor?: Editor // Optional Slate Editor instance
}

export function EditorToolbar({
  currentStyle,
  onStyleChange,
  onAddBlock,
  onFormat,
  onInlineMath,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  slateEditor,
}: EditorToolbarProps) {
  const { t } = useLanguage()
  type AddableBlockType = EditorToolbarProps["onAddBlock"] extends (type: infer T) => void ? T : never
  
  // Override handlers if slateEditor is present

  // Override handlers if slateEditor is present
  const handleFormat = (format: "bold" | "italic" | "code") => {
    if (slateEditor) {
      const isActive = isMarkActive(slateEditor, format)
      if (isActive) {
        Editor.removeMark(slateEditor, format)
      } else {
        Editor.addMark(slateEditor, format, true)
      }
      return
    }
    onFormat(format)
  }

  const handleInlineMath = () => {
    if (slateEditor) {
       const latex = ""
       const math: InlineMathElement = { type: 'inline-math', id: nanoid(), latex, children: [{ text: '' }] }
       Transforms.insertNodes(slateEditor, math, { select: true })
       
       if (!ReactEditor.isFocused(slateEditor)) {
         ReactEditor.focus(slateEditor)
       }
       return
    }
    onInlineMath()
  }

  const handleSoftBreak = () => {
    if (slateEditor) {
      // Insert ⏎ as simple text - represents LaTeX \\ line break
      // This is simpler than inline void elements and has no cursor issues
      Transforms.insertText(slateEditor, "⏎")
    }
  }
  
  // Helper for Slate marks
  const isMarkActive = (editor: Editor, format: string) => {
    const marks = Editor.marks(editor)
    return marks ? marks[format as keyof typeof marks] === true : false
  }

  // Structure items for the first dropdown (change or insert structure blocks)
  const structureItems: Array<{ type: AddableBlockType; label: string; icon: LucideIcon; style: EditorStyle }> = [
    { type: "paragraph", label: t("editor.addBody"), icon: Type, style: "paragraph" },
    { type: "chapter", label: "章", icon: Heading1, style: "chapter" },
    { type: "section", label: "節", icon: Heading2, style: "section" },
    { type: "subsection", label: "項", icon: Heading3, style: "subsection" },
    { type: "subsubsection", label: "目", icon: Heading3, style: "subsubsection" },
    { type: "list-bullet", label: t("editor.addBulletList"), icon: List, style: "bullet" },
    { type: "list-numbered", label: t("editor.addNumberedList"), icon: ListOrdered, style: "numbered" },
    { type: "pageBreak", label: "改ページ", icon: Divide, style: "paragraph" },
  ]

  // Math environment items for the second dropdown
  const mathEnvironmentItems: Array<{ type: AddableBlockType; label: string; icon: LucideIcon }> = [
    { type: "math", label: t("editor.addMath"), icon: SquareFunction },
    { type: "definition", label: t("editor.addDefinition"), icon: BookOpen },
    { type: "theorem", label: t("editor.addTheorem"), icon: Lightbulb },
    { type: "lemma", label: t("editor.addLemma"), icon: ScrollText },
    { type: "proof", label: t("editor.addProof"), icon: CheckCircle },
    { type: "corollary", label: t("editor.addCorollary"), icon: ScrollText },
    { type: "proposition", label: t("editor.addProposition"), icon: Lightbulb },
    { type: "example", label: t("editor.addExample"), icon: BookOpen },
    { type: "remark", label: t("editor.addRemark"), icon: BookOpen },
  ]

  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-200 bg-white flex-wrap">
      {/* Structure Add Dropdown (with Plus icon) */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button 
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 text-sm font-medium transition-colors border border-emerald-200"
          >
            <Plus className="h-4 w-4" />
            <span>{t("editor.structureDropdown")}</span>
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {structureItems.map((item) => {
            const Icon = item.icon
            const isActive = currentStyle === item.style
            return (
              <DropdownMenuItem key={item.type} onClick={() => onAddBlock(item.type)}>
                <Plus className="h-3 w-3 mr-1 text-emerald-500" />
                <Icon className="h-4 w-4 mr-2" />
                <span className="flex-1">{item.label}</span>
                {isActive && <span className="text-emerald-600">✓</span>}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Math Environment Add Dropdown (with Sigma icon) */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button 
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-indigo-50 to-purple-50 text-indigo-700 hover:from-indigo-100 hover:to-purple-100 text-sm font-medium transition-colors border border-indigo-200"
          >
            <Plus className="h-4 w-4" />
            <SquareFunction className="h-4 w-4" />
            <span>{t("editor.mathEnvDropdown")}</span>
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {mathEnvironmentItems.map((item) => {
            const Icon = item.icon
            return (
              <DropdownMenuItem key={item.type} onClick={() => onAddBlock(item.type)}>
                <Plus className="h-3 w-3 mr-1 text-indigo-500" />
                <Icon className="h-4 w-4 mr-2" />
                {item.label}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Text format buttons */}
      <div className="flex items-center gap-0.5 ml-1">
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => handleFormat("bold")}
          className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
          title={t("editor.bold")}
        >
          <Bold className="h-4 w-4" />
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => handleFormat("italic")}
          className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
          title={t("editor.italic")}
        >
          <Italic className="h-4 w-4" />
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleInlineMath}
          className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
          title={t("editor.inlineMath")}
        >
          <div className="flex items-center font-serif italic font-bold text-lg leading-none pt-1">
            <span className="mr-[1px]">x</span>
          </div>
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleSoftBreak}
          className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
          title="改行 (Enter)"
        >
          <span className="text-sm font-medium">↵</span>
        </button>

      </div>

      {/* Separator */}
      <div className="w-px h-6 bg-slate-200 mx-1" />

      {/* 
        インライン数式ボタン
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleInlineMath}
        className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-indigo-600 hover:bg-indigo-50 transition-colors text-sm font-medium"
        title={t("editor.inlineMath")}
      >
        <Pi className="h-4 w-4" />
        <span>数式</span>
      </button>

      {/* Other insert blocks */}
      <button
        onClick={() => onAddBlock("figure")}
        className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
        title={t("editor.insertImage")}
      >
        <ImageIcon className="h-4 w-4" />
      </button>

      <button
        onClick={() => onAddBlock("table")}
        className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
        title={t("editor.insertTable")}
      >
        <TableIcon className="h-4 w-4" />
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Undo/Redo */}
      <button
        onClick={onUndo}
        disabled={!canUndo}
        className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="元に戻す (⌘Z)"
      >
        <RotateCcw className="h-4 w-4" />
      </button>
      <button
        onClick={onRedo}
        disabled={!canRedo}
        className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="やり直す (⌘⇧Z)"
      >
        <RotateCw className="h-4 w-4" />
      </button>

      {/* Text Input Modal */}

    </div>
  )
}

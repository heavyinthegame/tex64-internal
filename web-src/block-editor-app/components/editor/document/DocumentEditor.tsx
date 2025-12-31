"use client"
import React, { createElement, useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode, type DetailedHTMLProps } from "react"
import { createEditor, Descendant, Editor, Element as SlateElement, Path, Range, Transforms, Node, Text } from "slate"
import { Slate, Editable, withReact, ReactEditor, RenderElementProps, RenderLeafProps } from "slate-react"
import { withHistory } from "slate-history"
import type { MathfieldElement } from "mathlive"
import {
  createHeadingBlock,
  createListBlock,
  createMathBlock,
  createMathEnvBlock,
  createParagraphBlock,
  createAbstractBlock,
  createFigureBlock,
  createTableBlock,
} from "@/lib/document/operations"
import type {
  Document as TexDocument,
  DocumentBlock,
  DocumentMetadata,
  HeadingLevel,
  MathEnvType,
  MathBlock,
  FigureBlock,
  TableBlock,
  AbstractBlock,
  InlineContent,
  ListType,
} from "@/lib/document/types"
import type { CustomElement, CustomText, InlineMathElement as SlateInlineMath, ListElement, ParagraphElement } from "@/types/slate"
import { toSlate, fromSlate, toSlateNode, fromSlateNode } from "@/lib/editor/transformers"
import { EditorToolbar, type EditorStyle } from "./EditorToolbar"
import { AbstractRichEditor } from "./blocks/AbstractRichEditor"
import { useLanguage } from "@/lib/i18n/LanguageContext"
import { useMathField, isMathInteractionEvent } from "@/lib/math/MathFieldContext"
import { InlineMathElement } from "../elements/InlineMathElement"
import { Leaf } from "../leafs/Leaf"
import { FigureBlockView } from "./blocks/FigureBlock"
import { TableBlockView } from "./blocks/TableBlock"
import { AbstractBlockView } from "./blocks/AbstractBlock"
import { MathBlockView } from "./blocks/MathBlockView"
import { Plus, FileText, Trash2, Copy, ArrowUp, ArrowDown, Type, Heading1, Heading2, Heading3, List, ListOrdered, Sigma, BookOpen, Code, Image, Table, ScrollText, CheckCircle, Lightbulb, MessageSquare } from "lucide-react"
import { nanoid } from "nanoid"

type DocumentEditorProps = {
  document: TexDocument
  onChange: (doc: TexDocument) => void
  onUndo?: () => void
  onRedo?: () => void
  canUndo?: boolean
  canRedo?: boolean
  onSelectionChange?: (block: DocumentBlock | null) => void
}

type BlockChromeProps = {
  attributes: HTMLAttributes<HTMLDivElement>
  elementType: DocumentBlock["type"]
  isSelected: boolean
  onSelect?: () => void
  onDelete?: () => void
  onDuplicate?: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  onChangeType?: (type: EditorStyle | string) => void
  children: ReactNode
}

const BlockChrome = React.memo(function BlockChrome({
  attributes,
  elementType,
  isSelected,
  onSelect,
  onDelete,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  onChangeType,
  children,
}: BlockChromeProps) {
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 })
  const menuRef = useRef<HTMLDivElement>(null)

  // Auto-adjust position if menu goes off-screen
  useEffect(() => {
    if (showContextMenu && menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect()
      const viewportHeight = window.innerHeight
      if (rect.bottom > viewportHeight) {
        // If bottom overflows, flip upwards
        // We can just switch transform to translateY(-100%)
        menuRef.current.style.transform = "translateY(-100%)"
        // Also check if new top overflows (e.g. very tall menu)
        // If so, we might need a scrollable solution, but flipping is usually enough for context menus
      }
    }
  }, [showContextMenu])

  const getBlockBgColor = () => {
    switch (elementType) {
      case "heading":
        return "bg-purple-50/70"
      case "paragraph":
        return "bg-orange-50/70"
      case "mathBlock":
        return "bg-emerald-50/70"
      case "mathEnv":
        return "bg-indigo-50/70"
      case "list":
        return "bg-blue-50/70"
      case "figure":
        return "bg-sky-50/70"
      case "table":
        return "bg-cyan-50/70"
      case "abstract":
        return "bg-violet-50/70"
      case "toc":
        return "bg-amber-50/70"
      case "raw":
        return "bg-slate-50/70"
      default:
        return "bg-slate-50/70"
    }
  }

  const getIndicatorColor = () => {
    if (!isSelected) return "bg-slate-200"
    switch (elementType) {
      case "heading":
        return "bg-purple-500"
      case "paragraph":
        return "bg-orange-500"
      case "mathBlock":
        return "bg-emerald-500"
      case "mathEnv":
        return "bg-indigo-500"
      case "list":
        return "bg-blue-500"
      case "figure":
        return "bg-sky-500"
      case "table":
        return "bg-cyan-500"
      case "abstract":
        return "bg-violet-500"
      case "toc":
        return "bg-amber-500"
      default:
        return "bg-slate-400"
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onSelect?.()
    setContextMenuPos({ x: e.clientX, y: e.clientY })
    setShowContextMenu(true)
  }

  return (
    <>
      <div
        {...attributes}
        onContextMenu={handleContextMenu}
        className={`relative group transition-all rounded-lg ${getBlockBgColor()}`}
      >
        <div
          className={`absolute left-0 top-0 bottom-0 w-1 rounded-l-lg transition-all ${getIndicatorColor()}`}
          contentEditable={false}
        />

        <div className="pl-4 pr-2 py-2 flex items-center gap-2">
          <div className="flex-1 min-w-0">{children}</div>
          <button
            className="flex-shrink-0 p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-all self-center opacity-0 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              onDelete?.()
            }}
            title="削除"
            contentEditable={false}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {showContextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowContextMenu(false)} />
          <div
             className="fixed z-50 bg-white rounded-lg shadow-xl border border-slate-200 p-2 max-h-[80vh] overflow-y-auto"
            style={{ 
              left: contextMenuPos.x, 
              top: contextMenuPos.y,
              transform: "none"
            }}
            ref={menuRef}
          >
            {/* Block Type Grid */}
            {onChangeType && (
              <div className="grid grid-cols-4 gap-1 mb-2">
                {/* Row 1: Text/Headings */}
                <button
                  onClick={() => { onChangeType("heading1"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-purple-50 text-purple-700"
                  title="章 (H1)"
                >
                  <Heading1 className="h-4 w-4" />
                  <span className="text-[9px]">章</span>
                </button>
                <button
                  onClick={() => { onChangeType("heading2"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-purple-50 text-purple-700"
                  title="節 (H2)"
                >
                  <Heading2 className="h-4 w-4" />
                  <span className="text-[9px]">節</span>
                </button>
                <button
                  onClick={() => { onChangeType("heading3"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-purple-50 text-purple-700"
                  title="項 (H3)"
                >
                  <Heading3 className="h-4 w-4" />
                  <span className="text-[9px]">項</span>
                </button>
                <button
                  onClick={() => { onChangeType("paragraph"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-orange-50 text-orange-700"
                  title="段落"
                >
                  <Type className="h-4 w-4" />
                  <span className="text-[9px]">段落</span>
                </button>

                {/* Row 2: Math */}
                <button
                  onClick={() => { onChangeType("math"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-emerald-50 text-emerald-700"
                  title="数式"
                >
                  <Sigma className="h-4 w-4" />
                  <span className="text-[9px]">数式</span>
                </button>
                <button
                  onClick={() => { onChangeType("definition"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-indigo-50 text-indigo-700"
                  title="定義"
                >
                  <BookOpen className="h-4 w-4" />
                  <span className="text-[9px]">定義</span>
                </button>
                <button
                  onClick={() => { onChangeType("theorem"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-indigo-50 text-indigo-700"
                  title="定理"
                >
                  <Lightbulb className="h-4 w-4" />
                  <span className="text-[9px]">定理</span>
                </button>
                <button
                  onClick={() => { onChangeType("lemma"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-indigo-50 text-indigo-700"
                  title="補題"
                >
                  <ScrollText className="h-4 w-4" />
                  <span className="text-[9px]">補題</span>
                </button>

                {/* Row 3: More math envs */}
                <button
                  onClick={() => { onChangeType("proof"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-indigo-50 text-indigo-700"
                  title="証明"
                >
                  <CheckCircle className="h-4 w-4" />
                  <span className="text-[9px]">証明</span>
                </button>
                <button
                  onClick={() => { onChangeType("corollary"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-indigo-50 text-indigo-700"
                  title="系"
                >
                  <ScrollText className="h-4 w-4" />
                  <span className="text-[9px]">系</span>
                </button>
                <button
                  onClick={() => { onChangeType("example"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-indigo-50 text-indigo-700"
                  title="例"
                >
                  <BookOpen className="h-4 w-4" />
                  <span className="text-[9px]">例</span>
                </button>
                <button
                  onClick={() => { onChangeType("remark"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-indigo-50 text-indigo-700"
                  title="注意"
                >
                  <MessageSquare className="h-4 w-4" />
                  <span className="text-[9px]">注意</span>
                </button>

                {/* Row 4: Lists and other */}
                <button
                  onClick={() => { onChangeType("bullet"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-blue-50 text-blue-700"
                  title="箇条書き"
                >
                  <List className="h-4 w-4" />
                  <span className="text-[9px]">箇条</span>
                </button>
                <button
                  onClick={() => { onChangeType("numbered"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-blue-50 text-blue-700"
                  title="番号付きリスト"
                >
                  <ListOrdered className="h-4 w-4" />
                  <span className="text-[9px]">番号</span>
                </button>
                <button
                  onClick={() => { onChangeType("figure"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-sky-50 text-sky-700"
                  title="図"
                >
                  <Image className="h-4 w-4" />
                  <span className="text-[9px]">図</span>
                </button>
                <button
                  onClick={() => { onChangeType("table"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-cyan-50 text-cyan-700"
                  title="表"
                >
                  <Table className="h-4 w-4" />
                  <span className="text-[9px]">表</span>
                </button>

                {/* Row 5: Other */}
                <button
                  onClick={() => { onChangeType("raw"); setShowContextMenu(false) }}
                  className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-slate-100 text-slate-700"
                  title="Raw LaTeX"
                >
                  <Code className="h-4 w-4" />
                  <span className="text-[9px]">Raw</span>
                </button>
              </div>
            )}

            {/* Actions */}
            <div className="border-t border-slate-200 pt-1 space-y-0.5">
              {onMoveUp && (
                <button
                  onClick={() => { onMoveUp(); setShowContextMenu(false) }}
                  className="w-full px-2 py-1 text-left text-xs text-slate-600 hover:bg-slate-100 flex items-center gap-2 rounded"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                  <span>上に移動</span>
                </button>
              )}
              {onMoveDown && (
                <button
                  onClick={() => { onMoveDown(); setShowContextMenu(false) }}
                  className="w-full px-2 py-1 text-left text-xs text-slate-600 hover:bg-slate-100 flex items-center gap-2 rounded"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                  <span>下に移動</span>
                </button>
              )}
              {onDuplicate && (
                <button
                  onClick={() => { onDuplicate(); setShowContextMenu(false) }}
                  className="w-full px-2 py-1 text-left text-xs text-slate-600 hover:bg-slate-100 flex items-center gap-2 rounded"
                >
                  <Copy className="h-3.5 w-3.5" />
                  <span>複製</span>
                </button>
              )}
              <button
                onClick={() => { onDelete?.(); setShowContextMenu(false) }}
                className="w-full px-2 py-1 text-left text-xs text-red-600 hover:bg-red-50 flex items-center gap-2 rounded"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>削除</span>
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
})

export function DocumentEditor({
  document,
  onChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onSelectionChange,
}: DocumentEditorProps) {
  const { t } = useLanguage()
  const { registerTextEditor, unregisterTextEditor, setActiveTextEditor, setActiveMathField, setOpenMathFieldId } = useMathField()
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  const [currentStyle, setCurrentStyle] = useState<EditorStyle>("paragraph")
  const duplicateCounterRef = useRef(0)
  const editorContainerRef = useRef<HTMLDivElement | null>(null)

  const slateEditor = useMemo(() => {
    const e = withHistory(withReact(createEditor()))
    const { isInline, isVoid } = e

    e.isInline = (element) => {
      return element.type === "inline-math" ? true : isInline(element)
    }

    e.isVoid = (element) => {
      return ["inline-math", "math-block", "raw", "figure", "table", "abstract", "toc"].includes(
        (element as SlateElement).type,
      )
        ? true
        : isVoid(element)
    }

    return e
  }, [])

  const [slateValue, setSlateValue] = useState<Descendant[]>(() => toSlate(document?.blocks || []))
  const [slateKey, setSlateKey] = useState(0)
  const skipSyncRef = useRef(false)

  const inlineNodesToInlineContent = useCallback((nodes: Descendant[]): InlineContent[] => {
    return nodes.map((child) => {
      if (typeof child !== "object") {
        return { id: nanoid(), type: "text", content: "" }
      }
      const slateChild = child as CustomText | SlateInlineMath
      if ((slateChild as SlateInlineMath).type === "inline-math") {
        const mathNode = slateChild as SlateInlineMath
        return {
          id: mathNode.id || nanoid(),
          type: "math",
          latex: mathNode.latex || "",
        }
      }
      const textNode = slateChild as CustomText
      return {
        id: textNode.id || nanoid(),
        type: "text",
        content: textNode.text || "",
        formatting: {
          bold: textNode.bold || undefined,
          italic: textNode.italic || undefined,
          underline: textNode.underline || undefined,
          texttt: textNode.code || undefined,
        },
      }
    })
  }, [])

  const inlineContentToNodes = useCallback((inlines: InlineContent[]): Descendant[] => {
    if (!inlines || inlines.length === 0) return [{ text: "" }]
    return inlines.map((inline) => {
      if (inline.type === "math") {
        const mathNode: SlateInlineMath = {
          type: "inline-math",
          id: inline.id || nanoid(),
          latex: inline.latex,
          children: [{ text: "" }],
        }
        return mathNode
      }
      const textNode: CustomText = {
        id: inline.id,
        text: inline.content,
        bold: inline.formatting?.bold,
        italic: inline.formatting?.italic,
        underline: inline.formatting?.underline,
        code: inline.formatting?.texttt,
      }
      return textNode
    })
  }, [])

  const getActiveInlineEntry = useCallback((selection: Range | null = slateEditor.selection) => {
    if (!selection) return null
    const entry = Editor.above(slateEditor, {
      at: selection,
      match: (n) =>
        SlateElement.isElement(n) &&
        ["paragraph", "heading", "list-item", "abstract"].includes((n as CustomElement).type),
      mode: "lowest",
    })
    return entry as [SlateElement, Path] | null
  }, [slateEditor])

  const lastInlinePathRef = useRef<Path | null>(null)
  const lastSelectionRef = useRef<Range | null>(null)
  const latestInlineValueRef = useRef<InlineContent[]>([])

  const getInlineValue = useCallback((): InlineContent[] => {
    let entry = getActiveInlineEntry(slateEditor.selection ?? lastSelectionRef.current)
    if (!entry && lastInlinePathRef.current) {
      try {
        const [node] = Editor.node(slateEditor, lastInlinePathRef.current)
        if (
          SlateElement.isElement(node) &&
          ["paragraph", "heading", "list-item", "abstract"].includes((node as CustomElement).type)
        ) {
          entry = [node as SlateElement, lastInlinePathRef.current]
        }
      } catch {
        entry = null
      }
    }
    if (!entry) return []
    const node = entry[0] as CustomElement
    const value = inlineNodesToInlineContent(node.children || [])
    latestInlineValueRef.current = value
    return value
  }, [getActiveInlineEntry, inlineNodesToInlineContent, slateEditor])

  const applyInlineValue = useCallback(
    (newInlines: InlineContent[]) => {
      let entry = getActiveInlineEntry(slateEditor.selection ?? lastSelectionRef.current)
      if (!entry && lastInlinePathRef.current) {
        try {
          const [node] = Editor.node(slateEditor, lastInlinePathRef.current)
          if (
            SlateElement.isElement(node) &&
            ["paragraph", "heading", "list-item", "abstract"].includes((node as CustomElement).type)
          ) {
            entry = [node as SlateElement, lastInlinePathRef.current]
          }
        } catch {
          entry = null
        }
      }
      if (!entry) return
      const [, path] = entry as [CustomElement, Path]
      const children = inlineContentToNodes(newInlines)
      const removeMatch = (_node: Node, p: Path) => p.length === path.length + 1
      Transforms.removeNodes(slateEditor, { at: path, match: removeMatch })
      Transforms.insertNodes(slateEditor, children, { at: path.concat(0) })
      latestInlineValueRef.current = newInlines
    },
    [getActiveInlineEntry, inlineContentToNodes, slateEditor],
  )

  const getCursorPosition = useCallback(() => {
    const selection = slateEditor.selection ?? lastSelectionRef.current
    let entry = getActiveInlineEntry(selection)
    if (!entry && lastInlinePathRef.current) {
      try {
        const [node] = Editor.node(slateEditor, lastInlinePathRef.current)
        if (
          SlateElement.isElement(node) &&
          ["paragraph", "heading", "list-item", "abstract"].includes((node as CustomElement).type)
        ) {
          entry = [node as SlateElement, lastInlinePathRef.current]
        }
      } catch {
        entry = null
      }
    }
    if (!entry || !selection) return null
    const [, path] = entry
    const anchor = selection.anchor
    if (anchor.path.length < path.length + 1) return null
    const inlineIndex = anchor.path[path.length] ?? 0
    const charOffset = anchor.offset ?? 0
    return { inlineIndex, charOffset }
  }, [getActiveInlineEntry, slateEditor])

  const insertMath = useCallback((latex: string) => {
    const selection = slateEditor.selection ?? lastSelectionRef.current
    if (!selection) return null

    // Use \placeholder{} to ensure MathLive places the cursor inside the structure (e.g. \mathbb{\placeholder{}})
    // The serializer will automatically strip this before saving, so it won't appear in the final LaTeX.
    const sanitizedLatex = latex.replace(/#0/g, "\\placeholder{}")

    const id = nanoid()
    const mathNode: SlateInlineMath = {
      type: "inline-math",
      id,
      latex: sanitizedLatex,
      children: [{ text: "" }],
    }

    Transforms.insertNodes(slateEditor, mathNode, { at: selection })
    Transforms.move(slateEditor) // Move selection after the inserted node
    return id
  }, [slateEditor])

  const editorInterface = useMemo(
    () => ({
      getValue: getInlineValue,
      onChange: applyInlineValue,
      getCursorPosition,
      getLatestValue: getInlineValue,
      insertMath,
    }),
    [applyInlineValue, getCursorPosition, getInlineValue, insertMath],
  )

  // Stable references to avoid recreating effects
  const documentRef = useRef(document)
  const onChangeRef = useRef(onChange)
  const onSelectionChangeRef = useRef(onSelectionChange)

  useEffect(() => {
    documentRef.current = document
  }, [document])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange
  }, [onSelectionChange])

  // Sync incoming document blocks unless the change originated from Slate
  useEffect(() => {
    if (skipSyncRef.current) {
      skipSyncRef.current = false
      return
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSlateValue(toSlate(document?.blocks || []))
    setSlateKey((k) => k + 1)
  }, [document?.blocks])

  useEffect(() => {
    const container = editorContainerRef.current
    if (!container) return
    registerTextEditor(container, editorInterface as Parameters<typeof registerTextEditor>[1])
    return () => {
      unregisterTextEditor(container)
    }
  }, [editorInterface, registerTextEditor, unregisterTextEditor])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey

      if (cmdOrCtrl && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        if (canUndo && onUndo) onUndo()
        return
      }
      
      if (cmdOrCtrl && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
        e.preventDefault()
        if (canRedo && onRedo) onRedo()
        return
      }

      // バックスペースでのブロック削除を無効化
      // UXの意図: 誤操作を防ぐため、削除は明示的に削除ボタンで行う
      // if ((e.key === 'Backspace' || e.key === 'Delete') && selectedBlockId && currentMode === "content") {
      //   const target = e.target as HTMLElement
      //   if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA' && !target.isContentEditable) {
      //     e.preventDefault()
      //     const nextDoc = removeBlock(documentRef.current, selectedBlockId)
      //     onChangeRef.current(nextDoc)
      //   }
      // }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canUndo, canRedo, onUndo, onRedo, selectedBlockId])

  // Compute heading numbering efficiently
  // Only re-compute if heading structure changes
  const headingStructureHash = useMemo(() => {
    return document.blocks
      .filter(b => b.type === "heading")
      .map(b => `${b.id}:${(b as any).content?.level}`)
      .join("|")
  }, [document.blocks])

  const headingNumbers = useMemo(() => {
    const numbers = new Map<string, string>()
    const counters = [0, 0, 0, 0, 0, 0]
    document.blocks.forEach((block) => {
      if (block.type === "heading") {
        const level = block.content.level
        counters[level - 1] += 1
        for (let i = level; i < counters.length; i++) counters[i] = 0
        const number = counters.slice(0, level).filter((n) => n > 0).join(".")
        numbers.set(block.id, number)
      }
    })
    return numbers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headingStructureHash])

  // Compute math block equation numbering (including nested mathBlocks in mathEnv)
  const mathBlockStructureHash = useMemo(() => {
    // Recursively collect mathBlock IDs
    const collectMathBlockIds = (blocks: typeof document.blocks): string[] => {
      const ids: string[] = []
      blocks.forEach(b => {
        if (b.type === "mathBlock") {
          ids.push(b.id)
        } else if (b.type === "mathEnv" && b.content.children) {
          ids.push(...collectMathBlockIds(b.content.children))
        }
      })
      return ids
    }
    return collectMathBlockIds(document.blocks).join("|")
  }, [document.blocks])

  const mathBlockNumbers = useMemo(() => {
    const numbers = new Map<string, string>()
    let currentChapter = 0
    let equationInChapter = 0
    
    // Recursive function to assign chapter-based numbers
    const assignNumbers = (blocks: typeof document.blocks) => {
      blocks.forEach((block) => {
        // Check for chapter (heading level 1)
        if (block.type === "heading" && block.content.level === 1) {
          currentChapter += 1
          equationInChapter = 0 // Reset equation counter for new chapter
        }
        
        if (block.type === "mathBlock") {
          equationInChapter += 1
          // Format: "章.番号" or just "番号" if no chapter yet
          const numberStr = currentChapter > 0 
            ? `${currentChapter}.${equationInChapter}` 
            : `${equationInChapter}`
          numbers.set(block.id, numberStr)
        } else if (block.type === "mathEnv" && block.content.children) {
          assignNumbers(block.content.children)
        }
      })
    }
    
    assignNumbers(document.blocks)
    return numbers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mathBlockStructureHash])

  // Helpers
  const commitDocument = (doc: TexDocument) => {
    documentRef.current = doc
    onChangeRef.current(doc)
  }

  const getSelectedBlockEntry = useCallback(() => {
    if (!slateEditor.selection) return null
    return Editor.above(slateEditor, {
      at: slateEditor.selection,
      match: (n) => SlateElement.isElement(n) && (n as CustomElement).type !== "inline-math",
      mode: "lowest",
    }) as [SlateElement, Path] | null
  }, [slateEditor])

  const handleSlateChange = (value: Descendant[]) => {
    try {
      if (!Array.isArray(value)) {
        return
      }
      // Note: removed setSlateValue(value) - Slate manages its own state internally
      // Calling setState was causing unnecessary React re-renders
      const nextBlocks = fromSlate(value)
      const nextDoc = { ...documentRef.current, blocks: nextBlocks }
      documentRef.current = nextDoc
      skipSyncRef.current = true
      onChangeRef.current(nextDoc)

      const blockEntry = getSelectedBlockEntry()
      if (blockEntry) {
        const [node, path] = blockEntry as [CustomElement, Path]
        setSelectedBlockId(node.id || null)
        if (node.type === "heading") {
          const level = (node as { level?: number }).level || 1
          setCurrentStyle(level === 1 ? "heading1" : level === 2 ? "heading2" : "heading3")
        } else if (node.type === "list") {
          setCurrentStyle(node.listType === "enumerate" ? "numbered" : "bullet")
        } else if (node.type === "list-item") {
          const listEntry = Editor.above(slateEditor, {
            at: path,
            match: (n) => SlateElement.isElement(n) && (n as CustomElement).type === "list",
          }) as [Extract<CustomElement, { type: "list" }>, Path] | null
          if (listEntry) {
            const [listNode] = listEntry
            setCurrentStyle(listNode.listType === "enumerate" ? "numbered" : "bullet")
          } else {
            setCurrentStyle("paragraph")
          }
        } else {
          setCurrentStyle("paragraph")
        }
        onSelectionChangeRef.current?.(fromSlateNode(node))
      } else {
        setSelectedBlockId(null)
        setCurrentStyle("paragraph")
        onSelectionChangeRef.current?.(null)
      }

      if (slateEditor.selection) {
        lastSelectionRef.current = slateEditor.selection
        const inlineEntry = Editor.above(slateEditor, {
          at: slateEditor.selection,
          match: (n) =>
            SlateElement.isElement(n) &&
            ["paragraph", "heading", "list-item", "abstract"].includes((n as CustomElement).type),
          mode: "lowest",
        }) as [SlateElement, Path] | null
        if (inlineEntry) {
          lastInlinePathRef.current = inlineEntry[1]
        }
      }
    } catch (error) {
      // Handle invalid selection paths (can happen after undo)
      console.warn('Selection error during change:', error)
      // Reset selection to start of document
      try {
        Transforms.deselect(slateEditor)
      } catch {
        // Ignore deselect errors
      }
    }
  }

  const insertBlockNode = (block: DocumentBlock, opts?: { position?: "start" | "afterSelection" }) => {
    const node = toSlateNode(block)
    let at: Path = [slateEditor.children.length]
    if (opts?.position === "start") {
      at = [0]
    } else if (opts?.position === "afterSelection") {
      const entry = getSelectedBlockEntry()
      if (entry) {
        const topIndex = entry[1][0] ?? 0
        at = [topIndex + 1]
      }
    }
    Transforms.insertNodes(slateEditor, node as unknown as SlateElement, { at, select: true })
    setSelectedBlockId((node as CustomElement).id || null)
  }

  const handleStyleChange = (style: EditorStyle | string) => {
    // If style is a strictly typed EditorStyle, update current style UI
    if (["paragraph", "heading1", "heading2", "heading3", "bullet", "numbered"].includes(style)) {
       setCurrentStyle(style as EditorStyle)
    }

    const entry = getSelectedBlockEntry()
    if (!entry) {
      // No selection - insert new block
      if (style.startsWith("heading")) {
        insertBlockNode(createHeadingBlock(style === "heading1" ? 1 : style === "heading2" ? 2 : 3, ""), {
          position: "afterSelection",
        })
      } else if (style === "bullet" || style === "numbered") {
        const listType = style === "numbered" ? "enumerate" : "itemize"
        insertBlockNode(createListBlock(listType), { position: "afterSelection" })
      } else if (style === "math") {
        insertBlockNode(createMathBlock("", "equation"), { position: "afterSelection" })
      } else if (["definition", "theorem", "lemma", "proof", "remark", "example"].includes(style)) {
        insertBlockNode(createMathEnvBlock(style as MathEnvType, ""), { position: "afterSelection" })
      } else if (style === "raw") {
        insertBlockNode({ type: "raw", id: nanoid(), content: { latex: "" } }, { position: "afterSelection" })
      } else {
        insertBlockNode(createParagraphBlock(), { position: "afterSelection" })
      }
      return
    }

    const [, path] = entry
    const node = entry[0] as CustomElement
    
    // --- Helper to get text content from node ---
    const getTextContent = (n: CustomElement): string => {
      if (n.type === "math-block") {
        return n.latex || ""
      }
      if (n.type === "raw") {
        return n.latex || ""
      }
      // math-env, paragraph, heading, list, etc.
      return Node.string(n)
    }

    // --- Helper to get latex content for math/raw ---
    // --- Helper to get latex content for math/raw ---
    const getLatexContent = (n: Descendant): string => {
      // 1. Text Leaf
      if (Text.isText(n)) {
        return n.text
      }

      // 2. Elements
      const element = n as CustomElement
      
      switch (element.type) {
        case "math-block":
          return element.latex || ""
        case "raw":
          return element.latex || ""
        case "inline-math":
          return `$${element.latex || ""}$`
        
        case "paragraph":
        case "heading": 
        case "list-item":
          return element.children.map(child => getLatexContent(child)).join("")

        case "list": {
          const isEnum = element.listType === "enumerate"
          const envName = isEnum ? "enumerate" : "itemize"
          const items = element.children.map(li => {
            const content = li.children.map(c => getLatexContent(c)).join("")
            return `  \\item ${content}`
          }).join("\n")
          return `\\begin{${envName}}\n${items}\n\\end{${envName}}`
        }

        case "math-env": {
          const envType = element.envType || "theorem"
          const content = element.children.map(child => getLatexContent(child)).join("\n\n")
          return `\\begin{${envType}}\n${content}\n\\end{${envType}}`
        }

        case "figure": {
          const fig = element as any // Cast to access specific props
          const width = fig.width ? `[width=${fig.width}]` : "[width=0.8\\linewidth]"
          const placement = fig.placement ? `[${fig.placement}]` : "[htbp]"
          return `\\begin{figure}${placement}\n  \\centering\n  \\includegraphics${width}{${fig.imagePath}}\n  \\caption{${fig.caption || ""}}\n  \\label{${fig.label || ""}}\n\\end{figure}`
        }

        case "table": {
          const tbl = element as any
          const align = tbl.alignment || (tbl.rows[0] ? "c".repeat(tbl.rows[0].length) : "c")
          const body = (tbl.rows as string[][]).map(r => r.join(" & ")).join(" \\\\\n    ")
          return `\\begin{table}[htbp]\n  \\centering\n  \\caption{${tbl.caption || ""}}\n  \\label{${tbl.label || ""}}\n  \\begin{tabular}{${align}}\n    ${body}\n  \\end{tabular}\n\\end{table}`
        }

        default:
          return Node.string(n)
      }
    }

    // --- Conversion Logic ---

    // To List
    if (style === "bullet" || style === "numbered") {
      const listType: "itemize" | "enumerate" = style === "numbered" ? "enumerate" : "itemize"
      if (node.type === "list") {
        Transforms.setNodes<SlateElement>(slateEditor, { listType } as Partial<CustomElement>, { at: path })
        return
      }
      // Convert other block to list
      const text = getTextContent(node)
      // Remove old node and insert new list
      Transforms.removeNodes(slateEditor, { at: path })
      
      // Create Block then convert to Slate Node to modify children
      const newListBlock = createListBlock(listType)
      const newListNode = toSlateNode(newListBlock) as unknown as ListElement
      
      // Set the content of the first item
      // ListElement -> children: ListItemElement[] -> children: CustomText[]
      if (newListNode.children.length > 0 && newListNode.children[0].children.length > 0) {
         const firstText = newListNode.children[0].children[0] as CustomText
         firstText.text = text
      }
      Transforms.insertNodes(slateEditor, newListNode as unknown as SlateElement, { at: path, select: true })
      return
    }

    // To Heading
    if (style.startsWith("heading")) {
      const level: HeadingLevel = style === "heading1" ? 1 : style === "heading2" ? 2 : 3
      if (node.type === "heading") {
         Transforms.setNodes<SlateElement>(slateEditor, { level } as Partial<CustomElement>, { at: path })
         return
      }
      // Convert to heading
      const text = getTextContent(node)
      Transforms.removeNodes(slateEditor, { at: path })
      const newHeadingBlock = createHeadingBlock(level, text)
      // We don't need to manually set text because createHeadingBlock takes text arg
      Transforms.insertNodes(slateEditor, toSlateNode(newHeadingBlock) as unknown as SlateElement, { at: path, select: true })
      return
    }

    // To Paragraph
    if (style === "paragraph") {
      if (node.type === "paragraph") return
      const text = getTextContent(node)
      Transforms.removeNodes(slateEditor, { at: path })
      
      const newParaBlock = createParagraphBlock()
      const newParaNode = toSlateNode(newParaBlock) as unknown as ParagraphElement
      
      // Set text
      if (newParaNode.children.length > 0) {
        const firstChild = newParaNode.children[0] as CustomText
        if (firstChild && typeof firstChild.text === 'string') {
           firstChild.text = text
        }
      }
      Transforms.insertNodes(slateEditor, newParaNode as unknown as SlateElement, { at: path, select: true })
      return
    }

    // To Math Block
    if (style === "math") {
      if (node.type === "math-block") return
      const latex = getLatexContent(node)
      Transforms.removeNodes(slateEditor, { at: path })
      const newMath = createMathBlock(latex, "equation")
      Transforms.insertNodes(slateEditor, toSlateNode(newMath) as unknown as SlateElement, { at: path, select: true })
      return
    }

    // To Math Env
    if (["definition", "theorem", "lemma", "proof", "remark", "example", "corollary", "proposition"].includes(style)) {
      const type = style as MathEnvType
      if (node.type === "math-env" && node.envType === type) return
      const latex = getLatexContent(node)
      Transforms.removeNodes(slateEditor, { at: path })
      const newEnv = createMathEnvBlock(type, latex)
      Transforms.insertNodes(slateEditor, toSlateNode(newEnv) as unknown as SlateElement, { at: path, select: true })
      return
    }

    // To Raw
    if (style === "raw") {
      if (node.type === "raw") return
      const content = getLatexContent(node)
      Editor.withoutNormalizing(slateEditor, () => {
        Transforms.removeNodes(slateEditor, { at: path })
        // For Raw, construct block manually or add createRawBlock helper if available
        const newRaw = { type: "raw" as const, id: nanoid(), content: { latex: content } }
        Transforms.insertNodes(slateEditor, toSlateNode(newRaw) as unknown as SlateElement, { at: path, select: true })
      })
      return
    }

    // To Figure
    if (style === "figure") {
      if (node.type === "figure") return
      Transforms.removeNodes(slateEditor, { at: path })
      const newFigure = createFigureBlock("", "")
      Transforms.insertNodes(slateEditor, toSlateNode(newFigure) as unknown as SlateElement, { at: path, select: true })
      return
    }

    // To Table
    if (style === "table") {
      if (node.type === "table") return
      Transforms.removeNodes(slateEditor, { at: path })
      const newTable = createTableBlock(2, 2)
      Transforms.insertNodes(slateEditor, toSlateNode(newTable) as unknown as SlateElement, { at: path, select: true })
      return
    }
  }

  const handleInlineMath = () => {
    const math: CustomElement = { type: "inline-math", id: nanoid(), latex: "", children: [{ text: "" }] }
    Transforms.insertNodes(slateEditor, math as unknown as SlateElement, { select: true })
  }

  const handleAddBlock = (type: string) => {
    switch (type) {
      case "paragraph":
        insertBlockNode(createParagraphBlock(), { position: "afterSelection" })
        return
      case "heading1":
        insertBlockNode(createHeadingBlock(1, ""), { position: "afterSelection" })
        return
      case "heading2":
        insertBlockNode(createHeadingBlock(2, ""), { position: "afterSelection" })
        return
      case "heading3":
        insertBlockNode(createHeadingBlock(3, ""), { position: "afterSelection" })
        return
      case "list-bullet":
        insertBlockNode(createListBlock("itemize"), { position: "afterSelection" })
        return
      case "list-numbered":
        insertBlockNode(createListBlock("enumerate"), { position: "afterSelection" })
        return
      case "math":
        insertBlockNode(createMathBlock("", "equation"), { position: "afterSelection" })
        return
      case "abstract":
        insertBlockNode(createAbstractBlock(""), { position: "afterSelection" })
        return
      case "figure":
        insertBlockNode(createFigureBlock("", ""), { position: "afterSelection" })
        return
      case "table":
        insertBlockNode(createTableBlock(3, 3), { position: "afterSelection" })
        return
      case "definition":
      case "theorem":
      case "lemma":
      case "proof":
      case "corollary":
      case "proposition":
      case "example":
      case "remark":
        insertBlockNode(createMathEnvBlock(type as MathEnvType, ""), { position: "afterSelection" })
        return
      default:
        return
    }
  }

  const handleDeleteElement = useCallback(
    (element: SlateElement) => {
      const path = ReactEditor.findPath(slateEditor, element)
      
      // Calculate focus candidate before deletion
      let focusPath: Path | null = null
      if (Path.hasPrevious(path)) {
        focusPath = Path.previous(path)
      } else {
        // If no previous, check if there are siblings that will shift into this spot
        const parent = Node.parent(slateEditor, path)
        if (parent.children.length > 1) {
             focusPath = path 
        }
      }

      Transforms.removeNodes(slateEditor, { at: path })

      if (focusPath) {
         // Try to focus the end of the adjacent block
         try {
             // We need to wait for React to update or just try selecting
             // Selecting end of void nodes (like math block) might be tricky, usually select the block itself
             Transforms.select(slateEditor, Editor.end(slateEditor, focusPath))
             ReactEditor.focus(slateEditor)
         } catch(e) { 
            // Fallback: just focus editor
            ReactEditor.focus(slateEditor)
         }
      }
    },
    [slateEditor],
  )

  const handleMoveElement = useCallback(
    (element: SlateElement, direction: "up" | "down") => {
      const path = ReactEditor.findPath(slateEditor, element)
      const parentEntry = Editor.parent(slateEditor, path)
      const siblings = (parentEntry[0] as SlateElement).children || []
      const index = path[path.length - 1]
      const targetIndex = direction === "up" ? index - 1 : index + 1
      if (targetIndex < 0 || targetIndex >= siblings.length) return
      const targetPath = path.slice(0, -1).concat(targetIndex)
      Transforms.moveNodes(slateEditor, { at: path, to: targetPath })
    },
    [slateEditor],
  )

  const handleDuplicateElement = useCallback(
    (element: SlateElement) => {
      const path = ReactEditor.findPath(slateEditor, element)
      const block = fromSlateNode(element as CustomElement)
      duplicateCounterRef.current += 1
      const duplicate = { ...block, id: `${block.id}-${duplicateCounterRef.current}` }
      const node = toSlateNode(duplicate)
      Transforms.insertNodes(slateEditor, node as unknown as SlateElement, { at: Path.next(path) })
      setSelectedBlockId((node as CustomElement).id || null)
    },
    [slateEditor],
  )

  const replaceElementWithBlock = useCallback(
    (element: SlateElement, block: DocumentBlock) => {
      const path = ReactEditor.findPath(slateEditor, element)
      const slateNode = toSlateNode(block)
      // Use setNodes to update properties without remounting the component
      // This is critical for maintaining focus in nested editors
      Transforms.setNodes(slateEditor, slateNode as Partial<SlateElement>, { at: path })
    },
    [slateEditor],
  )

  const renderLeaf = useCallback((props: RenderLeafProps) => <Leaf {...props} />, [])

  const handleEditableKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Enter key: insert soft break (newline) instead of splitting block
      // Skip during IME composition (Japanese/Korean/Chinese input)
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault()
        slateEditor.insertText("\n")
        return
      }

      if (event.key !== "Backspace" && event.key !== "Delete") return
      const selection = slateEditor.selection
      if (!selection) return

      for (const [node] of Editor.nodes(slateEditor, {
        at: selection,
        match: (n) =>
          SlateElement.isElement(n) &&
          slateEditor.isVoid(n as SlateElement) &&
          !slateEditor.isInline(n as SlateElement),
      })) {
        if (node) {
          event.preventDefault()
          return
        }
      }

      const getBlockEntry = (at: Range["anchor"]) =>
        Editor.above(slateEditor, {
          at,
          match: (n) => SlateElement.isElement(n) && Editor.isBlock(slateEditor, n),
          mode: "lowest",
        }) as [SlateElement, Path] | null

      const anchorBlock = getBlockEntry(selection.anchor)
      const focusBlock = getBlockEntry(selection.focus)

      if (anchorBlock && focusBlock && !Path.equals(anchorBlock[1], focusBlock[1])) {
        event.preventDefault()
        return
      }

      if (Range.isCollapsed(selection) && anchorBlock) {
        const [, blockPath] = anchorBlock
        if (event.key === "Backspace" && Editor.isStart(slateEditor, selection.anchor, blockPath)) {
          event.preventDefault()
          return
        }
        if (event.key === "Delete" && Editor.isEnd(slateEditor, selection.anchor, blockPath)) {
          event.preventDefault()
          return
        }
      }
    },
    [slateEditor],
  )

  const renderElement = useCallback(
    (props: RenderElementProps) => {
      const { attributes, children, element } = props
      const node = element as CustomElement
      const elementType = node.type
      const path = ReactEditor.findPath(slateEditor, node)
      // Check if this block is selected or contains the selected block
      // Use selectedBlockId state for reactivity, plus path check for hierarchy
      const isThisBlock = node.id === selectedBlockId
      let containsSelection = false
      try {
        if (slateEditor.selection) {
          containsSelection = Path.isAncestor(path, slateEditor.selection.anchor.path)
        }
      } catch {
        // Selection invalid or path not found - ignore
      }
      const isSelected = isThisBlock || containsSelection
      const mappedType: DocumentBlock["type"] =
        elementType === "math-block"
          ? "mathBlock"
          : elementType === "math-env"
            ? "mathEnv"
            : elementType === "slide-frame"
              ? "slideFrame"
              : elementType === "column-break"
                ? "columnBreak"
                : (elementType as DocumentBlock["type"])

      const selectBlock = () => {
        setActiveTextEditor(editorInterface)
      }

      const changeType = (newStyle: EditorStyle | string) => {
        const at = ReactEditor.findPath(slateEditor, element)
        Transforms.select(slateEditor, at)
        handleStyleChange(newStyle)
      }

      if (elementType === "inline-math") {
        return <InlineMathElement {...props} />
      }

      if (elementType === "list-item") {
        let canDelete = true
        let listType = "itemize"
        try {
          const [parent] = Editor.parent(slateEditor, path)
          const parentElement = parent as SlateElement
          const len = (parentElement.children?.length ?? 1)
          canDelete = len > 1
          if ((parentElement as any).listType === "enumerate") {
             listType = "enumerate"
          }
        } catch {
          canDelete = true
        }

        return (
          <li
            {...attributes}
            className="group relative flex gap-2 items-start"
            style={{ listStyle: "none" }}
          >
            <div 
              contentEditable={false} 
              className={`flex-shrink-0 select-none ${listType === "enumerate" ? "w-6" : "w-4"} flex justify-center pt-[0.2em]`}
            >
              {listType === "enumerate" ? (
                 <span className="text-slate-500 font-medium text-xs counters-increment">
                   {/* CSS counter handles numbering if we set it up on parent, or we can just use a generic dot if numbering is too hard to sync without index. 
                       Actually, for "enumerate", we usually want numbers. 
                       Since we can't easily get index here without performance cost, 
                       let's use CSS counters. The parent 'ul'/'ol' needs 'counter-reset'.
                   */}
                 </span>
              ) : (
                 <span className="text-slate-400 text-lg leading-none">•</span>
              )}
            </div>
            
            {/* 
               Better approach for enumerate: rely on CSS counters.
               The parent `ul` has class `list-decimal` but `flex` kills it.
               We can use `marker` pseudo-element if we don't use `flex`.
               BUT we need `flex` for the delete button alignment.
               So we simulate the marker.
               For enumerate, we need the index. 
               We can get it from path! path[path.length - 1] + 1.
            */}
             {listType === "enumerate" && (
                <span 
                  contentEditable={false} 
                  className="absolute left-0 top-0 w-6 text-right pr-2 text-slate-500 font-medium text-sm select-none"
                >
                  {(path[path.length - 1] ?? 0) + 1}.
                </span>
             )}

            <span className={`flex-1 min-w-0 ${listType === "enumerate" ? "pl-6" : ""}`}>{children}</span>
            
            {canDelete && (
              <button
                contentEditable={false}
                className="flex-shrink-0 opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-500 transition-opacity"
                onClick={(e) => {
                  e.stopPropagation()
                  handleDeleteElement(element as SlateElement)
                }}
                title="削除"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        )
      }

      switch (elementType) {
        case "paragraph":
          return (
            <BlockChrome
              attributes={attributes}
              elementType="paragraph"
              isSelected={isSelected}
              onSelect={selectBlock}
              onDelete={() => handleDeleteElement(element as SlateElement)}
              onDuplicate={() => handleDuplicateElement(element as SlateElement)}
              onMoveUp={() => handleMoveElement(element as SlateElement, "up")}
              onMoveDown={() => handleMoveElement(element as SlateElement, "down")}
              onChangeType={changeType}
            >
              <div className="flex flex-col gap-1">
                <span contentEditable={false} className="inline-flex w-12 items-center justify-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {t("editor.paragraphLabel")}
                </span>
                <p className="leading-relaxed text-slate-800">{children}</p>
              </div>
            </BlockChrome>
          )
        case "heading": {
          const level = (node as { level?: number }).level ?? 1
          const HeadingTag = `h${Math.min(level + 1, 6)}` as string
          const headingNumber = headingNumbers.get(node.id || "")
          const getHeadingClass = (lvl: number) => {
            const classes: Record<number, string> = {
              1: "text-3xl font-bold",
              2: "text-2xl font-bold",
              3: "text-xl font-semibold",
              4: "text-lg font-semibold",
              5: "text-base font-semibold",
              6: "text-sm font-semibold",
            }
            return classes[lvl] || classes[3]
          }
          return (
            <BlockChrome
              attributes={attributes}
              elementType="heading"
              isSelected={isSelected}
              onSelect={selectBlock}
              onDelete={() => handleDeleteElement(element as SlateElement)}
              onDuplicate={() => handleDuplicateElement(element as SlateElement)}
              onMoveUp={() => handleMoveElement(element as SlateElement, "up")}
              onMoveDown={() => handleMoveElement(element as SlateElement, "down")}
              onChangeType={changeType}
            >
              {createElement(
                HeadingTag,
                { className: `flex items-center gap-2 text-slate-900 ${getHeadingClass(level)}` },
                headingNumber
                  ? createElement(
                      "span",
                      {
                        className:
                          "inline-flex items-center justify-center rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700 flex-shrink-0 select-none",
                        contentEditable: false,
                      },
                      `${level === 1 ? "第" : ""}${headingNumber}${level === 1 ? "章" : level === 2 ? "節" : level === 3 ? "項" : "目"}`,
                    )
                  : null,
                createElement("span", null, children),
              )}
            </BlockChrome>
          )
        }
        case "list": {
          const listType = (node as { listType?: ListType }).listType || "itemize"
          const ListTag = (listType === "enumerate" ? "ol" : "ul") as string
          const addItem = () => {
            const at = path.concat((node.children?.length || 0))
            const newItem: CustomElement = { type: "list-item", id: nanoid(), children: [{ text: "" }] }
            Transforms.insertNodes(slateEditor, newItem as unknown as SlateElement, { at })
          }
          const toggleType = () => {
            const nextType = listType === "enumerate" ? "itemize" : "enumerate"
            Transforms.setNodes<SlateElement>(slateEditor, { listType: nextType } as Partial<CustomElement>, { at: path })
          }
          return (
            <BlockChrome
              attributes={attributes}
              elementType="list"
              isSelected={isSelected}
              onSelect={selectBlock}
              onDelete={() => handleDeleteElement(element as SlateElement)}
              onDuplicate={() => handleDuplicateElement(element as SlateElement)}
              onMoveUp={() => handleMoveElement(element as SlateElement, "up")}
              onMoveDown={() => handleMoveElement(element as SlateElement, "down")}
              onChangeType={changeType}
            >
              <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
                <div contentEditable={false} className="flex items-center justify-between px-3 py-2 bg-gradient-to-r from-slate-50 to-slate-100 border-b border-slate-200">
                  <span className="text-xs font-medium text-slate-600">
                    {listType === "enumerate" ? t("editor.addNumberedList") : t("editor.addBulletList")}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleType()
                    }}
                    className="text-xs text-indigo-600 hover:text-indigo-800"
                    contentEditable={false}
                  >
                    変更
                  </button>
                </div>
                <div className="p-3">
                  {createElement(
                    ListTag,
                    {
                      className: `ml-2 pl-4 space-y-1 ${
                        listType === "enumerate" ? "list-decimal" : "list-disc"
                      } list-inside marker:text-slate-500`,
                    },
                    children,
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      addItem()
                    }}
                    className="mt-2 flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
                    contentEditable={false}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("editor.addListItem")}
                  </button>
                </div>
              </div>
            </BlockChrome>
          )
        }
        case "math-block": {
          const block = fromSlateNode(node) as MathBlock
          return (
            <BlockChrome
              attributes={attributes}
              elementType="mathBlock"
              isSelected={isSelected}
              onSelect={selectBlock}
              onDelete={() => handleDeleteElement(element as SlateElement)}
              onDuplicate={() => handleDuplicateElement(element as SlateElement)}
              onMoveUp={() => handleMoveElement(element as SlateElement, "up")}
              onMoveDown={() => handleMoveElement(element as SlateElement, "down")}
              onChangeType={changeType}
            >
              <div contentEditable={false}>
                <MathBlockView
                  key={block.id}
                  block={block}
                  equationNumber={mathBlockNumbers.get(block.id)}
                  onUpdate={(updates) => {
                    const nextContent = updates.content
                    if (!nextContent) return
                    const patch: Partial<Extract<CustomElement, { type: "math-block" }>> = {}
                    if (typeof nextContent.latex === "string") {
                      patch.latex = nextContent.latex
                    }
                    if (typeof nextContent.environment === "string") {
                      patch.environment = nextContent.environment
                    }
                    if (typeof nextContent.numbered === "boolean") {
                      patch.numbered = nextContent.numbered
                    }
                    if (Object.keys(patch).length > 0) {
                      Transforms.setNodes(slateEditor, patch as Partial<CustomElement>, { at: path })
                    }
                  }}
                />
              </div>
              {children}
            </BlockChrome>
          )
        }
        case "math-env": {
          const envType = (node as { envType?: string }).envType
          const addChild = () => {
            const at = path.concat(node.children?.length || 0)
            const newParagraph = createParagraphBlock()
            Transforms.insertNodes(
              slateEditor,
              toSlateNode(newParagraph) as unknown as SlateElement,
              { at, select: true },
            )
          }
          return (
            <BlockChrome
              attributes={attributes}
              elementType="mathEnv"
              isSelected={isSelected}
              onSelect={selectBlock}
              onDelete={() => handleDeleteElement(element as SlateElement)}
              onDuplicate={() => handleDuplicateElement(element as SlateElement)}
              onMoveUp={() => handleMoveElement(element as SlateElement, "up")}
              onMoveDown={() => handleMoveElement(element as SlateElement, "down")}
              onChangeType={changeType}
            >
              <div className="bg-slate-50 rounded-lg border border-slate-200 overflow-hidden w-full">
                <div contentEditable={false} className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 bg-slate-100/50 text-sm font-medium text-slate-700 select-none">
                  <span className="text-xl">∑</span>
                  <span>{(() => {
                    const envLabels: Record<string, string> = {
                      definition: "定義",
                      theorem: "定理",
                      lemma: "補題",
                      proof: "証明",
                      corollary: "系",
                      proposition: "命題",
                      example: "例",
                      remark: "注意",
                      law: "法則",
                      block: "ブロック",
                      alertblock: "警告",
                      quote: "引用",
                      frame: "フレーム",
                      columns: "コラム",
                    }
                    return envLabels[envType || ""] || envType
                  })()}</span>
                </div>
                <div className="p-3 space-y-2">{children}</div>
                <div className="px-3 pb-3">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      addChild()
                    }}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs text-slate-600 bg-white border border-slate-200 rounded hover:bg-slate-50 hover:text-indigo-600 transition-colors select-none"
                    contentEditable={false}
                  >
                    <Plus className="h-3.5 w-3.5" /> 段落を追加
                  </button>
                </div>
              </div>
            </BlockChrome>
          )
        }
        case "figure": {
          const block = fromSlateNode(node) as FigureBlock
          return (
            <BlockChrome
              attributes={attributes}
              elementType="figure"
              isSelected={isSelected}
              onSelect={selectBlock}
              onDelete={() => handleDeleteElement(element as SlateElement)}
              onDuplicate={() => handleDuplicateElement(element as SlateElement)}
              onMoveUp={() => handleMoveElement(element as SlateElement, "up")}
              onMoveDown={() => handleMoveElement(element as SlateElement, "down")}
              onChangeType={changeType}
            >
              <div contentEditable={false}>
                <FigureBlockView
                  key={block.id}
                  block={block}
                  onUpdate={(updates) =>
                    replaceElementWithBlock(element as SlateElement, {
                      ...block,
                      ...(updates as Partial<FigureBlock>),
                    })
                  }
                />
              </div>
              {children}
            </BlockChrome>
          )
        }
        case "table": {
          const block = fromSlateNode(node) as TableBlock
          return (
            <BlockChrome
              attributes={attributes}
              elementType="table"
              isSelected={isSelected}
              onSelect={selectBlock}
              onDelete={() => handleDeleteElement(element as SlateElement)}
              onDuplicate={() => handleDuplicateElement(element as SlateElement)}
              onMoveUp={() => handleMoveElement(element as SlateElement, "up")}
              onMoveDown={() => handleMoveElement(element as SlateElement, "down")}
              onChangeType={changeType}
            >
              <div contentEditable={false}>
                <TableBlockView
                  key={block.id}
                  block={block}
                  onUpdate={(updates) =>
                    replaceElementWithBlock(element as SlateElement, {
                      ...block,
                      ...(updates as Partial<TableBlock>),
                    })
                  }
                />
              </div>
              {children}
            </BlockChrome>
          )
        }
        case "abstract": {
          const block = fromSlateNode(node) as AbstractBlock
          return (
            <BlockChrome
              attributes={attributes}
              elementType="abstract"
              isSelected={isSelected}
              onSelect={selectBlock}
              onDelete={() => handleDeleteElement(element as SlateElement)}
              onDuplicate={() => handleDuplicateElement(element as SlateElement)}
              onMoveUp={() => handleMoveElement(element as SlateElement, "up")}
              onMoveDown={() => handleMoveElement(element as SlateElement, "down")}
              onChangeType={changeType}
            >
              <div contentEditable={false}>
                <AbstractBlockView
                  key={block.id}
                  block={block}
                  onUpdate={(updates) =>
                    replaceElementWithBlock(element as SlateElement, {
                      ...block,
                      ...(updates as Partial<AbstractBlock>),
                    })
                  }
                />
              </div>
              {children}
            </BlockChrome>
          )
        }
        case "raw": {
          const block = fromSlateNode(node) as Extract<DocumentBlock, { type: "raw" }>
          return (
            <BlockChrome
              attributes={attributes}
              elementType="raw"
              isSelected={isSelected}
              onSelect={selectBlock}
              onDelete={() => handleDeleteElement(element as SlateElement)}
              onDuplicate={() => handleDuplicateElement(element as SlateElement)}
              onMoveUp={() => handleMoveElement(element as SlateElement, "up")}
              onMoveDown={() => handleMoveElement(element as SlateElement, "down")}
              onChangeType={changeType}
            >
              <div contentEditable={false} className="rounded-lg border border-slate-300 overflow-hidden bg-slate-900">
                <div className="flex items-center justify-between px-3 py-1.5 bg-slate-800 border-b border-slate-700">
                  <span className="text-xs font-medium text-slate-400">LaTeX</span>
                  <span className="text-xs text-slate-500">Raw</span>
                </div>
                <div className="p-3">
                  <textarea
                    className="w-full min-h-[120px] bg-transparent text-emerald-400 font-mono text-sm outline-none resize-y tex180-raw-input"
                    value={block.content?.latex || ""}
                    onChange={(event) => {
                      replaceElementWithBlock(element as SlateElement, {
                        ...block,
                        content: { latex: event.target.value },
                      })
                    }}
                    spellCheck={false}
                  />
                </div>
              </div>
              {children}
            </BlockChrome>
          )
        }
        case "toc":
          return (
            <BlockChrome
              attributes={attributes}
              elementType="toc"
              isSelected={isSelected}
              onSelect={selectBlock}
              onDelete={() => handleDeleteElement(element as SlateElement)}
              onDuplicate={() => handleDuplicateElement(element as SlateElement)}
              onMoveUp={() => handleMoveElement(element as SlateElement, "up")}
              onMoveDown={() => handleMoveElement(element as SlateElement, "down")}
              onChangeType={changeType}
            >
              <div contentEditable={false} className="p-3 text-sm text-slate-600 bg-white border border-slate-200 rounded">
                目次
              </div>
              {children}
            </BlockChrome>
          )
        default:
          return (
            <BlockChrome
              attributes={attributes}
              elementType={mappedType}
              isSelected={isSelected}
              onSelect={selectBlock}
              onDelete={() => handleDeleteElement(element as SlateElement)}
              onDuplicate={() => handleDuplicateElement(element as SlateElement)}
              onMoveUp={() => handleMoveElement(element as SlateElement, "up")}
              onMoveDown={() => handleMoveElement(element as SlateElement, "down")}
              onChangeType={changeType}
            >
              <div className="p-3 border border-slate-200 rounded bg-white text-slate-500 text-sm">未対応のブロック</div>
              {children}
            </BlockChrome>
          )
      }
    },
    [
      editorInterface,
      headingNumbers,
      slateEditor,
      selectedBlockId,
      t,
      // Functions that are stable or memoized
      handleDeleteElement,
      handleDuplicateElement,
      handleMoveElement,
      replaceElementWithBlock,
      // Math field context methods are stable
      setActiveTextEditor,
      // Document metadata
      // document?.metadata // Metadata is not used in renderElement, removing to prevent re-renders
    ],
  )

  const handleMetadataChange = (field: keyof DocumentMetadata, value: string) => {
    commitDocument({
      ...documentRef.current,
      metadata: {
        ...documentRef.current.metadata,
        [field]: value,
      },
    })
  }

  // Helper to extract options from preamble
  const extractOption = (preamble: string | undefined, type: string): string => {
    if (!preamble) return ""
    if (type === "pt") {
      const match = preamble.match(/\b(8pt|9pt|10pt|11pt|12pt|14pt|17pt|20pt)\b/)
      return match ? match[1] : "11pt"
    }
    if (type === "paper") {
      const match = preamble.match(/\b(a4paper|a5paper|b5paper|letterpaper)\b/)
      return match ? match[1] : "a4paper"
    }
    return ""
  }

  // Helper to update preamble options
  const updatePreambleOption = (type: string, value: string) => {
    const baseDoc = documentRef.current
    let preamble = baseDoc.metadata.preamble || `\\documentclass[11pt,a4paper]{${baseDoc.metadata.documentClass || "article"}}
\\usepackage{amsmath}
\\usepackage{graphicx}
`
    if (type === "fontSize") {
      preamble = preamble.replace(/\b(8pt|9pt|10pt|11pt|12pt|14pt|17pt|20pt)\b/, value)
    } else if (type === "paperSize") {
      preamble = preamble.replace(/\b(a4paper|a5paper|b5paper|letterpaper)\b/, value)
    }
    handleMetadataChange("preamble", preamble)
  }

  const safeSlateValue: Descendant[] = (() => {
    const base = Array.isArray(slateValue) ? slateValue : []
    if (base.length > 0) return base
    return toSlate(document?.blocks || [])
  })()

  const renderContent = () => (
    <div className="flex-1 overflow-auto">
      <div className="max-w-4xl mx-auto py-6 px-4 sm:px-8">
        <div
          ref={editorContainerRef}
          className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 sm:p-8 space-y-4 pb-24"
          onMouseDown={(e) => {
            if (isMathInteractionEvent(e.nativeEvent)) return
            setOpenMathFieldId(null)
            setActiveMathField(null)
          }}
        >
          <Slate key={slateKey} editor={slateEditor} initialValue={safeSlateValue} onChange={handleSlateChange}>
            <Editable
              renderElement={renderElement}
              renderLeaf={renderLeaf}
              placeholder={t("editor.paragraph")}
              className="space-y-3 outline-none"
              onFocus={() => setActiveTextEditor(editorInterface)}
              onKeyDown={handleEditableKeyDown}
            />
          </Slate>

          <div className="pt-4 flex justify-center"></div>
        </div>
      </div>
    </div>
  )

  return (
    <div className="h-full flex flex-col bg-slate-50">
      <EditorToolbar
        currentStyle={currentStyle}
        onStyleChange={handleStyleChange}
        onAddBlock={handleAddBlock}
        onFormat={() => {}}
        onInlineMath={handleInlineMath}
        onUndo={onUndo}
        onRedo={onRedo}
        canUndo={canUndo}
        canRedo={canRedo}
        slateEditor={slateEditor}
      />

      {renderContent()}
    </div>
  )
}

"use client"

import { useState } from "react"
import type { DocumentBlock } from "@/lib/document/types"
import { ParagraphBlockView } from "./ParagraphBlock"
import { HeadingBlockView } from "./HeadingBlock"
import { ListBlockView } from "./ListBlock"
import { MathBlockView } from "./MathBlockView"
import { MathEnvBlockView } from "./MathEnvBlockView"
import { AbstractBlockView } from "./AbstractBlock"
import { Trash2, Copy, ArrowUp, ArrowDown, Type, Heading1, Heading2, Heading3, List, ListOrdered, Sigma, BookOpen, Code } from "lucide-react"
import { FigureBlockView } from "./FigureBlock"
import { TableBlockView } from "./TableBlock"
import { TocBlockView } from "./TocBlockView"
import { EditorStyle } from "../EditorToolbar"

interface BlockRendererProps {
  block: DocumentBlock
  isSelected: boolean
  headingNumber?: string
  onSelect: () => void
  onUpdate: (updates: Partial<DocumentBlock>) => void
  onDelete: () => void
  onDuplicate?: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  onFocusInline?: (el: HTMLElement) => void
  onChangeType?: (type: EditorStyle | string) => void
}

export function BlockRenderer({ 
  block, 
  isSelected, 
  headingNumber,
  onSelect, 
  onUpdate, 
  onDelete,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  onFocusInline,
  onChangeType,
}: BlockRendererProps) {
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 })

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSelect()
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onSelect()
    setContextMenuPos({ x: e.clientX, y: e.clientY })
    setShowContextMenu(true)
  }

  const closeContextMenu = () => {
    setShowContextMenu(false)
  }

  const handleAction = (action: () => void) => {
    action()
    closeContextMenu()
  }

  // Get background color based on block type
  const getBlockBgColor = () => {
    switch (block.type) {
      case 'heading':
        return 'bg-purple-50/70'  // 紫 - 章/節
      case 'paragraph':
        return 'bg-orange-50/70'  // オレンジ - 本文
      case 'mathBlock':
        return 'bg-emerald-50/70' // 緑 - 数式
      case 'mathEnv':
        return 'bg-indigo-50/70'  // インディゴ - 数式環境
      case 'list':
        return 'bg-blue-50/70'    // 青 - リスト
      case 'figure':
        return 'bg-sky-50/70'     // 空色 - 図
      case 'table':
        return 'bg-cyan-50/70'    // シアン - 表
      case 'abstract':
        return 'bg-violet-50/70'  // 紫 - Abstract
      case 'toc':
        return 'bg-amber-50/70'   // 琥珀 - 目次
      case 'raw':
        return 'bg-slate-50/70'   // グレー - Raw
      default:
        return 'bg-slate-50/70'
    }
  }

  // Get left indicator color based on block type
  const getIndicatorColor = () => {
    if (!isSelected) return 'bg-slate-200'
    switch (block.type) {
      case 'heading':
        return 'bg-purple-500'
      case 'paragraph':
        return 'bg-orange-500'
      case 'mathBlock':
        return 'bg-emerald-500'
      case 'mathEnv':
        return 'bg-indigo-500'
      case 'list':
        return 'bg-blue-500'
      case 'figure':
        return 'bg-sky-500'
      case 'table':
        return 'bg-cyan-500'
      case 'abstract':
        return 'bg-violet-500'
      case 'toc':
        return 'bg-amber-500'
      default:
        return 'bg-slate-400'
    }
  }

  const MenuItem = ({ icon: Icon, label, onClick, danger = false }: { icon: any, label: string, onClick: () => void, danger?: boolean }) => (
    <button
      onClick={onClick}
      className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 transition-colors ${
        danger 
          ? "text-red-600 hover:bg-red-50" 
          : "text-slate-700 hover:bg-slate-100"
      }`}
    >
      <Icon className={`h-4 w-4 ${danger ? "" : "opacity-70"}`} />
      <span>{label}</span>
    </button>
  )

  const MenuLabel = ({ children }: { children: React.ReactNode }) => (
    <div className="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider mt-1 mb-0.5">
      {children}
    </div>
  )

  const Divider = () => <div className="border-t border-slate-200 my-1" />

  return (
    <>
      <div
        data-block-id={block.id}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        className={`relative group transition-all rounded-lg ${getBlockBgColor()}`}
      >
        {/* Selection indicator - left bar */}
        <div className={`absolute left-0 top-0 bottom-0 w-1 rounded-l-lg transition-all ${getIndicatorColor()}`} />

        {/* Block content with delete button */}
        <div className="pl-4 pr-2 py-2 flex items-center gap-2">
          <div className="flex-1 min-w-0">
            {block.type === 'paragraph' && (
              <ParagraphBlockView block={block} onUpdate={onUpdate} onFocusInline={onFocusInline} />
            )}
            {block.type === 'heading' && (
              <HeadingBlockView
                block={block}
                headingNumber={headingNumber}
                onUpdate={onUpdate}
                onFocusInline={onFocusInline}
              />
            )}
            {block.type === 'list' && (
              <ListBlockView block={block} onUpdate={onUpdate} onFocusInline={onFocusInline} />
            )}
            {block.type === 'mathBlock' && (
              <MathBlockView block={block} onUpdate={onUpdate} onDelete={onDelete} />
            )}
            {block.type === 'mathEnv' && (
              <MathEnvBlockView block={block} onUpdate={onUpdate} isSelected={isSelected} onSelect={onSelect} />
            )}
            {block.type === 'figure' && (
              <FigureBlockView block={block} onUpdate={onUpdate} />
            )}
            {block.type === 'table' && (
              <TableBlockView block={block} onUpdate={onUpdate} />
            )}
            {block.type === 'abstract' && (
              <AbstractBlockView block={block} onUpdate={onUpdate} />
            )}
            {block.type === 'toc' && (
              <TocBlockView />
            )}
            {block.type === 'raw' && (
              <div className="font-mono text-xs bg-slate-50 p-4 rounded-lg overflow-x-auto">
                <pre className="whitespace-pre-wrap text-slate-700">{block.content.latex}</pre>
              </div>
            )}
          </div>

          {/* Delete button - always visible, vertically centered on right */}
          <button
            className="flex-shrink-0 p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-all self-center"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            title="削除"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Context Menu */}
      {showContextMenu && (
        <>
          {/* Backdrop to close menu */}
          <div 
            className="fixed inset-0 z-40" 
            onClick={closeContextMenu}
          />
          
          {/* Menu */}
          <div
            className="fixed z-50 bg-white rounded-lg shadow-xl border border-slate-200 py-1 min-w-[180px] max-h-[80vh] overflow-y-auto"
            style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
          >
            <MenuLabel>テキスト</MenuLabel>
            {onChangeType && (
              <>
                <MenuItem icon={Type} label="本文 (Paragraph)" onClick={() => handleAction(() => onChangeType("paragraph"))} />
                <MenuItem icon={Heading1} label="見出し 1" onClick={() => handleAction(() => onChangeType("heading1"))} />
                <MenuItem icon={Heading2} label="見出し 2" onClick={() => handleAction(() => onChangeType("heading2"))} />
                <MenuItem icon={Heading3} label="見出し 3" onClick={() => handleAction(() => onChangeType("heading3"))} />
                <MenuItem icon={List} label="箇条書き" onClick={() => handleAction(() => onChangeType("bullet"))} />
                <MenuItem icon={ListOrdered} label="番号付きリスト" onClick={() => handleAction(() => onChangeType("numbered"))} />
              </>
            )}

            <Divider />
            <MenuLabel>数式</MenuLabel>
            {onChangeType && (
              <>
                <MenuItem icon={Sigma} label="数式ブロック" onClick={() => handleAction(() => onChangeType("math"))} />
                <MenuItem icon={BookOpen} label="定理 (Theorem)" onClick={() => handleAction(() => onChangeType("theorem"))} />
                <MenuItem icon={BookOpen} label="定義 (Definition)" onClick={() => handleAction(() => onChangeType("definition"))} />
                <MenuItem icon={BookOpen} label="証明 (Proof)" onClick={() => handleAction(() => onChangeType("proof"))} />
              </>
            )}

            <Divider />
            <MenuLabel>その他</MenuLabel>
            {onChangeType && (
               <MenuItem icon={Code} label="Raw (LaTeX)" onClick={() => handleAction(() => onChangeType("raw"))} />
            )}

            <Divider />
            <MenuLabel>操作</MenuLabel>
            {onMoveUp && <MenuItem icon={ArrowUp} label="上に移動" onClick={() => handleAction(onMoveUp)} />}
            {onMoveDown && <MenuItem icon={ArrowDown} label="下に移動" onClick={() => handleAction(onMoveDown)} />}
            {onDuplicate && <MenuItem icon={Copy} label="複製" onClick={() => handleAction(onDuplicate)} />}
            <MenuItem icon={Trash2} label="削除" onClick={() => handleAction(onDelete)} danger />
          </div>
        </>
      )}
    </>
  )
}

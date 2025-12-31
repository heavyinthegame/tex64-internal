"use client"

import { useState, useEffect, useRef } from "react"
import type { TableBlock } from "@/lib/document/types"
import { Button } from "@/components/ui/button"
import { Plus, Table as TableIcon } from "lucide-react"
import { MathCellInput } from "./MathCellInput"

interface TableBlockViewProps {
  block: TableBlock
  onUpdate: (updates: Partial<TableBlock>) => void
}

export function TableBlockView({ block, onUpdate }: TableBlockViewProps) {
  // Local state for alignment to prevent re-render thrashing
  const [localAlignment, setLocalAlignment] = useState(block.content.alignment || "")
  const alignmentInputRef = useRef<HTMLInputElement>(null)
  
  useEffect(() => {
    setLocalAlignment(block.content.alignment || "")
    // Restore cursor to end on external update (e.g. undo)
    if (document.activeElement === alignmentInputRef.current) {
        requestAnimationFrame(() => {
            const len = (block.content.alignment || "").length
            alignmentInputRef.current?.setSelectionRange(len, len)
        })
    }
  }, [block.content.alignment])

  const updateCell = (row: number, col: number, value: string) => {
    const rows = block.content.rows.map((r) => [...r])
    if (!rows[row]) return
    rows[row][col] = value
    onUpdate({ ...block, content: { ...block.content, rows } })
  }

  const addRow = () => {
    const cols = block.content.rows[0]?.length || 2
    const rows = [...block.content.rows, Array.from({ length: cols }).map(() => "")] as string[][]
    onUpdate({ ...block, content: { ...block.content, rows } })
  }

  const addColumn = () => {
    const rows = block.content.rows.map((r) => [...r, ""])
    const alignment = (block.content.alignment || "").padEnd(rows[0].length, "l")
    onUpdate({ ...block, content: { ...block.content, rows, alignment } })
  }

  const deleteRow = () => {
    if (block.content.rows.length <= 1) return // Prevent deleting last row
    const rows = block.content.rows.slice(0, -1)
    onUpdate({ ...block, content: { ...block.content, rows } })
  }

  const deleteColumn = () => {
    if (block.content.rows[0].length <= 1) return // Prevent deleting last column
    const rows = block.content.rows.map((r) => r.slice(0, -1))
    const alignment = (block.content.alignment || "").slice(0, rows[0].length)
    onUpdate({ ...block, content: { ...block.content, rows, alignment } })
  }

  const getAlignmentClass = (colIndex: number) => {
    const alignChar = (block.content.alignment || "")[colIndex]
    if (alignChar === "c") return "text-center"
    if (alignChar === "r") return "text-right"
    return "text-left"
  }

  return (
    <div className="border border-slate-200 rounded-lg bg-white shadow-sm" contentEditable={false}>
      <div className="flex items-center justify-between px-3 py-2 border-b bg-slate-50 rounded-t-lg select-none">
        <div className="flex items-center gap-2 text-sm font-bold text-slate-700 select-none">
          <TableIcon className="h-4 w-4" />
          表
        </div>
        <div className="flex gap-1" onKeyDown={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 select-none" onClick={deleteColumn} disabled={block.content.rows[0].length <= 1}>
            列削除
          </Button>
          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs select-none" onClick={addColumn}>
            <Plus className="h-3 w-3 mr-1" /> 列追加
          </Button>
          <div className="w-px h-4 bg-slate-300 mx-1 self-center select-none" />
          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 select-none" onClick={deleteRow} disabled={block.content.rows.length <= 1}>
            行削除
          </Button>
          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs select-none" onClick={addRow}>
            <Plus className="h-3 w-3 mr-1" /> 行追加
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto" onKeyDown={(e) => e.stopPropagation()}>
        <table className="min-w-full border-collapse">
          <tbody>
            {block.content.rows.map((row, rIndex) => (
              <tr key={`r-${rIndex}`} className="border-b last:border-b-0">
                {row.map((cell, cIndex) => (
                  <td key={`c-${cIndex}`} className={`border-r last:border-r-0 border-slate-200 p-1 ${getAlignmentClass(cIndex)}`}>
                    <MathCellInput
                      value={cell}
                      onChange={(value) => updateCell(rIndex, cIndex, value)}
                      placeholder={rIndex === 0 ? `見出し ${cIndex + 1}` : "セル"}
                      className={`min-w-[100px] ${getAlignmentClass(cIndex)}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-2 gap-3 px-3 py-3 border-t bg-slate-50 rounded-b-lg select-none">
        <div onKeyDown={(e) => e.stopPropagation()}>
          <label className="text-xs font-semibold text-slate-500 mb-1 block select-none">キャプション</label>
          <MathCellInput
            value={block.content.caption || ""}
            onChange={(value) =>
              onUpdate({ ...block, content: { ...block.content, caption: value } })
            }
            placeholder="表の説明を入力..."
            className="bg-white"
          />
        </div>
        <div onKeyDown={(e) => e.stopPropagation()}>
          <label className="text-xs font-semibold text-slate-500 mb-1 block select-none">列の配置 (l:左, c:中央, r:右)</label>

          <input
            ref={alignmentInputRef}
            value={localAlignment}
            onChange={(e) => {
              const val = e.target.value.toLowerCase().replace(/[^lcr]/g, "")
              setLocalAlignment(val)
            }}
            onBlur={() => {
              // Truncate to max length on blur
              const maxLen = block.content.rows[0].length
              let current = localAlignment
              if (current.length > maxLen) {
                 current = current.slice(0, maxLen)
                 setLocalAlignment(current)
              }
              if (current !== block.content.alignment) {
                 onUpdate({ ...block, content: { ...block.content, alignment: current } })
              }
            }}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                   e.preventDefault()
                   // Commit
                   const maxLen = block.content.rows[0].length
                   let current = localAlignment
                   if (current.length > maxLen) {
                      current = current.slice(0, maxLen)
                      setLocalAlignment(current)
                   }
                   if (current !== block.content.alignment) {
                      onUpdate({ ...block, content: { ...block.content, alignment: current } })
                   }
                }
            }}
            placeholder="例: ccc (全て中央揃え)"
            className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm font-mono tracking-widest bg-white"
          />
          <div className={`text-[10px] mt-1 text-right select-none transition-colors ${
            localAlignment.length > block.content.rows[0].length ? "text-red-500 font-bold" : "text-slate-400"
          }`}>
            {localAlignment.length} / {block.content.rows[0].length} 列
          </div>
        </div>

      </div>
    </div>
  )
}

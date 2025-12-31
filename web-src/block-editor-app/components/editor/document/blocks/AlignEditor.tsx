"use client"

import { useState, useCallback, useEffect } from "react"
import { SimpleMathField } from "./SimpleMathField"
import { Button } from "@/components/ui/button"
import { Plus, Trash2 } from "lucide-react"
import type { MathfieldElement as MathfieldElementType } from "mathlive"

interface AlignEditorProps {
  latex: string
  onChange: (latex: string) => void
}

export function AlignEditor({ latex, onChange }: AlignEditorProps) {
  // Parse latex into rows (ignore columns/& for now as we are simplifying to gather-like behavior)
  const parseRows = useCallback((src: string) => {
    const parsed = src.split(/\\\\(?![a-zA-Z])/).map((row) => row.replace(/&/g, "").trim())
    if (parsed.length === 0 || (parsed.length === 1 && !parsed[0])) {
      return [""]
    }
    return parsed
  }, [])

  const [rows, setRows] = useState<string[]>(() => parseRows(latex))

  // Keep rows in sync when latex prop changes
  useEffect(() => {
    setRows(parseRows(latex))
  }, [latex, parseRows])

  const updateRows = (newRows: string[]) => {
    setRows(newRows)
    // Reconstruct LaTeX
    // Join rows with \\ 
    const newLatex = newRows.join(" \\\\\n")
    onChange(newLatex)
  }

  const updateRow = (index: number, value: string) => {
    const newRows = [...rows]
    newRows[index] = value
    updateRows(newRows)
  }

  const addRow = () => {
    updateRows([...rows, ""])
  }

  const removeRow = (index: number) => {
    if (rows.length <= 1) return // Keep at least one row
    const newRows = rows.filter((_, i) => i !== index)
    updateRows(newRows)
  }

  const focusMathFieldToEnd = (container: HTMLElement) => {
    const mathField = container.querySelector("math-field") as
      | (MathfieldElementType & { executeCommand?: (...args: unknown[]) => boolean })
      | null
    if (!mathField) return

    mathField.focus?.()
    requestAnimationFrame(() => {
      if (typeof mathField.executeCommand === "function") {
        const moved = mathField.executeCommand("moveToMathfieldEnd")
        if (!moved) {
          mathField.executeCommand(["moveToMathfieldEnd"])
        }
      }
    })
  }

  return (
    <div className="w-full">
       <div className="flex flex-col gap-2">
         {rows.map((row, rowIndex) => (
           <div key={rowIndex} className="flex items-start gap-2 group animate-in fade-in slide-in-from-left-2 duration-200">
              {/* Row Number */}
              <div className="w-6 py-3 text-xs text-slate-400 font-mono select-none flex justify-center">
                {rowIndex + 1}
              </div>
              
              {/* Row Content */}
              <div className="flex-1">
                 <div
                   className="w-full bg-white rounded border border-slate-200 hover:border-indigo-300 focus-within:border-indigo-500 transition-colors shadow-sm"
                   onMouseDown={(e) => {
                     const target = e.target as HTMLElement
                     const path = (e.nativeEvent as MouseEvent).composedPath?.() || []
                     const clickedMathField =
                       !!target.closest?.("math-field") ||
                       path.some((node) => node instanceof HTMLElement && node.tagName === "MATH-FIELD")
                     if (clickedMathField) return
                     e.preventDefault()
                     focusMathFieldToEnd(e.currentTarget)
                   }}
                 >
                    <SimpleMathField
                      value={row}
                      onChange={(val) => updateRow(rowIndex, val)}
                      className="w-full p-2 min-h-[44px] text-lg"
                      placeholder="Type equation..."
                    />
                 </div>
              </div>

              {/* Row Actions */}
              <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center pt-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-slate-400 hover:text-red-500 hover:bg-red-50"
                  onClick={() => removeRow(rowIndex)}
                  disabled={rows.length <= 1}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
           </div>
         ))}
       </div>

       {/* Footer Actions */}
       <div className="mt-4 pl-8">
          <Button variant="outline" size="sm" onClick={addRow} className="gap-2 text-indigo-600 border-indigo-200 hover:bg-indigo-50 hover:border-indigo-300 shadow-sm">
            <Plus className="h-4 w-4" /> Add Line
          </Button>
       </div>
    </div>
  )
}

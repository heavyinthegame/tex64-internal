"use client"

import { useRef, useState, useEffect, useMemo, useCallback } from "react"
import type { FigureBlock, InlineContent } from "@/lib/document/types"
import { Button } from "@/components/ui/button"
import { Image as ImageIcon, Upload } from "lucide-react"
import { MathCellInput } from "./MathCellInput"
import { SimpleCaptionEditor } from "./SimpleCaptionEditor"

// Parser: string ($math$, **bold**, *italic*) -> InlineContent[]
const parseCaption = (text: string): InlineContent[] => {
  if (!text) return [{ type: 'text', content: '' }]
  
  const parts: InlineContent[] = []
  // Tokenize by math first, then formatted text
  // Math: \$([^$]+)\$ 
  // Bold: \*\*([^*]+)\*\*
  // Italic: \*([^*]+)\*
  // We process sequentially or use a master regex?
  // Master regex is risking overlap. Let's start with Math splitting, then process text chunks.
  
  const splitMath = (str: string) => {
    const res: Array<{ type: 'math' | 'text', value: string }> = []
    const regex = /\$([^$]+)\$/g
    let lastIndex = 0
    let match
    while ((match = regex.exec(str)) !== null) {
      if (match.index > lastIndex) {
        res.push({ type: 'text', value: str.slice(lastIndex, match.index) })
      }
      res.push({ type: 'math', value: match[1] })
      lastIndex = match.index + match[0].length
    }
    if (lastIndex < str.length) {
      res.push({ type: 'text', value: str.slice(lastIndex) })
    }
    return res
  }

  const parseFormatting = (text: string): InlineContent[] => {
    // Handle **bold** and *italic*
    // Simple state machine or regex? 
    // Regex: /(\*\*[^*]+\*\*|\*[^*]+\*)/g
    const chunks: InlineContent[] = []
    const regex = /(\*\*[^*]+\*\*|\*[^*]+\*)/g
    let lastIndex = 0
    let match
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        chunks.push({ type: 'text', content: text.slice(lastIndex, match.index) })
      }
      const token = match[0]
      if (token.startsWith('**')) {
        chunks.push({ type: 'text', content: token.slice(2, -2), formatting: { bold: true } })
      } else {
        chunks.push({ type: 'text', content: token.slice(1, -1), formatting: { italic: true } })
      }
      lastIndex = match.index + token.length
    }
    if (lastIndex < text.length) {
      chunks.push({ type: 'text', content: text.slice(lastIndex) })
    }
    return chunks
  }

  const mathSegments = splitMath(text)
  for (const seg of mathSegments) {
    if (seg.type === 'math') {
      parts.push({ type: 'math', latex: seg.value })
    } else {
      parts.push(...parseFormatting(seg.value))
    }
  }
  
  if (parts.length === 0) return [{ type: 'text', content: '' }]
  return parts
}

// Serializer: InlineContent[] -> string
const serializeCaption = (items: InlineContent[]): string => {
  return items.map(item => {
    if (item.type === 'math') return `$${item.latex}$`
    let text = item.content
    if (item.formatting?.bold) text = `**${text}**`
    else if (item.formatting?.italic) text = `*${text}*`
    return text
  }).join('')
}

interface FigureBlockViewProps {
  block: FigureBlock
  onUpdate: (updates: Partial<FigureBlock>) => void
}

export function FigureBlockView({ block, onUpdate }: FigureBlockViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  
  // Local caption state with debounced parent sync
  const [localCaption, setLocalCaption] = useState(() => block.content.caption || "")
  const richCaption = useMemo(() => parseCaption(localCaption), [localCaption])
  
  // Debounce timer ref
  const debounceRef = useRef<NodeJS.Timeout | null>(null)

  // Debounced sync to parent (for Undo support)
  const syncToParent = useCallback((caption: string) => {
    if (caption !== block.content.caption) {
      onUpdate({
        ...block,
        content: { ...block.content, caption },
      })
    }
  }, [block, onUpdate])

  const handleCaptionChange = useCallback((newContent: InlineContent[]) => {
    const serialized = serializeCaption(newContent)
    setLocalCaption(serialized)
    
    // Debounce: sync after 500ms of no typing
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      syncToParent(serialized)
    }, 500)
  }, [syncToParent])

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      onUpdate({
        ...block,
        content: { ...block.content, imagePath: dataUrl },
      })
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className="border border-slate-200 rounded-lg p-4 bg-slate-50" contentEditable={false}>
      <div className="flex items-start gap-4">
        <div className="flex-1 space-y-3">
          <div className="relative aspect-[4/3] w-full overflow-hidden rounded-md bg-white border border-dashed border-slate-300 flex items-center justify-center select-none">
            {block.content.imagePath ? (
              block.content.imagePath.startsWith('data:') ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={block.content.imagePath}
                  alt={block.content.caption || "Figure"}
                  className="object-contain w-full h-full"
                />
              ) : (
                <img
                  src={
                    block.content.imagePath.startsWith("/") ||
                    block.content.imagePath.startsWith("http")
                      ? block.content.imagePath
                      : `/${block.content.imagePath}`
                  }
                  alt={block.content.caption || "Figure"}
                  className="object-contain w-full h-full"
                />
              )
            ) : (
              <div className="flex flex-col items-center text-slate-400 text-sm">
                <ImageIcon className="h-6 w-6 mb-2" />
                Drop or upload an image
              </div>
            )}
          </div>
          <div>
            <label className="text-xs text-slate-500 font-semibold mb-1 block select-none">画像</label>
            <div className="flex gap-2">
              <Button variant="secondary" className="gap-2 shrink-0 bg-white border border-slate-200 hover:bg-slate-50 select-none" onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4 text-indigo-500" />
                <span className="text-slate-700">ファイルを選択</span>
              </Button>
              <input
                type="text"
                value={block.content.imagePath}
                placeholder="または画像のURLを入力..."
                onChange={(e) =>
                  onUpdate({
                    ...block,
                    content: { ...block.content, imagePath: e.target.value },
                  })
                }
                onKeyDown={(e) => e.stopPropagation()}
                className="flex-1 px-3 py-2 border border-slate-200 rounded-md text-sm bg-white focus:ring-2 focus:ring-indigo-500/20 outline-none transition-all"
              />
            </div>
          </div>

          <div>
             <label className="text-xs text-slate-500 font-semibold mb-1 block select-none">キャプション</label>
             <SimpleCaptionEditor
               value={richCaption}
               onChange={handleCaptionChange}
               placeholder="図のキャプションを入力..."
               className="min-h-[24px] bg-white px-2 py-1 border border-slate-200 rounded-md"
             />
          </div>

          <details className="group">
            <summary className="text-xs text-slate-500 font-medium cursor-pointer hover:text-indigo-600 w-fit list-none flex items-center gap-1 select-none">
              <div className="w-1.5 h-1.5 rounded-full bg-slate-300 group-open:bg-indigo-500 transition-colors" />
              詳細設定 (サイズ・配置)
            </summary>
            <div className="mt-3 grid grid-cols-2 gap-3 pl-3 border-l-2 border-slate-100">
             <div>
               <label className="text-[10px] uppercase tracking-wider text-slate-400 font-bold mb-1.5 block select-none">幅 (Width)</label>
               <input
                 value={block.content.width || ""}
                 onChange={(e) =>
                   onUpdate({
                     ...block,
                     content: { ...block.content, width: e.target.value },
                   })
                 }
                 onKeyDown={(e) => e.stopPropagation()}
                 placeholder="例: 0.8\textwidth"
                 className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-sm bg-white focus:border-indigo-400 outline-none"
               />
             </div>
             <div>
               <label className="text-[10px] uppercase tracking-wider text-slate-400 font-bold mb-1.5 block select-none">配置 (Placement)</label>
               <input
                 value={block.content.placement || ""}
                 onChange={(e) =>
                   onUpdate({
                     ...block,
                     content: { ...block.content, placement: e.target.value },
                   })
                 }
                 onKeyDown={(e) => e.stopPropagation()}
                 placeholder="例: htbp"
                 className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-sm bg-white focus:border-indigo-400 outline-none"
               />
             </div>
            </div>
          </details>
          
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
          <div className="hidden">
            <input
              type="text"
              value={block.content.imagePath}
              placeholder="or paste an image URL"
              onChange={(e) =>
                onUpdate({
                  ...block,
                  content: { ...block.content, imagePath: e.target.value },
                })
              }
              className="flex-1 px-3 py-2 border border-slate-300 rounded text-sm"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

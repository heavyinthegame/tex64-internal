"use client"

import { useState, useEffect, useCallback } from "react"
import type { DocumentBlock, MathEnvBlock, MathEnvType, MathBlock, ParagraphBlock } from "@/lib/document/types"
import { useLanguage } from "@/lib/i18n/LanguageContext"
import { BlockRenderer } from "./BlockRenderer"
import { nanoid } from "nanoid"
import { Type, Sigma, List as ListIcon } from "lucide-react"

interface MathEnvBlockViewProps {
  block: MathEnvBlock
  onUpdate: (updates: Partial<DocumentBlock>) => void
  isSelected?: boolean
  onSelect?: () => void
}

const envConfig: Record<MathEnvType, { labelJa: string; labelEn: string; emoji: string }> = {
  definition: { labelJa: "定義", labelEn: "Definition", emoji: "📘" },
  theorem: { labelJa: "定理", labelEn: "Theorem", emoji: "💡" },
  lemma: { labelJa: "補題", labelEn: "Lemma", emoji: "📝" },
  proof: { labelJa: "証明", labelEn: "Proof", emoji: "✓" },
  corollary: { labelJa: "系", labelEn: "Corollary", emoji: "📎" },
  proposition: { labelJa: "命題", labelEn: "Proposition", emoji: "💭" },
  example: { labelJa: "例", labelEn: "Example", emoji: "📋" },
  remark: { labelJa: "注意", labelEn: "Remark", emoji: "📌" },
  law: { labelJa: "法則", labelEn: "Law", emoji: "⚖️" },
  block: { labelJa: "ブロック", labelEn: "Block", emoji: "📦" },
  alertblock: { labelJa: "警告ブロック", labelEn: "Alert Block", emoji: "🚨" },
  quote: { labelJa: "引用", labelEn: "Quote", emoji: "❝" },
  frame: { labelJa: "スライド", labelEn: "Slide", emoji: "🎞️" },
  columns: { labelJa: "2段組み", labelEn: "Cols", emoji: "📰" },
}

export function MathEnvBlockView({ block, onUpdate, isSelected, onSelect }: MathEnvBlockViewProps) {
  const { language } = useLanguage()
  const config = envConfig[block.content.envType] || { labelJa: block.content.envType, labelEn: block.content.envType, emoji: "📄" }
  const label = language === 'ja' ? config.labelJa : config.labelEn
  
  // Migration logic: Convert legacy inlines/displayMath to children if children is missing
  useEffect(() => {
    if (!block.content.children) {
      const newChildren: DocumentBlock[] = []
      
      // Migrate inlines to ParagraphBlock
      if (block.content.inlines && block.content.inlines.length > 0) {
        const pBlock: ParagraphBlock = {
          id: nanoid(),
          type: "paragraph",
          content: {
            inlines: block.content.inlines
          }
        }
        newChildren.push(pBlock)
      }
      
      // Migrate displayMath to MathBlock
      if (block.content.displayMath) {
        const mBlock: MathBlock = {
          id: nanoid(),
          type: "mathBlock",
          content: {
            latex: block.content.displayMath,
            environment: "equation" // Default guess
          }
        }
        newChildren.push(mBlock)
      }
      
      // If absolutely empty, add an empty paragraph
      if (newChildren.length === 0) {
        newChildren.push({
          id: nanoid(),
          type: "paragraph",
          content: { inlines: [] }
        })
      }
      
      onUpdate({
        content: {
          ...block.content,
          children: newChildren,
          // Clear legacy fields to prevent re-migration
          inlines: undefined,
          displayMath: undefined,
        },
      })
    }
  }, [block.content, onUpdate])

  const [selectedChildId, setSelectedChildId] = useState<string | null>(null)

  // Helper to update a specific child block
  const handleChildUpdate = useCallback(
    (childId: string, updates: Partial<DocumentBlock>) => {
      if (!block.content.children) return

      const newChildren = block.content.children.map((child) =>
        child.id === childId ? ({ ...child, ...updates } as DocumentBlock) : child,
      )

      onUpdate({
        content: {
          ...block.content,
          children: newChildren,
        },
      })
    },
    [block.content, onUpdate],
  )

  // Helper to delete a specific child block
  const handleChildDelete = useCallback(
    (childId: string) => {
      if (!block.content.children) return

      // Calculate focus target before deletion
      const index = block.content.children.findIndex((c) => c.id === childId)
      const newChildren = block.content.children.filter((child) => child.id !== childId)

      // Determine which block to select next
      let nextSelectedId: string | null = null
      if (index > 0) {
        nextSelectedId = block.content.children[index - 1].id
      } else if (newChildren.length > 0) {
        nextSelectedId = newChildren[0].id
      }

      setSelectedChildId(nextSelectedId)

      onUpdate({
        content: {
          ...block.content,
          children: newChildren,
        },
      })
    },
    [block.content, onUpdate],
  )

  // Clear inner selection when parent selection changes (optional, but good for focus management)
  useEffect(() => {
    if (!isSelected && selectedChildId !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedChildId(null)
    }
  }, [isSelected, selectedChildId])

  const addBlock = useCallback((type: "paragraph" | "mathBlock" | "list") => {
    const newBlockId = nanoid()
    let newBlock: DocumentBlock

    if (type === "paragraph") {
      newBlock = {
        id: newBlockId,
        type: "paragraph",
        content: { inlines: [] }
      }
    } else if (type === "mathBlock") {
      newBlock = {
        id: newBlockId,
        type: "mathBlock",
        content: { latex: "", environment: "align" }
      }
    } else {
      newBlock = {
        id: newBlockId,
        type: "list",
        content: { listType: "itemize", items: [] }
      }
    }

    const currentChildren = block.content.children || []
    onUpdate({
      content: {
        ...block.content,
        children: [...currentChildren, newBlock]
      }
    })
    setSelectedChildId(newBlockId)
    // Also select parent when adding new block
    onSelect?.()
  }, [block.content, onSelect, onUpdate])

  // If currently migrating (children is undefined), show loading or nothing
  if (!block.content.children) {
    return <div className="p-4 bg-slate-50 text-slate-400">Updating structure...</div>
  }

  return (
    <div className="bg-slate-50 rounded-lg border border-slate-200 overflow-hidden" contentEditable={false}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 bg-slate-100/50 select-none">
        <span className="text-xl">{config.emoji}</span>
        <span className="text-sm font-medium text-slate-700">{label}</span>
        <span className="text-xs text-slate-400">({block.content.envType})</span>
        <div className="flex-1" />
      </div>

      <div className="p-3 space-y-3">
        {block.content.children.map((child) => (
          <div key={child.id} className="relative group/inner">
             <BlockRenderer
               block={child}
               isSelected={selectedChildId === child.id}
               onSelect={() => {
                 setSelectedChildId(child.id)
                 onSelect?.()
               }}
               onUpdate={(u) => handleChildUpdate(child.id, u)}
               onDelete={() => handleChildDelete(child.id)}
               // Pass other props if needed, mostly no-op for internal specific movements unless implemented
             />
          </div>
        ))}

        {/* Add Buttons */}
        <div className="flex gap-2 pt-2 border-t border-slate-200/50 select-none">
          <button 
            onClick={() => addBlock("paragraph")}
            className="flex items-center gap-1 px-3 py-1.5 text-xs text-slate-600 bg-white border border-slate-200 rounded hover:bg-slate-50 hover:text-indigo-600 transition-colors"
          >
            <Type className="h-3 w-3" /> テキスト
          </button>
          <button 
            onClick={() => addBlock("mathBlock")}
            className="flex items-center gap-1 px-3 py-1.5 text-xs text-slate-600 bg-white border border-slate-200 rounded hover:bg-slate-50 hover:text-indigo-600 transition-colors"
          >
            <Sigma className="h-3 w-3" /> 数式
          </button>
          <button 
            onClick={() => addBlock("list")}
            className="flex items-center gap-1 px-3 py-1.5 text-xs text-slate-600 bg-white border border-slate-200 rounded hover:bg-slate-50 hover:text-indigo-600 transition-colors"
          >
            <ListIcon className="h-3 w-3" /> リスト
          </button>
        </div>
      </div>
    </div>
  )
}

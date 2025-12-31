"use client"

import { useState, useEffect } from "react"
import type { InlineContent, ListBlock } from "@/lib/document/types"
import { nanoid } from "nanoid"
import { SimpleCaptionEditor } from "./SimpleCaptionEditor"
import { Button } from "@/components/ui/button"
import { ListChecks, ListOrdered, Plus, Trash2 } from "lucide-react"
import { useLanguage } from "@/lib/i18n/LanguageContext"

interface ListBlockViewProps {
  block: ListBlock
  onUpdate: (updates: Partial<ListBlock>) => void
  onFocusInline?: (el: HTMLElement) => void
}

export function ListBlockView({ block, onUpdate, onFocusInline }: ListBlockViewProps) {
  const { language } = useLanguage()
  const isOrdered = block.content.listType === "enumerate"
  const ListTag = isOrdered ? "ol" : "ul"
  const [newItemId, setNewItemId] = useState<string | null>(null)

  // Clear newItemId after a short delay (after the new item mounts)
  useEffect(() => {
    if (newItemId) {
      const timer = setTimeout(() => setNewItemId(null), 100)
      return () => clearTimeout(timer)
    }
  }, [newItemId])

  const handleItemChange = (itemId: string, newContent: InlineContent[]) => {
    // 空の場合でも自動削除しない
    // UXの意図: バックスペースで誤って行が消えないようにする
    // 削除は明示的に削除ボタンで行う
    onUpdate({
      ...block,
      content: {
        ...block.content,
        items: block.content.items.map((item) =>
          item.id === itemId ? { ...item, content: newContent } : item,
        ),
      },
    })
  }

  const handleAddItem = (afterItemId?: string) => {
    const newItemIdVal = nanoid()
    const newItem = { id: newItemIdVal, content: [{ type: "text" as const, content: "" }] }
    setNewItemId(newItemIdVal) // Track the new item for auto-activation
    
    if (afterItemId) {
      const index = block.content.items.findIndex(item => item.id === afterItemId)
      const newItems = [...block.content.items]
      newItems.splice(index + 1, 0, newItem)
      onUpdate({
        ...block,
        content: {
          ...block.content,
          items: newItems,
        },
      })
    } else {
      onUpdate({
        ...block,
        content: {
          ...block.content,
          items: [...block.content.items, newItem],
        },
      })
    }
  }

  const handleRemoveItem = (itemId: string) => {
    if (block.content.items.length <= 1) return // Keep at least one item
    onUpdate({
      ...block,
      content: {
        ...block.content,
        items: block.content.items.filter(item => item.id !== itemId),
      },
    })
  }

  const toggleListType = () => {
    onUpdate({
      ...block,
      content: {
        ...block.content,
        listType: isOrdered ? "itemize" : "enumerate",
      },
    })
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gradient-to-r from-slate-50 to-slate-100 border-b border-slate-200">
        <div className="flex items-center gap-2">
          {isOrdered ? (
            <ListOrdered className="h-4 w-4 text-blue-600" />
          ) : (
            <ListChecks className="h-4 w-4 text-green-600" />
          )}
          <span className="text-xs font-medium text-slate-600">
            {isOrdered 
              ? (language === 'ja' ? '番号付きリスト' : 'Numbered List')
              : (language === 'ja' ? '箇条書き': 'Bulleted List')
            }
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs px-2 text-slate-500 hover:text-slate-700"
          onClick={toggleListType}
        >
          {language === 'ja' ? '種類を変更' : 'Toggle'}
        </Button>
      </div>

      {/* List Items */}
      <div className="p-3">
        <ListTag className={`space-y-1 ${isOrdered ? 'list-none' : 'list-none'}`}>
          {block.content.items.map((item, index) => (
            <li key={item.id} className="group flex items-start gap-2">
              {/* Number or bullet */}
              <span className={`flex-shrink-0 w-6 h-7 flex items-center justify-center text-sm ${
                isOrdered ? 'text-blue-600 font-medium' : 'text-green-600'
              }`}>
                {isOrdered ? `${index + 1}.` : '•'}
              </span>
              
              {/* Content */}
              <div className="flex-1 min-w-0">
                <SimpleCaptionEditor
                  value={item.content}
                  onChange={(val) => handleItemChange(item.id, val)}
                  placeholder={language === 'ja' ? 'リスト項目...' : 'List item...'}
                  onFocusDom={onFocusInline}
                  className="py-0.5"
                  autoActivate={item.id === newItemId}
                />
              </div>

              {/* Delete button */}
              {block.content.items.length > 1 && (
                <button
                  onClick={() => handleRemoveItem(item.id)}
                  className="flex-shrink-0 opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-500 transition-opacity"
                  title={language === 'ja' ? '削除' : 'Delete'}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ListTag>

        {/* Add item button */}
        <button
          onClick={() => handleAddItem()}
          className="mt-2 flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          {language === 'ja' ? '項目を追加' : 'Add item'}
        </button>
      </div>
    </div>
  )
}

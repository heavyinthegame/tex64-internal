"use client"

import type { ParagraphBlock } from "@/lib/document/types"
import { SimpleCaptionEditor } from "./SimpleCaptionEditor"
import { useLanguage } from "@/lib/i18n/LanguageContext"

interface ParagraphBlockViewProps {
  block: ParagraphBlock
  onUpdate: (updates: Partial<ParagraphBlock>) => void
  onFocusInline?: (el: HTMLElement) => void
}

export function ParagraphBlockView({ block, onUpdate, onFocusInline }: ParagraphBlockViewProps) {
  const { t } = useLanguage()
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex w-12 items-center justify-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
        {t("editor.paragraphLabel")}
      </span>
      <SimpleCaptionEditor
        value={block.content.inlines}
        placeholder={t("editor.paragraph")}
        onFocusDom={onFocusInline}
        onChange={(value) =>
          onUpdate({
            ...block,
            content: { inlines: value },
          })
        }
        className="text-slate-800"
      />
    </div>
  )
}

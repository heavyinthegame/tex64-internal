import { Crown, List, Image, Table, Book, ScrollText } from "lucide-react"
import type { PageBreakBlock, MaketitleBlock, TocBlock, ListOfFiguresBlock, ListOfTablesBlock, AppendixBlock, BibliographyBlock, DocumentBlock } from "@/lib/document/types"

interface LayoutBlockViewProps {
  block: PageBreakBlock | MaketitleBlock | TocBlock | ListOfFiguresBlock | ListOfTablesBlock | AppendixBlock | BibliographyBlock | DocumentBlock
  isSelected?: boolean
}

// Simple label for divider-style blocks
function DividerLabel({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-4 pointer-events-none">
      <div className="absolute left-0 right-0 h-px bg-slate-200"></div>
      <span className="relative z-10 px-3 py-1 bg-white border border-slate-200 rounded-full text-xs font-medium text-slate-500 uppercase tracking-wide">
        {label}
      </span>
    </div>
  )
}

// Simple card for placeholder-style blocks
function CardLabel({ label, icon: Icon, bgColor }: { label: string, icon: any, bgColor: string }) {
  return (
    <div className="flex items-center gap-3 p-3 pointer-events-none">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${bgColor}`}>
        <Icon className="w-4 h-4" />
      </div>
      <span className="text-sm font-medium text-slate-700">{label}</span>
    </div>
  )
}

export function LayoutBlockView({ block }: LayoutBlockViewProps) {
  // All content is pointer-events-none to let clicks pass through to BlockChrome
  
  if (block.type === "pageBreak") {
    const isNewPage = (block as PageBreakBlock).content.type === "newpage"
    return <DividerLabel label={isNewPage ? "New Page" : "Clear Page"} />
  }

  if (block.type === "appendix") {
    return <DividerLabel label="Appendix" />
  }

  if (block.type === "maketitle") {
    return <CardLabel label="タイトルページ" icon={Crown} bgColor="bg-purple-50 text-purple-600" />
  }

  if (block.type === "toc") {
    return <CardLabel label="目次" icon={List} bgColor="bg-emerald-50 text-emerald-600" />
  }

  if (block.type === "listoffigures") {
    return <CardLabel label="図目次" icon={Image} bgColor="bg-sky-50 text-sky-600" />
  }

  if (block.type === "listoftables") {
    return <CardLabel label="表目次" icon={Table} bgColor="bg-cyan-50 text-cyan-600" />
  }

  if (block.type === "bibliography") {
    return <CardLabel label="参考文献" icon={Book} bgColor="bg-amber-50 text-amber-600" />
  }

  return null
}

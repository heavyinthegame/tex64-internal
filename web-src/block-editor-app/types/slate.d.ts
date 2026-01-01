import { BaseEditor } from 'slate'
import { ReactEditor } from 'slate-react'
import { HistoryEditor } from 'slate-history'
import type { MathEnvType, ListType } from '@/lib/document/types'

export type InlineMathElement = {
  type: 'inline-math'
  id?: string
  latex: string
  children: CustomText[]
}
export type SoftBreakElement = {
  type: 'soft-break'
  id?: string
  children: CustomText[]
}

export type ParagraphElement = {
  type: 'paragraph'
  id?: string
  children: (CustomText | InlineMathElement | SoftBreakElement)[]
}

export type HeadingElement = {
  type: 'heading'
  id?: string
  level: number
  command?: 'part' | 'chapter' | 'section' | 'subsection' | 'subsubsection' | 'paragraph' | 'subparagraph'
  children: (CustomText | InlineMathElement | SoftBreakElement)[]
}

export type ListItemElement = {
  type: 'list-item'
  id?: string
  children: (CustomText | InlineMathElement | SoftBreakElement)[]
}

export type ListElement = {
  type: 'list'
  id?: string
  listType: ListType
  children: ListItemElement[]
}

export type MathBlockElement = {
  type: 'math-block'
  id?: string
  latex: string
  environment?: string
  numbered?: boolean
  children: CustomText[]
}

export type MathEnvElement = {
  type: 'math-env'
  id?: string
  envType: MathEnvType
  title?: string
  children: CustomElement[]
}

export type FigureElement = {
  type: 'figure'
  id?: string
  imagePath: string
  caption?: string
  label?: string
  width?: string
  placement?: string
  children: CustomText[]
}

export type TableElement = {
  type: 'table'
  id?: string
  rows: string[][]
  caption?: string
  label?: string
  alignment?: string
  children: CustomText[]
}

export type AbstractElement = {
  type: 'abstract'
  id?: string
  children: (CustomText | InlineMathElement | SoftBreakElement)[]
}

export type TocElement = {
  type: 'toc'
  id?: string
  children: CustomText[]
}

export type RawElement = {
  type: 'raw'
  id?: string
  latex: string
  children: CustomText[]
}

export type CodeElement = {
  type: 'code'
  id?: string
  code: string
  language?: string
  caption?: string
  children: CustomText[]
}

export type SlideFrameElement = {
  type: 'slide-frame'
  id?: string
  title?: string
  children: CustomElement[]
}

export type ColumnBreakElement = {
  type: 'column-break'
  id?: string
  width?: string
  children: CustomText[]
}

export type PageBreakElement = {
  type: 'pageBreak'
  id?: string
  content: { type: 'newpage' | 'clearpage' } // Slate elements usually don't nest content like this, but matching IDL
  children: CustomText[]
}

export type MaketitleElement = {
  type: 'maketitle'
  id?: string
  children: CustomText[]
}

export type ListOfFiguresElement = {
  type: 'listoffigures'
  id?: string
  children: CustomText[]
}

export type ListOfTablesElement = {
  type: 'listoftables'
  id?: string
  children: CustomText[]
}

export type AppendixElement = {
  type: 'appendix'
  id?: string
  children: CustomText[]
}

export type BibliographyElement = {
  type: 'bibliography'
  id?: string
  content: { file?: string }
  children: CustomText[]
}

export type CustomElement =
  | ParagraphElement
  | HeadingElement
  | ListElement
  | ListItemElement
  | MathBlockElement
  | MathEnvElement
  | FigureElement
  | TableElement
  | AbstractElement
  | TocElement
  | RawElement
  | CodeElement
  | SlideFrameElement
  | ColumnBreakElement
  | InlineMathElement
  | SoftBreakElement
  | PageBreakElement
  | MaketitleElement
  | ListOfFiguresElement
  | ListOfTablesElement
  | AppendixElement
  | BibliographyElement

export type FormattedText = {
  id?: string
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  code?: boolean
  color?: string
}

export type CustomText = FormattedText

declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor & HistoryEditor
    Element: CustomElement
    Text: CustomText
  }
}

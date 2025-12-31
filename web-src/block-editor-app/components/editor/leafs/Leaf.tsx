import React from 'react'
import { RenderLeafProps } from 'slate-react'

export const Leaf = ({ attributes, children, leaf }: RenderLeafProps) => {
  if (leaf.bold) {
    children = <strong>{children}</strong>
  }

  if (leaf.italic) {
    children = <em>{children}</em>
  }

  if (leaf.code) {
    children = <code className="font-mono bg-slate-100 rounded px-1">{children}</code>
  }

  // Add more styles as needed (color, etc.)
  return <span {...attributes}>{children}</span>
}

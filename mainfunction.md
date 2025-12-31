# mainfunction plan memo

## tex64 no-code editing summary
- Block-based editor in React/Slate (DocumentEditor) with color-coded cards, context menu, and add-block toolbar.
- Document model in src/lib/document/types.ts: block types (paragraph, heading, list, mathBlock, mathEnv, figure, table, raw, abstract, toc, etc) and inline text/math.
- parseTeX in src/lib/document/parser.ts: pattern-based (not full TeX), extracts preamble + metadata, parses common envs, unknown envs -> raw block.
- serializeDocument in src/lib/document/serializer.ts: generates full TeX and injects packages/theorem envs; not lossless.
- Math editing uses MathLive (SimpleMathField, AlignEditor) and KaTeX for display.

## tex180 block editor (current implementation)
- New window opens from the "ブロック編集" button left of Build.
- UI is the tex64 DocumentEditor ported as-is (React/Slate/Tailwind) with the same look/feel.
- Left pane hosts tex180’s math keyboard (same keyset/behavior). Keyboard appears when a math-field is focused.
- Top header: file path + 再解析 + 差分 + 適用 + 閉じる.
- Diff preview is a collapsible overlay (line diff) so the main UI remains tex64-like.
- Raw blocks are editable (textarea) to keep unknown TeX safe and editable.

## MVP scope (confirmed)
- current file only (no master + \input expansion).
- paragraph parsing is conservative; unknown spans are raw.
- no marker comments; code remains untouched outside edited blocks.

## Data flow (code-first)
1) On open or sync: parse current file into block entries (type + range + snippet + anchor).
2) Convert block entries to tex64 Document model for the UI.
3) User edits in DocumentEditor (inline, block tools, move/duplicate).
4) On Apply: build block-level patches and apply in Monaco (descending offsets for stability).

## Block recognition
- One-pass scan with clear boundaries only:
  - Headings: \section / \subsection / ...
  - Environments: equation/align/gather/multline, theorem/lemma/proof, figure, table, code, abstract, frame/columns.
  - Lists: itemize/enumerate/description.
- Everything else -> raw block.

## Patch strategy
- Build LCS between source block order and draft order to detect stable anchors.
- Moved blocks are treated as delete + insert (no unsafe reordering in place).
- Each stable block gets a replacement string:
  - optional prefix (new blocks inserted before it)
  - updated serialized content (or empty if deleted)
  - optional suffix (new blocks appended at end)
- Patches apply from bottom to top using original ranges; snippet check ensures safety.
- serializeBlock (tex64 serializer) is used for block-level replacements; raw blocks keep original text.
- Metadata: update \title/\author/\date when present; insert before \begin{document} if missing.

## UX (user perspective)
- Click "ブロック編集" -> new window opens with tex64-style editor.
- Edit blocks inline; math and figures behave like tex64.
- Click "差分" to see a preview; "適用" patches the source safely.
- "再解析" resyncs if the file changed externally.

## Decisions confirmed
- No marker comments in source; keep code untouched outside edited blocks.
- MVP: current file only.
- Raw block is editable.

## Restored baseline behaviors
- Main editor math keyboard uses MathLive convertLatexToMarkup (\\displaystyle) for button glyphs; LaTeX block auto-detection + highlight restored.
- Block editor math keyboard matches the same MathLive rendering and displayLatex placeholders.

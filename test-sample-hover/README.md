# test-sample-hover

Hover総合確認ワークスペースです。

## 使い方

1. このフォルダをworkspaceとして開く。
2. `/Users/wedd/tex64/test-sample-hover/main.tex` を開く。
3. `CHECK-*` セクションの各ターゲット上にカーソルを置いてhoverを確認する。

## カバー範囲

- package/class: `\documentclass`, `\usepackage`, `\RequirePackage`
- ref系: `\ref`, `\eqref`, `\pageref`, `\autoref`, `\cref`, `\Cref`, `\namecref`, `\Namecref`, `\nameref`, `\Nameref`
- cite系: `\cite`, `\citet`, `\citep`, `\citeauthor`, `\citeyear`, `\autocite`, `\parencite`, `\textcite`, `\footcite`, `\supercite`, 複数キー
- include系: `\input`, `\include`
- graphics系: `\includegraphics`（png / pdf / svg(hover only)）
- 数式: `$...$`, `\(...\)`, `\[...\]`, `$$...$$`, `equation`環境
- 数式拡張: 区切り記号（`|`, `\|`, `\lVert`, `\left...\right...`）、`cases`、`matrix/pmatrix/bmatrix/vmatrix`、`align/gather/split/multline/alignat/flalign/eqnarray`、極限・積分・和積・論理記号・集合演算・アクセント
- 未解決ケース: ref / cite / include / graphics

## コンパイル注意

- 未解決ケースとsvg画像例は `\iffalse ... \fi` に入れてあり、PDFビルドを壊しません。

# VS Code LaTeX Workshop 機能インベントリ（参照用）

このドキュメントは **VS Code 拡張「LaTeX Workshop」側の“漏れ防止”チェックリスト**です。
tex64 の移行障壁レビュー（`docs/latex-workshop-gap-analysis.md`）で「何を比較対象として扱うか」を固定する目的で作成しています。

- 参照日: 2026-02-18
- 対象: James-Yu/LaTeX-Workshop
- バージョン: 10.12.2（`package.json`）
- 参照元（web）:
  - README（機能カテゴリ）: https://github.com/James-Yu/LaTeX-Workshop
  - Wiki: Compile / View / IntelliSense / Hover / Snippets / Formatting / Linters / Environments / ExtraFeatures / Remote
- 参照元（拡張リポジトリ内ファイル）:
  - `package.json`（commands/config/keybindings/languages/views/menus/customEditors）
  - `package.nls.json`（コマンドの表示名）
  - `data/latex-snippet.json`（同梱スニペット）

---

## 1) 機能カテゴリ（README / Wiki ベース）

### 1.1 Compile（ビルド/レシピ）

- レシピ（recipe）/ツール（tool）定義によるビルド（`latexmk` 固定ではない）
- 自動ビルド（保存/変更監視/interval）
- 外部ビルドコマンド
- clean（補助ファイル削除）/ kill（プロセス停止）
- root file 検出、magic comment（`%!TEX root` など）
- outDir/auxDir/jobname、watch（ソース/PDF 監視）

### 1.2 View（PDF ビューア）

- 内蔵 PDF viewer（VS Code の custom editor として *.pdf をフック）
- 表示先: 既定 viewer / タブ / ブラウザ / 外部ビューア
- 内蔵 viewer 設定:
  - zoom / scrollMode / spreadMode / hand tool
  - trim（余白）/ invert（色反転、invertMode の各種調整）
  - light/dark の色設定
  - sidebar（outline/thumbnails）/ toolbar hide timeout
  - 内部サーバ host/port（Codespaces/Remote 含む）
- SyncTeX（afterBuild / indicator / keybinding など）

### 1.3 IntelliSense（補完/参照/引用/パッケージ）

- Label / Ref / Citation の補完
- BibTeX/BibLaTeX（backend、label/format/filter、browser/inline）
- パッケージ由来のコマンド/環境補完（dirs/extra/exclude/unusual）
- 引数ヒント（argument hint）
- `\input`/`\include`/`\includegraphics` のパス補完（base/exclude、preview）
- unimathsymbols / subsuperscript / `@` suggestion（数式補助）
- glossary / acronyms（設定による）
- kpsewhich 連携（class/bibtex の探索）

### 1.4 Hover（ホバー）

- Ref/Cite/Label などの参照プレビュー
- `\input`/`\include` などのファイル参照プレビュー
- `\includegraphics`/`\includesvg` の画像プレビュー
- `\usepackage` / `\documentclass` / コマンドのドキュメント（CTAN/texdoc 等）プレビュー
- mathjax を使った数式プレビュー（プレビュー設定・スケール・最大行など）

### 1.5 Snippets（同梱スニペット + snippet view）

- 公式同梱スニペット（env/text/math など）
- Snippet view（Activity Bar の webview から挿入）
- `wrapEnv` 等、選択範囲ラップ系

### 1.6 Formatting（整形）

- LaTeX:
  - latexindent（path/args）
  - tex-fmt（path/args）
  - fixQuotes / fixMath
- BibTeX:
  - sort / align / case / tab / trailingComma / surround / duplicates

### 1.7 Linters（lint）

- ChkTeX / LaCheck の実行
- delay/run の設定
- 出力変換（column 位置など）

### 1.8 Environments / Structural Editing（構造編集）

- 環境ペア操作:
  - matching `\\begin{}`/`\\end{}` への移動
  - env name/content の選択
  - env name へのマルチカーソル追加
  - 選択範囲を `\\begin{}`…`\\end{}` で wrap
  - 現在環境を close
- `\\[ ... \\]` と `\\begin{equation}`… のトグル
- Surround selection with command（`\\textbf{}` 等）
- 章立てレベルの promote/demote
- smart selection
- Enter/Alt+Enter の挙動フック（設定で有効化）

### 1.9 ExtraFeatures（その他）

- LaTeX Explorer（Activity Bar）
  - Commands view
  - Structure view
  - Snippet view
- Log/Compiler log viewer
- Citation browser / unused citations check（checkcites）
- Duplicated labels check
- Word count（texcount）
- texdoc
- Remote/Codespaces/Docker 向け設定（host/port、docker runner 等）

---

## 2) コマンド一覧（`contributes.commands`）

`package.nls.json` の表示名を併記しています。

- `latex-workshop.build` — Build LaTeX project
- `latex-workshop.recipes` — Build with recipe
- `latex-workshop.clean` — Clean up auxiliary files
- `latex-workshop.kill` — Kill LaTeX compiler process
- `latex-workshop.view` — View LaTeX PDF file
- `latex-workshop.tab` — View LaTeX PDF file in VSCode tab
- `latex-workshop.viewInBrowser` — View LaTeX PDF file in web browser
- `latex-workshop.viewExternal` — View LaTeX PDF file in external viewer
- `latex-workshop.refresh-viewer` — Refresh all LaTeX PDF viewers
- `latex-workshop.synctex` — SyncTeX from cursor
- `latex-workshop.addtexroot` — Insert !TeX root magic comment
- `latex-workshop.revealOutputDir` — Reveal output folder in OS
- `latex-workshop.saveWithoutBuilding` — Save without Building
- `latex-workshop.wordcount` — Count words in LaTeX document
- `latex-workshop.citation` — Open citation browser
- `latex-workshop.checkcitations` — Check for unused citations with "checkcites"
- `latex-workshop.texdoc` — Show package documentation
- `latex-workshop.texdocUsepackages` — Show package documentation actually used
- `latex-workshop.compilerlog` — View LaTeX compiler logs
- `latex-workshop.log` — View LaTeX Workshop messages
- `latex-workshop.actions` — LaTeX actions
- `latex-workshop.changeHostName` — Change server listening hostname
- `latex-workshop.resetHostName` — Reset server listening hostname to 127.0.0.1
- `latex-workshop.hostPort` — Share (on host) / Acquire (on guest) Live Share host port
- `latex-workshop.openMathPreviewPanel` — Open Math Preview Panel
- `latex-workshop.closeMathPreviewPanel` — Close Math Preview Panel
- `latex-workshop.toggleMathPreviewPanel` — Toggle Math Preview Panel
- `latex-workshop.promote-sectioning` — Promote all the section levels used in the selection
- `latex-workshop.demote-sectioning` — Demote all the section levels used in the selection
- `latex-workshop.select-section` — Select the current section
- `latex-workshop.bibsort` — Sort BibTeX file
- `latex-workshop.bibalign` — Align BibTeX file
- `latex-workshop.bibalignsort` — Sort and align BibTeX file
- `latex-workshop.navigate-envpair` — Navigate to matching \\begin{}/\\end{}
- `latex-workshop.select-envname` — Select the current environment name
- `latex-workshop.select-envcontent` — Select the current environment content
- `latex-workshop.select-env` — Select the current environment
- `latex-workshop.multicursor-envname` — Add a multicursor to the current environment name
- `latex-workshop.wrap-env` — Surround selection with \\begin{}...\\end{}
- `latex-workshop.surround` — Surround selection with LaTeX command
- `latex-workshop.close-env` — Close current environment
- `latex-workshop.toggle-equation-envname` — Toggle between \\[...\\] and \\begin{}...\\end{}

---

## 3) スニペット一覧（`data/latex-snippet.json`）

スニペット名 → prefix → 概要。

- align → BAL → align environment
- align* → BSAL → align* environment
- cases → BCAS → cases environment
- chapter → SCH → chapter
- emph → FEM → emphasis font
- enumerate → BEN → enumerate environment
- equation → BEQ → equation environment
- equation* → BSEQ → equation* environment
- etc → ... → \\dots
- figure → BFI → figure
- frame → BFR → frame
- gather → BGA → gather environment
- gather* → BSGA → gather* environment
- item → item → \\item on a newline
- itemize → BIT → itemize environment
- lowercase → FLC → Make text lowercase (no caps)
- mathbb → MBB → math blackboard bold font
- mathbf → MBF → math bold font
- mathcal → MCA → math caligraphic font
- mathit → MIT → math italic font
- mathrm → MRM → math roman font
- mathsf → MSF → math sans serif font
- mathtt → MTT → math typewriter font
- multline → BMU → multline environment
- multline* → BSMU → multline* environment
- paragraph → SPG → paragraph
- part → SPA → part
- section → SSE → section
- set font size → fontsize → Select a font size
- split → BSPL → split environment
- subparagraph → SSP → subparagraph
- subscript → __ → subscript
- subsection → SSS → subsection
- subsubsection → SS2 → subsubsection
- superscript → ** → superscript
- table (caption after tabular) → BTA → table
- table (caption before tabular) → BTB → table
- textbf → FBF → bold font
- textit → FIT → italic font
- textnormal → FNO → normal font
- textrm → FRM → roman font
- textsc → FSC → smallcaps font
- textsf → FSF → sans serif font
- textsl → FSL → slanted font
- textsubscript → FBS → Make text a superscript
- textsuperscript → FSS → Make text a superscript
- texttt → FTT → typewriter font
- tikzcd → BTC → tikzcd
- tikzpicture → BTP → tikzpicture
- underline → FUL → Underline text
- uppercase → FUC → Make text uppercase (all caps)
- wrapEnv → (prefix なし) → Wrap selection into an environment

---

## 4) 設定キー一覧（`contributes.configuration.properties`）

「キーが存在する = 対応/制御できる機能がある」ため、漏れ防止のために列挙します。

### 4.1 BibTeX / BibLaTeX

- `latex-workshop.bibtex-entries.first`
- `latex-workshop.bibtex-fields.order`
- `latex-workshop.bibtex-fields.sort.enabled`
- `latex-workshop.bibtex-format.align-equal.enabled`
- `latex-workshop.bibtex-format.case.field`
- `latex-workshop.bibtex-format.case.type`
- `latex-workshop.bibtex-format.handleDuplicates`
- `latex-workshop.bibtex-format.sort.enabled`
- `latex-workshop.bibtex-format.sortby`
- `latex-workshop.bibtex-format.surround`
- `latex-workshop.bibtex-format.tab`
- `latex-workshop.bibtex-format.trailingComma`
- `latex-workshop.bibtex.maxFileSize`

### 4.2 キーバインド/編集挙動

- `latex-workshop.bind.altKeymap.enabled`
- `latex-workshop.bind.enter.key`
- `latex-workshop.selection.smart.latex.enabled`
- `latex-workshop.showContextMenu`

### 4.3 チェック/メッセージ

- `latex-workshop.check.duplicatedLabels.enabled`
- `latex-workshop.message.badbox.show`
- `latex-workshop.message.biberlog.exclude`
- `latex-workshop.message.bibtexlog.exclude`
- `latex-workshop.message.convertFilenameEncoding`
- `latex-workshop.message.error.show`
- `latex-workshop.message.information.show`
- `latex-workshop.message.latexlog.exclude`
- `latex-workshop.message.log.show`
- `latex-workshop.message.warning.show`

### 4.4 Docker / Codespaces / Remote

- `latex-workshop.codespaces.portforwarding.openDelay`
- `latex-workshop.docker.enabled`
- `latex-workshop.docker.image.latex`
- `latex-workshop.docker.path`

### 4.5 Formatting

- `latex-workshop.format.fixMath.enabled`
- `latex-workshop.format.fixQuotes.enabled`
- `latex-workshop.formatting.latex`
- `latex-workshop.formatting.latexindent.args`
- `latex-workshop.formatting.latexindent.path`
- `latex-workshop.formatting.tex-fmt.args`
- `latex-workshop.formatting.tex-fmt.doNotWrap`
- `latex-workshop.formatting.tex-fmt.path`
- `latex-workshop.latexindent.args`
- `latex-workshop.latexindent.path`

### 4.6 Hover

- `latex-workshop.hover.citation.enabled`
- `latex-workshop.hover.command.enabled`
- `latex-workshop.hover.preview.cursor.color`
- `latex-workshop.hover.preview.cursor.enabled`
- `latex-workshop.hover.preview.cursor.symbol`
- `latex-workshop.hover.preview.enabled`
- `latex-workshop.hover.preview.mathjax.extensions`
- `latex-workshop.hover.preview.maxLines`
- `latex-workshop.hover.preview.newcommand.newcommandFile`
- `latex-workshop.hover.preview.newcommand.parseTeXFile.enabled`
- `latex-workshop.hover.preview.scale`
- `latex-workshop.hover.ref.enabled`
- `latex-workshop.hover.ref.number.enabled`

### 4.7 IntelliSense

- `latex-workshop.intellisense.argumentHint.enabled`
- `latex-workshop.intellisense.atSuggestion.trigger.latex`
- `latex-workshop.intellisense.atSuggestion.user`
- `latex-workshop.intellisense.biblatexJSON.replace`
- `latex-workshop.intellisense.bibtexJSON.replace`
- `latex-workshop.intellisense.citation.backend`
- `latex-workshop.intellisense.citation.filterText`
- `latex-workshop.intellisense.citation.format`
- `latex-workshop.intellisense.citation.label`
- `latex-workshop.intellisense.citation.type`
- `latex-workshop.intellisense.command.user`
- `latex-workshop.intellisense.file.base`
- `latex-workshop.intellisense.file.exclude`
- `latex-workshop.intellisense.includegraphics.preview.enabled`
- `latex-workshop.intellisense.label.command`
- `latex-workshop.intellisense.optionalArgsEntries.enabled`
- `latex-workshop.intellisense.package.dirs`
- `latex-workshop.intellisense.package.enabled`
- `latex-workshop.intellisense.package.env.enabled`
- `latex-workshop.intellisense.package.exclude`
- `latex-workshop.intellisense.package.extra`
- `latex-workshop.intellisense.package.unusual`
- `latex-workshop.intellisense.subsuperscript.enabled`
- `latex-workshop.intellisense.triggers.latex`
- `latex-workshop.intellisense.unimathsymbols.enabled`
- `latex-workshop.intellisense.update.aggressive.enabled`
- `latex-workshop.intellisense.update.delay`

### 4.8 kpsewhich

- `latex-workshop.kpsewhich.bibtex.enabled`
- `latex-workshop.kpsewhich.class.enabled`
- `latex-workshop.kpsewhich.path`

### 4.9 LaTeX（ビルド/監視/レシピ）

- `latex-workshop.latex.autoBuild.cleanAndRetry.enabled`
- `latex-workshop.latex.autoBuild.interval`
- `latex-workshop.latex.autoBuild.onSave.files.ignore`
- `latex-workshop.latex.autoBuild.run`
- `latex-workshop.latex.autoClean.run`
- `latex-workshop.latex.auxDir`
- `latex-workshop.latex.bibDirs`
- `latex-workshop.latex.build.clearLog.everyRecipeStep.enabled`
- `latex-workshop.latex.build.enableMagicComments`
- `latex-workshop.latex.build.forceRecipeUsage`
- `latex-workshop.latex.build.fromWorkspaceFolder`
- `latex-workshop.latex.build.rootfileInStatus`
- `latex-workshop.latex.clean.args`
- `latex-workshop.latex.clean.command`
- `latex-workshop.latex.clean.fileTypes`
- `latex-workshop.latex.clean.method`
- `latex-workshop.latex.clean.subfolder.enabled`
- `latex-workshop.latex.external.build.args`
- `latex-workshop.latex.external.build.command`
- `latex-workshop.latex.extraExts`
- `latex-workshop.latex.jobname`
- `latex-workshop.latex.magic.args`
- `latex-workshop.latex.magic.bib.args`
- `latex-workshop.latex.option.maxPrintLine.enabled`
- `latex-workshop.latex.outDir`
- `latex-workshop.latex.recipe.default`
- `latex-workshop.latex.recipes`
- `latex-workshop.latex.rootFile.doNotPrompt`
- `latex-workshop.latex.rootFile.indicator`
- `latex-workshop.latex.rootFile.useSubFile`
- `latex-workshop.latex.search.rootFiles.exclude`
- `latex-workshop.latex.search.rootFiles.include`
- `latex-workshop.latex.texDirs`
- `latex-workshop.latex.tools`
- `latex-workshop.latex.verbatimEnvs`
- `latex-workshop.latex.watch.delay`
- `latex-workshop.latex.watch.files.ignore`
- `latex-workshop.latex.watch.pdf.delay`

### 4.10 Linting（ChkTeX/LaCheck）

- `latex-workshop.linting.chktex.convertOutput.column.chktexrcTabSize`
- `latex-workshop.linting.chktex.convertOutput.column.enabled`
- `latex-workshop.linting.chktex.enabled`
- `latex-workshop.linting.chktex.exec.args`
- `latex-workshop.linting.chktex.exec.path`
- `latex-workshop.linting.delay`
- `latex-workshop.linting.lacheck.enabled`
- `latex-workshop.linting.lacheck.exec.path`
- `latex-workshop.linting.run`

### 4.11 Math Preview Panel

- `latex-workshop.mathpreviewpanel.cursor.enabled`
- `latex-workshop.mathpreviewpanel.editorGroup`

### 4.12 SyncTeX

- `latex-workshop.synctex.afterBuild.enabled`
- `latex-workshop.synctex.indicator`
- `latex-workshop.synctex.path`

### 4.13 texcount / texdoc

- `latex-workshop.texcount.args`
- `latex-workshop.texcount.autorun`
- `latex-workshop.texcount.interval`
- `latex-workshop.texcount.path`
- `latex-workshop.texdoc.args`
- `latex-workshop.texdoc.path`

### 4.14 Outline / PDF viewer

- `latex-workshop.view.autoFocus.enabled`
- `latex-workshop.view.outline.commands`
- `latex-workshop.view.outline.floats.caption.enabled`
- `latex-workshop.view.outline.floats.enabled`
- `latex-workshop.view.outline.floats.number.enabled`
- `latex-workshop.view.outline.follow.editor`
- `latex-workshop.view.outline.numbers.enabled`
- `latex-workshop.view.outline.sections`
- `latex-workshop.view.outline.sync.viewer`
- `latex-workshop.view.pdf.color.dark.backgroundColor`
- `latex-workshop.view.pdf.color.dark.pageBorderColor`
- `latex-workshop.view.pdf.color.dark.pageColorsBackground`
- `latex-workshop.view.pdf.color.dark.pageColorsForeground`
- `latex-workshop.view.pdf.color.light.backgroundColor`
- `latex-workshop.view.pdf.color.light.pageBorderColor`
- `latex-workshop.view.pdf.color.light.pageColorsBackground`
- `latex-workshop.view.pdf.color.light.pageColorsForeground`
- `latex-workshop.view.pdf.external.synctex.args`
- `latex-workshop.view.pdf.external.synctex.command`
- `latex-workshop.view.pdf.external.viewer.args`
- `latex-workshop.view.pdf.external.viewer.command`
- `latex-workshop.view.pdf.hand`
- `latex-workshop.view.pdf.internal.keyboardEvent`
- `latex-workshop.view.pdf.internal.port`
- `latex-workshop.view.pdf.internal.synctex.keybinding`
- `latex-workshop.view.pdf.invert`
- `latex-workshop.view.pdf.invertMode.brightness`
- `latex-workshop.view.pdf.invertMode.enabled`
- `latex-workshop.view.pdf.invertMode.grayscale`
- `latex-workshop.view.pdf.invertMode.hueRotate`
- `latex-workshop.view.pdf.invertMode.sepia`
- `latex-workshop.view.pdf.ref.viewer`
- `latex-workshop.view.pdf.reload.transition`
- `latex-workshop.view.pdf.scrollMode`
- `latex-workshop.view.pdf.sidebar.open`
- `latex-workshop.view.pdf.sidebar.view`
- `latex-workshop.view.pdf.spreadMode`
- `latex-workshop.view.pdf.tab.editorGroup`
- `latex-workshop.view.pdf.toolbar.hide.timeout`
- `latex-workshop.view.pdf.trim`
- `latex-workshop.view.pdf.viewer`
- `latex-workshop.view.pdf.zoom`

---

## 5) シンタックス/ファイル種別（language & grammar）

### 5.1 Language IDs（抜粋）

LaTeX Workshop は `.tex/.ltx/.cls/.sty/.dtx/.ins/.bib/.bst/.bbx/.cbx/.lbx` 以外にも、
Sweave/Weave/Pweave、markdown+latex 合成、log 用 language などを提供します。

例:
- `latex`（.tex, .ltx）
- `latex-class`（.cls）
- `latex-package`（.sty）
- `doctex`（.dtx）
- `bibtex`（.bib）
- `bibtex-style`（.bst）
- `biblatex`（.bbx, .cbx, .lbx）
- `rsweave`（.rnw, .rtex, .snw）
- `jlweave`（.jnw, .jtexw）
- `pweave`（.pnw, .ptexw）
- `markdown_latex_combined`（拡張子なし。合成用）
- `latex_workshop_log`（拡張子なし。ログ用）

### 5.2 Grammar scopes（抜粋）

- LaTeX: `text.tex.latex`
- BibTeX: `text.bibtex`
- DocTeX: `text.tex.doctex`
- Markdown/LaTeX combined: `text.tex.markdown_latex_combined`
- Log: `text.latex_workshop.log`

### 5.3 PDF custom editor

- `latex-workshop-pdf-hook`（*.pdf の既定 custom editor）


# tex64 ⇄ VS Code + LaTeX Workshop 移行障壁レビュー

目的: VS Code + LaTeX Workshop から tex64 へ移行する際に、ユーザーが「執筆（書く/直す/コンパイルして確認する）」を止めうる **障壁**（不足・挙動差・設定移行コスト）を洗い出す。

- 基準日: 2026-02-18
- tex64 側の一次ソース: `implementation.md`（実装同期版）
- LaTeX Workshop 側の一次ソース:
  - README/Wiki（web）
  - `docs/latex-workshop-feature-inventory.md`（v10.12.2 の “漏れ防止”列挙）

---

## 0) 結論（移行を止めやすい P0）

VS Code 利用者が tex64 に乗り換える時、障壁になりやすいのは次の 6 点。

1. **ビルド定義の柔軟性**（recipe/tool/env/cwd/多段）  
   tex64 は `latexmk` を中心に「engine + outDir + extraArgs」のプロファイルを持つが、LaTeX Workshop の recipe/tool ほど一般化されていない。
2. **外部 PDF viewer 連携 + SyncTeX**（Skim/Evince/Zathura/Sioyek 等）  
   tex64 は内蔵 PDF viewer（タブ/別ウィンドウ）だが、外部 viewer との synctex は未提供。
3. **ビルドの kill/cancel**  
   LaTeX Workshop は「Kill LaTeX compiler process」があり、tex64 は現状プロセス停止導線が無い（ハング時の逃げ道が弱い）。
4. **Lint / Diagnostics（ChkTeX/LaCheck）**  
   tex64 の Issues は build/format/runtime 中心で、linter の常用ユーザーは戻りたくなる可能性がある。
5. **Word count（texcount）**  
   学術用途で提出要件に絡むことがあるため、必要な人には障壁。
6. **VS Code 本体の “作法”**（拡張・キーバインド・置換/正規表現検索・Git 等）  
   これは LaTeX Workshop ではなく VS Code 本体の価値。tex64 で全部は不要でも、最低限の代替導線が無いと移行ハードルが上がる。

---

## 1) tex64 が既に満たしている（移行で困りにくい）

LaTeX Workshop 由来で「執筆フローに直結」するところは、tex64 はすでに多く実装済み。

- **プロジェクト/ワークスペース**: root TeX 自動検出 + 手動固定、`%!TEX root` 追跡
- **編集**: Monaco、2ペイン split、タブ、`.tex/.bib` の色分け、`{[()]` と `$...$` のペア設定
- **補完**: `\\ref`/`\\cite`/`\\input`/`\\include`/`\\includegraphics`/`\\begin{...}`（env のスニペット付き）
- **Hover**: 数式プレビュー、ref/cite/includegraphics/input(include) のプレビュー、`\\usepackage`/`\\documentclass` の簡易ガイド（CTAN/texdoc 導線）
- **ビルド**: latexmk、engine 選択、outDir/extraArgs を含む build profile、clean/deep clean
- **PDF**: タブ内/別ウィンドウ、検索/outline/thumbnails/色反転/印刷/DL/reload
- **SyncTeX**: forward（ボタン + build 後自動）、reverse（PDF 上 Ctrl/Cmd+Click）
- **診断導線**: Issues 集約 + クリックジャンプ、duplicate label 検出

tex64 独自の強み（LaTeX Workshop に無い/薄い）:
- Blocks（数式の検出・編集）+ MathLive 入力 + OCR 導線
- AI アシスタント（提案→差分→適用→Undo）

---

## 1.1) 設定移行（LaTeX Workshop → tex64）対応表（ざっくり）

LaTeX Workshop の既存ユーザーがまず困るのは「設定がそのまま持ってこれない」点なので、代表的な項目だけ対応関係をまとめます。

### Root / Main TeX

- LaTeX Workshop: magic comment（`%!TEX root = ...`）、root file 設定  
  → tex64: **対応**（root 自動検出 + 手動固定 + `%!TEX root` 追跡）

### Build

- LaTeX Workshop: `latex-workshop.latex.recipes` / `latex-workshop.latex.tools` / `latex-workshop.latex.recipe.default`  
  → tex64: **非互換**（現状は latexmk ベースの build profile: `engine/outDir/extraArgs`）
- LaTeX Workshop: `latex-workshop.latex.outDir`  
  → tex64: **部分対応**（profile の `outDir`。ただしワークスペース外・絶対パスは拒否）
- LaTeX Workshop: `latex-workshop.latex.autoBuild.run`（保存/変更監視ビルド）  
  → tex64: **未対応**
- LaTeX Workshop: `latex-workshop.clean` / `latex-workshop.latex.clean.*`  
  → tex64: **対応**（clean / deep clean。ただし細かい fileTypes 指定等は未対応）
- LaTeX Workshop: `latex-workshop.kill`（ビルド停止）  
  → tex64: **未対応**

### View / SyncTeX

- LaTeX Workshop: `latex-workshop.view.pdf.viewer`（tab/browser/external）  
  → tex64: **非互換**（タブ内 or 別ウィンドウ）
- LaTeX Workshop: `latex-workshop.synctex.afterBuild.enabled`  
  → tex64: **対応**（ビルド成功後 forward）
- LaTeX Workshop: `latex-workshop.view.pdf.external.viewer.*` / `...external.synctex.*`  
  → tex64: **未対応**
- LaTeX Workshop: `latex-workshop.view.pdf.trim` / `scrollMode` / `spreadMode` / `hand` / `invertMode.*`  
  → tex64: **部分対応**（反転はあるが、trim/scroll/spread/hand/細かい色設定は未対応）

### Formatting / Lint / Wordcount

- LaTeX Workshop: `latex-workshop.formatting.latex`（latexindent/tex-fmt/none）  
  → tex64: **部分対応**（latexindent のみ）
- LaTeX Workshop: BibTeX format（`bibsort/bibalign` + `latex-workshop.bibtex-format.*`）  
  → tex64: **未対応**
- LaTeX Workshop: lint（`latex-workshop.linting.*`）  
  → tex64: **未対応**
- LaTeX Workshop: texcount（`latex-workshop.texcount.*`）  
  → tex64: **未対応**

## 2) LaTeX Workshop との差分（tex64 側の不足/差）

ここでは `docs/latex-workshop-feature-inventory.md` のカテゴリに沿って整理します。

### 2.1 Compile（Recipes/Tools/自動ビルド）

tex64:
- latexmk 固定（engine + outDir + extraArgs を build profile として保持）
- 自動ビルド（保存/変更監視/interval）に相当する機能は未提供
- build の kill/cancel が弱い（ハング/暴走時の回復導線が薄い）

LaTeX Workshop 側で期待されやすい要素:
- recipe/tool の多段構成（latexmk + biber + makeindex 等）
- autoBuild / watch / interval
- external build command

移行障壁の出方:
- 「特殊な toolchain（docker/remote/biber/latexmkrc/特殊 outDir）」を抱えると、tex64 の build profile だけでは吸収しきれない可能性。

### 2.2 View（外部 viewer / 表示モード差）

tex64:
- 内蔵 viewer は一通り揃っているが、LaTeX Workshop で一般的な設定（trim/scrollMode/spreadMode/hand tool/細かい color 設定）とは差がある
- 外部 viewer（Skim 等）への表示 + SyncTeX 連携は未提供

移行障壁の出方:
- 外部 viewer を “標準” として使っている人は移行しづらい。

### 2.3 IntelliSense（パッケージ由来補完/数式補助/引用ブラウザ）

tex64:
- `ref/cite` は Index ベースで実用
- `input/include/graphics` はワークスペース内パス補完（相対、拡張子省略対応）
- ただし、LaTeX Workshop のような **パッケージ由来の大量コマンド/環境補完**、argument hint、unimath/superscript 補助、citation browser 相当は未提供

移行障壁の出方:
- 「補完はパッケージ込みで育っている」ユーザーほど、入力速度が落ちる。

### 2.4 Hover（詳細度/ドキュメントの深さ）

tex64:
- ref/cite/include/input のプレビューは強い（とくに数式プレビューは強み）
- `\\usepackage`/`\\documentclass` の hover は簡易（texdoc の“実行”や “使われているパッケージ一覧” のような統合導線は薄い）

移行障壁の出方:
- 「texdoc を頻繁に引く」「コマンド定義まで追う」層は VS Code 側が快適。

### 2.5 Snippets / Structural Editing（環境編集・章立て操作）

LaTeX Workshop は “環境操作” が強い（navigate/select/wrap/close/toggle equation、promote/demote sectioning、surround selection 等）。

tex64:
- `\\begin{...}` のスニペットはあるが、上記の **構造編集コマンド群** は未提供
- キーバインドのカスタマイズも未提供

移行障壁の出方:
- 体に染みた “環境編集ショートカット” を持つユーザーは戻りたくなる。

### 2.6 Formatting（BibTeX 整形/tex-fmt）

tex64:
- LaTeX は latexindent + fallback がある
- BibTeX 整形（sort/align 等）や tex-fmt は未提供

移行障壁の出方:
- `.bib` を整形して運用しているプロジェクトではギャップになる。

### 2.7 Linters（ChkTeX/LaCheck）

tex64:
- build/format の issues 収集はあるが、linter 実行・marker 表示は無い

移行障壁の出方:
- 警告/規約を lint で回している人には痛い（ただし必須ではない）。

### 2.8 Extra（wordcount/unused citations/ログビュー）

tex64:
- wordcount（texcount）: 未提供
- unused citations check（checkcites）: 未提供
- compiler/log viewer: Issues にログは出るが、LaTeX Workshop の “ログ専用 UI” と比べると導線が異なる

---

## 3) VS Code 本体由来の障壁（LaTeX Workshop 以外）

tex64 は LaTeX 専用アプリなので、VS Code の “汎用 IDE 機能” をすべて持たないのは自然です。ただ、移行障壁としては確実に効きます。

- **拡張エコシステム**（LTeX/Spell/GitLens/Copilot 等）: tex64 には相当が無い
- **キーバインド/コマンドパレット/設定 UI**: VS Code はユーザーが完全に手を入れられるが、tex64 は固定
- **検索**: VS Code は正規表現/置換/ファイルフィルタが強い。tex64 は `.tex` 限定・大小無視・200件上限
- **Git**: 差分/ブランチ運用が VS Code で完結している場合は障壁
- **Remote 開発**（SSH/WSL/Container/Codespaces）: tex64 はローカル前提

---

## 4) 推奨アクション（優先度付き）

tex64 の方針（安定性最優先・自動確定禁止）を壊さずに、移行障壁だけを落とすなら次が効きます。

### P0（移行を止める可能性がある）

- **Build の kill/cancel**（実行中プロセス停止 + 状態復帰 + Issues 記録）
- **外部 PDF viewer + SyncTeX**（最小: Skim/Evince/Zathura/Sioyek のどれかから開始）
- **Recipes/Tools 相当の一般化**（少なくとも `command/args/env/cwd/timeout` を build profile に追加）

### P1（慣れの差でストレスになる）

- **構造編集ショートカット**（wrap/surround/close env、promote/demote section）
- **パッケージ由来コマンド補完**（まずは usepackage された分だけでも）
- **BibTeX 整形**（sort/align のみでも）

### P2（あると嬉しい/特定層に刺さる）

- wordcount（texcount）
- lint（ChkTeX/LaCheck）
- citation browser / checkcites

### 現状の回避策（実装前でも運用できる）

- **recipe 相当の不足**: `latexmkrc` をプロジェクトに置く + tex64 の build profile で `extraArgs`（例: `-use-biber`, `-shell-escape`）を使う。多段 toolchain が必要なら「ターミナルで開く」から手動実行。
- **外部 viewer + SyncTeX**: tex64 の「別ウィンドウ PDF」で運用（外部アプリ連携は不可）。どうしても外部 viewer を使う場合は PDF を開くだけは可能（ただし SyncTeX なし）。
- **lint/wordcount**: `chktex` / `lacheck` / `texcount` をターミナルで直接実行（tex64 の Issues 連携は現状なし）。
- **BibTeX 整形**: VS Code 側や外部ツールで `.bib` を整形してから tex64 で編集（tex64 内で sort/align は不可）。

以上。

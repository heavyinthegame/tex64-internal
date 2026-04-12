# E2E Test: Zero-to-Finished Paper (one-shot)

**目的**: TeX64 AI エージェントに新規作成テンプレートから完成論文を1本生成させ、完璧に仕上がるかを一連のフローで検証する。

**前提**:
- ワークスペース: `/Users/wedd/tex64-internal/test-workspace/e2e-paper-test/`
- 開始時点の状態: 新規作成直後のテンプレート `main.tex` のみ存在
  - `\title{タイトル}` `\author{著者名}` プレースホルダ
  - `\begin{abstract}`、`\section{はじめに}`、`\section{まとめ}` の骨格
  - サンプルの箇条書き/数式/図/表/参考文献
- モデル: `gpt-5.4-nano`（ユーザー設定から）
- `maxIterations`: 30
- `autoApply: true` / `autoBuild: true` / `allowRunCommand: true`

**論文テーマ** (固定):
> "Attention Mechanisms in Transformer Architectures: A Brief Survey"
> （Transformer の Attention 機構に関する短いサーベイ論文、全10〜15ページ想定）

---

## 進行フロー

各ステップは **ひとつの AI チャット指示** として与える。指示ごとに新しいチャットを開始するか、同一チャットで継続するかを明示する。各ステップ完了後、**期待される成果物** と **合否基準** を確認する。

---

### Step 1: プロジェクト初期化

**チャット**: 新規
**指示**:
```
This is a new project. Replace the Japanese template in main.tex with an English academic paper skeleton for a survey paper titled "Attention Mechanisms in Transformer Architectures: A Brief Survey". Change the document class to `article` (not ltjsarticle), set the title and author to "Anonymous", and remove the Japanese sample content (abstract placeholder, はじめに section content, sample itemize/figure/table, まとめ section, thebibliography). Keep only: documentclass, usepackage declarations (convert any Japanese-specific packages to English-compatible ones: drop ltjsarticle-specific ones, add `\usepackage[utf8]{inputenc}` and `\usepackage{cite}`), title/author/date, and an empty \begin{document}...\end{document} with \maketitle and a single empty \begin{abstract}\end{abstract}.
```

**期待される成果物**:
- `main.tex` が英語の空論文スケルトンに書き換わる
- `\documentclass{article}` に変更
- Japanese packages (`ltjsarticle` 等) 削除、`inputenc` / `cite` 追加
- プレースホルダ日本語コンテンツが全て消える
- 空の abstract 環境のみ残る

**合否基準**:
- [ ] `latexmk -pdf -interaction=nonstopmode main.tex` がエラーゼロで通る
- [ ] PDF に "Attention Mechanisms in Transformer Architectures: A Brief Survey" と "Anonymous" が表示される
- [ ] ファイルサイズが元より小さくなっている
- [ ] 日本語文字が一切残っていない

---

### Step 2: Abstract 執筆

**チャット**: Step 1 と同じチャットで継続
**指示**:
```
Write the abstract (150-200 words) summarizing: (1) the role of attention in Transformers, (2) what this survey covers (scaled dot-product, multi-head, self-attention, cross-attention, sparse variants), (3) the key takeaways. Write it directly in the \begin{abstract}...\end{abstract} block. Do not include citations yet.
```

**期待される成果物**:
- 150〜200 語の英文 abstract
- 3つの要素（役割・カバー範囲・key takeaways）が含まれる

**合否基準**:
- [ ] ビルド成功
- [ ] 語数が 140〜220 の範囲内
- [ ] citation コマンド（`\cite{}`）を含まない
- [ ] 文法的に破綻していない

---

### Step 3: セクション骨組み

**チャット**: 継続
**指示**:
```
Add the following section skeleton after the abstract (do not write content yet, just the \section and \subsection commands with empty bodies):

1. Introduction
2. Preliminaries
   - 2.1 Notation
   - 2.2 The Sequence-to-Sequence Problem
3. Scaled Dot-Product Attention
   - 3.1 Formulation
   - 3.2 Complexity
4. Multi-Head Attention
5. Self-Attention and Cross-Attention
6. Sparse and Efficient Variants
   - 6.1 Sparse Attention
   - 6.2 Linear Attention
7. Discussion
8. Conclusion
```

**期待される成果物**:
- 8つの section と適切な位置の subsection
- 各 section/subsection は空の本文

**合否基準**:
- [ ] ビルド成功
- [ ] 目次 (`\tableofcontents` 追加していれば) に全セクションが出る
- [ ] section 番号が 1〜8 まで順番通り

---

### Step 4: arXiv から参考文献を取得

**チャット**: 継続
**指示**:
```
Search arxiv for 6 highly relevant papers about attention mechanisms and transformer architectures (including the original "Attention is All You Need" by Vaswani et al., and 5 others covering topics like sparse attention, linear attention, long-context transformers). Create a references.bib file with those entries in BibTeX format. Then add `\bibliographystyle{plain}` and `\bibliography{references}` just before \end{document}, and also add `\usepackage{cite}` if not already present.
```

**期待される成果物**:
- `references.bib` に6件の arXiv 論文エントリ
- Vaswani et al. "Attention is All You Need" を含む
- `main.tex` に bibliography 設定追加

**合否基準**:
- [ ] `references.bib` が存在し、6エントリ以上
- [ ] 各エントリに `title`, `author`, `year`, `url` or `arxivId` が含まれる
- [ ] `latexmk -pdf main.tex` → `bibtex main` → `latexmk -pdf main.tex` で参考文献リストが PDF に出る

---

### Step 5: Introduction を執筆

**チャット**: 継続
**指示**:
```
Fill in the Introduction section (approximately 400 words). It should motivate why attention matters, briefly mention the pre-attention era (RNNs/LSTMs and their limitations), introduce the Transformer, and outline the rest of the paper. Cite Vaswani et al. using \cite{} at the appropriate place.
```

**期待される成果物**:
- 約 400 語の Introduction 本文
- RNN/LSTM の背景言及
- Transformer への流れ
- paper outline
- 最低1つの `\cite{}`

**合否基準**:
- [ ] ビルド + bibtex でビルド成功
- [ ] 語数 350〜500
- [ ] PDF 上で引用番号が正しく出る（`[?]` ではない）

---

### Step 6: Preliminaries を執筆

**チャット**: 継続
**指示**:
```
Fill in section 2 (Preliminaries) including:
- 2.1 Notation: define Q, K, V, d_k, d_model, sequence length n, batch size B using proper \mathbf and \mathbb notation in a `description` environment or inline.
- 2.2 The Sequence-to-Sequence Problem: 1 paragraph explaining encoder-decoder framing and why attention helps.

Use proper math display (\begin{equation} or \[...\]) for notation definitions where appropriate.
```

**期待される成果物**:
- 2.1 に適切な数式記号定義
- 2.2 に seq2seq 問題の説明

**合否基準**:
- [ ] ビルド成功
- [ ] `\mathbf{Q}`, `\mathbb{R}` 等の正しい math コマンドが使われる
- [ ] Overfull/Underfull のひどい warning がない

---

### Step 7: Scaled Dot-Product Attention を執筆

**チャット**: 継続
**指示**:
```
Fill in section 3 (Scaled Dot-Product Attention):
- 3.1 Formulation: derive the attention formula Attention(Q,K,V) = softmax(QK^T / sqrt(d_k)) V, present it as a labeled equation, and explain each term.
- 3.2 Complexity: analyze O(n^2 d) time and memory complexity.

Include at least one display equation with \label and reference it in the text with \eqref.
```

**期待される成果物**:
- labeled equation + \eqref 参照
- O(n²) complexity の明示的言及

**合否基準**:
- [ ] ビルド成功
- [ ] `\eqref` が PDF 上で正しい番号に解決
- [ ] `QK^T / \sqrt{d_k}` 的な式が正しくレンダリング

---

### Step 8: 残りの中身セクション（4〜6）を一気に執筆

**チャット**: 継続
**指示**:
```
Fill in sections 4, 5, and 6 with concise but substantive content (about 300 words each):
- Section 4: Multi-Head Attention — explain the h heads, concatenation, projection, and why multi-head helps.
- Section 5: Self-Attention and Cross-Attention — distinguish the two, give examples (encoder self-attn, decoder cross-attn).
- Section 6.1: Sparse Attention — mention Longformer, BigBird style patterns.
- Section 6.2: Linear Attention — mention Performers, Linformer style kernel-based approaches.

Cite relevant papers from references.bib where appropriate.
```

**期待される成果物**:
- 4つのセクション/サブセクションに本文
- 複数の citation

**合否基準**:
- [ ] ビルド成功
- [ ] 各セクション語数 250〜400
- [ ] 最低 4 つの `\cite{}` が本文に散りばめられている

---

### Step 9: TikZ でアーキテクチャ図を追加

**チャット**: 継続
**指示**:
```
Add `\usepackage{tikz}` to the preamble, then add a TikZ figure to Section 4 (Multi-Head Attention) showing the multi-head attention block diagram: input Q, K, V go through h linear projections, each feeds into scaled dot-product attention, outputs are concatenated, then final linear projection. Use simple rectangles and arrows. Wrap it in a \begin{figure}[t] with \caption and \label.
```

**期待される成果物**:
- TikZ figure が Section 4 内に追加
- caption と label 付き
- h=4 or h=8 heads 程度の視覚化

**合否基準**:
- [ ] ビルド成功（TikZ コンパイルエラーなし）
- [ ] PDF に図が出る
- [ ] figure に label が付き、本文から `\ref{}` 参照できる

---

### Step 10: Discussion と Conclusion

**チャット**: 継続
**指示**:
```
Fill in sections 7 (Discussion) and 8 (Conclusion). Discussion should compare trade-offs of the variants covered (200 words). Conclusion should summarize key findings and suggest 2-3 future research directions (150 words).
```

**期待される成果物**:
- Discussion 約 200 語
- Conclusion 約 150 語 + 2〜3 の future directions

**合否基準**:
- [ ] ビルド成功
- [ ] 語数要件を満たす

---

### Step 11: 最終ビルドと品質検証

**チャット**: 新規（クリーンな状態で）
**指示**:
```
Build main.tex via latexmk and check the log for any errors or warnings. Report the PDF page count, total word count (you can approximate by running `detex main.tex | wc -w` via run_command), and list any unresolved references, undefined citations, overfull hboxes, or other warnings. If any errors exist, fix them and rebuild.
```

**期待される成果物**:
- エラーゼロ、warning 最小
- ページ数、語数のレポート

**合否基準**:
- [ ] LaTeX エラーゼロ
- [ ] undefined reference / citation ゼロ
- [ ] ページ数 8〜15
- [ ] 語数 2000〜4000
- [ ] overfull hbox は 3 件未満（ある場合）

---

## 評価サマリー

各ステップを通過するか `/` で採点：

| Step | 内容 | 結果 | メモ |
|------|-----|------|------|
| 1 | プロジェクト初期化 | ✅ PASS | クリーンに変換、article クラス、`inputenc`/`cite` 追加 |
| 2 | Abstract | ✅ PASS | 1 行に長く展開された (改行なし) が valid LaTeX |
| 3 | セクション骨組み | ⚠️ PARTIAL | セクションは追加されたが **preamble の geometry/graphicx/amsmath/hyperref を全削除**。abstract も無断書き換え |
| 4 | arXiv 参考文献 | ⚠️ PARTIAL | references.bib 6 件作成 ✓。Vaswani の著者リスト **ハルシネーション**。指定の Longformer/Performer/Linformer 等は取得されず別の論文 |
| 5 | Introduction | ⚠️ PARTIAL | 本文追加 ✓ だが **`\section{Introduction}` を重複追加** & **`\cite{Vaswani2017}` の指示を無視** |
| 6 | Preliminaries | ❌ FAIL→retry | 1 回目: **完全ハルシネーション** (「書きました」と返答するも実際は空)。2 回目で書かれた |
| 7 | Scaled Dot-Product | ✅ PASS | equation/label/eqref 正しく動作。amsmath 追加 ✓。但し `Attention(Q,K,V)` を operator name で囲んでいない (字面ミス) |
| 8 | Sections 4-6 | 💀 CATASTROPHIC | **main.tex を 1 行 (`\usepackage{amssymb}`) に完全消失**。Steps 1-7 の全成果が失われた。手動指示で復旧 |
| 9 | TikZ 図 | ⚠️ PARTIAL | tikz package と figure 追加 ✓ だが **`\title{}` を「Anonymous」に上書き** & **positioning library 抜け** & 図の構造が概念的に誤り |
| 10 | Discussion/Conclusion | ⚠️ PARTIAL | 本文追加 ✓ だが **6.1/6.2 subsection を消去**。再度 abstract/Introduction を書き換え |
| 11 | 最終ビルド検証 | ✅ PASS | **build 成功、main.pdf 4 ページ 178KB** 生成、warning 1 件 (empty bibliography) |

## 最終成果物

- `main.tex`: 60 行
- `main.pdf`: 4 ページ、178 KB
- `references.bib`: 6 entries (内容に問題あり、後述)
- `\cite{}` count in main.tex: **0** (指示違反)
- LaTeX errors: **0**
- LaTeX warnings: **1** (empty thebibliography)

## 失敗モードの観察結果 (実測)

| # | 観察ポイント | 実測 |
|---|-------------|-----|
| 1 | tool_call 無限ループ | 観測されず — recovery hint 機構は発動せず |
| 2 | context snapshot stale | 観測されず |
| 3 | auto-continuation | 30 iter 上限に到達せず (各ステップは数 iter で完了) |
| 4 | file creation leakage | **観測されず** (前回テストで頻発していた `new_main.tex` は今回ゼロ) ← 改善 |
| 5 | 日本語/英語の混在 | 観測されず — 英語指示には英語応答 |
| 6 | max_tokens / temperature | リクエスト body には temperature=0.2 が含まれているはず (コード上で確認済み)、ただし モデル側で reasoning オーバーライドの可能性 |
| 7 | quota consumption | 別途 api-usage.json 確認可能 |
| 8 | arxiv_search レート制限 | Step 4 は普通に成功 (~1 分以内) |
| 9 | run_command 安定性 | Step 11 で `latexmk` 成功 |
| 10 | Retry-After 尊重 | 429 は発生せず、検証機会なし |

## ★ 重大な問題点 (AI 機能側) ★

### 🔴 P0 (致命的)

**A. 全文書消失バグ (Step 8)**

LLM が `write_file` を呼んだ時、本来 `\usepackage{amssymb}` を **追加** すべき場面で、**ファイル全体を `\usepackage{amssymb}` 1 行に置き換えた**。Steps 1-7 で作成した 50+ 行の論文内容が完全消失。

このとき:
- AI は「success」を報告 (proposal が auto-apply されたから)
- TeX64 のフロントエンドは Undo ボタンを表示したが、**Undo 押下で復元できなかった** (Undo の対象が異なる単位)
- 唯一の救済は手動指示による再生成

**根本原因 (推定)**: `gpt-5.4-nano` が `write_file` の使い方を理解せず、「現在のファイル内容 + 追加内容」を返すべきところを「追加内容だけ」を返している。`apply_patch` を使うべき場面で `write_file` を選んでいる。

**対策案**:
1. tools.cjs の `write_file` description に "ALWAYS provide the COMPLETE file content. Never use this for partial updates — use apply_patch for that." と明示
2. write_file 実行前に「現在ファイルが N 行ある状態で、新しい content が M 行 (M < N/2) なのは異常」みたいなサニティチェックを入れる
3. write_file の auto-apply 後の Undo を明示的に「直前のファイル全体を復元」するセマンティクスにする (現状は Monaco の undo stack 依存で復元できない)

**B. ハルシネーション付き「成功」報告 (Step 6)**

AI は「Filled in Section 2 (Preliminaries) in main.tex. In subsection 2.1 Notation, defined Q, K, V, d_k, d_model, n, B... In subsection 2.2 The Sequence-to-Sequence Problem, added a paragraph...」と応答したが、**実際にはどのツールも呼ばず、ファイルは未変更**。

**根本原因 (推定)**: モデルが「ツールを呼んだつもり」になって最終応答テキストを生成してしまう。

**対策案**:
1. system prompt で「After every file modification, always re-read the file with read_file to confirm. Never claim to have written content without verifying.」と強制
2. write_file 呼び出しが 0 回のターンでは「completed successfully」系の文言を言わせない
3. 最終応答前に context snapshot と提案ファイルを比較して「実際に書かれていない」場合は warning を出す

### 🟠 P1 (重大)

**C. 既存内容の破壊的書き換え (Steps 3, 4, 5, 9)**

各ステップで「○○セクションだけ追加して、他は触らないで」と明示しても、AI は毎回 **abstract や preamble を勝手に書き換え**。

特に Step 3 で:
- `[a4paper,11pt]` オプションを documentclass から削除
- `\usepackage{geometry}` 削除
- `\usepackage{graphicx}` 削除
- `\usepackage{amsmath,amssymb}` 削除
- `\usepackage{hyperref}` 削除
- `\geometry{margin=25mm}` 削除
- `\hypersetup{...}` 削除
- `\date{\today}` を `\date{}` に変更
- abstract を別の文に書き換え

これらの大半は後続ステップで build エラーの原因になる (実際 Step 6 の `\mathbb{R}` で amssymb 不足、Step 9 の TikZ で positioning 不足)。

Step 9 では `\title{}` を「Anonymous」に書き換え (author の値で title を上書き)。

**対策案**:
1. tools.cjs の system prompt に「When the user says 'do not modify other parts', use apply_patch with line ranges, NEVER write_file.」を明示
2. write_file 実行時、「直前ファイルから 30% 以上の行が消える」変更は警告 or 確認を要求
3. プリアンブル領域 (`\begin{document}` 以前) を保護領域として扱うオプション

**D. 多パート指示の片方無視 (Step 5 の cleanup)**

「(a) 重複 section を消す + (b) `\cite{Vaswani2017}` を追加」と 2 つ依頼したが、(a) のみ実行、(b) は無視。報告には「両方やった」と書かれていた (=ハルシネーション)。

**対策案**:
1. system prompt で multi-step task は箇条書きで全て trace する命令を強化
2. 応答テキストで主張した変更が実ファイルに反映されているか auto-verify

**E. arXiv 検索結果の質**

Step 4 で「Longformer/BigBird/Performer/Linformer/BERT」のような著名論文を要求したが、取得されたのは別の論文 (Dilated Neighborhood Attention Transformer など)。`arxiv_search` ツールがクエリの意味を理解せず、キーワード単純マッチで返している可能性。

さらに Vaswani et al. の論文の **author list がハルシネーション** (実在しない著者名 "Shardlow, David"、"Kattner, Florian and N. K." など)。これは arxiv API 結果ではなく LLM が捏造したと推定される。

**対策案**:
1. arxiv_bibtex ツールで取得した metadata を **そのまま** bib に書く (LLM が再生成しない)
2. arxiv_search の結果に「これを bib にしたいなら arxiv_bibtex を使え」のヒントを加える

### 🟡 P2 (改善余地)

**F. `\cite{}` コマンドが結局 0 個**

複数ステップで明示的に `\cite{}` の使用を指示したが、最終ファイルに 0 個。AI は「Vaswani et al. と書けば cite した気になる」傾向。結果として bibliography が empty environment になる warning。

**G. TikZ コードの品質**

- 概念的に誤り (h heads ではなく Q/K/V 1 つずつに attention block を割当)
- positioning library 漏れ (後で修正された)
- foreach loop で head1〜head4 を全部 `right=of input` で配置 → 同位置に重なる

**H. 抽象的記述ステップでファイルを「全文書き換え」する傾向**

「この section に N 語追加して」と言っても、`apply_patch` ではなく `write_file` でファイル全体を再生成しがち。前後の不要な変更を生む元凶。

## ★ 気になる UX / アプリ側の問題点 ★

### 🟠 UX1: Undo ボタンが期待通りに復元しない (Step 8 の致命傷)

Step 8 で main.tex が 1 行に消失した時、proposal の Undo ボタンを押しても **ファイルが元の状態に戻らなかった**。実際には Undo は適用された差分を取り消すはずだが、Monaco editor の undo stack と proposal の undo の連携がうまく動いていない。

**ユーザーの期待**: 「直前の AI 適用を Undo すれば確実に直前の状態に戻る」
**実態**: 戻らない / 戻ったように見えても content が途中状態

ファイル全体破壊バグの最後の砦が機能していない。

### 🟠 UX2: チャット側に「destructive change」の警告がない

main.tex が 60 行 → 1 行に縮んだ時、UI は普通に「Applied」として表示。`+1 / -59` のような diff 統計はあったかもしれないが、危険な縮小に対する警告 prompt は出ない。

**改善案**: ファイル長が 50% 以上短くなる write_file は user 確認 dialog を出す

### 🟡 UX3: 1 つのチャットで履歴が長くなると AI の context が劣化していく

ステップが進むほど、AI が以前の指示を忘れ、preamble を書き換え、cite を忘れる傾向が強まった。会話履歴が膨らむと old instructions が衝突して、最新の指示だけ部分的に従う。

**改善案**:
1. 各ステップ完了時に AI に「現在のファイル状態を read_file で読み直して、次の指示の前提とせよ」と促す system reminder
2. または user 側で「new chat」を頻繁に切り替えるベストプラクティス推奨

### 🟡 UX4: チャット入力欄のスクロール問題

長い prompt を投げた後、画面下部の入力欄が見えなくなる。chat panel の内部スクロールが scroll-to-bottom にならず、前のメッセージのまま固定される。

### 🟡 UX5: ファイル選択ダイアログで「最近開いた」フォルダから e2e-paper-test が出てこない

新規 folder を選ぶには `Cmd+Shift+G` で path を打つしかなかった。recent projects に手動で追加する手段がない。

### 🟡 UX6: AI チャット応答が長時間スピナーのまま動かない時、進捗が不明

特に Step 8 / Step 9 のように 60-90 秒以上かかるステップで、現在何の tool を呼んでいるのか UI から分からない。tool execution log が見えると debug しやすい。

**改善案**: status bar に「Calling tool: write_file (main.tex)...」のような current tool 表示

### 🟢 UX7: 良かった点

- maxIterations=30 で auto-continuation を発動させる必要がなかった (各ステップが軽量だったので)
- ストリーミング応答が滑らか
- 日本語/英語応答の言語マッチング適切
- 422 / 500 系 error は 1 度も発生しなかった (rate limit handling は OK)
- arxiv_search が動いた (前回テストではタイムアウトする可能性を懸念していたが今回は OK)
- run_command で latexmk が問題なく実行できた

## ★ アーキテクチャ提案 ★

このテストで明らかになった最大のリスクは **「AI が全ファイルを書き換える時に部分的・破壊的書き換えをする」** こと。これに対する根本対策案:

### 提案 1: write_file の input を「intent-based」に
現在は `path + content` のみ。これを `path + content + reason + expectedDelta` に拡張し、サーバー側で「expectedDelta が "modify abstract only" なのに content が 1 行になっている」のような不整合を検知して reject。

### 提案 2: `apply_patch` を最優先・`write_file` を refuser tool に
system prompt で「Always prefer apply_patch. write_file is ONLY for creating brand-new files or full rewrites explicitly requested by the user.」と強く言う。tool description にも記述。

### 提案 3: ファイルレベル checkpoint
各 AI run の最初に main.tex のスナップショットを取り、run 終了時に「N 行以上消えていたら revert option を user に提示」。

### 提案 4: プリアンブル保護モード
`.tex` ファイルの `\begin{document}` 以前を「保護領域」として扱い、AI が触ると warning。tool 内で「protected zone を変更しようとしました。確認しますか?」を返す。

## ★ 結論 ★

**E2E テスト総合スコア: 5/11 PASS, 5/11 PARTIAL (要再指示), 1/11 CATASTROPHIC**

AI エージェントは **小さい単位の指示**（add a bibliography line, run latexmk, write 250 words in this section）には対応できるが、**「他は触らないで」という制約を守れない**ことが繰り返し発覚した。

特に Step 8 の **全文書消失バグ** は商用利用上の最大リスク。1 つの write_file 呼び出しでユーザーの作業を破壊する可能性がある。これは Undo でも復元できなかった。

ただし、AI 機能 **以外** (LLM API 通信、quota、Retry-After、stream 処理、月次ロールオーバー、エンドポイント解決) は今回のセッションで触った範囲では正しく動作した。問題は主に **モデル (gpt-5.4-nano) の指示遵守能力** と **write_file ツールの安全機構不足** にある。

最優先で対応すべきは:
1. write_file の「destructive shrink」検知 + Undo 復元の確実化
2. system prompt で「他は触らない」指示を強制する仕組み (apply_patch の優先化)
3. AI の self-report verification (read-back after write)

## 失敗モードの観察ポイント

テスト実行中に以下を確認する：

1. **tool_call 無限ループ**: 同じ `apply_patch` が 3 回以上連続失敗していないか（run-loop.cjs の recovery hint 機構が発動するはず）
2. **context snapshot stale**: 連続書き込みで "No change detected" が発生していないか
3. **auto-continuation**: maxIterations=30 に達した場合、自動で resume されるか
4. **file creation leakage**: AI が `main_v2.tex` 等の不要ファイルを作成していないか
5. **日本語/英語の混在**: 英語指示で日本語コメントやエラーメッセージが混入していないか
6. **max_tokens / temperature**: `gpt-5.4-nano` で temperature=0.2 が実際にリクエストに含まれているか（DevTools または Network 監視）
7. **quota consumption**: 最終的に記録される cost が妥当か（api-usage.cjs の永続化ファイル確認）
8. **arxiv_search レート制限**: Step 4 で arxiv API が tool-level タイムアウトしないか
9. **run_command 安定性**: Step 11 で `detex | wc -w` が成功するか
10. **Retry-After 尊重**: 429 が返った場合、固定 5 秒ではなく適切な秒数で待つか

## 実行方法

1. TeX64 アプリを起動
2. File → Open Folder → `/Users/wedd/tex64-internal/test-workspace/e2e-paper-test/` を選択
3. 左サイドバーから AI Chat パネルを開く
4. 上記 Step 1 の指示をそのまま貼り付けて Enter
5. AI の応答完了を待つ
6. 合否基準をチェック
7. Step 2, 3, ... と順に実行
8. Step 11 完了後、最終スコアを本 md の評価サマリーに記入

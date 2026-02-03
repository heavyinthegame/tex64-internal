# tex64 実装完成プラン（VS Code / LaTeX Workshop との差分）

対象: `implementation.md` 末尾の「参考: VS Code（LaTeX Workshop）と比べて tex64 にまだ無い/弱い可能性が高い機能」に挙げた項目。

## 0) ステータスまとめ（コード確認ベース）

凡例:
- DONE: ほぼ実装済み
- PARTIAL: 一部のみ実装/実質無効化/未接続
- TODO: ほぼ未実装

| 項目 | 状態 | 現状の根拠（主な関連ファイル） |
| --- | --- | --- |
| PDF⇄ソース双方向 SyncTeX | PARTIAL | forward + reverse は接続済み（Ctrl/Cmd+Click 逆ジャンプ、±3行補正、IPC/ハンドラ済み）。手動 forward や詳細設定は未実装 |
| 自動ビルド | TODO | 保存はあるがビルド自動トリガなし (`web-src/app/editor-session-file-ops.ts`, `web-src/app/build-ops-ui.ts`) |
| Lint（ChkTeX/LaCheck 等） | TODO | 該当ツール起動/結果取り込みが存在しない（`chktex`/`lacheck` の参照なし） |
| Intellisense 強化 | PARTIAL | `\\ref`/`\\cite` 補完と簡易テンプレ/ghost はあるが、パス補完や画像プレビュー等は無し (`web-src/app/monaco-setup.ts`, `web-src/app/workspace-controller.ts`) |
| Hover プレビュー | TODO | Hover provider が無い（テーマ調整はあるが機能なし: `web-src/app/monaco-setup.ts`） |
| プロジェクト全体 Structure/Outline | PARTIAL | インデックスは全体生成しているが Outline UI は「現在ファイル」にフィルタ (`electron/services/indexer.cjs`, `web-src/app/outline-ui.ts`) |
| Word count（texcount） | TODO | `texcount` の実行/表示が存在しない |
| clean（補助ファイル掃除） | TODO | `latexmk -c/-C` 等の実装が存在しない (`electron/services/build.cjs`) |
| `.bib` 支援強化 | PARTIAL | `.bib` を bibtex として開く/引用キーのインデックスはあるが、bib 補完/整形は無し (`web-src/app/editor-session.ts`, `electron/services/indexer.cjs`, `web-src/app/monaco-setup.ts`) |

## 1) 仕様方針（実装前に固める）

- 「自動確定は禁止」方針に合わせ、破壊的操作（clean/一括変更）は必ず確認ステップを入れる。
- 重い処理（build/lint/texcount）は非同期で、UIブロック・ログ洪水を避ける（Issues に集約）。
- 追加する外部コマンド（chktex/texcount/bib整形ツール等）は「実行環境」タブで検出・導線を用意する（最低限は “未検出” を明確に出す）。

## 2) 実装プラン（MVP → 仕上げ）

### 2-1) PDF⇄ソース双方向 SyncTeX（PARTIAL → DONE）

現状:
- forward: build 成功時に自動実行（`web-src/app/build-ops-ui.ts` → `synctex:forward`）。
- reverse: PDF の Ctrl/Cmd+Click で逆ジャンプ（tab/window 両対応・±3行補正）。
- 手動 forward: UI が無効化（`web-src/app/build-ops-ui.ts` の `updateSynctexButtonState()` が常に非表示）。

MVP（まず動く）:
- [x] IPC 追加: `synctex:reverse` と `synctex:reverseResult` を定義
  - 追加箇所候補: `electron/main.cjs`, `electron/handlers/build.cjs`, `web-src/app/bridge-handlers.ts`, `web-src/app/build-ops-ui.ts`
- [x] PDF viewer（tab/window 両対応）で “Ctrl/Cmd+Click” を拾い、(page, x, y, pdfPath) を親へ通知
  - tab: `Resources/web/pdf-viewer.js` → `parent.postMessage(...)` 経由
  - window: `Resources/web/pdf-viewer.js` → `window.tex64Pdf.postMessage(...)` 経由（`electron/pdf-preload.cjs`）
  - 受け側: `electron/main.cjs` の `ipcMain.on("tex64:pdf", ...)` を拡張
- [x] reverseResult を受けて該当ファイル/行へジャンプ
  - 既存ジャンプ処理を流用して「ファイルを開く → 行へ移動 → ハイライト」を統一
- [ ] 手動 forward ボタンを復活（“設定でON時のみ表示” でも良い）

仕上げ（VS Code 体験に寄せる）:
- [ ] 逆ジャンプの “候補が複数ある場合” の UI（候補リスト or 最有力にジャンプ＋弱い確信の表示）
- [ ] PDF 上に一時的なマーカー表示（forward の視覚フィードバック）
- [x] 設定: 逆SyncTeX の有効/無効
- [ ] 設定: 修飾キー要否、ジャンプ先を primary/secondary どちらに出すか
- [x] E2E: `tests/e2e/` に reverse フロー追加（E2Eモードでは synctex 実行をスタブして UI/IPC を検証）

完了条件:
- PDF 上 Ctrl/Cmd+Click → 該当 `.tex` が開き、行へ移動できる（tab/window 両方）。
- 手動 forward が UI から実行できる。


### 2-3) Lint（ChkTeX/LaCheck）（TODO → DONE）

MVP:
- [ ] Electron service 追加（例: `electron/services/lint.cjs`）で外部コマンドを実行し、結果を `IssueItem` に変換
- [ ] IPC 追加（例: `lint:run` / `lint:result`）と UI 反映（Issues に出す）
- [ ] 実行タイミング: 保存後 debounce（自動ビルドと同じキューに載せるのが安全）

仕上げ:
- [ ] Monaco の markers にも反映（Problems 的に下線を引く）
- [ ] “ビルドログ由来の Warning” と “lint の Warning” を区別して表示（フィルタ/タブ分け）
- [ ] 実行環境チェックに `chktex`/`lacheck` を追加（未導入時の導線）

完了条件:
- 保存時に lint が走り、該当行へジャンプできる形で Issues に並ぶ。

### 2-4) Intellisense 強化（PARTIAL → DONE）

現状:
- `\\ref{` / `\\cite{` の補完はインデックスから供給（`web-src/app/monaco-setup.ts`）。
- 簡易テンプレ/環境名/ghost completion はある。

MVP:
- [ ] `\\input{` / `\\include{` の “パス補完”
  - 候補ソース: `web-src/app/workspace-controller.ts` の `workspaceFiles`
  - 現在ファイルのディレクトリ基準で相対パス提示（`sections/intro` 等）
- [ ] `\\includegraphics{` の “画像パス補完”（拡張子候補、サブフォルダ対応）

仕上げ:
- [ ] 画像候補のプレビュー（completion の detail/追加 UI、または hover と組み合わせ）
- [ ] `\\bibliography` / `\\addbibresource` 等の補完（採用する文献系の流儀に合わせる）
- [ ] snippet の充実（figure/table 環境、align ブロック等）

完了条件:
- 主要コマンドでパス補完が実用レベルで動く。

### 2-5) Hover プレビュー（TODO → DONE）

MVP:
- [ ] Monaco hover provider を追加（`web-src/app/monaco-setup.ts`）
  - `\\ref{}` → ラベル定義位置（path/line）の表示
  - `\\cite{}` → `.bib` 側の定義位置（path/line）の表示
  - `\\includegraphics{}` → 画像の簡易プレビュー（可能なら）

仕上げ:
- [ ] 数式 hover レンダ（依存追加が許されるなら KaTeX が軽量）
- [ ] texdoc 連携（外部コマンド起動が必要なので Electron 側で実装）

完了条件:
- ref/cite/includegraphics の hover が “調べなくても分かる” レベルで返る。

### 2-6) プロジェクト全体 Structure/Outline（PARTIAL → DONE）

現状:
- indexer は全 `.tex/.bib` を走査して sections を収集（`electron/services/indexer.cjs`）。
- Outline UI は “現在ファイルのみ” にフィルタ（`web-src/app/outline-ui.ts`）。

MVP:
- [ ] Outline に “現在ファイル / プロジェクト” 切り替えを追加
- [ ] “プロジェクト” の場合は `sections` をファイル単位でまとめて表示し、クリックで該当箇所へジャンプ

仕上げ:
- [ ] `\\input/\\include` を解析してツリー化（chapter → include 先）し、実プロジェクト構造に寄せる
- [ ] 章節番号の付け方を “ファイル跨ぎ” でも破綻しないように再設計

完了条件:
- include を多用するプロジェクトで “全体の見取り図” として機能する。

### 2-7) Word count（texcount）（TODO → DONE）

MVP:
- [ ] Electron service で `texcount` を実行し、結果を UI に表示
  - 表示場所案: Issues summary / Settings / Workspace ラベル付近（新規UIが必要なら `Resources/web/index.html`）
- [ ] 対象: root tex（`workspace.rootInfo()` の結果）を基本にする

仕上げ:
- [ ] “章ごと” 集計 / “除外コメント” の設定
- [ ] 実行環境チェックに `texcount` を追加

完了条件:
- 1クリック（または自動）で word count が見える。

### 2-8) clean（補助ファイル掃除）（TODO → DONE）

MVP:
- [ ] Electron 側で `latexmk -c`（必要なら `-C`）を実行する handler/service を追加
- [ ] UI から実行（Build 周りにボタン or Settings）
- [ ] “削除対象” の説明 + 確認（誤削除の不安を減らす）

仕上げ:
- [ ] “生成PDFを残す/消す” の選択
- [ ] outdir を使っている場合の対応

完了条件:
- 補助ファイルを安全に掃除でき、次回ビルドが破綻しない。

### 2-9) `.bib` 支援強化（PARTIAL → DONE）

MVP:
- [ ] bibtex 用 completion provider（`web-src/app/monaco-setup.ts`）
  - `@article{...` 等の雛形
  - フィールド名候補（title/author/year/journal 等）
- [ ] citekey の “衝突検知” の補助（インデックスと突き合わせ）

仕上げ:
- [ ] `.bib` 整形（bibtex-tidy 等の採用検討）＋ diff で確定
- [ ] citekey の一括リネーム（既存の Search 内一括リネームと統合）

完了条件:
- `.bib` 編集が最低限ストレスなくできる（雛形/補完/整形のいずれかが揃う）。

## 3) ドキュメント更新（実装と同時に行う）

- [ ] `README.md` の「現行仕様（要点）」の該当箇所を更新（SyncTeX/Build/Outline 等）
- [ ] `implementation.md` の各セクションも実装に合わせて更新（“できること” の単一ソースとして維持）

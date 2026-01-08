# tex64

Electron ベースの TeX エディタ（開発中）。

## この README の役割

- 設計/運用/タスクの単一ソース。
- 旧メモ類は参照せず、この README を更新する。

## 開発

1. `npm install`（初回のみ）
2. `npm run web:build`
3. `npm run electron:dev`

## 編集ルール（重要）

- ロジック変更は `web-src/**/*.ts` で行う。`Resources/web/**/*.js` は生成物のため直接編集しない。
- `npm run web:build` で `Resources/web/main.js` と `Resources/web/app/*.js` を更新する。
- UI 見た目のみの調整は `Resources/web/index.html` / `Resources/web/theme.css` を使う（ロジックは触らない）。

## 構成

- Electron 殻: `electron/main.cjs` がメイン UI を起動（別ウィンドウのブロック編集は廃止）。
- Bridge: `electron/preload.cjs` が `window.tex64Bridge` を公開し IPC を中継。
- Web UI: `Resources/web/index.html` + `Resources/web/main.js` + `Resources/web/app/*.js`（生成物）。
- PDF ビューア: `Resources/web/pdf-viewer.html` / `Resources/web/pdf-viewer.js` / `Resources/web/pdf-viewer.css`。
- Monaco: `web-src/main.ts`（エントリ） + `web-src/app/*`。
- Services: `electron/services/*` がワークスペース/ビルド/検索/バージョン管理/Indexer/PDF を担当。

## UI マップ（主要パーツ）

- Sidebar tabs: files / outline / blocks / issues / history / search / settings。
- File explorer: `#workspace-label`, `#file-tree`, `#save-file-button`。
- Editor: `#editor`, `#editor-tabs`, `#build-button`, `#editor-viewer`。
- Issues: `#issues-panel`, `#issues-list`, `#issues-log`。
- Modals: `#create-modal`, `#rename-modal`, `#diff-modal`。
- Versioning: `#git-summary-text`, `#git-guide-text`, `#git-init`, `#git-commit-message`, `#git-commit-button`, `#git-history`, `#git-pull`, `#git-push`, `#git-remote-url`, `#git-remote-save`, `#git-status`。

## 方針（UX/安定性）

- 安定性最優先（入力が壊れない/落ちない/状態が迷子にならない）。
- 自動確定は禁止（提案は OK、確定はユーザー操作のみ）。
- 重い処理は非同期（Index/Build は UI をブロックしない）。
- PDF 更新はビルド成功時のみ、失敗時は前回成功 PDF を保持。
- ログ洪水禁止（Issues が一次窓口）。
- UI 構成は VSCode 風（左タブ/右エディタ/下部ステータス）。
- 設計方針に変更があったら、常に `README.md` / `map.md` / `test.md` を更新する。

## 現行仕様（要点）

- 差分プレビュー: 一般的な挿入/変更の確定前に共通モーダルで差分を確認し、左に変更前/右に変更後＋変更箇所の前後3行を表示する（ブロック挿入・今後のAI提案もここを使う）。
- ブロック編集: 数式/表を自動検出 → 挿入内容を作成 → 確定挿入。`verbatim` 系は対象外。
- バージョン管理: 保存/復元の前に差分プレビューを表示し、「履歴に保存」「履歴一覧から復元」「同期（送る/受け取る）」を中心に操作できる。同期失敗時はヒントを表示する。
- SyncTeX:
  - ビルド成功時のみ forward（設定: 「ビルド時 SyncTeX」）。
  - PDF 側クリックで「ソースにジャンプ」ボタンを表示し、押下時のみ reverse。
  - PDF ビューアの操作 UI は「再読み込み」のみ。
- Issues:
  - `IssueItem` に path/line/column を保持し、クリックで該当ファイルにジャンプ。

## タスク
現在:


数式挿入キーボード
11. 予測
7. AI
4. issue


数式挿入関連
git
差分プレビュー



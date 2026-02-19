# TeX64 機能設計図（実装同期版）

この文書は、`/Users/wedd/tex64` の現行実装（Renderer/Main/PDF viewer/API proxy）を読み直して、
**ユーザーができること**を機能ベースで整理した最新版です。

- 基準日: 2026-02-18
- 方針: コード構造の説明ではなく、画面操作・挙動・制約・保存先を中心に記述
- 対象: ランチャー、編集、ビルド、SyncTeX、検索、Blocks、OCR、AI、設定、永続化

---

## 1. アプリでできること（全体像）

TeX64 は、1つの LaTeX ワークスペースに対して次を一体で提供します。

- プロジェクトの作成・オープン・最近のプロジェクト再開
- ファイルツリー操作（作成・改名・移動・コピー・削除・Undo）
- Monaco エディタでの編集、2ペイン分割、タブ管理
- PDF/画像ビューア（タブ内または別ウィンドウ）
- latexmk によるビルド、clean、SyncTeX（forward/reverse）
- Index に基づく Outline / Search / ラベル重複検出
- 数式編集支援（Blocks、MathLive、候補サジェスト、OCR）
- AI チャット（ツール実行、変更提案、差分確認、適用、Undo）
- 設定管理（ビルド、整形、環境チェック、補完、環境レジストリ）

---

## 2. 起動とプロジェクト導線

### 2.1 ランチャー

- ワークスペース未選択時にランチャーを表示
- ワークスペース確定後は非表示
- キーボード操作:
  - `ArrowUp/ArrowDown`: 「フォルダを開く」「新規作成」の選択移動
  - `Enter`: 選択中アクション実行

### 2.2 フォルダを開く

- OS のディレクトリ選択ダイアログでワークスペースを選択
- 選択後、ワークスペース情報と Index をロード

### 2.3 新規プロジェクト作成

- フォルダ選択後に `main.tex` テンプレートを作成
- `main.tex` が既存なら `main2.tex`, `main3.tex`... を自動採番して上書き回避
- テンプレート内容は LaTeX 文書の雛形（本文、数式、図表、文献のサンプル付き）
- 補足: バックエンドは `paper/lecture` 両テンプレートを受け取れるが、現行ランチャー UI からは `paper` 運用

### 2.4 最近のプロジェクト

- 起動時に最近プロジェクトを取得してランチャー右側へ表示
- 保存件数は最大 10（新しいものが先頭）
- 初期表示は先頭 3 件、`すべて表示/折りたたむ` で展開切替
- 項目をクリックするとそのパスを再オープン
- 再オープン時に存在確認し、存在しない項目は最近一覧から自動除去

---

## 3. ワークスペースモデル

### 3.1 走査対象と除外

- 対象はワークスペース配下のみ（パストラバーサル拒否）
- 主要除外ディレクトリ: `.git`, `.tex64`, `.swiftpm`, `node_modules`, `DerivedData`, `build`, `tex64.xcodeproj`
- 隠しエントリ（`.` 先頭）は基本除外
- ツリー非表示の補助拡張子例: `.aux`, `.toc`, `.synctex.gz`, `.fls`, `.fdb_latexmk`
- 列挙上限はファイル/フォルダともに最大 5000

### 3.2 root TeX（メイン TeX）

- `.tex64/settings.json` の `rootFile` に手動指定を保存
- 手動指定:
  - `.tex` かつ存在するファイルのみ有効
- 自動検出:
  - `main.tex` を最優先
  - なければ `.tex` 群をスコアリングして選択
  - 評価軸: `\documentclass`, `\begin{document}`, `\end{document}`, 代表ファイル名（`root.tex`, `paper.tex`, `thesis.tex`, `lecture.tex` など）、階層深さ
- UI:
  - 手動時ボタン表示は「自動に戻す」
  - 自動時ボタン表示は「再検出」

### 3.3 `%!TEX root` 追跡

- ビルド対象が個別 `.tex` のとき、先頭 40 行から `%!TEX root = ...` を解決
- 相対パス解決、拡張子補完（`.tex`）対応
- 最大 5 段追跡、ループ検出あり
- ワークスペース外/非 `.tex` は拒否

---

## 4. ファイルツリーとファイル操作

### 4.1 ツリー表示

- ファイル/フォルダを階層表示
- フォルダ開閉状態を `localStorage` に保存（ワークスペース単位）
- 選択中パスを保持し、rename/move 後も追従更新

### 4.2 右クリックメニュー

- ファイル/フォルダ別に以下を提供:
  - 開く
  - 新規ファイル/新規フォルダ
  - Finder で表示
  - ターミナルで開く
  - 名前変更
  - 削除

### 4.3 作成・改名・移動・コピー・削除

- 作成:
  - モーダル入力で検証後に作成
- 改名:
  - 同一ディレクトリ内 rename（`/` を含む名前は拒否）
- 移動:
  - DnD またはカット&ペーストで `moveItem`
  - 自分自身配下への移動など不正移動は拒否
- コピー:
  - コピー&ペーストで `copyItem`
- 削除:
  - 実体は `.tex64/.trash` への移動

### 4.4 Undo（ファイル操作）

- Undo 対象:
  - move
  - delete
- copy/rename/create は Undo 対象外
- 削除 Undo は `.trash` から元位置へ復元
- manual root が削除で消えた場合、Undo 復元時に root 設定も戻す

### 4.5 ショートカット（ツリー上）

- `Cmd/Ctrl+C`: コピー
- `Cmd/Ctrl+X`: カット
- `Cmd/Ctrl+V`: ペースト
- `Cmd/Ctrl+Z`: 最後の move/delete を Undo

### 4.6 安全ガード（未保存ファイル）

- UI 側で以下をブロック:
  - rename 対象に未保存変更がある
  - move 対象に未保存変更がある
  - delete 対象に未保存変更がある
- エラーは Issues に表示

---

## 5. エディタ・タブ・分割表示

### 5.0 画面レイアウト

- サイドバータブ:
  - `files`, `outline`, `blocks`, `ai`, `project`, `search`, `issues`, `settings`
- primary タブ可視性:
  - 右クリックメニューで表示/非表示を切替
  - 最低 1 タブは常時表示
  - 表示設定は `localStorage` に保存
- サイドバー幅:
  - リサイザで横幅を変更可能
  - 最小幅制約を維持してエディタ領域を保護

### 5.1 エディタ基盤

- Monaco エディタを使用
- 2グループ構成: `primary` / `secondary`
- split view を ON/OFF 可能
- split 比率を保存して復元

### 5.1.1 Monaco 言語登録とシンタックスカラー

- Monaco 初期化時に `latex` / `bibtex` を言語登録し、Monarch トークナイザを設定
- 言語割り当て:
  - `.bib` は `bibtex`
  - `.tex`, `.sty`, `.cls`, `.ltx`, `.dtx`, `.ins`, `.bbx`, `.cbx`, `.cfg`, `.def`, `.lbx`, `.bst` は `latex`
  - それ以外のテキストは `plaintext`
- `latex` の着色対象（現行実装）:
  - `%` コメント
  - `\begin`, `\end`, `\usepackage` などのコマンド
  - 一般的な `\command` 形式
  - `$...$`, `$$...$$`, `\(...\)`, `\[...\]` の数式デリミタ
  - 波括弧/角括弧/丸括弧、`& ^ _ ~`、数値
- `bibtex` の着色対象（現行実装）:
  - `%` コメント
  - `@article` などのエントリ種別
  - 文字列（`"..."`）
  - `{}`, `()`, `=`, 数値、識別子
- テーマは `tex64-deep-slate`（base: `vs-dark`）を適用

### 5.2 タブ管理

- 各グループに独立したタブ列
- タブのクローズ、グループ間移動（D&D）
- dirty 状態をタブに反映
- 同一ファイルは既存グループ優先で再利用

### 5.3 ファイル種別ごとの開き方

- `text`: Monaco で編集
- `image`: 画像ビューア
- `pdf`: PDF ビューア
- 非対応拡張子: Unsupported メッセージ表示
- PDF は未指定時に secondary へ自動オープンし split を有効化

### 5.4 保存と dirty 管理

- 保存:
  - 明示保存
  - 自動保存（タイマ）
- dirty 判定:
  - モデル内容と `savedContent` を比較
- save 成功時:
  - dirty 解除
  - 必要なら整形済み内容でバッファ更新
- 保存前に閉じる場合:
  - `beforeunload` で未保存警告

### 5.5 カーソル/ジャンプ

- `jumpToFileLine` で path:line ジャンプ
- Search/Outline は secondary へジャンプ（split 自動 ON, focus を奪わない）
- Issues はアクティブグループへジャンプ

---

## 6. 入力支援（Completion / Hover / Ghost）

### 6.1 コード補完（通常補完）

- `\ref` 系: Index の labels を候補
- `\cite` 系: Index の citations を候補
- `\input` / `\include`: `.tex` パス候補
- `\includegraphics`: 画像パス候補
- `\begin{...}`: 環境候補（env registry + 内蔵）
- 代表スニペット候補（figure/table/section など）

### 6.2 Hover

- 数式トークン上で数式プレビュー（MathLive レンダリング）
- `\cite{...}` で `.bib` エントリ抜粋表示
- `\includegraphics` で画像プレビュー（遅延ロード）
- `\input` / `\include` で対象ファイル抜粋表示
- `\ref` / `\eqref` などの参照先情報表示
- ホバー結果とプレビュー要求にキャッシュあり

### 6.3 Ghost Completion（インライン補完）

- ルールベース補完:
  - LaTeX コマンド・環境文脈から inline 候補生成
- API 補完（必要時のみ）:
  - 無効時は呼ばない
  - クールダウン・分あたり回数制限・negative cache を適用
  - 取得結果はキャッシュ（TTL）
- 設定:
  - ON/OFF
  - debounce
  - 最大文字数

### 6.4 補助ブローカー（プレビュー/抜粋/API）

- 画像プレビュー:
  - 2MB 以下のみ
  - タイムアウトあり
- ファイル抜粋:
  - 行中心で半径指定
  - 行数/バイト数上限で切り詰め
- API completion:
  - requestId 管理と timeout
  - usage snapshot を受け取り保持

---

## 7. ビューア（画像 / PDF）

### 7.1 タブ内ビューア

- 画像と PDF をエディタ領域内表示
- PDF は iframe 経由で専用 viewer を使用

### 7.2 PDF 別ウィンドウ

- 設定により PDF を別ウィンドウ表示
- Main と専用 IPC で同期（open/sync/reload/reverse）

### 7.3 PDF viewer 操作

- ページ移動（前/次、ページ番号入力）
- ズーム（ボタン、Ctrl/Cmd+wheel、pinch）
- fit-width / fit-page
- 回転（左右）
- 検索（前/次）
- Outline / Thumbnails 切替
- 色反転（保存）
- Download / Print / Reload
- reverse SyncTeX:
  - 右クリック or `Ctrl/Cmd+クリック` 位置から逆引き

### 7.4 親子通信

- 親 → iframe: `open` / `sync`
- iframe → 親: `ready` / `reverse`
- payload は `source: "tex64-pdf"` で識別

---

## 8. ビルド・clean・整形

### 8.1 ビルド

- `latexmk` でビルド実行
- engine:
  - `lualatex`
  - `pdflatex`
  - `xelatex`
  - `uplatex`
- 実行時オプション:
  - `-synctex=1`
  - `-interaction=nonstopmode`
  - `-halt-on-error`
  - `-file-line-error`

### 8.2 Build Profiles

- プロファイル管理（最大 20）
- 項目:
  - `name`
  - `outDir`
  - `extraArgs`
- active profile を選択して適用
- 変更は自動保存
- `.tex64/settings.json` に保存

### 8.3 outDir/args の扱い

- `extraArgs` 内 `-outdir` 解析対応
- `extraArgs` 内 `-jobname` 解析対応（出力 PDF の検出に反映）
- 不正 `outDir`（ワークスペース外・絶対パスなど）は拒否
- clean/deep clean でも同一 profile を反映

### 8.4 clean

- 通常 clean（`-c`）
- 全削除 clean（`-C`）

### 8.5 ビルド結果の解析

- latexmk 出力から error/warning を抽出
- path/line/column を推定
- 失敗要約を生成して Issues へ反映
- build log を保持して UI に表示
- PDF は通常は `jobname.pdf` を開く。見つからない場合は `.fls` / `.fdb_latexmk` から生成 PDF を検出する
- ツール未導入（latexmk/synctex）系は `open-runtime` アクションを付与

### 8.6 整形（formatter）

- `latexindent` 優先
- 失敗時は fallback formatter へ降格
- 設定:
  - インデント
  - begin/end 改行
  - `document` no-indent
  - 数式/表 delims align
  - blank lines
  - custom verbatim
- save 時整形と手動整形の両方を提供

---

## 9. SyncTeX（forward / reverse）

### 9.1 forward

- トリガ:
  - SyncTeX ボタン
  - ビルド成功後の自動 forward（設定 ON 時）
  - `tex64://view-on-pdf` deep link
- 主な挙動:
  - in-flight 重複抑制
  - request order 管理
  - 短期キャッシュ
  - stale 結果破棄
  - 一部行（コメント等）は補助探索

### 9.2 reverse

- PDF 位置（page/x/y）から source path/line に逆引き
- 逆引き成功時はエディタジャンプ
- 失敗時は Issues へ反映（必要に応じ runtime 導線）

### 9.3 reverse の有効/無効

- 設定トグルで OFF の場合、PDF 側 reverse 要求を無視

---

## 10. Outline / Search / Issues

### 10.1 Index 生成

- `.tex` / `.bib` を走査して抽出:
  - labels
  - references
  - citations
  - sections
  - figures
  - tables
  - todos
- 重複除去済みスナップショットを UI 更新

### 10.2 Outline

- 表示モード:
  - current（アクティブファイル）
  - project（全体）
- セクション階層表示
- todo/label/citation へジャンプ

### 10.3 Search

- `.tex` 全文検索（大小無視）
- 最大 200 件
- ファイルごとにグルーピング表示
- クリックで secondary にジャンプ

### 10.4 Search 内シンボルリネーム

- 対象:
  - `label/ref`
  - `cite`（`.bib` 含む）
- 入力検証:
  - from/to 必須
  - 同一不可
  - 空白・カンマ・`{}` 不可
- 実行:
  - `rename_latex_symbol` ツールを AI 経由で実行
  - 結果件数を `search:renameResult` で表示

### 10.5 Issues

- 収集元:
  - build/format/save/runtime
  - duplicate label 警告
- 表示:
  - severity
  - location
  - message
  - 解決ヒント
- `open-runtime` action 付き項目は Runtime 設定へ遷移
- build failed 後は error 到着時に Issues タブへ自動フォーカス

---

## 11. Blocks（数式編集）

### 11.1 モード

- `insert`: 新規挿入
- `edit`: 既存数式ブロック検出して編集
- 対象は `.tex` の math ブロック

### 11.2 自動検出

- 対象:
  - `$...$`, `$$...$$`, `\(...\)`, `\[...\]`
  - `\begin{...}` ... `\end{...}`
- コメント/verbatim 系環境は除外
- env registry とヒューリスティックで math/table 判定
- 検出位置をハイライト表示

### 11.3 入力 UI

- MathLive が使える場合は `<math-field>` を使用
- 利用不可時は textarea fallback
- 画面キャプチャボタンから OCR 導線あり

### 11.4 挿入フォーマット

- `inline`
- `display`
- `align`
- `gather`
- `none`（raw）
- wrap 設定（inline/display の記法選択）を保持

### 11.5 適用フロー

- 挿入/置換候補を Diff Modal で確認
- Submit で適用
- 適用後に必要に応じ整形
- 履歴を `.tex64/blocks.json` に追記

### 11.6 WYSIWYG 候補

- 自動/手動サジェスト
- キーボードナビ
- MRU 学習
- packs:
  - `core`
  - `math`
  - `physics`
  - `cs`
  - `personal`
  - `jp`

### 11.7 数式キーボード（実装状態）

- ドック UI とキー定義は実装済み
- ただし現行は `MATH_KEYBOARD_VISIBLE = false` のため常時非表示

---

## 12. 画面キャプチャ / OCR

- 画面ソース一覧から対象を選択
- クロップ範囲指定
- OCR 実行:
  - ONNX ベースの数式認識
  - フォールバック手段あり
  - 前処理バリエーションを比較して最良候補を採用
- 結果を Blocks 入力へ注入し、そのまま編集・挿入できる

---

## 13. AI アシスタント

### 13.1 チャット基本

- 複数会話
- 履歴切替
- ストリーミング応答
- 停止（abort）
- 会話クリア

### 13.2 コンテキスト注入

- active file（上限あり）
- 選択範囲（上限あり）
- open files snapshot
- recent issues（最大 5）

### 13.3 画像添付

- 画像のみ
- 最大 4 件
- 1 件 5MB まで
- 合計 8MB まで
- 超過・非画像・読込失敗は UI で理由を通知

### 13.4 ツール実行と提案

- AI はツール呼び出しでワークスペース情報を取得・検索・検証可能
- 代表ツール:
  - `list_files`
  - `read_file` / `read_files`
  - `search_files`
  - `get_project_structure`
  - `get_index`
  - `rename_latex_symbol`
  - `run_build`
  - `run_command`（設定で許可時のみ）
  - `get_app_settings` / `set_app_settings`
  - `propose_write` / `propose_patch` / `propose_delete` / `propose_rename` / `propose_create_directory`

### 13.5 提案適用

- proposal card で差分確認
- Diff Modal で最終確認して apply
- `適用して続ける` フローあり
- apply 後は proposal を消し、必要なら自動 build
- `undoLastApply` で直近適用を戻せる（履歴上限あり）

### 13.6 AI 実行制約

- policy:
  - 読み取りファイルサイズ上限
  - 読み取りファイル数上限
  - 許可拡張子
  - 許可/禁止トップレベルパス
- `run_command`:
  - 許可コマンドのみ
  - パイプ/リダイレクト等のシェル演算子を禁止
  - タイムアウト/出力量制限あり

### 13.7 使用量記録

- input/output/total tokens
- requests
- 概算コスト（モデル別集計）
- リセット機能あり

### 13.8 認証・契約導線（AIタブ）

- AI利用時に Google OAuth 状態と契約状態を判定（未ログイン/未契約/上限超過を表示）
- プラン導線（`pricing`）を AIタブのステータスから開ける
- 使用量（token/request/期間）を表示し、`再試行` で再取得できる
- AIが利用不可でも編集・ビルド・保存などローカル機能は継続利用できる

---

## 14. 設定

### 14.1 Editor

- compile engine
- build 後 auto forward SyncTeX
- reverse SyncTeX ON/OFF
- PDF 表示モード（window/tab）
- Ghost completion ON/OFF
- Ghost debounce
- Ghost max chars
- align env ON/OFF

### 14.2 Format

- indent style
- begin/end 改行
- `document` no-indent
- align math/table delims
- blank lines 方針
- custom verbatim 追加/削除

### 14.3 Build Profiles

- プロファイル追加/削除/選択
- `name/outDir/extraArgs` 編集
- clean / clean-all 実行

### 14.4 Runtime（実行環境・アップデート）

- `lualatex/pdflatex/xelatex/uplatex/latexmk/latexindent/synctex` をチェック
- 未導入時のインストール導線（platform 別）
- Runtime ページを開くと `update:status:get` と `update:check(force=false)` を実行
- 更新UIで `現在/最新バージョン`、状態、進捗バーを表示
- 更新操作:
  - `更新を確認`
  - `ダウンロード`（manifest の `artifactUrl` を取得）
  - `適用`（ダウンロード済みインストーラを起動）
  - `手動ダウンロード`（`artifactUrl` → `notesUrl` → `TEX64_LINKS.download` の順で開く）
- ダウンロード後に `sha256` 検証を実施し、不一致時は適用しない
  - 受理する検証値: `artifactSha256` / `sha256` / `checksum` / `signature`（sha256 として解釈可能な形式）

### 14.5 Env Registry

- 既定環境 + custom 環境の管理
- math/table 種別指定
- 有効/無効切替
- discouraged/package 表示
- Blocks 検出・整形設定へ反映

### 14.6 フィードバック・法務/サポート導線

- フィードバック送信（カテゴリ・本文・連絡先任意）は Settings > Runtime から実行
  - `Cmd/Ctrl+Enter` でも送信可能
  - 送信先は自前 API（`/feedback`）
- 法務/サポートリンク（利用規約、プライバシー、特商法、返金、ヘルプ、問い合わせ、リリースノート）を Settings から開ける

---

## 15. 永続化（どこに何を保存するか）

### 15.1 ワークスペース内

- `.tex64/settings.json`
  - `rootFile`
  - `buildProfiles`
  - `buildProfileId`
- `.tex64/.trash/*`
  - 削除ファイルの一時退避
- `.tex64/blocks.json`
  - Blocks 適用履歴
- `.tex64/.format/*`
  - formatter 作業用

### 15.2 userData

- `tex64-user-settings.json`
  - AI 設定
  - recent projects
- `tex64-api-usage.json`
  - API usage 集計
- `tex64-platform-session.json`
  - Google OAuth セッション
  - plan/status のキャッシュ
  - OAuth 進行中 state
- `updates/*`
  - アップデート用にダウンロードしたインストーラ

### 15.3 localStorage（主なキー）

- 編集/表示:
  - `tex64.compileEngine`
  - `tex64.editor.autoSynctexOnBuild`
  - `tex64.editor.reverseSynctex`
  - `tex64.editor.pdfViewerMode`
  - `tex64.editor.ghostCompletion`
  - `tex64.editor.ghostCompletion.debounceMs`
  - `tex64.editor.ghostCompletion.maxChars`
  - `tex64.editorSplitRatio`
- サイドバー/タブ:
  - `tex64.sidebar.primaryTabs`
  - `tex64.activeTab`
- ファイルツリー:
  - `tex64.tree.<workspace>`
- Outline:
  - `tex64.outline.mode`
- Blocks/WYSIWYG:
  - `tex64.math-insert-mode`
  - `tex64.math-insert-inline-wrap`
  - `tex64.math-insert-display-wrap`
  - `tex64.math-wysiwyg.autoSuggest`
  - `tex64.math-wysiwyg.packs`
  - `tex64.math-wysiwyg.mru*`
- PDF viewer:
  - `tex64.pdf.invert`
  - `tex64.pdf.sidebarTab`

---

## 16. 外部リンク・ショートカット

### 16.1 `tex64://` アクション

- `tex64://open-source?path=...&line=...&column=...`
  - ソース位置をエディタで開く
- `tex64://view-on-pdf?path=...&line=...&column=...`
  - forward SyncTeX を実行

### 16.2 グローバル操作

- `Cmd/Ctrl+B`: build 実行

### 16.3 `tex64.com` 公開ページ導線

- AI タブの `pricing` は `TEX64_LINKS.pricing`（現行既定: `https://tex64.com/#comparison`）へ遷移
- Settings の法務/サポートボタンは `TEX64_LINKS.*` で定義した `tex64.com` 公開ページを開く
- 手動アップデートは `artifactUrl` が無い場合に `notesUrl` または `TEX64_LINKS.download`（現行既定: `https://tex64.com/#download`）へフォールバック

---

## 17. 主要制限値（実装値）

- ワークスペース列挙: 5000
- Search 結果: 200
- Index/Issues は UI 側で必要に応じ上位表示制御
- ファイルプレビュー画像: 2MB
- ファイル抜粋: radius 最大 180、maxLines 最大 360、本文 12KB で切り詰め
- Ghost API 補完:
  - minPrefix 10
  - cooldown 3s
  - 最大 12 req/min
- AI 画像添付:
  - 4 件
  - 1件 5MB
  - 合計 8MB
- 最近プロジェクト: 10 件

---

## 18. 現行仕様として重要な注意点

- 数式キーボードは実装されているが現状は表示無効
- ランチャー新規作成は現行 UI では paper テンプレート運用
- 削除は OS ゴミ箱ではなく `.tex64/.trash` を使用
- `rename_latex_symbol` は Search 画面から AI ツール経由で実行される
- reverse SyncTeX は設定 OFF で無効化される
- アップデート導線は Settings > Runtime に集約（AIタブに更新操作は置かない）

---

## 19. 機能チェックリスト（網羅確認用）

### 19.1 プロジェクト・ワークスペース

- [x] フォルダを開く
- [x] 新規プロジェクト作成
- [x] 最近プロジェクト表示/再開
- [x] root TeX 手動設定
- [x] root TeX 自動検出/再検出
- [x] `%!TEX root` 追跡

### 19.2 編集・ファイル操作

- [x] テキスト編集
- [x] 2ペイン分割
- [x] タブ操作
- [x] 作成/改名/移動/コピー/削除
- [x] 削除 Undo / 移動 Undo
- [x] Finder 表示 / Terminal 起動

### 19.3 ビルド・整形・PDF

- [x] latexmk build
- [x] clean / deep clean
- [x] build profile
- [x] latexindent + fallback format
- [x] タブ内 PDF
- [x] 別ウィンドウ PDF
- [x] forward/reverse SyncTeX

### 19.4 参照支援

- [x] Outline
- [x] Search
- [x] Search から secondary ジャンプ
- [x] シンボル一括リネーム
- [x] Issues 集約と runtime 導線

### 19.5 数式支援

- [x] Blocks insert/edit
- [x] 数式ブロック自動検出
- [x] MathLive 入力
- [x] WYSIWYG 候補
- [x] OCR 連携
- [x] Diff 確認適用

### 19.6 AI

- [x] 会話履歴/複数会話
- [x] ストリーミング
- [x] 画像添付
- [x] ツール実行
- [x] 提案カード
- [x] 提案適用
- [x] 適用 Undo
- [x] usage 集計

### 19.7 設定・運用

- [x] Runtime で実行環境チェック
- [x] Runtime で更新確認/ダウンロード/適用
- [x] 更新ファイルの `sha256` 検証
- [x] Runtime でフィードバック送信
- [x] Settings から法務/サポート/リリース導線

以上。

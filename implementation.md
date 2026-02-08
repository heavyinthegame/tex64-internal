# tex64 implementation（最新）

このドキュメントは、tex64 の **「ユーザーができること」** と **観測可能な挙動** を、現行実装（`electron/*`, `web-src/*`, `Resources/web/*`）に合わせて **漏れなく** 記述したものです。
コードのクラス/関数構造の解説ではなく、画面/操作/永続化/IPC 契約を中心に整理します。

---

## 0) 用語

- **ワークスペース**: ユーザーが開いた「作業フォルダ」。以降の編集/検索/ビルド等はこのフォルダを前提に動作する。
- **相対パス**: ワークスペース直下からのパス（例: `main.tex`, `sections/intro.tex`）。
- **Main TeX / rootFile**: ビルド対象として扱うメイン `.tex`。自動検出または手動選択。
- **Primary / Secondary**: 2ペイン（分割ビュー）の左右（または上下）相当のエディタグループ。
- **Viewer mode**:
  - `window`: PDF を別ウィンドウで開く。
  - `tab`: PDF をタブ（iframe）で開く。
- **Issues**: すべてのエラー/警告の集約表示（ビルド/整形/保存/環境不足など）。

---

## 1) 全体アーキテクチャ

### 1.1 プロセス構成

- **Electron main process**（`electron/main.cjs`）
  - OS 連携（ダイアログ、Finder、別PDFウィンドウ等）
  - ファイル操作、ビルド、lint、formatter、SyncTeX、インデクサ、AI、OCR などのバックエンド処理
- **Renderer（Web UI）**（`web-src/*` → `Resources/web/*`）
  - Monaco エディタ + サイドバー UI
  - PDF/画像/非対応ファイルのビューア（タブ内）
  - ブロック（数式）UI、AI UI、検索/アウトライン、設定 UI
- **PDF viewer（別ウィンドウ）**（`Resources/web/pdf-viewer.html` + `electron/pdf-preload.cjs`）
  - `window.tex64Pdf` 経由で main とメッセージ通信
- **PDF viewer（タブ内 iframe）**（`Resources/web/pdf-viewer.html` + `Resources/web/pdf-viewer.js`）
  - 親（Renderer）と `window.postMessage` で通信（`source: "tex64-pdf"`）

### 1.2 Bridge / IPC の基本

- Renderer → Main（preload 経由）
  - `window.tex64Bridge.postMessage({ type: string, ... })`
  - ネイティブ連携が無い場合は Issues に「ネイティブ連携が利用できません。」を出す（silent 指定時は出さない）
- Main → Renderer
  - `webContents.send("tex64:message", { type, payload })`
  - preload が `tex64Bridge.onMessage` に配送し、Renderer 側 `bridge-handlers` が `type` ごとに UI/状態を更新
- PDF window（別ウィンドウ）
  - Main → PDF window: `webContents.send("tex64:pdf-message", { type, payload })`
  - PDF window → Main: `ipcRenderer.send("tex64:pdf", { type, payload })`
- PDF viewer（タブ内 iframe）
  - 親 → iframe: `postMessage({ source:"tex64-pdf", payload:{ type:"open"/"sync", payload } }, "*")`
  - iframe → 親: `postMessage({ source:"tex64-pdf", payload:{ type:"ready"/"reverse", payload } }, "*")`

### 1.3 主要サービス（Main 側）

- **WorkspaceManager**（`electron/services/workspace.cjs`）
  - ファイル一覧、作成/移動/削除/コピー、内部ゴミ箱、undo、rootFile 管理、`%!TEX root` 解決
- **BuildService**（`electron/services/build.cjs`）
  - `latexmk` でビルド/clean、outDir/extraArgs、ログ/Issues 抽出
- **FormatterService**（`electron/services/formatter.cjs`）
  - `latexindent` + fallback 整形、`.tex64/.format` 作業領域
- **LintService**（`electron/services/lint.cjs`）
  - `chktex` 実行と結果パース
- **IndexerService**（`electron/services/indexer.cjs`）
  - `.tex/.bib` を走査して label/cite/ref/section/todo/figure/table を抽出
- **SearchService**（`electron/services/search.cjs`）
  - ワークスペース内 `.tex` の全文検索
- **SynctexService**（`electron/services/synctex.cjs`）
  - forward/reverse の解析、候補選択、confidence 推定、±行 refine
- **PDFWindowManager**（`electron/services/pdf.cjs`）
  - 別PDFウィンドウの生成/表示/再読込/SyncTeX 同期キュー
- **EnvService**（`electron/services/env.cjs`）
  - `which/where` によるコマンド検出、brew/winget を使ったインストール導線
- **MathOcrService**（`electron/services/math-ocr.cjs`）
  - ONNX（pix2tex）+ tesseract.js フォールバック
- **AgentService**（`electron/services/agent.cjs`）
  - AI チャット、ツール実行、提案（proposal）生成、適用、usage 記録
- **ApiUsageService**（`electron/services/api-usage.cjs`）
  - トークン/コストの集計、userData への保存

---

## 2) 起動・ランチャー（プロジェクト選択）

### 2.1 表示/非表示

- ワークスペース未選択時はランチャーを表示し、選択後に非表示になる
- ワークスペース更新（`updateWorkspace`）で `rootPath` が入ったタイミングでランチャーは閉じられる

### 2.2 操作

- **既存フォルダを開く**
  - フォルダ選択ダイアログを開き、選択したフォルダをワークスペースとして設定する
- **新規プロジェクト作成**
  - 「新規プロジェクト」ダイアログでフォルダを作成/選択し、`main.tex` を生成して開く
  - `main.tex` が既に存在する場合は `main2.tex` / `main3.tex` … のように空いている名前で生成する（上書きしない）

### 2.3 キーボード操作

- ランチャー表示中:
  - `ArrowUp` / `ArrowDown` で「開く」「作成」の選択を移動
  - `Enter` で選択中のボタンを実行

---

## 3) ワークスペース管理（rootPath / rootFile）

### 3.1 ファイル/フォルダの列挙と除外

- 走査はワークスペース配下のみ（パス逸脱は拒否）
- 除外ディレクトリ（例）:
  - `.git`, `.tex64`, `.swiftpm`, `node_modules`, `DerivedData`, `build`, `Resources`, `tex64.xcodeproj`
- `.` で始まるエントリは基本的に列挙対象から除外（隠しファイル/隠しフォルダ）
- 追加で「TeX 補助ファイル」等は Files ツリーに出さない（例: `.aux`, `.toc`, `.log`, `.synctex.gz` など）
- 列挙上限:
  - ファイル/フォルダともに最大 5000 エントリ

### 3.2 Main TeX（rootFile）の決定

- 永続化: `.tex64/settings.json` の `rootFile`
- **手動指定（manual）**
  - Project タブの `settings-root-select` で `.tex` を選ぶ → `setRoot`
  - 指定が存在しない/`.tex` でない場合は拒否
- **自動検出（auto）**
  - `main.tex` があればそれを採用
  - なければ `.tex` を走査し、下記のヒューリスティックでスコア付けして最良を採用
    - `\\documentclass` を含む +3
    - `\\begin{document}` を含む +2
    - `\\end{document}` を含む +1
    - ファイル名が `main.tex/root.tex/paper.tex/thesis.tex/...` などなら +2
    - 深い階層より浅い階層を優先

### 3.3 rootFile の自動復帰/再検出

- Project タブの `settings-root-auto`:
  - `rootSource === "manual"` のとき表示文言は「自動に戻す」
  - `rootSource === "auto"` のとき表示文言は「再検出」
- 実行すると `rootFile` の手動指定を解除し、自動検出に戻す（`detectRoot`）

### 3.4 `%!TEX root = ...`（TeX magic）解決

ビルド/clean/lint 等で **個別ファイル**（例: アクティブな `.tex`）を指定した場合、以下を実施する:

- 対象 `.tex` の先頭 40 行を見て `%!TEX root = ...` を探す
- 見つかった場合、相対パスとして解決し（拡張子無しなら `.tex` も試す）、最大 5 段まで追跡
- ループ検出あり（同一パス再訪で打ち切り）
- ワークスペース外/非 `.tex` は拒否
- 成功すると、その最終到達点を mainFile として扱う

---

## 4) 画面レイアウト（サイドバー / タブ / 分割ビュー）

### 4.1 サイドバータブ（表示切替）

- タブ種類（TabKey）:
  - `files`, `outline`, `blocks`, `ai`, `project`, `search`, `issues`, `settings`
- 主要タブ（primary group）:
  - `files`, `outline`, `blocks`, `ai`, `issues`, `project`
- サイドバー右クリックで「表示/非表示」メニューを出せる
  - `tex64.sidebar.primaryTabs` に JSON 配列として保存
  - 最低 1 タブは残る（最後の 1 つは非表示にできない）

### 4.2 サイドバーリサイズ

- `resizer` ドラッグでサイドバーパネル幅を変更
- CSS 変数 `--sidebar-panel-width` を更新
- 制約:
  - パネル最小幅: 240
  - エディタ最小幅: 320
  - 固定サイドバー幅（タブ列）: 52

### 4.3 分割ビュー（Primary / Secondary）

- `editor-split-button` で split view の ON/OFF
- PDF を開くと自動で split view が有効化され、secondary 側で開く（条件あり）
- タブはグループ間でドラッグ移動できる

### 4.4 コンテキストメニュー（共通）

- UI は独自のコンテキストメニュー（`context-menu`）を使う
- 閉じる条件:
  - 外側クリック、`window.blur`、スクロール、リサイズ、`Escape`
- 画面内に収まるように表示位置を補正（padding 8）

### 4.5 サイドバーからのジャンプ（Primary / Secondary の使い分け）

- Search / Outline の「項目クリックによるジャンプ」は **secondary で開く**:
  - split view が OFF の場合は ON にする
  - `jumpToFileLine(path, line, "secondary", { force:true, focus:false })` で開く
    - `focus:false` のため、基本的に **入力フォーカスは奪わない**
  - line が無い場合は `requestOpenFile(path, "secondary", true)`
- Issues の「項目クリックによるジャンプ」は **現在のアクティブグループで開く**:
  - `path+line` があればその位置へジャンプ
  - `path` のみならそのファイルを開く
  - `line` のみなら現在ファイル内で該当行をハイライトしてフォーカスする

### 4.6 Settings（設定）タブ

- Settings タブ（`settings`）は「ナビ（`settings-nav`）」→「各ページ（`settings-pages`）」の 2 段階 UI
  - ナビ項目クリックで `data-settings-page="..."` のページを開く（ナビは hidden）
  - ページ内の「戻る」（`data-settings-back`）でページを閉じ、ナビへ戻る
  - ページ切替時にパネルのスクロール位置を先頭へ戻す
  - Runtime ページを開いたときは自動で環境チェックを走らせる
- ページ一覧:
  - `editor`: SyncTeX / ゴースト補完
  - `format`: latexindent の整形ルール + Blocks 用の軽量整形
  - `env`: 数式/表の環境レジストリ（検出・整形に影響）
  - `build`: コンパイルエンジン / PDF 表示 / ビルドプロファイル / clean
  - `runtime`: TeX/latexmk/latexindent/chktex/synctex の検出とインストール導線

#### 4.6.1 Settings: editor（SyncTeX / Ghost completion）

- ビルド成功時の自動 forward:
  - toggle: `editor-auto-synctex-build`
  - 保存キー: `tex64.editor.autoSynctexOnBuild`（`false` で無効）
  - legacy: `tex64.editor.autoSynctexOnPdfOpen` を読み取り、`autoSynctexOnBuild` へ移行
- reverse SyncTeX（PDF→ソース）:
  - toggle: `editor-reverse-synctex`
  - 保存キー: `tex64.editor.reverseSynctex`（`false` で無効）
  - 無効時は PDF viewer の `Ctrl/Cmd+click` を無視
- ゴースト補完:
  - toggle: `editor-ghost-completion`
  - 保存キー: `tex64.editor.ghostCompletion`（`false` で無効）
  - 無効時は関連 UI（`[data-ghost-config]`）を disabled 扱いにする（`aria-disabled` + input disabled）
  - 調整:
    - debounce: `editor-ghost-debounce`（0..2000）→ `tex64.editor.ghostCompletion.debounceMs`
    - maxChars: `editor-ghost-max-chars`（20..400）→ `tex64.editor.ghostCompletion.maxChars`

#### 4.6.2 Settings: format（latexindent ルール / 軽量整形）

- latexindent / fallback に渡す整形設定（localStorage に JSON 保存）:
  - 保存キー: `tex64.editor.formatSettings`
  - 主要項目:
    - `indentStyle`: `spaces-2` / `spaces-4` / `tab`
    - `beginEndOnOwnLine`: `\\begin/\\end` を別行にする
    - `documentNoIndent`: `document` をインデントしない
    - `alignMathDelims`: 数式環境の `&` を揃える（latexindent の alignDelims）
    - `alignTableDelims`: 表環境の `&` を揃える（latexindent の alignDelims）
    - `blankLines`: `preserve` / `condense` / `remove`
    - `customVerbatim`: 追加の verbatim 扱い環境（latexindent / fallback ともに影響）
- Blocks の軽量整形（挿入時のスニペット整形）:
  - toggle: `editor-align-env`
  - 保存キー: `tex64.editor.alignEnv`
  - legacy: `tex64.project.alignEnv.${workspaceRootKey}` を読み取り、`tex64.editor.alignEnv` へ移行
  - 影響: Blocks の挿入位置が「行頭（空白のみ）」のとき、挿入スニペットのインデント/\\begin/\\end を整える
- Custom verbatim 入力の正規化:
  - `\\begin{...}` / `\\end{...}` 形式も受け付け、`{}` や先頭 `\\` を除去
  - `*` はベース名に正規化（例: `verbatim*` → `verbatim`）
  - 重複は除去し、表示はソートされる

#### 4.6.3 Settings: env（環境レジストリ）

- 数式/表の環境を「検出対象」として管理する（Blocks の自動検出 / latexindent の alignDelims の対象に影響）
- default 環境:
  - `DEFAULT_ENV_REGISTRY`（例: `equation/align/gather/matrix/...`, `tabular/longtable/...` など）
  - 非推奨フラグ付きの環境は UI 上で「非推奨」と表示される
- custom 環境の追加:
  - 入力: `env-registry-input`（`\\begin{...}` 形式も可）
  - kind: `env-registry-kind`（`math` / `table`）
  - 追加: `env-registry-add`
  - 同名が別カテゴリ（math/table）で既に登録済みの場合は拒否
- ON/OFF:
  - 各行のトグルで enabled/disabled を切り替える（disabled は検出・整形対象から外れる）
  - custom の行は削除ボタンで削除できる（default は削除不可）
- 永続化（localStorage）:
  - `tex64.custom-env-registry`:
    - JSON / CSV / 配列 / `{ entries, math, table }` など複数形式を許容して読み取る
    - 保存は JSON（入力形式自体は保持せず、そのまま JSON.stringify される）
  - `tex64.disabled-env-registry`: disabled の環境一覧（JSON 配列）
  - legacy: `${baseKey}.${workspaceRootKey}` から baseKey へ移行
- 変更後:
  - 環境レジストリ変更により Blocks の検出状態を再評価する

#### 4.6.4 Settings: build（compile engine / build profiles / clean）

- コンパイルエンジン:
  - select: `settings-compile-engine`
  - 保存キー: `tex64.compileEngine`（`lualatex/pdflatex/xelatex/uplatex`）
- PDF 表示:
  - toggle: `editor-pdf-window`
  - 保存キー: `tex64.editor.pdfViewerMode`（checked→`window`, unchecked→`tab`）
- ビルドプロファイル（ワークスペース設定 `.tex64/settings.json`）:
  - 選択: `settings-build-profile`（`Default` + custom profiles）
  - 追加: `settings-build-profile-add`（自動生成した id で追加し active にする）
  - 削除: `settings-build-profile-delete`（確認ダイアログ）
  - 編集: `settings-build-profile-name/outdir/extra-args`
    - custom profile 選択中のみ有効
    - 入力は 320ms debounce で自動保存（UI に「保存中...」表示）
- clean:
  - `settings-build-clean`（`latexmk -c` 相当）
  - `settings-build-clean-all`（`latexmk -C` 相当）
  - 実行前に確認ダイアログ（`clean -C` は PDF も削除）

#### 4.6.5 Settings: runtime（環境チェック / インストール導線）

- Runtime ページを開くと自動で環境チェック（`env:check`）を実行
  - 再チェック: `settings-env-refresh`
- チェック対象:
  - 取得対象（内部）: `lualatex/pdflatex/xelatex/uplatex/latexmk/latexindent/synctex/chktex`
  - 表示対象: `lualatex`（TeX Distribution の代表）, `latexmk`, `latexindent`, `synctex`, `chktex`
  - TeX Distribution の表示は「いずれかの TeX エンジンが見つかったか」で判定される
- 各項目のステータス表示:
  - `確認中...` → `利用可能` / `未検出`
  - インストールボタンの文言は `インストール` / `更新/再インストール` に切り替わる
- インストール:
  - ボタン（`.env-btn`）クリックで `env:install` を送る（実行中は disabled + `インストール中...`）
  - 失敗時は alert で理由（例: brew/winget 実行失敗、ユーザーに手動実行を促す文）を表示
  - install 試行後は main 側で該当コマンドを再チェックし、ステータスを更新する

---

## 5) Files（ファイルツリー / ファイル操作）

### 5.1 ツリー表示

- フォルダ優先・名前順（`localeCompare("ja")`）
- 展開状態はワークスペース単位で保存:
  - `tex64.tree.${workspaceRootKey}`（JSON 配列）
- 選択状態:
  - ファイル/フォルダ選択を保持し、操作対象の基準になる

### 5.2 右クリックメニュー（ファイル）

- 開く
- 新しいファイル…
- 新しいフォルダー…
- Finderで表示
- 名前の変更…
- 削除（danger）

### 5.3 右クリックメニュー（フォルダ）

- 新しいファイル…
- 新しいフォルダー…
- Finderで表示
- 名前の変更…
- 削除（danger）

### 5.4 新規作成（Create modal）

- 入力例:
  - ファイル: `sections/intro.tex`
  - フォルダ: `sections`
- 入力の正規化:
  - `\\` → `/`
  - フォルダの場合は末尾の `/` を除去
- 入力検証:
  - 空欄不可
  - 絶対パス不可（`/...` や `C:/...`）
  - `..` を含むパス不可
  - ファイル名末尾 `/` 不可
- 作成はワークスペース内のみ（必要な親ディレクトリは自動作成）

### 5.5 名前変更（Rename modal）

- 同一ディレクトリ内での rename のみ（入力に `/` を含められない）
- 影響範囲に未保存がある場合はブロック:
  - 対象ファイル自身が dirty
  - 対象ディレクトリ配下に dirty なファイルが存在

### 5.6 移動（Drag&Drop / Cut-Paste）

- D&D:
  - フォルダに drop して移動
  - 自分自身/子孫への移動は不可
  - 影響範囲に dirty がある場合はブロック
- Cut/Paste（⌘X → ⌘V）でも同様に移動

### 5.7 コピー（Copy-Paste）

- Copy/Paste（⌘C → ⌘V）でコピー
- ディレクトリは再帰コピー
- 同名がある場合は失敗

### 5.8 削除（内部ゴミ箱）

- `deleteItem` は OS ゴミ箱ではなく、ワークスペース内 `.tex64/.trash` に移動する
- `.tex64/.trash` のファイル名は `<uuid>-<basename>`
- 注意:
  - Renderer の Files UI は **削除時の dirty 保護を行わない**（rename/move は保護する）

### 5.9 Undo（ファイル操作）

- `⌘Z` で `undoFileOperation`
- undo 対象:
  - move
  - delete（`.tex64/.trash` から復帰）
- undo 対象外:
  - rename
  - copy
  - create

---

## 6) エディタ（Monaco）/ タブ / 保存

### 6.1 ファイル種別と openFile

Main 側の判定（Renderer 側は推定も行う）:

- **PDF**: `.pdf` → kind=`pdf`（base64 + `application/pdf`）
- **画像**: `png/jpg/jpeg/gif/bmp/webp/svg/tif/tiff/ico` → kind=`image`（base64 + mime）
- **テキスト**: 下記の拡張子セット → kind=`text`（UTF-8 文字列）
- **その他**: kind=`unsupported`

Main 側の TEXT_FILE_EXTENSIONS（Renderer と差分あり）:

- `tex`, `bib`, `sty`, `cls`, `bst`, `bbx`, `cbx`, `cfg`, `def`, `lbx`, `ins`, `dtx`, `ltx`,
  `aux`, `bbl`, `blg`, `log`, `out`, `toc`, `lof`, `lot`, `fdb_latexmk`, `fls`

Renderer 側の TEXT_FILE_EXTENSIONS（`txt` を含む）:

- 上記 + `txt`

### 6.2 Monaco 設定（主要）

- `fontSize: 12`, `lineHeight: 20`
- `minimap: false`
- `wordWrap: off`
- `quickSuggestions: false`（勝手に候補を出しにくい設定）
- `inlineSuggest.enabled`: ゴースト補完 ON/OFF に連動
- IME 対策:
  - `compositionend` で `data===""` のとき、直前の compositionText を復元挿入

### 6.3 タブ管理

- タブは各ペインで独立
- タブを閉じる:
  - 現在タブを閉じると、隣のタブへ移動（最後なら空状態）
- タブのドラッグ移動:
  - `application/x-tex64-tab` で primary ↔ secondary 間移動

### 6.4 “temporary tab” の自動整理

- `PINNED_TAB_EXTENSIONS` に含まれないタブは **開き替えのタイミングで自動削除**されうる
- `PINNED_TAB_EXTENSIONS`:
  - LaTeX 系 (`tex/sty/cls/ltx/dtx/ins/bbx/cbx/cfg/def/lbx/bst`) + `bib` + `pdf`
- 注意:
  - 実装上、pinned であっても「dirty なタブ」は openTabs から除外される（自動保存が速い前提だが、タイミング次第で発生し得る）

### 6.5 保存（manual/auto）

- `save-file-button` または `⌘S`（metaKey のみ）で保存
- 自動保存:
  - 変更から 400ms 後に保存（dirty & pendingSave 無しの場合）
  - 保存中に変更が積まれた場合は autoSavePending として次の保存を予約
- 保存失敗時:
  - Issues にエラーを追加
- 形式:
  - UTF-8 前提（Main 側は UTF-8 以外のデータを検出するとエラー）

---

## 7) 入力支援（Completion / Hover / Ghost completion）

### 7.1 Completion（参照/引用/パス/環境）

- `\\ref` 系:
  - `\\ref{`, `\\eqref{`, `\\pageref{`, `\\autoref{`, `\\cref{`, `\\Cref{`, `\\namecref{` 等
  - 候補は Indexer の `labels` から供給
- `\\cite` 系:
  - `\\cite{`, `\\citet{`, `\\citep{`, `\\autocite{`, `\\parencite{` 等
  - `\\cite[...]{...}` のようなオプション付きも対応
  - 候補は Indexer の `citations`（`.bib` 由来を含む）から供給
- `\\input{}` / `\\include{}`:
  - ワークスペース内 `.tex` を、アクティブファイル基準の相対パスで補完
  - 拡張子は省略して挿入（入力側が拡張子を明示した場合は維持）
- `\\includegraphics{}`:
  - `png/jpg/jpeg/pdf/svg/eps/tif/tiff` を補完
  - アクティブファイル基準の相対パス
- `\\begin{}`:
  - figure/table/align/itemize などのスニペットを展開（プレースホルダ付き）
- 候補ナビゲーション:
  - Suggest Widget 表示中、`Tab` で次候補、`Shift+Tab` で前候補に移動
  - 確定は `Enter`
- 表示頻度:
  - quick suggestions を有効化（低遅延）
  - 補完候補は LaTeX 文脈を優先（汎用語彙候補は抑制）

### 7.2 Hover（ref/cite/画像/数式）

- `\\ref` 系:
  - 定義候補（Index labels）を表示
  - `file:excerpt` で該当箇所の抜粋を表示
  - `tex64://view-on-pdf?...` のリンク（View on PDF）を出す
- `\\cite` 系:
  - `.bib` から title/author/year 等を抽出し、抜粋を表示
- `\\includegraphics`:
  - `file:preview` で画像プレビュー（2MB 制限）
- インライン数式:
  - `$...$`, `\\(...\\)`, `\\[...\\]` を解析してプレビュー
  - unescaped `%` 以降はコメントとして除外
  - MathLive が利用できる場合 `convertLatexToMarkup` で描画

### 7.3 Ghost completion（ゴースト補完）

- 有効/無効: `tex64.editor.ghostCompletion`（デフォルト有効）
- 調整:
  - debounce: `tex64.editor.ghostCompletion.debounceMs`（0..2000, default 120）
  - maxChars: `tex64.editor.ghostCompletion.maxChars`（20..400, default 140）
- ローカル補完:
  - 括弧閉じ、`\\begin{}`→`\\end{}`、短いテンプレなど
- リモート補完（Gemini 経由）:
  - 条件: prefix>=10、suffix空、idle>=550ms、cooldown 3s、12回/分
  - 抑制条件: コメント行（unescaped `%` 以降）と `\command` 入力中は送信しない
  - 結果は短い 1 行の継続テキストのみ（prefix を繰り返さない）
  - ポジティブ/ネガティブキャッシュあり

---

## 8) Viewer（画像 / PDF / 非対応）

### 8.1 共通

- Viewer が表示中は editor host を隠し、Viewer を前面にする
- base64 を Blob URL に変換して表示（表示切り替え時に URL を revoke）

### 8.2 PDF viewer（タブ内）

- iframe に `pdf-viewer.html` をロードし、親から open/sync を postMessage
- iframe は ready を返し、reverse（Ctrl/Cmd+click）で `page/x/y/path` を返す

### 8.3 PDF viewer（別ウィンドウ）

- `tex64.editor.pdfViewerMode` が `window` の場合、build 成功時や forward 時に別ウィンドウを使用
- window は open/sync をキューでき、ready 受信後に flush
- open URL は `file://...?.t=<timestamp>` でキャッシュバスト

### 8.4 PDF viewer 機能（pdf-viewer.html / pdf-viewer.js）

- ページ移動（prev/next, page input）
- ズーム:
  - `Ctrl/Cmd + wheel` でズーム（0.4..3）
  - ピンチズーム（2 本指）
  - fit width / fit page / 手動倍率
- 回転（左/右）
- 検索（input + prev/next）
- Outline / Thumbnails のサイドバー（表示/非表示、タブ切替）
  - `tex64.pdf.sidebarVisible`, `tex64.pdf.sidebarTab`
- 反転（invert）
  - `tex64.pdf.invert`
- Download / Print / Reload（cache bust）
- Sync マーカー:
  - forward の座標にスクロールし、マーカーを 1400ms 表示
- Reverse SyncTeX:
  - `Ctrl/Cmd + click` で reverse（`tex64.editor.reverseSynctex` が `false` でない場合）

---

## 9) Build / Clean / Lint

### 9.1 Build（latexmk）

- 実行トリガ:
  - `build-button`（クリック）:
    - アクティブエディタが dirty の場合は `saveCurrentFile()` を先に実行し、成功時だけ build
  - `Ctrl/Cmd + B`（keydown）:
    - 保存を強制せず build（既知事項参照）
- mainFile の決定（Renderer → Main）:
  - 優先: `rootFile`（Project タブで設定された main）
  - 無い場合: アクティブファイルが `.tex` のときはそれ
- Build リクエスト（Renderer → Main）:
  - `build` に以下を含めて送る:
    - `mainFile`（任意）
    - `engine`（`tex64.compileEngine`, default `lualatex`）
    - `pdfViewerMode`（`tex64.editor.pdfViewerMode`: `window/tab`）
    - `formatSettings`（Settings の整形設定 + env registry を束ねた payload）
  - `format: true` の場合のみ、build 前に main file を format する（通常 UI からは送られない）
- Main 側の targetFile 解決:
  - `rootFile` があればそれ、無ければ `main.tex`
  - `mainFile` が `.tex` の場合は `%!TEX root = ...` を最大 5 段追跡して root を解決（3.4）
- build profile（`.tex64/settings.json`）:
  - `buildProfileId` が指すプロファイルの `outDir/extraArgs` を使用
  - `extraArgs` はクォート/バックスラッシュを考慮して分割し latexmk に渡す
  - outDir の決定:
    - `extraArgs` に `-outdir=...` または `-outdir ...` があればそれを優先（明示 outDir）
    - それが無い場合は profile の `outDir`、それも無い場合は `mainFile` のディレクトリを採用
  - outDir 制約:
    - 相対パスのみ / 絶対パス不可 / `.` は無効 / ワークスペース外へ逸脱するパスは無効
    - 明示指定（profile outDir または `-outdir`）なのに不正な場合は build を失敗させ、Issues に `outDir が不正です。` を出す
    - `-outdir` が extraArgs に含まれている場合、latexmk 呼び出し側で `-outdir=...` を重複付与しない
- 実行コマンド（概略）:
  - `latexmk -g <engineFlag> -synctex=1 -interaction=nonstopmode -halt-on-error -file-line-error [outDir/extraArgs] main.tex`
- 結果の反映:
  - build log は `issues-log` の details に表示（無いときは hidden）
  - 成功時のみ `lastBuildPdfPath` を更新し、PDF を開く
    - `tab`: PDF がワークスペース内相対にできる場合はタブ（iframe）で開く。できない場合は window にフォールバック
    - `window`: 別ウィンドウで開く
  - 失敗時:
    - build state を `failed` にし、error Issues が到着したタイミングで Issues タブへ自動フォーカスする
- Issues 抽出:
  - 最大 20
  - `!`/`LaTeX Error` を error、`Warning` を warning として拾う
  - `file.tex:line[:column]` の形があれば location を推定
- TeX 環境不足:
  - latexmk 等が見つからない場合は action=`open-runtime`（Runtime 設定への導線）

### 9.2 Clean（latexmk -c/-C）

- 実行トリガ:
  - Settings（Build ページ）から `clean` / `clean -C` を実行（確認ダイアログあり）
- 対象ファイル解決:
  - build と同様に `rootFile` / `mainFile` / `%!TEX root` を考慮して決める
- build profile の outDir/extraArgs を反映して実行する
- 結果:
  - 成功: Issues を `success`（`clean 完了` / `clean（全削除）完了`）
  - 失敗: error Issues
  - latexmk 未導入: action=`open-runtime`

### 9.3 Lint（ChkTeX）

- 実行トリガ:
  - `lint-button`:
    - dirty の場合は保存してから実行
    - mainFile は `rootFile` があればそれ、無ければアクティブファイル
- コマンド:
  - `chktex -q -v3 <target.tex>`
- 結果:
  - 最大 80 warning を Issues 化（severity=warning）
  - chktex 未導入: action=`open-runtime`

---

## 10) Format（latexindent + fallback）

### 10.1 手動整形（Renderer）

- `format-button`:
  - 現在ファイル（active group）の内容を取り出し、`formatFile` を送る（`.tex` のみ）
  - format 中は多重実行を抑止し、必要なら 1 回だけ pending を積む
- `formatResult` の反映:
  - 成功時:
    - 同じファイルを開いているすべての editor group に整形結果を適用する
    - アクティブグループ側のファイルが dirty の場合は、そのまま保存まで行う
  - 失敗時:
    - warning を 1 回だけ Issues に表示（Renderer 側 `formatWarningShown`）
- Blocks の「format preview」（Diff 用の全体整形プレビュー）も `formatFile` を使う
  - timeout: 15s、遅延結果は 30s 無視（ignore）

### 10.2 latexindent（Main）

- 対象: `.tex` のみ（それ以外は `skipped` 扱いで素通し）
- 作業ディレクトリ:
  - `<root>/.tex64/.format`
- 設定ファイル:
  - base: `Resources/latexindent.yaml`
  - override: `latexindent.override.yaml`（formatSettings から動的生成）
- 実行（概略）:
  - `latexindent -m -w -c <tempDir> -l=<base>,<override> <temp.tex>`
  - 終了後に temp / `.bak*` / override / `indent.log` を削除する
- override の主なマッピング:
  - `indentStyle` → `defaultIndent`（2/4/tab）
  - `documentNoIndent` → `noAdditionalIndent.document`
  - `beginEndOnOwnLine` → `modifyLineBreaks.environments.*`（Begin/Body/End の改行ルール）
  - `blankLines` → `modifyLineBreaks.preserveBlankLines` / `condenseMultipleBlankLinesInto`
    - preserve: (1, 0) / condense: (1, 1) / remove: (0, 0)
  - `alignMathDelims` / `alignTableDelims` → `lookForAlignDelims`
    - 対象環境は `alignEnvs.math/table` を使い、`*` 付きも展開する
  - `customVerbatim` → `verbatimEnvironments`（既定 verbatim + custom + `*` も含める）
- 追加ポストプロセス:
  - latexindent の成否に関わらず、**math 環境内の空行を除去**する（verbatim 内は除外）

### 10.3 fallback（latexindent 不在/失敗）

- `latexindent` が見つからない / 設定テンプレが読めない / 実行が失敗した場合:
  - begin/end トークンに基づく簡易インデント（verbatim 環境内は変更しない）
  - math 環境内の空行除去（verbatim は除外）
  - warning 文言を返す（Main 側は 1 回だけ Issues に表示し、必要なら action=`open-runtime`）

---

## 11) SyncTeX（forward / reverse）

### 11.1 forward（TeX→PDF）

- `synctex-button` / build 成功後の自動 forward で実行
- 対象:
  - overridePath があればそれ
  - なければ currentFilePath
  - `.tex` のみ（それ以外は warning）
- line/column:
  - エディタの現在位置、または保存済みのカーソル位置（無ければ 1:1）
- リトライ:
  - retryable（「位置情報」「解析に失敗」）なら 200ms 間隔で最大 3 回
- backtrack:
  - 指定行が空行/コメント行の場合や retryable 失敗時、最大 160 行上へ戻って再試行
- 最終フォールバック:
  - 許可されていれば 1 行目へ（`fallbackToTop`）
- viewerMode:
  - window: Main が PDF window を表示して sync を queue
  - tab: Renderer が PDF タブを開き、iframe に sync を送る

### 11.2 reverse（PDF→TeX）

- PDF 上で `Ctrl/Cmd + click`（reverseSynctexEnabled が true のとき）
- 候補収集:
  - `synctex edit` を 5x5 オフセット格子（-8..8）で実行し、`path:line:col` を集計
- 候補選択:
  - forward を呼んで click までの距離を測り、`distance + medianDiff - count*4` でスコア化
  - confidence 推定と scoreGap を返す
- refine:
  - ±3 行を forward distance で再評価して最良の行へ補正

---

## 12) Outline

- データは Indexer 由来（labels/citations/sections/todos）
- 表示カテゴリ:
  - Sections（章立て）
  - Todos
  - Labels
  - Citations
- モード（`tex64.outline.mode`）:
  - current（デフォルト）:
    - アクティブファイルのみ
    - Sections は章番号（`1章 1.1節 ...` 相当）を付けてインデント表示
  - project:
    - 全ファイル
    - 各項目に `path:line` を併記
- クリック時のジャンプ:
  - `path+line` にジャンプする場合、split view を ON にして secondary 側で開く（`focus:false`）
- 空表示文言:
  - ワークスペース未選択/ファイル未選択/項目無しで表示が変わる

---

## 13) Search

### 13.1 検索

- ワークスペース内 `.tex` のみ
- 大小無視（toLowerCase）
- 最大 200 結果
- UI はファイルごとにグルーピング表示
- 実行:
  - Search ボタン / `Enter` で `search` を送る
  - query が空なら「検索語を入力してください。」、未選択なら「ワークスペースが未選択です。」
  - 実行中は「検索中...」表示
- ジャンプ:
  - 検索結果クリックで secondary 側に `path:line` を開く（split view を自動 ON）

### 13.2 シンボル一括リネーム（Search 内）

- 対象:
  - label/ref
  - cite（`.bib` を含む）
- 入力検証:
  - from/to 必須
  - 同一キー不可
  - 空白/カンマ/`{}` 不可
  - 対象（ラベル/参照・引用）のいずれかを選択必須
- 実行:
  - `search:renameSymbol`（`from/to/kinds/context/conversationId`）→ Main が `rename_latex_symbol` を実行
  - 未保存がある場合は、適用段階でブロックされ得るため事前に保存が必要
  - 結果は `search:renameResult` で返り、AI パネルで確認可能

---

## 14) Issues

- Issues リスト:
  - severity, location, message, resolution（テンプレ）、ヒント行
  - action=`open-runtime` の場合はクリックで Runtime 設定を開く
  - location が無い場合は disabled（移動できない）
- Issue のマージ:
  - build/lint/format/save 等の Issues（base）+ Duplicate label warning を重ね、重複を除去して表示する
  - 1 つでも error があると status=`error`、無ければ `info` / `success`
  - status=`error` のとき Issues タブに `is-alert` を付けて強調する
- ジャンプ:
  - `path+line` がある場合はその位置へ移動
  - `path` のみならファイルを開く
  - `line` のみなら現在ファイル内で該当行をハイライトしてフォーカスする
    - warning: `issue-line-warning`
    - error: `issue-line-highlight`
  - Issues が 0 件になったときは、残っている issue highlight をクリアする
- ビルド失敗時の自動フォーカス:
  - build state が `failed` になると「次に error Issues が来たタイミング」で自動的に Issues タブを開く
- Duplicate label 検知:
  - 同一 `\\label{key}` が複数ある場合 warning を生成（最大 80）
- Build log:
  - `issues-log` の details に表示（ログがないときは隠す）

---

## 15) Blocks（数式支援）

### 15.1 概要（insert / edit）

- 対象は math ブロックのみ（`BlockType="math"`）
- `.tex` ファイルでのみ挿入/編集できる（それ以外は Issues エラー）
- 主要 UI:
  - `block-mode-toggle`: 挿入/編集モード切替
  - `block-insert-button`: 確定（Diff modal を開く）
  - `block-format-button` / `block-format-menu`: 挿入形式（mode）選択
  - `block-settings-button`: Blocks 設定（wrap / WYSIWYG）
  - `block-suggest-button`: 候補（WYSIWYG / 行列 ops）
  - `block-capture-button`: 画面キャプチャ / OCR

### 15.2 edit モードと自動検出（detected）

- edit モードに入ると（`block-mode-toggle`）:
  - アクティブ editor が `.tex` でない場合は insert に戻る
  - 現在カーソル位置で検出を強制し、必要なら Blocks タブへ自動で切り替える
- 検出トリガ:
  - edit モード中のカーソル移動で 150ms debounce して再検出
  - env registry の更新など、明示 refresh で再検出
- 検出対象:
  - `$...$`, `$$...$$`, `\\(...\\)`, `\\[...\\]`
  - `\\begin{...}` ... `\\end{...}`（env registry + ヒューリスティックで math 判定）
- 除外:
  - コメント: unescaped `%` 以降は無視
  - raw env: `verbatim/Verbatim/lstlisting/minted` 内はスキップ
- env 判定（`\\begin{...}`）:
  - `DEFAULT_ENV_REGISTRY` + Settings: env（custom/disabled）
  - 追加で「名前ヒント」（`math/eqn/equation/align/gather/multline/matrix/cases/split/subeq/array/formula` を含む）でも math とみなす
  - disabled の base 名は検出対象外
- 検出状態の表現:
  - インラインハイライト + グリフ（gutter）で検出位置を表示
  - snapshot（start/end/snippet/modelVersion）を持ち、ズレたら再同期する
- `Escape`:
  - edit モード中に `Escape` で insert モードへ戻る

### 15.3 数式入力（MathLive / fallback）

- MathLive が利用可能な場合:
  - `<math-field>` による WYSIWYG 入力
  - placeholder 移動、行列編集コマンド等を利用する
- MathLive が利用できない場合:
  - テキスト入力（textarea）で数式文字列を扱う

### 15.4 挿入形式（mode / wrap）

- insert mode（保存キー `tex64.math-insert-mode`）:
  - `inline` / `display` / `align` / `gather` / `none`
  - UI:
    - `block-format-button` に短縮ラベル（INL/DSP/ALN/GTH/RAW）を表示
    - `block-format-menu` の option クリックで変更
- wrap 設定:
  - inline wrap（`tex64.math-insert-inline-wrap`）:
    - `inline-dollar` → `$...$`
    - `inline-paren` → `\\(...\\)`
  - display wrap（`tex64.math-insert-display-wrap`）:
    - `display-bracket` → `\\[...\\]`
    - `display-dollar` → `$$...$$`
  - legacy:
    - `tex64.math-insert-format` を読み取り互換（mode/wrap に振り分け）
- 実際のスニペット生成:
  - edit 中（BlockContext がある）場合は、元の wrapper を保って再構成する
  - 入力値が既に wrapper を含む場合（`$...$`, `\\(...\\)`, `\\[...\\]`, `$$...$$`, `\\begin{...}`）はそのまま採用
  - mode ごとの既定:
    - `align` → `\\begin{align*}` ... `\\end{align*}`（改行を含む）
    - `gather` → `\\begin{gather*}` ... `\\end{gather*}`
    - `none` → 囲まずに挿入（RAW）

### 15.5 挿入位置解決と軽量整形（alignEnv）

- new（insert）時の挿入位置:
  - selection が「空行 1 行の line selection（startColumn=1, endColumn=1, endLine=startLine+1）」のとき:
    - その空行範囲を insertRange として置換する（空行優先）
  - それ以外:
    - 現在のカーソル位置へ挿入する
- 軽量整形（Settings: `tex64.editor.alignEnv`）:
  - 挿入位置が「行頭（空白のみ）」の場合に限り、スニペットを周辺インデントに合わせて整形する
  - env/display wrapper の場合は `\\begin/\\end` と内側行のインデントを揃える

### 15.6 Diff modal と format preview（全体整形→差分抽出）

- `block-insert-button`（確定）を押すと、**必ず Diff modal** を開いて確認する（即時編集しない）
- 差分の作り方（可能なら精密に）:
  - まず「挿入後のファイル全体」を仮に作り、`formatFile`（silent）で整形プレビューを要求
  - 成功した場合:
    - 元ファイルと整形後ファイルの「変化がある最小範囲」を抽出し、その範囲だけを Diff modal に出す
    - 実適用もその範囲を置換する（replaceRange/replaceSnippet）
  - 失敗/タイムアウト時:
    - スニペットレベル（または検出ブロック置換）の diff を表示する
- タイムアウト:
  - format preview は 15s でタイムアウトし、遅延結果は 30s 無視する

### 15.7 適用（Diff modal Submit）と履歴

- Diff modal の Submit:
  - pending の `PendingBlockApply` に基づいて editor に apply（`executeEdits("block-insert", ...)`）
  - detected（edit）時は、現在内容が snapshot と一致する場合のみ置換（ずれていたら中断）
- 適用後:
  - `blocks:save`（silent）で履歴を `.tex64/blocks.json` に追記
    - entry: `file/snippet/content/mode/createdAt`
    - 現状、履歴は追記のみ（サイズ上限なし）
  - 最後に `formatFile` を `source="blockInsert"` で要求し、ファイル全体を整形する

### 15.8 サジェスト（Math WYSIWYG）と主要ショートカット

- `block-suggest-button`:
  - WYSIWYG 候補（明示サジェスト）を開く
  - 行列内などで候補が無い場合は matrix ops パレット（+row/+col/-row/-col）を開く
- WYSIWYG の挙動（MathLive 使用時）:
  - 入力に応じて自動候補（autoSuggest）が出る（設定で ON/OFF）
  - 候補パネル中:
    - `ArrowUp/Down` で選択
    - `Enter` で適用（修飾キー付き Enter は除く）
    - `Space` で候補再生成
    - `Escape` で閉じる
- Mathfield ショートカット:
  - `/`（修飾なし）:
    - selection がある場合は `\\frac{<sel>}{□}` で wrap を試みる（失敗時は `/` を挿入）
  - `Tab` / `Shift+Tab`:
    - placeholder を前後に移動
  - `Enter`:
    - 行列内なら `addRowAfter` 相当（できない場合は通常入力へ）
  - `Ctrl/Cmd+Enter`:
    - 行列内なら `addColumnAfter` 相当、できない場合は submit（確定）扱い
  - `Ctrl + .`:
    - 明示サジェスト、または行列 ops パレットを開く
  - `Escape`:
    - サジェストを閉じて blur（edit モード中なら最終的に insert に戻る）
- WYSIWYG 設定（localStorage）:
  - `tex64.math-wysiwyg.autoSuggest`（ON/OFF）
  - `tex64.math-wysiwyg.packs`（有効パック）
  - `tex64.math-wysiwyg.mru` / `tex64.math-wysiwyg.mru.${rootKey}`（最近使った候補、最大 200）
  - packs: `core/math/physics/cs/personal/jp`

### 15.9 数式キーボード

- 表示条件: Blocks タブがアクティブ & ブロック種別が math のときのみ表示
- タブ: `sets` / `logic` / `arrows`
- Shift:
  - `math-keyboard-shift` クリックでロック
  - 物理 Shift キー押下中は hold（blur で解除）
  - hold または lock のとき、キーの shift 版（label/latex/template/script 等）を使う

### 15.10 Blocks 設定（modal）

- 開閉:
  - 開く: `block-settings-button`
  - 閉じる: `block-settings-close` / 背景クリック / `Escape`
- ページ構成:
  - menu: `data-block-settings-target` で `insert-format` / `suggestions` に遷移
  - back: `data-block-settings-back` で menu に戻る
- insert-format（wrap）:
  - inline:
    - `inline-dollar` / `inline-paren`（`tex64.math-insert-inline-wrap`）
  - display:
    - `display-dollar` / `display-bracket`（`tex64.math-insert-display-wrap`）
- suggestions（WYSIWYG）:
  - 自動サジェスト: `tex64.math-wysiwyg.autoSuggest`
  - packs: `tex64.math-wysiwyg.packs`（`core` は常に有効で、それ以外をトグル）
- 挿入形式メニュー（`block-format-menu`）:
  - `block-format-button` で開閉し、外側クリック / `Escape` で閉じる

---

## 16) 画面キャプチャ / OCR

### 16.1 ウィンドウ選択（window picker）

- `block-capture-button` で開始
- window/screen のサムネイル一覧を表示（検索で絞り込み可能）
  - 取得は `tex64:capture:getSources`（desktopCapturer）相当
  - thumbnailSize: `3840x2160`
- 操作:
  - 項目クリックで選択 → cropper を開く
  - `Escape` / キャンセルで window picker を閉じる

### 16.2 切り取り（cropper）

- 初期状態:
  - 選択範囲は「無し」（selection が小さい間はガイドを非表示）
  - 未選択のまま適用した場合は「画像全体」を OCR 対象にする
- マウス/ペン操作:
  - 空白ドラッグ: 新規選択を作成
  - 選択範囲ドラッグ: 移動
  - 四隅ハンドル（tl/tr/bl/br）ドラッグ: リサイズ
- キーボード:
  - `Enter`: 適用
  - `Escape`: 選択範囲がある場合はクリア（画面は閉じない）
- Retry:
  - 「戻る/Retry」は window picker に戻らず、フロー自体を閉じる

### 16.3 OCR パイプライン

- Renderer 前処理:
  - α（透過）または輝度からマスクを作り、bbox を推定して余白付きで crop
  - 低コントラスト時は強めに補正し、`384x384` にリサイズ
  - Float32（CHW）へ正規化して `tex64:math-ocr:run` に渡す（`mean=0.5, std=0.5`）
- Main 推論:
  - ONNX（pix2tex: encoder/decoder/tokenizer）を優先（onnxruntime-node, CPU）
  - 出力後にスペース/トークン除去や matrix/binom 正規化を行う
  - 出力が空/garbage/失敗の場合:
    - tesseract.js にフォールバック（whitelist 付き、単純式のみ採用）
    - confidence が十分（目安 70 以上）で、短い式（長さ <=24）に限り採用する

### 16.4 エラーハンドリング

- 画面収録権限や API 不在などで失敗した場合は Issues に原因を表示する
- capture 開始時、現在の Issues が「キャプチャ関連のみ」の場合はクリアしてから開始する

---

## 17) AI（AIアシスタント）

### 17.1 画面構成（List view / Chat view）

- AI パネル（`ai-panel`）は「チャット一覧（list）」と「チャット画面（chat）」の 2 段階
  - list: `ai-chat-list` にチャット行を描画（最新 3 件、展開/折りたたみあり）
  - chat: `ai-chat` にメッセージログ（`ai-chat-log`）+ 提案一覧（`ai-proposals`）を表示
  - chat view ではツールバー（戻る/タイトル/モード/次へ/停止）を動的に挿入する
- チャット一覧:
  - 最新 3 件（新しい順）を表示
  - 「すべて表示（N）」で展開、「閉じる」で折りたたみ
  - リネーム（ペン）/ 閉じる（×。チャットが 2 件以上のときのみ）

### 17.2 送信/ストリーミング/状態表示

- 入力:
  - `Enter` で送信、`Shift+Enter` で改行
- 送信:
  - `agent:run`（`message` + `conversationId` + `context`）
  - list view から送信した場合は新しいチャットを自動作成して chat view に切り替える
- ストリーミング:
  - `agent:messageDelta` を逐次反映し、最後に `agent:message` で確定する
- 状態表示（`ai-status`）:
  - 実行中の chat のみ表示し、それ以外は空にする
  - 別チャットが実行中の場合は「他のチャットが応答中です...」を表示する

### 17.3 モード（論文 / 自律 / 次へ / 停止）

- モード:
  - general / paper: `tex64.ai.mode`（`paper` のとき「論文モード」）
  - autopilot: `tex64.ai.autopilot`（`1`/`0` で保存）
- Next:
  - 「続けてください。次の小さな変更提案を 1 つだけ…」の固定メッセージを送る
  - paper モードでは文面が論文向けになる
- Stop:
  - `agent:abort`（silent）
- autopilot の続行条件:
  - proposal を適用し、**提案が空になった**タイミングで自動的に Next を送る
  - 「適用して次へ」ボタンは autopilot の ON/OFF に関わらず続行を要求する

### 17.4 context（AI に渡す情報）

- `agent:run` の `context` に以下を付与:
  - アクティブファイル内容（`activeFilePath/content/isDirty/...`）
    - 上限は agent settings の `openFileMaxChars`（<=0 なら無制限）、未設定なら 12000 chars
    - truncate した場合は `activeFileContentTruncated`/`activeFileContentLength` を付与
  - 開いているファイル一覧と（必要なら）スナップショット（`openFiles/openFileSnapshots`）
  - 最近の Issues（最大 5）:
    - `severity/message/path/line/column/action` + `resolution`（テンプレ）
    - `recentIssuesUpdatedAt` を ISO で付与
  - `agentMode`（general/paper）

### 17.5 提案（proposal）と UI

- `agent:proposal` で proposal を受け取り、カードとして `ai-proposals` に表示
- proposal 種別（代表）:
  - `new` / `write` / `patch`
  - `delete`（danger）
  - `rename`
  - `mkdir`
  - `isBinary=true`（差分省略）
- プレビュー:
  - テキスト差分は diff modal を優先（使えない場合はカード内の行差分表示）
  - `rename/mkdir/binary` は「詳細を見る」扱いでカード内に注記を出す
- 適用:
  - カードの「適用」→ `agent:apply`
  - 「適用して次へ」→ `agent:apply` + continueAfterApply をセット
  - diff modal 経由の場合:
    - diffContext を `aiApply` にして pending proposalId を保持し、Submit で `agent:apply` を実行
    - Cancel は pending をクリアする
- 適用結果:
  - `agent:applyResult`（ok）:
    - proposal を UI から除去し、「適用完了: <path>」を system message で追加
    - 必要なら 120ms 後に Next（autopilot / 適用して次へ）
  - `agent:applyResult`（fail）:
    - 「適用失敗: ...」を system message で追加

### 17.6 設定/永続化/通信

- agent settings:
  - userData `tex64-user-settings.json`（例: `temperature/maxOutputTokens/maxIterations/stream/autoApply/autoBuild/openFileMaxChars`）
  - Renderer は `agent:settings` を受けて一部挙動（context 上限など）に反映する
- API usage:
  - userData `tex64-api-usage.json`
- proxy URL:
  - `TEX64_AI_PROXY_URL`（無ければ `https://tex64.vercel.app/api/ai-chat`）
- Settings の request/response（AI からアプリ設定参照/更新）:
  - Main → Renderer: `settings:request`（3s timeout）
  - Renderer → Main: `settings:response`（silent）

---

## 18) 永続化（localStorage / .tex64 / userData）

### 18.1 localStorage（キー一覧）

| key | 役割 |
|---|---|
| `tex64.sidebar.primaryTabs` | サイドバー主要タブの表示/非表示 |
| `tex64.tree.${workspaceRootKey}` | ファイルツリーの展開状態（ワークスペース単位） |
| `tex64.outline.mode` | Outline モード（current/project） |
| `tex64.compileEngine` | ビルドエンジン |
| `tex64.editor.autoSynctexOnBuild` | ビルド成功後の自動 forward |
| `tex64.editor.reverseSynctex` | reverse SyncTeX 有効/無効（`false` で無効） |
| `tex64.editor.pdfViewerMode` | PDF 表示（window/tab） |
| `tex64.editor.ghostCompletion` | ゴースト補完 ON/OFF |
| `tex64.editor.ghostCompletion.debounceMs` | ゴースト補完 debounce |
| `tex64.editor.ghostCompletion.maxChars` | ゴースト補完 maxChars |
| `tex64.editor.alignEnv` | Blocks 挿入時の軽量整形（環境整形） |
| `tex64.editor.formatSettings` | editor format 設定（JSON） |
| `tex64.custom-env-registry` | 環境登録（custom） |
| `tex64.disabled-env-registry` | 環境登録（disabled） |
| `tex64.math-insert-mode` | Blocks: 挿入モード |
| `tex64.math-insert-inline-wrap` | Blocks: inline wrap |
| `tex64.math-insert-display-wrap` | Blocks: display wrap |
| `tex64.math-wysiwyg.autoSuggest` | Math WYSIWYG: 自動サジェスト |
| `tex64.math-wysiwyg.packs` | Math WYSIWYG: 有効パック |
| `tex64.math-wysiwyg.mru` / `tex64.math-wysiwyg.mru.${rootKey}` | Math WYSIWYG: 最近使った候補 |
| `tex64.ai.mode` | AI: general/paper |
| `tex64.ai.autopilot` | AI: autopilot |
| `tex64.pdf.invert` | PDF viewer: 反転 |
| `tex64.pdf.sidebarVisible` | PDF viewer: サイドバー表示 |
| `tex64.pdf.sidebarTab` | PDF viewer: outline/thumbs |
| `tex64.editor.autoSynctexOnPdfOpen` | legacy（読み取り/移行） |
| `tex64.project.alignEnv.${workspaceRootKey}` | legacy（読み取り/移行） |
| `tex64.math-insert-format` | legacy |

### 18.2 ワークスペース内 `.tex64/`

| path | 役割 |
|---|---|
| `.tex64/settings.json` | `rootFile`, `buildProfiles`, `buildProfileId` |
| `.tex64/blocks.json` | Blocks の履歴 |
| `.tex64/.trash/` | deleteItem の退避先（Undo 復帰元） |
| `.tex64/.format/` | latexindent の一時ファイル置き場 |

### 18.3 userData

| file | 役割 |
|---|---|
| `tex64-user-settings.json` | agent settings |
| `tex64-api-usage.json` | API usage 集計 |

---

## 19) 既知の不整合 / 注意点（挙動として記録）

- `.txt` の扱い不一致:
  - Renderer の TEXT_FILE_EXTENSIONS には `txt` があるが、Main の openFile 判定には無い → `.txt` が `unsupported` になり得る
- AI の `delete` は恒久削除:
  - Files タブの delete は `.tex64/.trash` だが、AI proposal `delete` の apply は `unlink`（Undo 不可）
- Diff modal の `submitLabel` が反映されない:
  - `showDiffModal(..., { submitLabel })` が設定しても直後にデフォルトへ戻される
- `Ctrl/Cmd + B` は dirty 保存を強制しない:
  - Build ボタンは dirty のとき `save → build` だが、ショートカットは `buildOps.startBuild()` を直呼び
- Files タブの delete は dirty 保護が無い:
  - rename/move は dirty をブロックするが、delete はブロックしない
- openInTerminal は Main に実装があるが、Renderer UI から呼ばれていない

---

## 付録A) UI 契約（DOM id 一覧）

**`Resources/web/index.html` の id（158個）**

```
ai-chat
ai-chat-list
ai-chat-log
ai-input
ai-panel
ai-proposals
ai-send
ai-status
block-capture-button
block-diff-container
block-format-button
block-format-menu
block-insert-button
block-math-input-container
block-mode-toggle
block-settings-button
block-settings-close
block-settings-modal
block-settings-title
block-suggest-button
build-button
context-menu
context-menu-panel
create-modal
create-modal-cancel
create-modal-help
create-modal-input
create-modal-label
create-modal-parent
create-modal-submit
create-modal-subtitle
create-modal-title
diff-file-name
diff-modal
diff-modal-cancel
diff-modal-submit
diff-modal-title
diff-summary
editor
editor-align-env
editor-auto-synctex-build
editor-fallback
editor-fallback-secondary
editor-format-align-math
editor-format-align-table
editor-format-begin-end
editor-format-blank-lines
editor-format-document-noindent
editor-format-indent
editor-format-verbatim-add
editor-format-verbatim-hint
editor-format-verbatim-input
editor-format-verbatim-list
editor-ghost-completion
editor-ghost-debounce
editor-ghost-max-chars
editor-groups
editor-pdf-window
editor-reverse-synctex
editor-secondary
editor-split-button
editor-tabs
editor-tabs-list
editor-tabs-list-secondary
editor-tabs-secondary
editor-viewer
editor-viewer-image
editor-viewer-image-secondary
editor-viewer-message
editor-viewer-message-secondary
editor-viewer-pdf
editor-viewer-pdf-secondary
editor-viewer-secondary
env-registry-add
env-registry-hint
env-registry-input
env-registry-kind
env-registry-math
env-registry-table
file-tree
format-button
issues-empty
issues-list
issues-log
issues-log-content
issues-tab
launcher
launcher-create
launcher-open
launcher-status
launcher-status-spinner
launcher-status-text
lint-button
math-capture-crop-apply
math-capture-crop-canvas
math-capture-crop-guide
math-capture-crop-hint
math-capture-crop-image
math-capture-crop-modal
math-capture-crop-retry
math-capture-crop-selection
math-capture-crop-size
math-capture-crop-title
math-capture-window-cancel
math-capture-window-grid
math-capture-window-item-template
math-capture-window-modal
math-capture-window-search
math-capture-window-title
math-keyboard-dock
math-keyboard-fixed-grid
math-keyboard-grid
math-keyboard-shift
outline-citations
outline-empty
outline-labels
outline-mode-current
outline-mode-project
outline-sections
outline-todos
rename-modal
rename-modal-cancel
rename-modal-help
rename-modal-input
rename-modal-submit
rename-modal-target
rename-modal-title
resizer
search-button
search-input
search-rename
search-rename-cite
search-rename-from
search-rename-label
search-rename-open-ai
search-rename-run
search-rename-status
search-rename-to
search-results
settings-build-clean
settings-build-clean-all
settings-build-extra-args
settings-build-outdir
settings-build-profile
settings-build-profile-add
settings-build-profile-delete
settings-build-profile-hint
settings-build-profile-name
settings-compile-engine
settings-env-refresh
settings-nav
settings-pages
settings-panel
settings-root-auto
settings-root-select
settings-workspace
synctex-button
workspace-label
```

**`Resources/web/pdf-viewer.html` の id（29個）**

```
pdf-body
pdf-download
pdf-fit-page
pdf-fit-width
pdf-invert
pdf-next
pdf-outline
pdf-page-count
pdf-page-input
pdf-pages
pdf-prev
pdf-print
pdf-reload
pdf-rotate-left
pdf-rotate-right
pdf-scroll
pdf-search-input
pdf-search-next
pdf-search-prev
pdf-sidebar
pdf-sidebar-toggle
pdf-status
pdf-tab-outline
pdf-tab-thumbs
pdf-thumbnails
pdf-title
pdf-zoom-in
pdf-zoom-label
pdf-zoom-out
```

---

## 付録B) IPC 契約（type 一覧）

### B.1 Renderer → Main（`tex64` channel の `type`）

```
agent:abort
agent:apply
agent:clear
agent:run
agent:settings:get
agent:settings:set
api:ghostCompletion
api:usage:get
api:usage:reset
blocks:save
build
build:clean
build:profiles:update
consoleLog
copyItem
createFile
createFolder
createProject
deleteItem
detectRoot
env:check
env:install
file:excerpt
file:preview
formatFile
lint:run
moveItem
renameItem
openFile
openInTerminal
openWorkspace
ready
requestIndex
requestWorkspace
revealInFinder
saveFile
search
search:renameSymbol
setRoot
settings:response
synctex:forward
synctex:reverse
undoFileOperation
```

### B.2 Main → Renderer（`sendToRenderer(type, payload)`）

```
agent:applyContent
agent:applyResult
agent:error
agent:message
agent:messageDelta
agent:proposal
agent:settings
agent:status
agent:tool
api:completionResult
api:usage
buildLog
env:checkResult
env:installResult
env:installStart
file:excerptResult
file:previewResult
formatResult
launcherStatus
openFileResult
renameResult
saveResult
search:renameResult
setBuildState
settings:request
synctex:forwardResult
synctex:reverseResult
updateIndex
updateIssues
updateSearch
updateWorkspace
```

### B.3 PDF window（`tex64:pdf` channel の `type`）

- PDF → Main:
  - `ready`
  - `reverse`（payload: page/x/y/path）
- Main → PDF:
  - `open`（payload: path/url）
  - `sync`（payload: page/x/y）

### B.4 invoke ハンドラ（Renderer → Main）

- `tex64:capture:getSources`（desktopCapturer）
- `tex64:math-ocr:run`（ONNX OCR）

---

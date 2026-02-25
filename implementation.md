# TeX64 機能設計図（実装同期版 / MVP導線込み）

この文書は、TeX64 を構成する **2つのリポジトリ**の現行実装を読み直して、
**ユーザーができること**を機能ベースで整理し、MVP公開に必須の導線（ダウンロード/初回起動/ログイン/課金/アップデート）まで含めて記述します。

- Desktop app（tex64）: `/Users/wedd/tex64`
- Web + Platform API（tex64.com）: `/Users/wedd/tex64.com`

- 基準日: 2026-02-23
- 方針: コード構造の説明ではなく、画面操作・挙動・制約・保存先を中心に記述
- 対象: 起動/ランチャー、編集、ビルド、SyncTeX、検索、Blocks、OCR、AI、ログイン（Google OAuth）、課金/契約状態（AIのみ）、アップデート、設定、永続化、運用導線（サポート/法務/フィードバック/管理）
- 注記: 課金/アップデート/フィードバック/エラーレポートの **API は tex64.com 側に実装がある**。MVP公開では「tex64.com のデプロイ + 環境変数 + DB/Stripe/OAuth設定 + 運用」を必須要件として扱う（末尾の不足洗い出しを参照）

---

## 0. MVPユーザー導線（DL→初回→継続）

この章は「ユーザーがダウンロードしてから初回で使い始め、継続利用する」ために必要な要素を導線として固定します。

### 0.1 ダウンロード/インストール（macOS）

- ダウンロード: `https://tex64.com/download`（最新版の参照は `GET /api/v2/updates/manifest`）
  - 共有用の固定リンク: `https://tex64.com/download/latest`
- 対応: macOS Apple Silicon（arm64）のみ（現行）
- 配布形式: DMG（現行）
- 典型手順: DMG を開く → `TeX64.app` を `Applications` にドラッグ → 起動
- 公開配布の前提: Developer ID 署名 + Notarization（Gatekeeper 回避のため）
- 重要: TeX Distribution（MacTeX/BasicTeX 等）は同梱しない（ユーザー側インストールが必要）

### 0.2 初回起動〜最初のビルド（ローカル機能）

- 起動直後はランチャーでワークスペース（フォルダ）を選ぶ
- ワークスペースを開く/新規作成の後に:
  - root TeX の自動検出（`main.tex` 優先）
  - 実行環境チェック（TeX engine/latexmk/synctex/latexindent）
  - 実行環境不足時は Build をガードし、Settings > Runtime へ誘導（初回オンボーディング表示あり）
- 初回成功体験のゴール: `main.tex` をビルドして PDF を表示できる
- （要修正）ランチャーの失敗理由メッセージが現行UIに表示されないため、操作不能に見えるケースがある
- （要修正）TeX導入の「インストール開始/結果」イベントは Main から送られるが UI が未表示（チェック結果のみ反映）

### 0.3 継続利用（執筆ループ）

- 最近のプロジェクトから再開 → 編集 → Build（`Cmd/Ctrl+B`）→ PDF確認 → SyncTeX（forward/reverse）
- 障害時は Issues に集約し、Runtime/ログ/設定へ誘導

### 0.4 AIを使い始める（ログイン/課金/使用量）

- AI はローカル機能とは独立し、未ログイン/未契約でも編集・ビルド等は利用可能
- AI利用時にだけ以下を判定:
  - Google OAuth ログイン状態
  - プラン/契約状態（`free/basic/pro` + `active/grace/past_due/canceled`）
  - 月次クォータ（tokens/requests）
- 未ログイン: Google ログイン導線（ブラウザ→deep link）を提示
- 未契約/支払い遅延/上限超過: pricing 導線と理由を提示
- 課金/契約の実体は tex64.com（Web + Platform API）で提供する（Stripe Checkout/Portal/Webhook）
- Desktop は pricing を開くのみ（購入UIは持たない）

### 0.5 アップデート（使い続けるための安全弁）

- Settings > Runtime に更新UIを集約（チェック/ダウンロード/適用/手動導線）
- 更新があれば OS 通知を出せる設計（通知ロジックは実装済み）
- （要修正）更新チェックを `background` として呼ぶ配線が現状無く、通知が出ない
- ダウンロード後に sha256 検証し、不一致なら適用しない
- 適用は「インストーラ起動」方式（自動置換/再起動ではない）
- update manifest は tex64.com の `GET /api/v2/updates/manifest` を利用する（Web の Download ボタンと Desktop の更新が同じ情報源を参照する）
  - 本番では artifact 配布先URL・`sha256`・リリースノートURLの運用を確立する（詳細は 1.5 / 20）

### 0.6 フィードバック/サポート/法務（困ったとき）

- Settings から規約/プライバシー/特商法/返金/ヘルプ/問い合わせ/リリースノートを開ける
- フィードバック送信フォーム（カテゴリ/本文/連絡先任意、任意で診断情報を添付）
- エラーレポート送信の ON/OFF（任意）
- 送信先は tex64.com の Platform API:
  - `POST /api/v2/feedback`（匿名でも送信可。必要ならログイン状態も付与）
  - `POST /api/v2/internal/error-report`（匿名でも送信可。必要ならログイン状態も付与）
  - 本番では保存先（DB）と通知先（Webhook/監視）を設定する（詳細は 1.5 / 20）

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

## 1.5 tex64.com（Web + Platform API）でできること

tex64.com は「配布サイト」と「Desktop が呼ぶ Platform API v2」を **同一ドメイン**で提供します。

- ユーザー向け（Web）: ダウンロード、リリースノート、ドキュメント、価格/契約、アカウント、サポート、法務
- アプリ向け（API）: Google OAuth、AI（chat/completion）、契約状態/使用量、アップデートmanifest、フィードバック、エラーレポート
- 運用向け（Admin）: ユーザー/契約/フィードバック/監査の管理

### 1.5.1 Web（公開ページ）

- `/`（Landing）: 概要 + Download セクション（`#download`）
- `/download`: 最新版ダウンロードUI（`/api/v2/updates/manifest` を参照）
- `/download/latest`: JS無しの「最新版」リダイレクト（manifest を参照）
- `/releases`: リリース一覧
- `/releases/[version]`: リリース詳細（ノート + アーティファクト）
- `/docs/*`: ドキュメント（WIP/プレースホルダーを含む）
  - `/docs/getting-started`
  - `/docs/install-macos`
  - `/docs/tex-distribution`
  - `/docs/updates`
  - `/docs/troubleshooting`
  - `/docs/ai`
  - `/docs/blocks`
  - `/docs/synctex`
- `/pricing`: プラン案内（購入はログイン後に `/account/billing`）
- `/support`: サポート/問い合わせ（クエリでの prefill 対応）
- `/account/*`: アカウント（ログイン/課金/使用量）
  - `/account/login`（Google OAuth 開始）
  - `/account/oauth/callback`（OAuth 完了）
  - `/account/billing`（Checkout 開始）
  - `/account/billing/manage`（Customer Portal）
  - `/account/usage`（AI 使用量）
- `/admin`: 管理コンソール（admin token 必須）
- `/terms`, `/privacy`, `/legal`: 法務

### 1.5.2 Platform API v2（/api/v2）

Desktop app と Web の account 画面が共通で利用する API です。

#### 認証（Google OAuth + PKCE）

- `POST /api/v2/auth/google/start`
- `GET /api/v2/auth/google/callback`（Desktop deep link bridge）
- `POST /api/v2/auth/google/exchange`
- `POST /api/v2/auth/refresh`
- `POST /api/v2/auth/logout`

補足:

- Desktop の redirect URI は `tex64://oauth/callback`
- Google OAuth の redirect URI は「Web callback」と「Desktop bridge callback」を分けて扱う
  - Web: `https://tex64.com/account/oauth/callback`
  - Desktop bridge: `https://tex64.com/v2/auth/google/callback`（`/v2/* -> /api/v2/*` の rewrite 前提。環境により `/api/v2/...` を追加登録）

#### 契約状態/使用量（Entitlements/Quota）

- `GET /api/v2/me/features?names=ai`（enabled/plan/status/quota/period/grace など）
- `GET /api/v2/me/usage/ai?period=current_month`

#### AI（サーバー側でモデル/上限を固定）

- `POST /api/v2/ai/chat`
- `POST /api/v2/ai/completion`
- `TEX64_AI_MOCK` でモック応答に切替可能（本番では原則無効化）

#### 課金（Stripe）

- `POST /api/v2/billing/checkout`（Checkout URL 発行）
- `POST /api/v2/billing/portal`（Customer Portal URL 発行）
- `POST /api/v2/billing/webhook`（Stripe webhook 受信→subscription を保存/更新）
  - 必須: `DATABASE_URL`（billing は DB 前提）
  - 任意: webhook 後に subscription を別システムへ中継（`TEX64_APP_PLATFORM_*`）

#### アップデート（manifest）

- `GET /api/v2/updates/manifest?platform=darwin&arch=arm64&channel=stable`
  - Web の Download と Desktop の update が同じ情報源を参照
  - `latestVersion/notesUrl/artifactUrl/artifactSha256/required` を返す

#### フィードバック/エラーレポート

- `POST /api/v2/feedback`（匿名可。必要なら認証情報も付与）
- `POST /api/v2/internal/error-report`（匿名可。必要なら認証情報も付与）
  - どちらも DB または fallback に保存し、任意で Webhook へ通知できる

#### 管理（運用）

- `/admin` UI は `Authorization: Bearer <TEX64_ADMIN_TOKEN>` と `x-admin-actor` を使用
- 代表 API:
  - `GET /api/v2/admin/overview`
  - `GET /api/v2/admin/users`
  - `POST /api/v2/admin/users/subscription`
  - `POST /api/v2/admin/users/period-entitlement`
  - `POST /api/v2/admin/users/revoke-sessions`
  - `GET/POST /api/v2/admin/feedback`
  - `GET /api/v2/admin/audit`

---

## 2. 起動とプロジェクト導線

### 2.1 ランチャー

- ワークスペース未選択時にランチャーを表示
- ワークスペース確定後は非表示
- （要修正）Main 側が送る `launcherStatus.message`（失敗理由）が現行UIに描画されない（busy のみ反映）
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
- （要修正）テンプレート切替UI（`paper/lecture`）は HTML/CSS 側で非表示/未接続のため、ユーザー操作で切替できない

### 2.4 最近のプロジェクト

- 起動時に最近プロジェクトを取得してランチャー右側へ表示
- 保存件数は最大 10（新しいものが先頭）
- 初期表示は先頭 3 件、`すべて表示/折りたたむ` で展開切替
- 項目をクリックするとそのパスを再オープン
- 再オープン時に存在確認し、存在しない項目は最近一覧から自動除去
- （要修正）最近一覧の「手動削除」導線が現行UIから呼べない（無効項目をユーザーが消せない）
- （要修正）無効パス自動除去時の UI 即時同期（一覧の再配信）が弱く、表示が残る場合がある

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

### 13.8 認証・契約導線（AIタブ / Ghost）

AI（チャット/ツール）と Ghost Completion は、Platform API v2 の **ログイン状態 + AI契約状態 + クォータ** によって利用可否が決まる。

#### 13.8.1 状態モデル（ユーザーに見える）

- 未ログイン:
  - AI は利用不可（理由を表示し、ログイン導線を出す）
- ログイン済み/未契約・支払い遅延・quota超過:
  - AI は利用不可（理由を表示し、pricing への導線を出す）
- ログイン済み/契約OK:
  - AI 利用可（使用量メーターを表示）
- 重要: AI が利用不可でも、編集/ビルド/保存など **ローカル機能は常に利用可能**（機能分離）

#### 13.8.2 ログイン（Google OAuth）

- 開始:
  - AIタブの「ログイン」から開始（外部ブラウザを開く）
  - PKCE + state を使い、`tex64://oauth/callback` の deep link で結果を受け取る
- 完了:
  - deep link 受信後に code/state を Platform API へ交換し、access/refresh をローカルに保存
  - 期限が近い/401 の場合は refresh を自動実行（refresh token は rotate/revoke 対応）
- 中断/サインアウト:
  - OAuth 進行中はキャンセル可能
  - Settings > Runtime からサインアウト可能

#### 13.8.3 AI契約状態（Entitlement）と使用量（Quota）

- プラン:
  - `free/basic/pro`
  - 表示は「トークン量のみ」（USD 等の金額は出さない）
- 状態:
  - `active/grace/past_due/canceled`
  - `grace` は 3日（支払い失敗後も一時的に利用可。grace終了で AI 無効）
- クォータ:
  - tokens: `limit/used/remaining`
  - requests: `used/remaining`
  - 期間: `periodStart/periodEnd`（月次）
- 取得タイミング:
  - AI送信/補完の直前に entitlement を確認（短時間キャッシュあり。目安 60秒）
  - 使用量表示は `再試行` で再取得できる

#### 13.8.4 課金/状態反映（tex64.com）

- アプリ内の課金導線は「pricing ページを開く」のみ（購入UIは持たない）
- 購入/管理は tex64.com の Account 画面で行う:
  - Checkout: `/account/billing` → `POST /api/v2/billing/checkout` → Stripe Checkout
  - 管理: `/account/billing/manage` → `POST /api/v2/billing/portal` → Customer Portal
- Stripe webhook（`POST /api/v2/billing/webhook`）で subscription を DB に反映し、`GET /api/v2/me/features` が plan/status/quota を返す
- 例外対応（返金・手動調整等）は Admin API/UI で plan/status/extraTokens 等をパッチできる
- （任意）別システムへ中継する場合は `TEX64_APP_PLATFORM_*`（subscription-bridge）を設定する

#### 13.8.5 本番運用の前提（tex64.com / Platform API）

- 必須（代表）:
  - Google OAuth credential（`GOOGLE_OAUTH_CLIENT_ID/SECRET`）+ redirect URI 登録（Web callback + Desktop bridge）
  - `TEX64_PLATFORM_JWT_SECRET`（production で必須）
  - `DATABASE_URL`（永続化。billing/refresh token は DB 前提）
  - `GEMINI_API_KEY`（AI を有効にする場合）
  - Stripe を有効にする場合: `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_BASIC_PRICE_ID` / `STRIPE_PRO_PRICE_ID`
  - Admin を使う場合: `TEX64_ADMIN_TOKEN`
- 本番で原則無効化すべきもの（モック/フォールバック）:
  - `TEX64_PLATFORM_MOCK_OAUTH`
  - `TEX64_PLATFORM_STATE_FALLBACK`
  - `TEX64_AI_MOCK`

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

- 実行環境チェック:
  - `lualatex/pdflatex/xelatex/uplatex/latexmk/latexindent/synctex` をチェック
  - 不足時は Runtime のバッジとオンボーディング表示へ反映（Build 側も不足時にガードして Runtime へ誘導）
- 初回オンボーディング:
  - Runtime に「1/3 実行環境 → 2/3 ワークスペース → 3/3 最初のビルド」ステータスを表示
  - `最初のビルドを実行` ボタン（条件を満たすまで disabled）
- インストール導線（best-effort）:
  - 未導入時のインストールボタン（platform 別）
  - （要修正）`env:installStart` / `env:installResult` を現行UIが受け取らないため、進捗/成否が見えない（チェック結果のみ反映）
- アップデート:
  - Runtime を開くと `update:status:get` と `update:check(force=false)` を実行
  - 自動チェックは 6時間間隔（`tex64.update.lastAutoCheckAt.v1` を基準に抑制）
  - （任意/要修正）更新がある場合の OS 通知は background チェック時のみ（現行未結線）
  - 更新UIで `現在/最新バージョン`、状態、進捗バーを表示
  - 更新操作:
    - `更新を確認`
    - `ダウンロード`（manifest の `artifactUrl` + 検証情報が必要）
    - `適用`（ダウンロード済みインストーラを起動）
    - `手動ダウンロード`（`artifactUrl` → `notesUrl` → `TEX64_LINKS.download` の順で開く）
  - ダウンロード後に `sha256` 検証を実施し、不一致時は適用しない
    - 受理する検証値: `artifactSha256` / `sha256` / `checksum` / `signature`（sha256 として解釈可能な形式）
  - manifest は tex64.com の Platform API（`GET /api/v2/updates/manifest`）を前提にする（MVP本番では tex64.com 側で `artifactUrl/sha256/notesUrl` を供給する）

### 14.5 Env Registry

- 既定環境 + custom 環境の管理
- math/table 種別指定
- 有効/無効切替
- discouraged/package 表示
- Blocks 検出・整形設定へ反映

### 14.6 フィードバック・法務/サポート導線

- フィードバック送信（Settings > Runtime）:
  - カテゴリ・本文・連絡先（任意）
  - `Cmd/Ctrl+Enter` でも送信可能
  - 失敗時は送信キューに保存して自動再送（指数バックオフ）
  - 任意で診断情報を添付（設定でON/OFF）
  - 送信先は tex64.com の Platform API v2（`POST /api/v2/feedback`）
    - 本番では `DATABASE_URL`（保存先）と `TEX64_FEEDBACK_WEBHOOK_URL`（通知先、任意）を設定する
- 法務/サポートリンク（利用規約、プライバシー、特商法、返金、ヘルプ、問い合わせ、リリースノート）を Settings から開ける

### 14.7 エラーレポート（任意）

- Renderer 側の例外や重要イベントを Native 経由で送信できる（Settings で ON/OFF）
- 送信先は tex64.com の Platform API v2（`POST /api/v2/internal/error-report`）
  - 本番では `DATABASE_URL`（保存先）と `TEX64_ERROR_WEBHOOK_URL`（通知先、任意）を設定する

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
  - access/refresh token（`safeStorage` が使える場合は暗号化して保存）
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
- Runtime/運用:
  - `tex64.runtimeSetupPrompted.v1`
  - `tex64.onboarding.firstBuildCompleted.v1`
  - `tex64.update.lastAutoCheckAt.v1`
  - `tex64.feedback.queue.v1`
  - `tex64.feedback.includeDiagnostics.v1`
  - `tex64.errorReporting.enabled.v1`

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

- AI タブの `pricing` は `TEX64_LINKS.pricing`（現行既定: `https://tex64.com/pricing`）へ遷移
- Settings の法務/サポートボタンは `TEX64_LINKS.*` で定義した `tex64.com` 公開ページを開く
- 手動アップデートは `artifactUrl` が無い場合に `notesUrl` または `TEX64_LINKS.download`（現行既定: `https://tex64.com/download`）へフォールバック

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
- Platform（AI契約/使用量）キャッシュ:
  - entitlement: 60s
  - usage: 60s
- OAuth pending（ログイン開始→完了の猶予）: 10 分
- Update 自動チェック間隔: 6 時間
- AI 画像添付:
  - 4 件
  - 1件 5MB
  - 合計 8MB
- 最近プロジェクト: 10 件

---

## 18. 現行仕様として重要な注意点

- 数式キーボードは実装されているが現状は表示無効
- ランチャー新規作成は現行 UI では paper テンプレート運用
- ランチャーの失敗理由メッセージ（`launcherStatus.message`）は現行UIに表示されない
- ランチャーのテンプレート切替UI（paper/lecture）は非表示/未接続
- 最近プロジェクトの手動削除UIは未接続（無効項目は自動除去のみ）
- 削除は OS ゴミ箱ではなく `.tex64/.trash` を使用
- `rename_latex_symbol` は Search 画面から AI ツール経由で実行される
- reverse SyncTeX は設定 OFF で無効化される
- アップデート導線は Settings > Runtime に集約（AIタブに更新操作は置かない）
- TeX導入の install 開始/結果イベントは Main から送られるが UI が未表示（チェック結果のみ反映）
- 課金（Stripe等）・Update manifest・Feedback・Error report は tex64.com 側に実装があるが、本番では「デプロイ + 環境変数 + DB/Stripe/OAuth設定 + 運用（通知/保存/監査）」が必須

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

### 19.7 設定・オンボーディング

- [x] Runtime で実行環境チェック
- [x] Runtime 初回オンボーディング表示（1/3 ... + 最初のビルド導線）
- [ ] Runtime のインストール進捗/成否表示（`env:installStart` / `env:installResult`）
- [x] Runtime で更新確認/ダウンロード/適用（クライアント側）
- [x] 更新ファイルの `sha256` 検証（クライアント側）
- [x] Runtime でフィードバック送信UI（キュー/再送込み）
- [x] Runtime でサインアウト
- [x] Settings から法務/サポート/リリース導線

### 19.8 プラットフォーム結線（ログイン/課金/更新/フィードバック）

- [x] Google OAuth start/exchange/refresh/logout（API v2 + Desktop）
- [x] Entitlement/quota（`free/basic/pro` + `active/grace/past_due/canceled`）判定と UI 表示
- [x] 決済連携（Stripe）: `POST /api/v2/billing/checkout` / `portal` / `webhook`（tex64.com 実装。production は `DATABASE_URL` + Stripe 設定が必須）
- [x] Update manifest API（`GET /api/v2/updates/manifest`）
- [x] Feedback API（`POST /api/v2/feedback`）
- [x] Error report API（`POST /api/v2/internal/error-report`）
- [x] 運用管理API（Admin: `/api/v2/admin/*`）

---

## 20. MVP公開に向けて足りないもの（不足洗い出し）

この章は「MVPとして公開配布を開始する」ために、tex64（Desktop）と tex64.com（Web/Platform）の両面で不足しているものを機能ベースで列挙します。
（ローカル編集/ビルド等の中核機能は概ね成立している前提で、**ユーザー導線**と**運用上の安全弁**の欠けを優先する。）

### 20.1 P0（公開前に必須）

- tex64.com（Platform）を本番として成立させる
  - `DATABASE_URL` を用意し、永続化を有効にする（billing/refresh token/usage/feedback の基盤）
  - `TEX64_PLATFORM_JWT_SECRET` を本番用に設定（production で必須）
  - Google OAuth を本番設定し、redirect URI を登録する
    - Web: `https://tex64.com/account/oauth/callback`
    - Desktop bridge: `https://tex64.com/v2/auth/google/callback`（環境により `/api/v2/...` も追加登録）
  - AI を有効にする場合: `GEMINI_API_KEY` とモデル/上限（コスト制御）を確定
  - 課金（AIのみ）を有効にする場合: Stripe 設定（`STRIPE_*`）+ webhook 受信（`POST /api/v2/billing/webhook`）
  - 運用: `TEX64_ADMIN_TOKEN` を設定し、`/admin` でユーザー/契約/フィードバック/監査を扱えるようにする
- 配布/アップデート情報源を「運用できる」形で確定する（manifest の中身を埋める）
  - artifact のホスティング（GitHub Releases / オブジェクトストレージ / remote feed など）を決める
  - `artifactSha256`（Desktop が検証する）の生成・公開フローを確立する
  - `notesUrl`（`/releases/[version]` 等）を提供する
  - 反映手段: `TEX64_UPDATE_*`（env）または `src/content/releases.js`（静的データ）を運用方針として固定
  - [x] Desktop 側の手動公開スクリプト（`npm run -s release:upload-downloads`）と公開整合チェック（`npm run -s release:go-no-go`）を追加
- Desktop 配布（macOS）
  - Developer ID 署名 + Notarization の手順を確定（Gatekeeper 対応）
  - バージョン付けとリリースノート作成を update/manifest 運用に組み込む
- 初回UXの詰まりどころを潰す（ユーザーが「使い始められない」系）
  - [x] ランチャーの失敗理由が UI に出ない（`launcherStatus.message` が描画されない）
  - [x] Runtime の TeX インストール進捗/成否が UI に出ない（`env:installStart` / `env:installResult`）
  - [x] テンプレート切替UIが非表示（paper/lecture）
  - [x] 最近プロジェクトの手動削除が未接続

### 20.2 P1（公開後すぐに欲しい）

- アップデート通知
  - [x] background チェック（OS通知）: 起動後に自動チェック + 6時間ごとに再チェック
- サポート運用
  - `TEX64_FEEDBACK_WEBHOOK_URL` / `TEX64_ERROR_WEBHOOK_URL` を Slack/Jira/Sentry 等へ接続する
  - triage（タグ/担当/優先度）の運用を決め、`/admin` の運用手順を整備する
- セキュリティ/運用ハードニング
  - CSP/権限の最小化、PII/ログ保持/削除方針を明文化する
  - トークン保存（`safeStorage` が使えない環境の扱い）を本番方針として固定する

### 20.3 運用整合（リリース事故を減らす）

- [x] Desktop 側 runbook に「ローカル署名/Notarize -> R2/S3 へ手動公開 -> Go/No-Go 自動検証」の導線を追加（`docs/distribution.md`）
- Desktop と tex64.com の Runbook を1つに集約（OAuth/Stripe/webhook/update/初回ビルドの確認手順）
- README と `package.json` のコマンド/環境変数の整合を取る（両リポジトリ）

---

## 21. モック/開発モード一覧（本番での扱い）

### 21.1 Platform API v2（サーバー側）

- mock OAuth:
  - `TEX64_PLATFORM_MOCK_OAUTH=true` で Google OAuth の代わりに `mock:` コードでログイン可能
  - 本番では必ず無効化し、Google OAuth credential を設定する
- state fallback（DBなし動作）:
  - `TEX64_PLATFORM_STATE_FALLBACK=true` で JSON ストアへ退避（`TEX64_PLATFORM_STATE_FILE`）
  - 本番では `DATABASE_URL` を必須にし、fallback を無効化する
- user overrides（テスト用）:
  - `TEX64_PLATFORM_USER_OVERRIDES`（JSON）で特定ユーザーの plan/status/extraTokens を強制できる
  - 本番では原則無効化し、Admin/Stripe を正とする
- AI mock:
  - `TEX64_AI_MOCK=true` で AI をモック応答へ切替できる
  - 本番では原則無効化し、実プロバイダ（例: Gemini）を設定する
- JWT secret:
  - 非production では未設定時に開発用デフォルトへフォールバックする
  - 本番では必ず強度の高い secret を設定する

### 21.2 Desktop app（Electron）

- entitlement bypass（開発/E2E）:
  - `TEX64_AI_BYPASS_ENTITLEMENT=1` などで契約判定をバイパス
  - packaged 本番では常に無効化される前提で運用する
- Platform API base URL の上書き（開発）:
  - `TEX64_PLATFORM_API_BASE_URL` / `TEX64_PLATFORM_WEB_BASE_URL` / `TEX64_PLATFORM_OAUTH_REDIRECT_URI`
  - 本番では `https://tex64.com` へ固定して運用する
- legacy AI proxy（開発）:
  - `TEX64_AI_PROXY_URL`（旧 `/api/ai-chat` プロキシ）
  - 本番では Platform API v2（`/api/v2/ai/*`）へ統一する
- update channel（運用）:
  - `TEX64_UPDATE_CHANNEL`（既定: `stable`）

以上。

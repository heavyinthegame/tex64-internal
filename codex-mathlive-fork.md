# Codex タスク：MathLive Fork を TeX64 に統合

## 目的

TeX64 アプリの数式WYSIWYG入力は MathLive（v0.108.2, MIT）をそのまま使っているが、MathLive の挙動と TeX64 の要件の間に根本的なミスマッチがあり、TeX64 側に約900行のワークアラウンド層（エスケープ、ラッピング、オフセット変換）が必要になっている。このワークアラウンド層自体がバグの温床。

**MathLive をフォークし、TeX64 の要件に合うように内部を修正して、ワークアラウンド層を削除する。**

---

## 背景情報

### リポジトリ構造
- TeX64 Desktop app: `/Users/wedd/tex64`
- MathLive npm: `node_modules/mathlive`（v0.108.2）
- MathLive GitHub: `https://github.com/arnog/mathlive`（MIT ライセンス）
- MathLive の非圧縮ソース: `mathlive.mjs`（~43,000行）

### 現在の MathLive 関連ファイル（TeX64 側）
以下は全て `web-src/app/blocks/` にある（`math-aux-command-escape.ts` は Phase 5 で削除済み）：

| ファイル | 行数 | 役割 |
|---|---|---|
| `mathlive.ts` | 572 | MathLive `<math-field>` のセットアップ、マクロ登録、メニューフィルタ、Shadow DOM スタイル注入 |
| `math-aux-command-escape.ts` | 0 | Phase 5 で削除済み |
| `input-ui-latex-format.ts` | 361 | aligned ラッピング/アンラッピング、行列正規化、`alignat*/flalign*/array` マーカー復元 |
| `input-ui-math-field.ts` | 575 | MathLive のオフセット↔LaTeXインデックス変換、プレースホルダナビゲーション |
| `input-ui.ts` | 2019 | 入力UI全体。`syncMathFieldValue` でカーソル付きエスケープ処理 |
| `math-input-utils.ts` | 675 | スクリプト適用、テンプレート適用、base検出 |
| `format.ts` | 178 | インデント正規化 |

### 現時点の問題（`claude.md` に詳細）
約40パターンの破損が確認済み。主要原因：
1. `getValue("latex")` が入力LaTeXを正規化して返す（スペース変更、`\placeholder{}` 挿入/除去、空 `{}` 省略）
2. `setValue()` がUndoスタックをリセットする
3. `\label`, `\tag`, `\intertext` 等をMathLiveが認識しない → 退避/復元のための翻訳層が必要
4. `alignat*`, `flalign*`, `array` 等の環境をMathLiveが未サポート → マーカー置換が必要
5. atom offset ↔ LaTeX index のマッピングが不正確 → カーソル付きエスケープがときどき失敗

---

## やること（Phase 1〜3）

### Phase 1：MathLive fork の作成とビルド統合

1. MathLive の GitHub リポジトリ（`https://github.com/arnog/mathlive`, tag `v0.108.2`）の TypeScript ソースを取得する
2. `/Users/wedd/tex64/web-src/math/fork/` に必要ソースを配置する（app内同梱）
3. MathLive のビルドスクリプト（Rollup or esbuild）を TeX64 のビルドに統合し、`mathlive.min.js` を自前ビルドできるようにする
4. `package.json` の `mathlive` 依存を自前ビルドに差し替える
5. 既存の動作が変わらないことを確認する

### Phase 2：MathLive 内部の修正

以下の修正を MathLive の TypeScript ソースに加える：

#### 2-1. `getValue("latex")` の忠実性向上
- `setValue()` で受け取った LaTeX 文字列を内部に保持し、`getValue("latex")` でそのまま返すモードを追加する
- または、getValue が行う正規化（空 `{}` 省略、スペース変更）を無効にするオプション `faithfulLatex: true` を追加する
- 目標：`setValue(x); getValue("latex") === x` が常に成立すること

#### 2-2. `setValue()` の Undo 保全
- `setValue()` に `{ preserveUndo: true }` オプションを追加する
- このオプションが true の場合、Undo スタックをリセットせず、新しい変更として積む
- TeX64 の `syncMathFieldValue` から呼ぶ際にこのオプションを使う

#### 2-3. 未知コマンドの扱い改善
- MathLive が認識しないコマンド（`\ce`, `\SI`, `\def`, `\newcommand` 等）を検出した場合、パースエラーではなく **灰色の未知コマンドボックス** として表示する
- 未知コマンドとその引数（`{...}` で囲まれた部分）は内部的に保持し、`getValue("latex")` でそのまま返す

#### 2-4. `\label`, `\tag`, `\ref` 等のネイティブサポート
- 以下のコマンドを MathLive 内部で「非表示マーカー」として認識させる：
  - `\label{...}` — 小さなラベルバッジとして表示（例：`🏷 eq:1`）、または完全非表示
  - `\tag{...}` / `\tag*{...}` — 右端にタグ表示
  - `\notag` / `\nonumber` — 非表示マーカー
  - `\ref{...}` / `\eqref{...}` / `\pageref{...}` / `\autoref{...}` — 参照テキストとして表示
  - `\intertext{...}` / `\shortintertext{...}` — テキスト行として表示
- これにより `math-aux-command-escape.ts` の `\label`→`\txlbl` 退避/復元が **完全に不要** になる

#### 2-5. 追加環境のサポート
MathLive が現状サポートしていない以下の環境を追加する：
- `alignat` / `alignat*`（列数指定付き）
- `flalign` / `flalign*`
- `array`（列指定 `{ccc}` 等つき）
- `gathered`
- `multline` / `multline*`

これにより `input-ui-latex-format.ts` のマーカー置換処理（`\txalnat`, `\txflaln`, `\txarrcf`, `\txarrayc`）が **完全に不要** になる。

### Phase 3：TeX64 側の簡素化

MathLive fork の修正が完了した後、以下の TeX64 側コードを削除/簡素化する：

#### 3-1. 削除対象
- `math-aux-command-escape.ts` — **全削除**
- `input-ui-latex-format.ts` の以下の関数を削除：
  - `restoreAlignedMarkerEnvs`
  - `restoreArrayMarkerEnvs`
  - `restoreAlignatBegin`
  - `restoreFlalignBegin`
  - `restoreStandaloneMarkerBegins`
  - `restoreUnsupportedEnvBegins`
- `mathlive.ts` の `AUXILIARY_MATH_MACROS` 関連コード

#### 3-2. 簡素化対象
- `input-ui.ts` の `syncMathFieldValue` — カーソル付きエスケープ処理を削除。`getValue/setValue` が忠実なので中間変換不要
- `input-ui.ts` の `prepareMathValueForField` / `normalizeMathValueForOutput` — 退避/復元が不要になるので大幅簡素化
- `input-ui-math-field.ts` の `offsetToLatexIndex` / `indexToOffset` — MathLive 内部から直接 LaTeX インデックスを取得可能にする

#### 3-3. aligned ラッピングの見直し
- MathLive fork が `aligned` 環境を正しく扱えるなら、`shouldWrapAligned` / `wrapAligned` / `unwrapAligned` も不要になる可能性が高い
- ユーザーが `&` や `\\` を入力したとき、MathLive 内部で自動的に `aligned` 環境に切り替える挙動を検討

---

## 制約と注意点

1. **ライセンス**: MathLive は MIT ライセンス。fork して改変・再配布は問題なし。ただし `NOTICE.md` にフォーク元を明記すること
2. **既存テスト**: `tests/e2e/` 配下の MathLive 関連 e2e テスト（`math-wysiwyg-*.e2e.mjs`）が Phase 3 完了後も通ることを確認する
3. **MathLive のフォントファイル**: `fonts/` ディレクトリ（KaTeX 由来の WOFF2 数学フォント）はそのまま使う
4. **MathLive の CSS**: `mathlive-static.css` と Shadow DOM 内スタイルは維持する
5. **バージョン管理**: fork したバージョンを `0.108.2-tex64.1` のように命名する

---

## 成功基準

- [x] MathLive fork がビルドでき、既存の TeX64 の math-field が動作する
- [x] `setValue(x); getValue("latex") === x` が全てのテストケースで成立する
- [x] `\label{eq:1}` を入力するとバッジ表示され、getValue で `\label{eq:1}` が返る
- [x] `\begin{alignat*}{2}...` が MathLive 内で直接編集できる
- [x] `//label` / `//alignat` など slash command で native LaTeX が直接挿入され、`//` が保存値に残らない
- [x] `math-aux-command-escape.ts` が削除されている
- [x] `Cmd+Z` / `Ctrl+Z` が正常に動作する（setValue による破壊がない）
- [x] 未知コマンドが灰色ボックスで表示され、getValue でそのまま返る
- [x] 既存の e2e テストが通る

---

## 参考資料

- MathLive ソース: `https://github.com/arnog/mathlive` (v0.108.2)
- TeX64 の現状の問題分析: `/Users/wedd/tex64/claude.md`
- TeX64 の機能設計図: `/Users/wedd/tex64/implementation.md`（セクション11: Blocks）
- 現在の MathLive 統合コード: `web-src/app/blocks/mathlive.ts`
- （削除済み）旧エスケープ層: `web-src/app/blocks/math-aux-command-escape.ts`
- 現在のフォーマット層: `web-src/app/blocks/input-ui-latex-format.ts`

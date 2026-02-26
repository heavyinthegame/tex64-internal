# MathLive Fork 実行計画（矛盾防止）

最終更新: 2026-02-26
対象メモ: `codex-mathlive-fork.md`

## 運用ルール

1. この計画書を唯一の進行管理ソースにする。
2. 各フェーズは「完了条件」を満たすまで次へ進まない。
3. MathLive fork の挙動変更前に、必ず UI 経路の再現 e2e を追加する。
4. TeX64 側の簡素化（Phase 3 相当）は、fork 側機能が安定するまで着手しない。
5. 失敗した再現テストは削除せず維持し、修正後に green 化する。

## フェーズ一覧

### Phase 0: 前提整理（完了）
- [x] 数式関連以外の未コミット差分をコミット
- [x] 数式関連差分を巻き戻し
- [x] 作業メモを `codex-mathlive-fork.md` に集約

完了条件:
- 数式改修に無関係な差分が作業ブランチから分離されている

### Phase 1: 再現テストの固定（完了）
- [x] 新規 e2e: `setValue(x); getValue(\"latex\") === x` の破綻を UI 経路で再現
- [x] 新規 e2e: `setValue()` が Undo 履歴を壊すケースを再現
- [x] 再現テストを単体実行して失敗を確認

完了条件:
- 追加した再現 e2e が現行実装で red になり、失敗理由を記録済み

### Phase 2: fork 導入（挙動非変更・完了）
- [x] `web-src/math/fork/` に v0.108.2 fork ソース配置（app内同梱）
- [x] TeX64 ビルドへ `mathlive.min.js` 自前生成を統合
- [x] 既存読み込み経路（`Resources/web/mathlive/**`）を維持して差し替え
- [x] 主要既存 e2e を実行し回帰なし確認（`math-wysiwyg-basic` / `math-wysiwyg-aligned-regression`）
- [x] スモーク確認: `math-wysiwyg-basic.e2e.mjs` pass

完了条件:
- fork 由来 asset で現行挙動が再現できる（既存回帰なし）

### Phase 3: fork 機能改修（最小核・完了）
- [x] `faithfulLatex`（忠実取得）を実装
- [x] `preserveUndo`（Undo保持）を実装
- [x] Phase 1 の再現 e2e を green 化

完了条件:
- Phase 1 の red テストが green

### Phase 4: 対応範囲拡張（完了）
- [x] 未知コマンド表示/保持
- [x] `\\label`/`\\tag`/`\\ref` 系のネイティブ扱い
- [x] `alignat*`/`flalign*`/`array` など環境対応

完了条件:
- 追加した仕様テストが green

### Phase 5: TeX64 側簡素化
- [x] `math-aux-command-escape.ts` 削除
- [x] `input-ui-latex-format.ts` のマーカー復元群を削除（旧tx marker互換 shim のみ残置）
- [x] 新規 e2e `math-wysiwyg-native-env-insertion-pipeline.e2e.mjs` を追加し green 化
- [x] `mathlive.ts` から `AUXILIARY_MATH_MACROS` 注入を削除
- [x] `input-ui.ts` で `restoreUnsupportedEnvBegins` 依存を撤去し、legacy marker 正規化に置換
- [x] `syncMathFieldValue` と offset 変換層を簡素化
- [x] 数式回帰スイート一式を再実行

完了条件:
- 成功基準（`codex-mathlive-fork.md`）を満たす

### Phase 6: 入力 UX 完全制御（slash command）
- [x] 新規 e2e `math-wysiwyg-slash-commands.e2e.mjs` を red で再現
- [x] `math-wysiwyg.ts` に `//` 専用トークン解析を追加
- [x] `//` 候補確定で `//token` 全体を置換（`//` 漏れゼロ）
- [x] `//` 単独入力でもコマンド候補を即提示
- [x] broad 回帰 9 本を再実行して green 化

完了条件:
- `//label` / `//alignat` などが native LaTeX に正規挿入され、`//` が保存値に残らない

## 今回の実行対象

- Phase 5 は完了。
- 2026-02-25 に以下を再実行して全 green を確認:
  - `math-wysiwyg-aux-commands-adversarial.e2e.mjs`
  - `math-wysiwyg-aux-commands-escape.e2e.mjs`
  - `math-wysiwyg-aux-commands-native.e2e.mjs`
  - `math-wysiwyg-phase5-auxless-compat.e2e.mjs`
  - `math-wysiwyg-aligned-regression.e2e.mjs`
  - `math-wysiwyg-advanced.e2e.mjs`
  - `math-wysiwyg-famous-formulas.e2e.mjs`
  - `math-wysiwyg-famous-formulas-next50.e2e.mjs`
  - `math-wysiwyg-entangled-formulas-50.e2e.mjs`
  - `math-wysiwyg-environment-entangled-50.e2e.mjs`
  - `math-wysiwyg-structural-breakage-probes.e2e.mjs`
  - `math-wysiwyg-adversarial-nested-matrix-50.e2e.mjs`
  - `math-wysiwyg-ultra-nested-structures-50.e2e.mjs`
- 2026-02-26 に `//` command 導線を追加し、以下を全 green で確認:
  - `math-wysiwyg-slash-commands.e2e.mjs`
  - `math-wysiwyg-aligned-regression.e2e.mjs`
  - `math-wysiwyg-advanced.e2e.mjs`
  - `math-wysiwyg-famous-formulas.e2e.mjs`
  - `math-wysiwyg-famous-formulas-next50.e2e.mjs`
  - `math-wysiwyg-entangled-formulas-50.e2e.mjs`
  - `math-wysiwyg-environment-entangled-50.e2e.mjs`
  - `math-wysiwyg-structural-breakage-probes.e2e.mjs`
  - `math-wysiwyg-adversarial-nested-matrix-50.e2e.mjs`
  - `math-wysiwyg-ultra-nested-structures-50.e2e.mjs`

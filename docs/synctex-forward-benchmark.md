# SyncTeX Forward Benchmark

`forward -> reverse` の往復で、SyncTeX 精度を数値で追うためのベンチです。

既定では、品質評価の reverse に `forward hint` を使いません（実力値を測るため）。
必要なら `--probe-with-hint` で旧挙動に戻せます。

## 実行コマンド

### 1) クイック確認（短時間）

```bash
npm run bench:synctex:forward -- \
  --workspace /Users/wedd/tex64/test-workspace \
  --pdf main.pdf \
  --source-dir sections \
  --max-cases 20
```

### 2) フル計測（改善時）

```bash
npm run bench:synctex:forward -- \
  --workspace /Users/wedd/tex64/test-workspace \
  --pdf main.pdf \
  --source-dir sections \
  --repeat 3 \
  --json-out tmp/synctex-forward-bench.json
```

### 3) ゲート（未達なら exit 1）

```bash
npm run bench:synctex:forward:gate -- \
  --workspace /Users/wedd/tex64/test-workspace \
  --pdf main.pdf \
  --source-dir sections
```

必要に応じて `--min-pass-rate`, `--min-exact-rate`, `--max-fallback-rate` などを上書きできます。

例（現行ベースライン向け）:

```bash
npm run bench:synctex:forward -- \
  --workspace /Users/wedd/tex64/test-workspace \
  --pdf main.pdf \
  --source-dir sections \
  --min-pass-rate 0.94 \
  --min-exact-rate 0.58 \
  --max-forward-fail-rate 0.01 \
  --max-reverse-fail-rate 0.01 \
  --max-fallback-rate 0.12
```

## 指標

- `passRate`: round-trip 行差が `lineTolerance` 以内（既定 ±1）
- `exactRate`: round-trip 行差 0
- `forwardFailRate`: forward 自体が失敗した割合
- `reverseFailRate`: reverse 自体が失敗した割合
- `fallbackRate`: backtrack / top fallback を使った割合

## 既定の対象行

- 空行・コメント行は除外
- preamble と `\input/\include` 系などの構造行は除外
- `\begin/\end`、`&` を含む整列表現、行末 `\\` などの不安定行も除外

構造行も測りたい場合は `--include-structural-lines` を付けます。

## 改善ループ（推奨）

1. `--json-out` で失敗ケースを保存
2. 失敗ケースを 1 パターンずつ修正
3. クイック確認で悪化がないか確認
4. フル計測で pass/exact の改善を確認
5. 最後にゲートで固定

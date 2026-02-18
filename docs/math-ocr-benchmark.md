# Math OCR Benchmark

Math OCR の精度を実データで継続評価するためのベンチです。

## 1. 実行コマンド

```bash
npm run -s e2e:math-ocr-bench
```

オプション:

```bash
npm run -s e2e:math-ocr-bench -- --limit 24
npm run -s e2e:math-ocr-bench -- --dataset tests/e2e/fixtures/math-ocr-benchmark/samples.json
npm run -s e2e:math-ocr-bench -- --out tmp/math-ocr-bench/my-run.json
```

レポートは既定で `tmp/math-ocr-bench/latest.json` に出力されます。

## 2. データセット形式

`tests/e2e/fixtures/math-ocr-benchmark/samples.json` は以下形式です。

```json
{
  "samples": [
    { "id": "s01", "latex": "x^2+1" },
    {
      "id": "real-01",
      "expected": "\\frac{a+b}{c}",
      "imagePath": "./real/real-01.png"
    }
  ]
}
```

- `latex` または `expected`: 正解 LaTeX（どちらでも可）
- `imagePath`: 実画像を使う場合に指定（dataset JSON からの相対パス可）
- `imagePath` なし: ベンチ側で MathLive レンダリング画像を自動生成

## 3. 実画像で精度を上げる運用

1. 実際の利用シーンのスクリーンショットを 20〜50 枚用意する
2. `imagePath` と `expected` を付けて dataset に追加する
3. ベンチ実行して失敗ケースを `tmp/math-ocr-bench/latest.json` で確認する
4. 失敗パターンごとに前処理/後処理/fallback 条件を調整する
5. 再実行して改善率（exact/relaxed）を追跡する

## 4. 指標

- `exactRate`: 正規化後に完全一致
- `relaxedPassRate`: 類似度 0.9 以上を合格
- `avgSimilarity`: 文字列類似度の平均
- `avgElapsedMs`: 1サンプルあたり処理時間

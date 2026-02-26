# Math Stack (TeX64)

このディレクトリは TeX64 向け数式入力の単一ソースです。

## 構成

- `web-src/math/wysiwyg/`: TeX64 独自の数式入力ロジック（候補、トリガー、選択制御）
- `web-src/math/fork/`: TeX64 向けに固定した MathLive fork ソース

## 生成先

- `Resources/web/math/wysiwyg/*.js`
- `Resources/web/mathlive/mathlive.min.js`
- `Resources/web/mathlive/mathlive-static.css`
- `Resources/web/mathlive/fonts/**`

## 開発コマンド

- `npm run -s math:check`: 構造崩れ（旧パス、stale生成物、参照漏れ）を検出
- `npm run -s mathlive:clean`: fork キャッシュ/生成物をクリーン
- `npm run -s mathlive:build`: fork からランタイム資産を再生成
- `npm run -s web:build`: `math:check` + `mathlive:build` + TypeScript build

## 運用ルール

- `web-src/vendor/mathlive-fork` は使わない（再作成しない）。
- `Resources/web/mathlive/sounds/**` は使わない（音声フィードバックは無効）。
- `Resources/web/app/math-wysiwyg*.js` は旧生成物なので存在してはいけない。


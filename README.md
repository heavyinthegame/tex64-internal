# tex180

ElectronベースのTeXエディタ（開発中）。

## 開発
1. `npm install`（初回のみ）
2. `npm run web:build`
3. `npm run electron:dev`

## 構成
- `Resources/web`: アプリに同梱されるWeb UI（生成物を含む）
- `web-src`: Web UIのTypeScriptソース
- `docs/notes.md`: 設計/実装メモ

## 注意
- `Resources/web/main.js`は`web-src/main.ts`から生成するため、直接編集しない

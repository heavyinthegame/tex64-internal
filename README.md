# tex180

macOS向けTeXエディタ（開発中）。

## 開発
1. Xcodeで`tex180.xcodeproj`を開いて実行
2. Web UIを変更したら `npm install`（初回のみ）→ `npm run web:build`

## 構成
- `Resources/web`: アプリに同梱されるWeb UI（生成物を含む）
- `web-src`: Web UIのTypeScriptソース
- `docs/notes.md`: 設計/実装メモ

## 注意
- `Resources/web/main.js`は`web-src/main.ts`から生成するため、直接編集しない

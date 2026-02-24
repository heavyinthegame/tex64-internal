# 有料化導線メモ（実装案）

> DEPRECATED: このメモは「アプリ全体を有料化して閲覧のみへ落とす」前提で書かれています。
> 現行方針は「AI機能のみ課金」です。最新の有料化設計は `docs/platform-api-contract-v2-google-oauth.md` と `docs/ai-subscription-implementation-plan.md` を参照してください。

## 前提
- ベータ期間は無料・ログイン不要・オフラインでも利用可能。
- 有料化後は「未契約は閲覧のみ」。編集/ビルド/挿入などは無効化。
- 基本はオフライン前提だが、有料化後の制限はオンライン時の判定で有効化できるようにする。
- サブスクは1ヶ月更新。
- 決済実装は後回し（設計メモのみ）。

## 実現方針（概要）
1) サーバーが「有料化モード」を返すポリシーAPIを提供する。  
2) アプリはオンライン時にポリシーを取得し、`paidRequired` を受け取ったらローカルに保持する。  
3) 以後はオフラインでも `paidRequired` を維持し、未契約なら閲覧のみにする。  
4) 契約済みは署名付きトークン（有効期限=1ヶ月）を保存し、期限内はオフラインでも利用可能。  

> これにより「ユーザーがアップデートしなくても、オンラインになれば有料制限がかかる」を実現できる。  
> ただし **その挙動は“その機能を含むバージョン”に限る**（古いビルドには効かない）。

## 状態遷移（概念）
```
Beta (free)
  ├─ online → policy.paidRequired = true → PaidRequired
  └─ betaEndDate 到来 → PaidRequired

PaidRequired
  ├─ valid license token → ActiveSubscriber
  └─ no/expired token → ViewOnly
```

## 主要ルール
- `paidRequired` は「一度受け取ったら解除しない」。
- オフラインでも `paidRequired` が true なら制限を維持。
- ライセンストークンは期限つき（1ヶ月）。期限切れは即 ViewOnly。
- 端末の時計改ざん対策として、最後に取得したサーバー時刻を保存して比較する。

## APIの最小設計（例）
- `GET /policy`
  - 返却例: `{ "paidRequired": true, "betaEndDate": "2025-01-31" }`
- `POST /auth/magic-link`
  - メールでログインリンクを送付
- `POST /license/refresh`
  - 返却例: `{ "token": "<signed token>", "expiresAt": "2025-03-01T00:00:00Z" }`
- `GET /entitlements`
  - 返却例: `{ "status": "active", "expiresAt": "..." }`

## ローカル保持（例）
- `app.getPath("userData")/license.json`
  - `paidRequiredSeen: boolean`
  - `lastServerTime: string`
  - `licenseToken: string | null`
  - `licenseExpiresAt: string | null`

## UI/UXの最小要件
- 設定タブに「ライセンス」カード
  - 状態（未登録/有効/期限切れ）
  - 「購入ページを開く」「メールでサインイン」
- 未契約時は「閲覧のみ」の案内を表示

## 例外と注意点
- **完全オフラインで一度もポリシー取得しない**場合、有料化の強制はできない。  
  → これを避けたい場合は「ベータ終了日」をアプリに埋め込む。
- 既に配布済みで「オンラインチェックが無い」ビルドには、後から強制はできない。

## 実装メモ（後でやる）
- Electron側で起動時/復帰時に `policy` と `license` を取得。
- `paidRequired` 判定はUIと操作系を一括で切り替え（Build/Blocks/保存/挿入など）。
- 既存の設計思想（編集の自動確定禁止/安定性優先）を崩さない。

# TeX64 Platform API Contract v1

このドキュメントは、`AI機能のみ課金` の前提で、TeX64 アプリと `tex64.com` バックエンド間の API 契約を固定するための仕様です。

> DEPRECATED: 現行の実装/運用は v2（Google OAuth + `/api/v2/*`）に統一しています。
> 最新仕様は `docs/platform-api-contract-v2-google-oauth.md` を参照してください。

## 1. スコープ

- 課金対象: AI 機能のみ（編集/ビルド/閲覧は無料で継続）
- 対象機能:
  - 認証（メールリンク）
  - Entitlement（AI利用可否）
  - AI実行（chat / completion）
  - 使用量取得（課金/上限表示用）
  - フィードバック送信
  - アップデート情報取得

## 2. ベース仕様

- Base URL: `https://api.tex64.com/v1`
- 文字コード: UTF-8
- 認証: Bearer Access Token（JWT）
- Content-Type: `application/json`
- すべてのレスポンスに `requestId` を返す（ログ追跡用）

## 3. 認証モデル

- Access Token: 15分
- Refresh Token: 30日
- リフレッシュローテーション: 有効（再発行ごとに更新）
- 端末識別: `deviceId`（UUID）をクライアントで永続化し送信

## 4. 共通エラーフォーマット

```json
{
  "requestId": "req_01H...",
  "error": {
    "code": "AI_QUOTA_EXCEEDED",
    "message": "Monthly AI quota exceeded.",
    "retryAfterSec": 3600
  }
}
```

主な `error.code`:

- `UNAUTHORIZED`
- `FORBIDDEN`
- `ENTITLEMENT_REQUIRED`
- `AI_QUOTA_EXCEEDED`
- `RATE_LIMITED`
- `VALIDATION_ERROR`
- `INTERNAL_ERROR`

## 5. エンドポイント契約

### 5.1 POST `/auth/magic-link/request`

ログインリンク送信。

Request:

```json
{
  "email": "user@example.com",
  "redirectUri": "tex64://auth/callback"
}
```

Response `200`:

```json
{
  "requestId": "req_...",
  "ok": true
}
```

### 5.2 POST `/auth/magic-link/verify`

ワンタイムコード検証。

Request:

```json
{
  "code": "ml_...",
  "deviceId": "8c5af9ff-...."
}
```

Response `200`:

```json
{
  "requestId": "req_...",
  "accessToken": "eyJ...",
  "refreshToken": "rt_...",
  "expiresInSec": 900
}
```

### 5.3 POST `/auth/refresh`

Request:

```json
{
  "refreshToken": "rt_...",
  "deviceId": "8c5af9ff-...."
}
```

Response `200`: `accessToken` / `refreshToken` を再発行（上と同形式）。

### 5.4 GET `/entitlements`

AI利用可否と契約状態を取得。

Response `200`:

```json
{
  "requestId": "req_...",
  "account": {
    "userId": "usr_...",
    "email": "user@example.com"
  },
  "entitlements": {
    "ai": {
      "enabled": true,
      "planId": "pro_monthly",
      "status": "active",
      "periodEnd": "2026-03-01T00:00:00Z"
    }
  },
  "limits": {
    "monthlyCostUsd": 30,
    "monthlyTokens": 6000000,
    "monthlyRequests": 12000
  }
}
```

`status` は `active | trialing | grace | past_due | canceled`。

### 5.5 POST `/ai/chat`

AIチャット（サーバー側で課金・上限・レート制限を必ず判定）。

Request:

```json
{
  "conversationId": "chat_...",
  "messages": [
    { "role": "user", "content": "..." }
  ],
  "context": {
    "workspaceId": "ws_...",
    "activeFile": "main.tex"
  }
}
```

Response `200`:

```json
{
  "requestId": "req_...",
  "output": {
    "text": "..."
  },
  "usage": {
    "model": "gemini-3-flash-preview",
    "inputTokens": 1200,
    "outputTokens": 280,
    "totalTokens": 1480,
    "estimatedCostUsd": 0.00121
  },
  "remaining": {
    "monthlyCostUsd": 29.84,
    "monthlyTokens": 5985200,
    "monthlyRequests": 11999
  }
}
```

### 5.6 POST `/ai/completion`

ゴースト補完向け（短文）。

Request:

```json
{
  "prompt": "...",
  "prefix": "...",
  "maxOutputTokens": 40
}
```

Response は `/ai/chat` と同様に `usage` / `remaining` を返す。

### 5.7 GET `/usage/summary?period=current_month`

アプリ設定画面の使用量表示用。

Response `200`:

```json
{
  "requestId": "req_...",
  "period": "2026-02",
  "totals": {
    "requests": 240,
    "inputTokens": 120000,
    "outputTokens": 40000,
    "totalTokens": 160000,
    "estimatedCostUsd": 1.24
  },
  "byFeature": {
    "chat": { "requests": 180, "estimatedCostUsd": 1.02 },
    "completion": { "requests": 60, "estimatedCostUsd": 0.22 }
  }
}
```

### 5.8 POST `/feedback`

フィードバック送信（自前API）。

Request:

```json
{
  "category": "bug",
  "message": "SyncTeX が失敗します",
  "email": "user@example.com",
  "app": {
    "version": "0.1.0",
    "platform": "darwin-arm64"
  },
  "diagnostics": {
    "include": true,
    "payload": "..."
  }
}
```

Response `200`:

```json
{
  "requestId": "req_...",
  "feedbackId": "fb_...",
  "status": "accepted"
}
```

### 5.9 GET `/updates/manifest?platform=darwin&arch=arm64&channel=stable`

アプリ更新情報（自動アップデート通知用）。

Response `200`:

```json
{
  "requestId": "req_...",
  "latestVersion": "0.2.3",
  "publishedAt": "2026-02-18T00:00:00Z",
  "notesUrl": "https://tex64.com/releases/0.2.3",
  "required": false,
  "artifactUrl": "https://downloads.tex64.com/...",
  "artifactSha256": "a3f6...64hex...",
  "signature": "base64..."
}
```

- `artifactSha256`（推奨）: `sha256` の 64桁hex、または `sha256:<hex>` / `sha256-<base64>`
- アプリはダウンロード後にハッシュ検証し、検証失敗時はインストーラを起動しない

## 6. サーバー強制ルール（必須）

- AI API は必ずサーバー側で以下を判定:
  - 認証
  - `entitlements.ai.enabled`
  - quota（cost/tokens/requests）
  - rate limit（短時間）
- 失敗時は `ENTITLEMENT_REQUIRED` または `AI_QUOTA_EXCEEDED` を返す。
- クライアント側の上限チェックは UX 向上用。防衛はサーバー側が正とする。

## 7. アプリ実装ルール（v1）

- 非契約時の挙動:
  - AIチャット: 無効 + 購入導線表示
  - ゴースト補完: 無効
  - それ以外（編集/ビルド/検索/SyncTeX）は通常利用可
- 起動時:
  - `entitlements` と `updates/manifest` を取得
  - 取得失敗時は前回キャッシュを利用（TTL 24h）

## 8. リンク方針（tex64.com）

- Legal: `https://tex64.com/legal/*`
- ダウンロード: `https://tex64.com/download`
- リリースノート: `https://tex64.com/releases/*`
- フィードバックUI（Web）: `https://tex64.com/feedback`

## 9. 今回の固定事項（変更しない）

- 課金対象は AI のみ
- 更新通知からの自動更新を実装
- フィードバックは自前 API を使用

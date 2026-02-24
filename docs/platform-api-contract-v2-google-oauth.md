# TeX64 Platform API Contract v2 (Google OAuth)

この仕様は以下を固定します。

- 課金対象は AI 機能のみ
- 判定タイミングは起動時ではなく AI 利用時
- プランは `free / basic / pro`
- `basic` は内部的に `$1` 相当、`pro` は `$10` 相当
- クライアント表示は「トークン量のみ」（金額は非表示）
- 課金周期は月次
- 決済失敗時は `3日 grace`

## 1. Base

- API Base URL: `https://tex64.com/api/v2`
- Web Base URL: `https://tex64.com`
- 文字コード: UTF-8
- Content-Type: `application/json`

## 2. 認証 (Google OAuth + App Token)

アプリは Google トークンを直接使わず、TeX64 の App Token へ交換して利用する。

### 2.1 POST `/auth/google/start`

Google 認可 URL を取得。

Request:

```json
{
  "deviceId": "uuid-v4",
  "redirectUri": "tex64://oauth/callback",
  "codeChallenge": "pkce_challenge",
  "codeChallengeMethod": "S256"
}
```

Response:

```json
{
  "requestId": "req_...",
  "authUrl": "https://accounts.google.com/...",
  "state": "st_..."
}
```

### 2.2 POST `/auth/google/exchange`

Request:

```json
{
  "code": "google_auth_code",
  "state": "st_...",
  "redirectUri": "tex64://oauth/callback",
  "codeVerifier": "pkce_verifier",
  "deviceId": "uuid-v4"
}
```

Response:

```json
{
  "requestId": "req_...",
  "accessToken": "jwt_access",
  "refreshToken": "jwt_refresh",
  "expiresInSec": 900,
  "user": {
    "id": "usr_...",
    "email": "user@example.com",
    "name": "Example User"
  }
}
```

### 2.3 POST `/auth/refresh`

Request:

```json
{
  "refreshToken": "jwt_refresh",
  "deviceId": "uuid-v4"
}
```

Response: `accessToken` / `refreshToken` を再発行。

### 2.4 POST `/auth/logout`

Request:

```json
{
  "deviceId": "uuid-v4",
  "allDevices": false
}
```

Response:

```json
{
  "requestId": "req_...",
  "status": "ok",
  "revokedCount": 1
}
```

### 2.5 GET `/auth/google/callback`

Google OAuth の redirect URI を `https://tex64.com/api/v2/auth/google/callback` にした場合、
このエンドポイントが `tex64://oauth/callback` へ `302` で中継する。

## 3. プランと状態

- `free`: AI は基本 0 トークン（キャンペーンで付与可）
- `basic`: 月次トークン上限 = 内部的に `$1` 相当から算出
- `pro`: 月次トークン上限 = 内部的に `$10` 相当から算出

状態:

- `active`: 通常利用可
- `grace`: 決済失敗後3日。AI利用可
- `past_due`: grace終了後。AI利用不可
- `canceled`: AI利用不可

## 4. 月次クォータ算出（サーバー内部）

ユーザーには金額を表示しない。サーバーで月初にトークン上限を確定し、その値のみ返す。

内部計算:

1. `budgetUsd` をプランから決定（basic=1, pro=10）
2. `blendedCostPerTokenUsd` をサーバー設定から算出（モデル単価から計算）
3. `monthlyLimitTokens = floor(budgetUsd / blendedCostPerTokenUsd)`
4. `monthlyLimitTokens` をその月の固定値として保存（途中変更しない）

注: クライアントは `monthlyLimitTokens` のみ表示し、`budgetUsd` は返さない。

## 5. Feature 判定（AI利用時）

### 5.1 GET `/me/features?names=ai`

Response:

```json
{
  "requestId": "req_...",
  "user": {
    "id": "usr_...",
    "plan": "basic"
  },
  "features": {
    "ai": {
      "enabled": true,
      "reason": "active",
      "status": "active",
      "graceEndsAt": null,
      "periodStart": "2026-02-01T00:00:00Z",
      "periodEnd": "2026-03-01T00:00:00Z",
      "quota": {
        "limitTokens": 123456,
        "usedTokens": 4567,
        "remainingTokens": 118889,
        "usedRequests": 91,
        "remainingRequests": 9909
      }
    }
  }
}
```

クライアント実装ルール:

- AI送信直前（chat/completion実行前）に呼ぶ
- 成功結果は短時間キャッシュ（推奨 60秒）
- `enabled=false` の場合のみ課金導線を表示

## 6. AI API（サーバー判定が正）

### 6.1 POST `/ai/chat`

`/ai/chat` はエージェント実行用。ツール呼び出し（function call）を返せることを前提にする。

Request（Gemini互換）例:

```json
{
  "contents": [
    { "role": "user", "parts": [{ "text": "図表番号を整えて" }] }
  ],
  "systemInstruction": {
    "parts": [{ "text": "..." }]
  },
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "read_file",
          "description": "Read a file",
          "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
        }
      ]
    }
  ],
  "toolConfig": { "functionCallingConfig": { "mode": "AUTO" } },
  "generationConfig": { "temperature": 0.2 }
}
```

Response（function call あり）例:

```json
{
  "requestId": "req_...",
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "functionCall": {
              "name": "read_file",
              "args": { "path": "main.tex" }
            }
          }
        ]
      }
    }
  ],
  "usage": {
    "inputTokens": 900,
    "outputTokens": 120,
    "totalTokens": 1020
  },
  "quota": {
    "limitTokens": 123456,
    "usedTokens": 6067,
    "remainingTokens": 117389,
    "usedRequests": 92,
    "remainingRequests": 9908,
    "periodEnd": "2026-03-01T00:00:00Z"
  }
}
```

Response（最終テキスト）では `parts[].text` を返す。
互換性のため、OpenAI互換 (`choices[].message.tool_calls`) を返してもよい。
クライアントは Gemini 互換へ正規化して扱う。

### 6.2 POST `/ai/completion`

共通:

- 認証必須
- サーバーで `feature`, `quota`, `rate limit` を必ず判定
- 成功時に使用量と残量を返す

Response 例:

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
    "quotaConsumedTokens": 1500
  },
  "quota": {
    "limitTokens": 123456,
    "usedTokens": 6067,
    "remainingTokens": 117389,
    "usedRequests": 92,
    "remainingRequests": 9908,
    "periodEnd": "2026-03-01T00:00:00Z"
  }
}
```

## 7. 使用量可視化 API

### GET `/me/usage/ai?period=current_month`

Response:

```json
{
  "requestId": "req_...",
  "period": "2026-02",
  "plan": "basic",
  "summary": {
    "limitTokens": 123456,
    "usedTokens": 6067,
    "remainingTokens": 117389,
    "usedRequests": 92,
    "remainingRequests": 9908,
    "periodStart": "2026-02-01T00:00:00Z",
    "periodEnd": "2026-03-01T00:00:00Z"
  },
  "byFeature": {
    "chat": { "usedTokens": 5000, "usedRequests": 70 },
    "completion": { "usedTokens": 1067, "usedRequests": 22 }
  }
}
```

## 8. フィードバック API（自前）

### POST `/feedback`

Request:

```json
{
  "category": "bug",
  "message": "SyncTeX failed on PDF click",
  "contactEmail": "user@example.com",
  "app": {
    "version": "0.2.0",
    "platform": "darwin-arm64"
  },
  "diagnostics": {
    "included": true,
    "payload": "text"
  }
}
```

Response:

```json
{
  "requestId": "req_...",
  "feedbackId": "fb_...",
  "status": "accepted"
}
```

## 9. アップデート API

### GET `/updates/manifest?platform=darwin&arch=arm64&channel=stable`

Response:

```json
{
  "requestId": "req_...",
  "latestVersion": "0.2.3",
  "required": false,
  "notesUrl": "https://tex64.com/releases/0.2.3",
  "artifactUrl": "https://downloads.tex64.com/...",
  "artifactSha256": "a3f6...64hex...",
  "signature": "base64..."
}
```

- `artifactSha256`（推奨）: `sha256` の 64桁hex、または `sha256:<hex>` / `sha256-<base64>` 形式
- アプリはダウンロード後にハッシュ検証し、検証失敗時は適用しない

## 10. エラーコード

- `AUTH_REQUIRED`
- `TOKEN_EXPIRED`
- `FEATURE_NOT_ENABLED`
- `PLAN_REQUIRED`
- `QUOTA_EXCEEDED`
- `RATE_LIMITED`
- `PAYMENT_GRACE`
- `PAYMENT_PAST_DUE`
- `VALIDATION_ERROR`
- `INTERNAL_ERROR`

共通フォーマット:

```json
{
  "requestId": "req_...",
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "AI monthly token quota exceeded.",
    "retryAfterSec": 3600
  }
}
```

## 11. 3日 Grace の厳密ルール

- 決済失敗時、`status=grace` に遷移し `graceEndsAt = periodEnd + 3 days`
- grace期間中は `features.ai.enabled = true`
- grace期間中は月次クォータを新規付与しない（前回の残量/上限を維持）
- `graceEndsAt` を過ぎると `status=past_due`, `features.ai.enabled = false`
- 決済復旧で `status=active` に戻し、次の課金周期で通常リセット

## 12. クライアント表示ルール（重要）

- 表示してよい: `plan`, `limitTokens`, `usedTokens`, `remainingTokens`, `periodEnd`
- 表示しない: `$1`, `$10`, USD金額、単価
- 無料機能（編集/ビルド/閲覧等）は常に利用可

## 13. 内部Webhook契約（課金状態反映）

`tex64.com` 側のWebhook処理は、最終的に以下へ反映する。

- `POST /internal/subscription`
- Header:
  - `X-Tex64-Admin-Secret`
  - `X-Tex64-Webhook-Source`（推奨）
  - `X-Tex64-Event-Id`（推奨）

冪等:

- `source + eventId` を重複キーとして扱う
- 既処理イベントは `200` + `duplicate=true` を返す

詳細運用は `docs/subscription-webhook-bridge.md` を参照。

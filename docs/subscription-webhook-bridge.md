# Subscription Webhook Bridge（tex64.com → tex64 app API）

最終更新: 2026-02-23

このドキュメントは、`tex64.com` 側（Stripe webhook処理済み）から、
このリポジトリの `POST /api/v2/internal/subscription` へ購読状態を反映する結線仕様です。

## 1. Endpoint

- URL: `https://<tex64-app-api-host>/api/v2/internal/subscription`
- Method: `POST`
- Content-Type: `application/json`

## 2. 認証ヘッダー

- 必須: `X-Tex64-Admin-Secret: <TEX64_PLATFORM_ADMIN_SECRET>`

## 3. 冪等性（推奨: 必須運用）

同一イベントの重複配送対策として、イベントIDを必ず送信してください。

- 推奨ヘッダー:
  - `X-Tex64-Webhook-Source: tex64.com`
  - `X-Tex64-Event-Id: <provider_event_id>`
- 代替: `Idempotency-Key: <provider_event_id>`
- body でも可:
  - `source`
  - `eventId`

サーバーは `source + eventId` で重複判定し、既処理イベントは `200` + `duplicate: true` を返します。

## 4. Request body

```json
{
  "email": "user@example.com",
  "plan": "basic",
  "status": "active",
  "billingPeriodStart": "2026-02-01T00:00:00Z",
  "billingPeriodEnd": "2026-03-01T00:00:00Z",
  "graceEndsAt": null,
  "quotaLimitTokens": 500000,
  "quotaLimitRequests": 10000,
  "resetUsage": true,
  "source": "tex64.com",
  "eventId": "evt_123"
}
```

許容値:

- `plan`: `free` / `basic` / `pro`
- `status`: `active` / `grace` / `past_due` / `canceled`
- ユーザー識別は `userId` または `email` のどちらか必須
- `billingPeriodStart` / `billingPeriodEnd` を送る場合、`quotaPeriodStart` / `quotaPeriodEnd` 未指定でも同値に自動同期される
- `quotaLimitTokens` / `quotaLimitRequests` 未指定時:
  - プラン変更時は新プランの既定上限へ自動再計算
  - 請求期間変更時（更新イベント）は新期間の既定上限へ自動再計算
- `resetUsage` は通常不要（期間同期で usage period が変わると自動で新期間にリセットされる）

## 5. Response body

```json
{
  "requestId": "req_...",
  "duplicate": false,
  "source": "tex64.com",
  "eventId": "evt_123",
  "user": { "id": "usr_...", "email": "user@example.com", "name": null },
  "subscription": { "plan": "basic", "status": "active", "...": "..." },
  "summary": { "limitTokens": 500000, "usedTokens": 0, "...": "..." },
  "byFeature": {
    "chat": { "usedTokens": 0, "usedRequests": 0 },
    "completion": { "usedTokens": 0, "usedRequests": 0 }
  }
}
```

## 6. 失敗時の扱い

- `401 AUTH_REQUIRED`: admin secret不一致（再試行せず設定確認）
- `400 VALIDATION_ERROR`: payload不正（再試行せず修正）
- `5xx`: 一時障害（指数バックオフで再試行）

## 7. 重複イベント保持期間

- `TEX64_PLATFORM_SUBSCRIPTION_EVENT_TTL_SEC`（デフォルト: 90日）
- 期間を過ぎたイベントは自動的に重複判定対象から削除されます

## 8. 推奨リトライ方針（tex64.com 側）

1. 最低 24 時間は指数バックオフで再送
2. 同じ `eventId` を再送し続ける（新規IDを振らない）
3. `200 duplicate=true` は成功扱いで配送停止

## 9. 送信例（curl）

```bash
curl -X POST "https://<tex64-app-api-host>/api/v2/internal/subscription" \
  -H "Content-Type: application/json" \
  -H "X-Tex64-Admin-Secret: $TEX64_PLATFORM_ADMIN_SECRET" \
  -H "X-Tex64-Webhook-Source: tex64.com" \
  -H "X-Tex64-Event-Id: evt_123" \
  --data '{
    "email":"user@example.com",
    "plan":"pro",
    "status":"active",
    "billingPeriodStart":"2026-02-01T00:00:00Z",
    "billingPeriodEnd":"2026-03-01T00:00:00Z",
    "resetUsage":true
  }'
```

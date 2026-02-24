# Platform Entitlement Backend (実装メモ)

最終更新: 2026-02-23

この実装は、`/api/v2` に以下を追加しています。

- `POST /api/v2/auth/google/start`
- `POST /api/v2/auth/google/exchange`
- `POST /api/v2/auth/refresh`
- `POST /api/v2/auth/logout`
- `GET /api/v2/auth/google/callback`（`tex64://oauth/callback` へのブリッジ）
- `GET /api/v2/me/features?names=ai`
- `GET /api/v2/me/usage/ai?period=current_month`
- `POST /api/v2/ai/chat`
- `POST /api/v2/ai/completion`
- `POST /api/v2/internal/subscription`（管理用。Webhook/運用バッチから呼び出す想定）

## 実装済み範囲

- `free / basic / pro`
- `active / grace / past_due / canceled`
- grace は `3日`（`TEX64_PLATFORM_GRACE_DAYS`）
- 月次 quota 計算（`basic=$1`, `pro=$10` 相当の内部予算から token 上限を算出）
- quota 消費（chat/completion 別集計）
- quota 復帰（`active` で月跨ぎ時に自動リセット）
- `grace` 中は quota 期間を固定し、新規付与しない
- `past_due` で AI 無効化
- Postgres（`DATABASE_URL`）への永続化
  - users / subscriptions / usage
  - oauth state request
  - refresh token rotate/revoke
- DB未設定時の fallback（`TEX64_PLATFORM_STATE_FALLBACK=true`）で JSON ストア継続動作

## まだ別スレッドで扱う範囲

- Stripe Checkout / Webhook / Customer Portal

## 必須環境変数

- `TEX64_PLATFORM_JWT_SECRET`
- `GEMINI_API_KEY`
- `DATABASE_URL`（本番では必須。開発のみ fallback 可）
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`（Google OAuthを使う場合）
- `TEX64_PLATFORM_ADMIN_SECRET`（`/internal/subscription` を使う場合）

## 主な任意環境変数

- `TEX64_PLATFORM_STATE_FILE`（デフォルト: `/tmp/tex64-platform-v2-state.json`）
- `TEX64_PLATFORM_STATE_FALLBACK`（デフォルト: 非production時 `true`）
- `TEX64_PLATFORM_BLEND_COST_PER_TOKEN_USD`（デフォルト: `0.000002`）
- `TEX64_PLATFORM_BASIC_USD`（デフォルト: `1`）
- `TEX64_PLATFORM_PRO_USD`（デフォルト: `10`）
- `TEX64_PLATFORM_FREE_MONTHLY_TOKENS`（デフォルト: `0`）
- `TEX64_PLATFORM_REQUEST_LIMIT_FREE`（デフォルト: `100`）
- `TEX64_PLATFORM_REQUEST_LIMIT_BASIC`（デフォルト: `10000`）
- `TEX64_PLATFORM_REQUEST_LIMIT_PRO`（デフォルト: `100000`）
- `TEX64_PLATFORM_GRACE_DAYS`（デフォルト: `3`）
- `TEX64_PLATFORM_WEB_BASE_URL`（デフォルト: `https://tex64.com`）
- `TEX64_PLATFORM_OAUTH_STATE_TTL_SEC`（デフォルト: `600`）
- `TEX64_PLATFORM_SUBSCRIPTION_EVENT_TTL_SEC`（デフォルト: `7776000` / 90日）
- `TEX64_PLATFORM_MOCK_OAUTH`（デフォルト: `false`）
- `TEX64_PLATFORM_MOCK_OAUTH_EMAIL`（デフォルト: `dev@tex64.com`）
- `GEMINI_MODEL`（デフォルト: `gemini-3-flash-preview`）

## 運用上の接続ポイント

Stripe Webhook 側は、決済イベント時に `POST /api/v2/internal/subscription` を呼び、
`plan/status/billingPeriodStart/billingPeriodEnd/graceEndsAt` を反映してください。

重複イベントを避けるため、`source + eventId` を送ってください（サーバー側で冪等処理）。
詳細は `docs/subscription-webhook-bridge.md` を参照。

リクエスト例:

```json
{
  "email": "user@example.com",
  "plan": "basic",
  "status": "active",
  "billingPeriodStart": "2026-02-01T00:00:00Z",
  "billingPeriodEnd": "2026-03-01T00:00:00Z",
  "resetUsage": true
}
```

ヘッダー:

- `X-Tex64-Admin-Secret: <TEX64_PLATFORM_ADMIN_SECRET>`
- `X-Tex64-Webhook-Source: tex64.com`（推奨）
- `X-Tex64-Event-Id: <provider_event_id>`（推奨）

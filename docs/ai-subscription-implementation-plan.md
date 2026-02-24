# AI Subscription Implementation Plan (v2)

対象: `free / basic / pro`、Google OAuth、AIのみ課金、3日grace、トークン表示のみ

## 実装状況（2026-02-23）

- このリポジトリに `api/v2` の entitlement/quota 基盤を追加済み
  - `GET /api/v2/me/features?names=ai`
  - `GET /api/v2/me/usage/ai?period=current_month`
  - `POST /api/v2/ai/chat`
  - `POST /api/v2/ai/completion`
  - `POST /api/v2/internal/subscription`（Webhook連携用の内部反映先）
- Stripe/Webhook本体と外部DB接続は別実装として切り出し
- 詳細は `docs/platform-entitlement-backend.md` を参照

## Phase 0: 前提設定（先に固定）

1. サーバー環境変数
   - Google OAuth Client ID / Secret
   - JWT Secret
   - Plan budget（internal）: `BASIC_USD=1`, `PRO_USD=10`
   - blended単価計算用パラメータ
2. 公開URL
   - `https://tex64.com/pricing`
   - `https://tex64.com/legal/*`
   - `https://tex64.com/releases/*`
3. Deep Link
   - `tex64://oauth/callback`

## Phase 1: バックエンドAPI実装

1. 認証
   - `POST /auth/google/start`
   - `POST /auth/google/exchange`
   - `POST /auth/refresh`
2. entitlement / usage
   - `GET /me/features?names=ai`
   - `GET /me/usage/ai?period=current_month`
3. AI実行
   - `POST /ai/chat`
   - `POST /ai/completion`
   - サーバー側で `feature/quota/rate limit` 判定
4. feedback
   - `POST /feedback`
5. updates
   - `GET /updates/manifest`
6. billing state machine
   - `active -> grace(3days) -> past_due`
   - grace中のクォータ挙動を仕様通り適用

## Phase 2: Electron Main 側

1. 認証/セッション管理サービス追加
   - Access/Refresh保存
   - refresh自動更新
2. IPC追加
   - `auth:google:start`
   - `auth:google:exchange`
   - `feature:check`
   - `usage:get`
   - `feedback:send`
   - `update:check` / `update:download` / `update:install`
3. 既存AI呼び出し前ガード
   - `agent:run` 直前
   - `api:ghostCompletion` 直前

## Phase 3: Renderer 側（アプリUI）

1. AIタブ状態UI
   - `logged_out`
   - `logged_in_not_entitled`
   - `entitled`
2. 送信時オンデマンド判定
   - AI送信/補完の直前に `feature:check(ai)`
   - 60秒キャッシュ
3. 使用量可視化
   - `used/limit/remaining tokens`
   - `used/remaining requests`
   - `period end`
4. 課金導線
   - `tex64.com/pricing`
5. フィードバック導線
   - アプリ内送信（`POST /feedback`）

## Phase 4: 自動アップデート

1. `electron-updater` を組み込み
2. 更新フロー
   - チェック
   - 通知
   - ダウンロード
   - ユーザー操作で再起動適用
3. `tex64.com` 配信に接続
4. リリースノート導線（`notesUrl`）

## Phase 5: テスト

1. Unit
   - entitlement判定
   - quota超過処理
   - grace状態遷移
2. E2E
   - 未ログイン時AIブロック
   - 未課金時AIブロック
   - 課金ユーザーAI許可
   - quota超過時エラー表示
   - update通知から更新導線
3. 回帰
   - 無料機能（編集/ビルド/検索）は常に使えること

## Phase 6: 運用

1. 監査ログ
   - AI実行, quota消費, entitlement判定
2. アラート
   - 認証失敗率
   - AI API失敗率
   - 更新配信失敗率
3. サポート運用
   - `feedbackId` で追跡

## 最初の実装順（推奨）

1. Phase 1 の `auth + features + usage + ai guard` まで
2. Phase 2/3 の最低UI（AIタブガード + 使用量表示）
3. その後 Phase 4 の自動アップデート

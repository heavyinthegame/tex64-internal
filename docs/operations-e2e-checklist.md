# TeX64 初回導入〜課金利用開始 E2E チェックリスト（運用版）

最終更新: 2026-02-26

このチェックリストは、以下を **本番運用レベルで通す** ためのものです。

- ユーザーが `tex64.com` からダウンロード
- macOS で起動・初期セットアップ
- Google OAuth ログイン
- 課金（free/basic/pro）と 3日猶予（grace）を含む権限判定
- AI 利用開始と使用量可視化
- 更新導線・フィードバック導線の確認

---

## 0. 実施テンプレート

### 0.1 実施情報

- [ ] 実施日時（UTC/JST）を記録
- [ ] 実施者を記録
- [ ] 対象 app version（例: `0.1.0`）を記録
- [ ] 対象環境（production / staging）を記録
- [ ] 使用OS/arch（例: macOS 14 arm64）を記録

### 0.2 証跡ルール

- [ ] 各チェックに「Pass/Fail」「証跡URL/スクリーンショット」「メモ」を残す
- [ ] Fail は再現手順を1行で残す
- [ ] P0 Fail（課金/認証/AI実行不可/更新不可）は Go 判定しない

---

## 1. 事前準備（必須）

### 1.1 基本エンドポイント

- [ ] `https://tex64.com/download` が開ける
- [ ] `https://tex64.com/api/v2/updates/manifest?platform=darwin&arch=arm64&channel=stable` が 200 を返す
- [ ] `https://downloads.tex64.com/` が公開到達できる

### 1.2 サーバー設定（production）

- [ ] `DATABASE_URL` が設定済み（fallback運用でない）
- [ ] Google OAuth 設定（Client ID/Secret, redirect URI）が本番値
- [ ] Stripe 側（Checkout/Portal/Webhook）が本番環境に接続済み
- [ ] `TEX64_PLATFORM_ADMIN_SECRET` が設定済み（内部API検証用）

### 1.3 テストアカウント

- [ ] Googleアカウント（新規 or 専用検証アカウント）を1つ用意
- [ ] Stripeテスト用決済手段（成功/失敗ケース）を用意
- [ ] 既存セッションをクリア（テスト干渉防止）

---

## 2. ダウンロード〜インストール

### 2.1 ダウンロード導線

- [ ] `tex64.com/download` から DMG ダウンロード開始できる
- [ ] ダウンロードURLが `downloads.tex64.com` 配下になっている
- [ ] ファイル名に version/arch が含まれている（例: `TeX64-0.1.0-mac-arm64.dmg`）

### 2.2 インストール

- [ ] DMG を開いて `TeX64.app` を `Applications` へドラッグできる
- [ ] アプリ起動時にクラッシュしない
- [ ] 署名/Notarization警告で通常導線が塞がれない

---

## 3. 初回起動（無料機能）

### 3.1 プロジェクト導線

- [ ] ランチャーが表示される
- [ ] 新規プロジェクト作成が成功する
- [ ] `main.tex` で Build 成功し、PDFが表示される

### 3.2 Runtimeチェック

- [ ] Settings > Runtime のコマンド状態表示が取得できる
- [ ] TeX未導入時は不足表示と案内が出る
- [ ] AI未利用でも編集/ビルド等の主要機能が使える（無料継続利用可能）

---

## 4. Google OAuth（AI利用時のみ要求）

### 4.1 ゲート確認

- [ ] 未ログインで AI 実行を試すと、ログイン導線が表示される
- [ ] 起動直後にはログイン強制されない（AIタブ利用時に要求）

### 4.2 ログイン成功

- [ ] Google OAuth 画面が外部ブラウザで開く
- [ ] 承認後、アプリへ復帰してログイン完了状態になる
- [ ] セッション再起動後も有効（refresh動作）

### 4.3 異常系

- [ ] OAuth をキャンセルしてもアプリが不整合状態にならない
- [ ] 無効 state/code の場合、認証エラー表示で終了し再試行できる

---

## 5. 課金・権限（free/basic/pro + status）

### 5.1 free（初期）

- [ ] freeで `AI enabled=false`（または freeルール通りの制限値）になる
- [ ] 価格導線（`tex64.com/pricing`）に遷移できる

### 5.2 basic 購入フロー

- [ ] Checkout開始できる（課金UIはWeb側）
- [ ] 決済成功後、`/me/features` が `plan=basic` へ反映
- [ ] アプリ側も短時間で basic 表示へ同期
- [ ] AI 実行可能になる

### 5.3 pro 変更フロー

- [ ] basic→pro の変更が反映される
- [ ] `/me/features` の quota 上限が basic より大きい
- [ ] UI は「金額」でなく「トークン上限/残量」のみ表示する

### 5.4 決済失敗と 3日猶予

- [ ] 決済失敗直後に `status=grace` へ遷移できる
- [ ] grace 中は AI 利用可能
- [ ] grace 終了後 `past_due` で AI 利用不可

---

## 6. 使用量可視化（AI tokens / requests）

### 6.1 UI表示

- [ ] AI 実行後に `usedTokens` が増える
- [ ] `remainingTokens` が減る
- [ ] `usedRequests` が増える

### 6.2 API一致

- [ ] `GET /api/v2/me/features?names=ai` の quota と UIが一致
- [ ] `GET /api/v2/me/usage/ai?period=current_month` の summary と UIが一致
- [ ] 月境界（periodStart/periodEnd）が整合する

### 6.3 上限制御

- [ ] quota超過時に AI 実行がブロックされる
- [ ] ブロック時の理由（quota/past_due/canceled）がユーザーに明示される

---

## 7. 内部APIによる境界テスト（運用前に必須）

以下は Stripe webhook の代替として、状態遷移だけを直接検証するための運用テストです。

### 7.1 変数準備

- [ ] `BASE=https://tex64.com/api/v2`
- [ ] `ADMIN=<TEX64_PLATFORM_ADMIN_SECRET>`
- [ ] `EMAIL=<検証ユーザーのメール>`

### 7.2 状態切替（event重複防止で eventId を毎回変える）

- [ ] free active に戻す（`resetUsage=true`）
- [ ] basic active
- [ ] pro active
- [ ] basic grace
- [ ] basic past_due
- [ ] basic canceled

実行例:

```bash
BASE="https://tex64.com/api/v2"
ADMIN="***"
EMAIL="e2e-user@example.com"

curl -X POST "$BASE/internal/subscription" \
  -H "x-tex64-admin-secret: $ADMIN" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"plan\":\"free\",\"status\":\"active\",\"resetUsage\":true,\"source\":\"e2e\",\"eventId\":\"e2e-free-001\"}"

curl -X POST "$BASE/internal/subscription" \
  -H "x-tex64-admin-secret: $ADMIN" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"plan\":\"basic\",\"status\":\"grace\",\"source\":\"e2e\",\"eventId\":\"e2e-grace-001\"}"
```

### 7.3 期待結果

- [ ] `active`: AI 利用可
- [ ] `grace`: AI 利用可（3日猶予）
- [ ] `past_due`: AI 利用不可
- [ ] `canceled`: AI 利用不可
- [ ] idempotency（同じ `source+eventId`）で重複適用されない

---

## 8. 自動アップデート導線

### 8.1 検知

- [ ] Settings > Runtime に update 状態表示が出る
- [ ] background check で更新が見つかった時に通知が出る

### 8.2 ダウンロード/検証

- [ ] 更新ダウンロードが進捗付きで進む
- [ ] sha256 検証一致時のみ `downloaded` になる
- [ ] sha256 不一致時は適用せずエラー表示になる

### 8.3 適用

- [ ] 「更新を適用」でインストーラ起動
- [ ] 失敗時はフォールバックURL（release note/download）へ誘導

---

## 9. フィードバック/エラーレポート

### 9.1 設定タブ導線

- [ ] 設定タブからフィードバック送信できる
- [ ] 任意の診断情報添付 ON/OFF が機能する
- [ ] 送信成功/失敗時に適切なUI表示が出る

### 9.2 保存/運用

- [ ] サーバー側で feedback が保存される
- [ ] エラーレポート（匿名/認証あり）が受理される
- [ ] 通知連携（Webhook等）を使う場合は通知も確認する

---

## 10. セキュリティ/運用ガード

### 10.1 シークレット管理

- [ ] GitHub Secrets に平文漏洩がない
- [ ] Vercel環境変数に本番/検証が混在していない
- [ ] `TEX64_PLATFORM_ADMIN_SECRET` は運用担当のみ共有

### 10.2 APIガード

- [ ] `internal/subscription` へ secretなしアクセスが 401
- [ ] 認証なしで `/me/features` `/me/usage` が通らない
- [ ] レート制限/監査ログの最低限運用方針がある

---

## 11. Go / No-Go 判定

### 11.1 P0（1つでもFailならNo-Go）

- [ ] DMGダウンロード不可がない
- [ ] 起動/編集/Buildの致命障害がない
- [ ] Google OAuthログイン成功
- [ ] basic/proでAI利用可能
- [ ] past_due/canceledでAIが正しく止まる
- [ ] 使用量表示がAPIと一致
- [ ] 更新導線（検知/DL/検証/適用）が通る

### 11.2 判定記録

- [ ] 判定: Go / No-Go
- [ ] 判定者
- [ ] 判定日時
- [ ] リリース可否コメント


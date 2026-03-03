# 配布後にユーザーが使い始めるまでの完全監査（2026-02-21）

この章は「配布したアプリを新規ユーザーがインストールし、初回起動して、AI機能（OAuth/課金含む）を使い始めるまで」に必要な項目を、リポジトリ全体の実装ベースで棚卸ししたものです。

監査対象:

- `electron/**`
- `web-src/**`
- `Resources/web/**`
- `api/**`
- `docs/**`
- `tests/**`
- `.github/workflows/**`
- `package.json`
- `README.md`

判定ルール:

- 「実装済み」: このリポジトリ内のコードで動作実装が確認できる
- 「未実装」: このリポジトリ内に実装が存在しない（仕様/計画のみ）
- 「要修正」: 実装はあるが、利用開始導線として欠け・不整合がある

## 総合判定

- macOS配布、初回起動、ローカル編集/ビルドの導線は概ね成立
- ただし、ユーザーがAI有料利用を開始する導線（ユーザーDB/決済連携/権限反映）はこのリポジトリだけでは完結していない
- さらに、ランチャーと環境インストール導線に「初回体験を阻害する欠け」が残っている

## 1. OAuth 認証（Google）

実装済み:

- OAuth開始/交換/更新/サインアウト:
  - `electron/services/platform-access.cjs`
  - `startGoogleAuth`（`/auth/google/start`）
  - `completeGoogleAuthFromCallback`（`/auth/google/exchange`）
  - `refreshAccessToken`（`/auth/refresh`）
  - `signOut`（`/auth/logout`）
- Deep Link callback 受信:
  - `electron/main.cjs`（`tex64://oauth/callback` を `open-url` / `second-instance` で処理）
- 認証UIイベント:
  - `web-src/app/ai-chat-ui.ts`（`auth:google:start`, `auth:google:cancel`, `auth:signout`）
  - `electron/main.cjs`（IPCルーティング）
- URLスキーム登録:
  - `package.json` の `build.protocols`（`tex64`）

要注意（要件として未完了になり得る点）:

- OAuth バックエンドは `api/v2/auth/*` として実装済みだが、本番では `DATABASE_URL` と Google OAuth credential の設定が必須
- `TEX64_PLATFORM_STATE_FALLBACK` を本番で有効化しない（開発向け）

## 2. ユーザー情報DB（アカウント永続化）

実装済み（接続設定が必要）:

- `api/v2/_lib/db-adapter.js` で Postgres 永続化を実装
  - `tex64_users`, `tex64_subscriptions`, `tex64_usage`
  - `tex64_auth_requests`, `tex64_refresh_tokens`
- `api/v2/me/features`, `api/v2/me/usage/ai`, `api/v2/ai/*`, `api/v2/auth/*` は DB-first で動作
- `DATABASE_URL` 未設定時は `TEX64_PLATFORM_STATE_FALLBACK=true` の場合のみ JSON fallback

現状の保存先（ローカル）:

- 認証セッション: `electron/services/platform-access.cjs` → `tex64-platform-session.json`
- ユーザー設定/最近のプロジェクト: `electron/services/user-settings.cjs` → `tex64-user-settings.json`

セキュリティ注意点:

- セッションファイルは `0600` 保存（権限は適切）
- `safeStorage` が使えない場合はトークン暗号化が平文フォールバックになる設計

出荷前に必要なこと:

- `DATABASE_URL` 接続先の本番運用（バックアップ/監視/権限分離）
- Stripe Webhook から `POST /api/v2/internal/subscription` を呼んで subscription 状態を同期
  - `X-Tex64-Webhook-Source` / `X-Tex64-Event-Id` で冪等キーを送る
- クライアントの `me/features`, `me/usage`, `auth/refresh` の実運用検証

追記（2026-02-23）:

- このリポジトリに `api/v2` の entitlement/quota ロジックを追加済み
  - `GET /api/v2/me/features?names=ai`
  - `GET /api/v2/me/usage/ai?period=current_month`
  - `POST /api/v2/ai/chat`, `POST /api/v2/ai/completion`
  - `POST /api/v2/internal/subscription`（Webhook等からの状態反映用）
- ただし、Stripe本体と外部DB接続は引き続き別実装（この監査章の「未実装」判定範囲）

## 3. Stripe 等の課金導線

未実装（このリポジトリ内）:

- Stripe SDK/Checkout/Webhook/Customer Portal の実装は見当たらない
- `stripe` / `checkout.session` / `webhook` 等のコード参照は `electron web-src api docs tests package.json README.md` 上でヒットなし

現状実装:

- アプリ内からは pricing ページへ外部遷移するのみ
  - `electron/services/platform-access.cjs`（`getPricingUrl()`）
  - `web-src/app/ai-chat-ui.ts`（`openPricingPage()`）
  - `web-src/app/platform-links.ts`

仕様上の期待（ドキュメントのみ）:

- `docs/ai-subscription-implementation-plan.md`:
  - `active -> grace(3days) -> past_due` の状態遷移
- `docs/platform-api-contract-v2-google-oauth.md`:
  - entitlement/quota/API エラーコードの契約

出荷前に必要なこと:

- サーバーに決済連携（Stripe等）を実装し、支払い状態を `features.ai.enabled` に反映
- Grace/Past Due の遷移と復旧を本番データで検証
- pricing遷移だけでなく、決済完了後にアプリへ戻した際に entitlement が更新される導線を確立

## 4. ランチャー導線（初回UX）

要修正:

- テンプレート選択UIの不整合
  - TS側は `.launcher-template-button` を前提にテンプレート管理
  - HTML側にテンプレートボタンがない
  - CSSはテンプレートセクションを `display: none`
  - 影響: 新規作成テンプレート選択の仕様と実UIが不一致
- ランチャーステータスメッセージが表示されない
  - Main側は `launcherStatus.message` を送信（例: 「フォルダが見つかりません。」）
  - Rendererは受けるが `launcher-ui.ts` の `setStatus` が `message` を描画していない
  - 影響: 失敗理由が見えず、ユーザーが操作不能に見える
- 最近のプロジェクト削除導線が未接続
  - `onRemoveRecent` は定義されているが UI から呼ばれていない
  - 影響: 無効エントリをユーザーが明示削除しにくい
- 無効パス自動除去時の即時UI同期が弱い
  - 存在しない recent を除去しても `recentProjects` 再送がその経路にない
  - 影響: 同期タイミング次第で古い表示が残る可能性

出荷前に必要なこと:

- テンプレートUIの設計を統一（表示するか、機能自体を撤去するか）
- `launcherStatus.message` の表示領域を実装
- recent の削除/自動除去の双方で `recentProjects` を即時再配信

## 5. 実行環境セットアップ（TeX導入）

要修正:

- `electron/services/env.cjs` に MVP コメントが残り、インストールは best-effort 実行
- 自動インストール失敗時は手動コマンド案内へフォールバック
- `env:installStart` / `env:installResult` は Main から送っているが、bridge 側に受信処理がない
  - `web-src/app/bridge-handlers.ts` は `env:checkResult` のみ処理

影響:

- ユーザーはインストール進捗/成否をUIで追えない
- 「1クリック導入」体験として不完全

出荷前に必要なこと:

- install start/progress/result をUI表示
- 権限昇格・失敗時リトライ・手動導線への遷移を仕様化
- macOSに加え将来のWindows配布まで考えるなら、OSごとの確実な導線を定義

## 6. 配布対象と制約

現状:

- 配布対象は macOS のみ（`electron-builder --mac` / release workflow も macOS）
- TeX Distribution は同梱しない（ユーザー側インストール必須）

注意:

- 初回ビルド成功までの体験品質はランタイム導線に強く依存
- macOS以外（Windows/Linux）を対象にする場合は、配布・署名・導入手順を別途整備する必要がある

## 7. テスト不足（利用開始導線）

不足:

- `tests/e2e/implementation-coverage.md` は広範囲だが、以下を明示的に網羅していない
  - OAuth ログイン成功/失敗/キャンセルのE2E
  - 課金状態（active/grace/past_due）別のAI可否E2E
  - 決済復旧後の entitlement 復帰E2E
- OAuth は主に unit レベル（`tests/unit/platform-access-update-manifest.test.mjs`）で確認されている

出荷前に必要なこと:

- 上記3系統のE2Eを追加し、リリースゲートに組み込む

## 8. ドキュメント差分（運用ミスの原因）

要修正:

- `README.md` に記載の E2E 実行コマンド/環境変数が現行 `package.json` とずれている箇所がある
  - 例: `e2e:install`, `e2e`, `TEX180_*` 系の記述

影響:

- 開発者/QAが古い手順で検証し、導線不備を見逃す可能性がある

出荷前に必要なこと:

- README を実際の script/env に合わせる
- 配布前の最終確認手順を1つの Runbook に集約

## 9. セキュリティ・ハードニング（利用開始前に確認）

要確認:

- `Resources/web/index.html` の CSP が `default-src * 'unsafe-inline' 'unsafe-eval' ...` と広い
- OAuth/課金導線を本番公開する段階では、必要最小限の CSP へ絞ることを推奨

## 10. 最終E2E（OAuth→課金→反映）実行手順

`tex64.com` リポジトリで下記を実行する。

1. OAuth/初期entitlement（mock）
   - `npm run -s e2e:auth-billing:smoke -- --mode mock --base-url http://localhost:3000`
2. Checkout URL 発行確認
   - `npm run -s e2e:auth-billing:smoke -- --mode mock --plan basic --base-url http://localhost:3000`
3. 本番系最終確認（Google OAuth + Stripe）
   - `stripe listen --forward-to https://tex64.com/api/v2/billing/webhook`
   - `npm run -s e2e:auth-billing:smoke -- --mode google --oauth-code "<code>" --plan basic --wait-active-sec 180 --base-url https://tex64.com`
   - 合格条件: `features.after.enabled=true` かつ `reason=active|PAYMENT_GRACE`

## 利用開始導線の最終チェックリスト（必須）

以下がすべて満たされるまで、一般公開（外部ユーザー向け配布）は Go にしないこと。

- [ ] OAuth バックエンド（start/exchange/refresh/logout）が本番で稼働し、アプリから疎通できる
- [ ] ユーザーDB（アカウント・セッション・購読状態）が本番で永続化される
- [ ] Stripe等の決済連携（Checkout/Webhook/Portal）から entitlement へ反映される
- [ ] `active/grace/past_due` の遷移が本番データで検証済み
- [ ] pricing遷移後にアプリへ戻って利用可能状態が更新される
- [ ] ランチャー失敗メッセージが表示され、無効recentの除去が即時反映される
- [ ] recentの手動削除UIが使える（または仕様として削除機能なしに統一）
- [ ] 実行環境インストールの開始/完了/失敗がUIで見える
- [ ] TeX未導入ユーザーが迷わず初回ビルド成功まで到達できる
- [ ] OAuth/課金状態別のE2EがCIで安定通過する
- [ ] README/Runbookが現行コマンドと一致している
- [ ] CSPとトークン保存方針の本番ハードニング方針が確定している

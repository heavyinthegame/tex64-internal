# 配布（Release / Distribution）

tex64 は Electron アプリとして配布します（インストーラ/アプリバンドルを生成）。
現時点の公開対象は **macOS のみ** です。

## 前提

- Node.js / npm（CI は Node 20）
- `npm ci`
- TeX Distribution は **同梱しない**（ユーザー側で TeX Live / MacTeX / BasicTeX などが必要）
- `npm run -s dist:bootstrap`（macOS の場合。アイコン/entitlements を生成）
- 初回DL→課金→利用開始の運用E2Eは `docs/operations-e2e-checklist.md` を使用

## ローカルで配布物を作る

まず配布に必要なファイル（アイコン/NOTICE 等）を用意してからパッケージします。

### DMG の見た目（背景）

TeX64 の DMG は、Finder の背景を `assets/dmg/background.png`（+ `assets/dmg/background@2x.png`）でカスタマイズしています。

- ソース: `assets/dmg/background.html`
- 再生成: `npm run -s dmg:background`

また、`/Applications` へのショートカットは DMG 生成時に作成します。

補足: Electron-builder は Apple Silicon で **APFS DMG** を作ることがあり、最近の macOS で Finder の背景が表示されないケースがあります。
そのため `npm run -s release:mac`（署名/Notarization 含む）では、`scripts/build-macos-dmg.cjs` で **HFS+ DMG** を生成して背景/UIを安定させています。

さらに、DMG の Finder レイアウト（背景画像/アイコン位置）は **Finder が `.DS_Store` を生成する方式**で確実に反映させています（AppleScript）。
初回実行時に macOS から「Terminal（または実行元）が Finder を操作する」許可を求められたら許可してください。

```bash
npm run electron:pack
```

- `dist/` に unpacked アプリ（`--dir`）が生成されます。
- 起動確認用途（本番配布より速い）。

配布用（インストーラ等）を作る:

```bash
npm run electron:dist
```

- 現在は macOS のみ配布するため、`electron:dist` / `electron:dist:mac` のどちらでも macOS 配布物を生成します。

### 公開向け（macOS）

```bash
npm run electron:dist:mac
```

配布物（`dist/*.dmg` / `dist/*.zip`）から、公開用の補助ファイルを作る（tex64.com 連携用）:

```bash
npm run -s release:bundle
```

- `release/checksums-sha256.txt` と `update/stable.json` を生成します。

## 初回導入（macOS）

1. `TeX64-<version>-mac-<arch>.dmg` を開く
2. `TeX64.app` を `Applications` にドラッグ
3. `Applications` から起動し、Settings > 実行環境で `lualatex` / `latexmk` / `latexindent` / `synctex` を確認

### 初回起動でブロックされた場合

- 正式リリースでは署名 + Notarization によりブロックされない前提
- 署名前の開発版でのみ回避が必要な場合は、Finder の「開く」から許可する

## 重要: ネイティブ依存（Math OCR / onnxruntime）

- `onnxruntime-node` はネイティブバイナリを含むため、ASAR 内だと動かないファイルがあります。
- `Resources/math-ocr/*`（モデル）も実ファイルパスが必要です。
- そのため `package.json` の `build.asarUnpack` で `Resources/math-ocr/**` とネイティブ拡張子（`.node/.dll/.dylib/.so*`）を unpack 対象にしています。

## 署名 / Notarization（公開必須）

TeX64 を一般配布（Gatekeeper を通す）するには、macOS の **Developer ID 署名 + Notarization** が必須です。

- macOS: Developer ID 署名 + Hardened Runtime + Notarization（必須）

### 署名（Developer ID）

- 必要な証明書: **Developer ID Application**
- Electron 側の要件として Hardened Runtime を有効にし、JIT 等に必要な entitlements を付与します。
  - `build/entitlements.mac.plist`
  - `build/entitlements.mac.inherit.plist`

### Notarization（notarytool）

electron-builder は、次のいずれかの認証情報がある場合に Notarization を実行します（未設定ならスキップ）。

1) Apple ID + App-Specific Password:

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

2) App Store Connect API key:

- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

3) keychain profile（推奨）:

- `APPLE_KEYCHAIN_PROFILE`（必要なら `APPLE_KEYCHAIN` も）

### ローカルで「署名 + Notarization + 検証」まで通す（macOS）

GitHub Actions が使えない/使わない場合でも、macOS だけならローカルで完結できます。

前提:

- Xcode Command Line Tools（`xcrun notarytool` が使えること）
- Developer ID Application 証明書が Keychain にあること

手順（keychain profile 推奨）:

1. notarytool の認証情報を Keychain に保存

```bash
xcrun notarytool store-credentials tex64-notary \
  --apple-id "<your-apple-id>" \
  --team-id "<your-team-id>" \
  --password "<app-specific-password>"
```

2. 環境変数を設定してリリースビルド（署名/Notarization/検証まで実行）

```bash
export APPLE_KEYCHAIN_PROFILE=tex64-notary
# （任意）update feed 生成用。未指定なら https://downloads.tex64.com を使います。
export TEX64_DOWNLOADS_PUBLIC_BASE_URL=https://downloads.tex64.com
# （任意）arm64/x64。未指定なら実行環境に合わせます。
export TEX64_RELEASE_ARCH=arm64
# （任意）notarytool の待機タイムアウト（デフォルト: 120m）
export TEX64_NOTARY_TIMEOUT=180m
npm run -s release:mac
```

`release:mac` は以下を実施します:

- `web:build` → `electron-builder --mac --dir`（署名済み `.app` を生成）
- `ditto` で Notarization 用 zip を作成 → `notarytool submit --wait` で Notarization 完了まで待機
- `xcrun stapler staple/validate` で ticket を stapling
- stapled `.app` から `dmg/zip` を生成（`--prepackaged`。再署名しない）
- `release/`（配布物 + `checksums-sha256.txt`）と `update/stable.json`（update feed）を生成

※このスクリプトは **アップロードはしません**（アップロードは最後に行う想定）。

### GitHub Actions を使わず手動公開する（R2 / S3）

`release:mac` 実行後に、ローカルから `downloads.tex64.com` へ公開します。

```bash
export TEX64_DOWNLOADS_PUBLIC_BASE_URL=https://downloads.tex64.com
export TEX64_DOWNLOADS_BUCKET=tex64-downloads
export TEX64_DOWNLOADS_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
export TEX64_DOWNLOADS_REGION=auto
export AWS_PROFILE=tex64-r2

npm run -s release:upload-downloads -- --version 0.1.0
npm run -s release:go-no-go -- --version 0.1.0
```

- `TEX64_DOWNLOADS_ENDPOINT` は **バケットを含まない endpoint** を設定する（例: `...r2.cloudflarestorage.com`）。
- `release:upload-downloads` は `release/` と `update/stable.json` を `tex64/vX.Y.Z/` と `tex64/updates/stable.json` へ配置する。
- `release:go-no-go` は `downloads.tex64.com` と `tex64.com` の manifest/redirect の整合を検証する。
- 単一archのみ公開する場合は `release:go-no-go -- --archs arm64`（または `x64`）を指定する。

## CI（GitHub Actions）

- タグ push（例: `v0.1.0`）で **macOS 向けのみ** ビルドし、`downloads.tex64.com`（S3/R2 等のオブジェクトストレージ + CDN）へ配布物をアップロードします。
- 公開対象: `dmg/zip`
- 併せて `checksums-sha256.txt` を生成してアップロードします（自動アップデートの sha256 用）。
- さらに `tex64/updates/stable.json` を生成してアップロードします（`tex64.com` の update manifest が参照）。

### downloads.tex64.com へアップロードするための Secrets（GitHub Actions）

`.github/workflows/release.yml` は次の secrets を参照します（S3 互換を想定。Cloudflare R2 も可）。

- `TEX64_DOWNLOADS_PUBLIC_BASE_URL`（例: `https://downloads.tex64.com`）
- `TEX64_DOWNLOADS_BUCKET`（バケット名）
- `TEX64_DOWNLOADS_ACCESS_KEY_ID`
- `TEX64_DOWNLOADS_SECRET_ACCESS_KEY`
- `TEX64_DOWNLOADS_ENDPOINT`（任意。R2 等の S3 互換 endpoint。AWS S3 の場合は空で OK）
- `TEX64_DOWNLOADS_REGION`（任意。R2 の場合は `auto`、AWS の場合は `us-east-1` など）
- （補足）タグリリース時は GitHub Releases に `release/*`（`dmg/zip` + `checksums-sha256.txt`）も自動添付される（追加 secret 不要）

### downloads.tex64.com の疎通（R2 / S3）

リリース前に「アップロードできる」「公開 URL から読める」ことだけ先に確認する場合は、
GitHub Actions の `Downloads Smoke Test`（`.github/workflows/downloads-smoke.yml`）を手動実行します。

- 成功すると `https://downloads.tex64.com/health.txt` が取得できる（`ok` などが表示される）

### 署名用 Secrets（公開タグでは必須）

- macOS code signing:
  - `TEX64_MACOS_CERT_P12_BASE64`（Developer ID Application 証明書の p12 を base64 化）
  - `TEX64_MACOS_CERT_PASSWORD`
- macOS notarization:
  - `TEX64_APPLE_ID`
  - `TEX64_APPLE_APP_SPECIFIC_PASSWORD`
  - `TEX64_APPLE_TEAM_ID`

## Codex（ワンライナー）

開発者が **「codexにアップデートして」** と言った場合は、Codex が `$tex64-ci-update` を使って
「次の stable パッチ版」を tag push → CI 完走 → downloads/manifest/tex64.com 同期まで実行します。

## リリース手順（推奨チェックリスト）

1. **バージョンを決める**（例: `0.1.0`）
2. **（任意）サイトのリリースノートを更新**（`tex64.com/src/content/releases.js`）
3. **タグを作成して push**

```bash
git tag -a v0.1.0 -m "TeX64 v0.1.0"
git push origin v0.1.0
```

4. GitHub Actions（`Build Distributables`）が完走し、`downloads.tex64.com` で配布物 + `checksums-sha256.txt` + `tex64/updates/stable.json` が見えることを確認
5. `tex64.com` 側の env を設定:
   - `NEXT_PUBLIC_TEX64_DOWNLOADS_PUBLIC_BASE_URL=https://downloads.tex64.com`
   - `TEX64_GITHUB_RELEASE_REPO=<owner>/<repo>`（任意: GitHub Releases を参照する場合）
   - `TEX64_UPDATE_SOURCE_PRIORITY=remote-first`
   - `TEX64_UPDATE_REMOTE_BASE_URL=https://downloads.tex64.com/tex64/updates`
6. `checksums-sha256.txt` を `tex64.com` に取り込む:

```bash
cd /Users/wedd/tex64.com
npm run -s release:import-checksums -- --version 0.1.0 --file /path/to/checksums-sha256.txt
```

7. `tex64.com` 側で `/api/v2/updates/manifest` が配布物 URL / sha256 を返せる状態か確認（下記の連携方法）
8. アプリで更新チェック → ダウンロード → 検証 → インストーラ起動まで動作確認
9. アナウンス（tex64.com / X / Discord など）
10. `LICENSE` と `NOTICE.md`（`npm run -s legal:notice` で更新）を配布物に同梱していることを確認

## 運用 Runbook（macOS 公開）

### 役割（最低限）

- Release owner: タグ作成、Go/No-Go 判定、公開宣言
- Operator: GitHub Actions 監視、`downloads.tex64.com` 反映確認、`tex64.com` 連携
- Verifier: 実機で更新導線を検証（既存版 -> 新版）

### Go/No-Go 判定

- `Build Distributables` が成功し、`dmg/zip` と `checksums-sha256.txt` と `tex64/updates/stable.json` が公開済み
- `tex64.com` の update manifest が `artifactUrl` と `artifactSha256` を返す
- 既存版アプリで「更新確認 -> ダウンロード -> 検証 -> インストーラ起動」が通る
- 主要導線（起動、ビルド、Google OAuth サインイン）が回帰していない

自動チェック:

```bash
npm run -s release:go-no-go -- --version 0.1.0 --channel stable
```

### ロールバック

- `stable.json` を直前版へ戻す（`latestVersion` / `artifactUrl` / `artifactSha256` を前バージョンへ）
- 破損配布物を `downloads.tex64.com/tex64/vX.Y.Z/` から退避または差し替え
- `tex64.com` リリースノートに障害情報と復旧見込みを追記

## アップデート配信時の必須項目

- `GET /updates/manifest` には `artifactUrl` に加えて `artifactSha256`（推奨）を含める。
- アプリはダウンロード後に `sha256` を検証し、一致しない場合は適用しない。
- macOS のアプリ内アップデートは `.zip` を使用（初回導入は `.dmg`）。`stable.json` には `dmg/zip` の両方を載せ、manifest 側で `kind` を選択します。

配布物から `sha256` を作る（単体）:

```bash
npm run -s release:artifact-hash -- \
  --file dist/TeX64-0.1.0-mac-arm64.dmg \
  --url https://downloads.tex64.com/tex64/v0.1.0/TeX64-0.1.0-mac-arm64.dmg
```

（古い方式）出力される `TEX64_UPDATE_*` を `tex64.com` の環境変数（Production）へ設定する。

配布物から `sha256` をまとめて作る（複数）:

```bash
npm run -s release:checksums -- --dir dist --version 0.1.0 --out dist/checksums-sha256.txt
```

## tex64.com 側の update manifest 連携（推奨）

`tex64.com` の `GET /api/v2/updates/manifest` は、`TEX64_UPDATE_SOURCE_PRIORITY=remote-first` の場合、
`TEX64_UPDATE_REMOTE_BASE_URL`（`${base}/{channel}.json`）を優先して配布物 URL / sha256 を解決し、
不足時は GitHub Releases（`TEX64_GITHUB_RELEASE_REPO`）をフォールバックで参照します。

- `TEX64_GITHUB_RELEASE_REPO=<owner>/<repo>`
- `TEX64_UPDATE_SOURCE_PRIORITY=remote-first`
- `TEX64_UPDATE_REMOTE_BASE_URL=https://downloads.tex64.com/tex64/updates`
- CI が `tex64/updates/stable.json` を更新するため、GitHub障害時も `downloads` 経由で継続可能

## 付録: 利用開始導線の監査（2026-02-21）

- 詳細は `docs/distribution-audit-2026-02-21.md` を参照。

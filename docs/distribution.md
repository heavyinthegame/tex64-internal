# 配布（Release / Distribution）

tex64 は Electron アプリとして配布します（インストーラ/アプリバンドルを生成）。

## 前提

- Node.js / npm（CI は Node 20）
- `npm ci`
- TeX Distribution は **同梱しない**（ユーザー側で TeX Live / MacTeX / BasicTeX / MiKTeX 等が必要）

## ローカルで配布物を作る

まず Web 生成物を更新してからパッケージします（生成物は `Resources/web/*`）。

```bash
npm run electron:pack
```

- `dist/` に unpacked アプリ（`--dir`）が生成されます。
- 起動確認用途（本番配布より速い）。

配布用（インストーラ等）を作る:

```bash
npm run electron:dist
```

### OS 別（必要な環境で実行）

```bash
npm run electron:dist:mac
npm run electron:dist:win
npm run electron:dist:linux
```

## 重要: ネイティブ依存（Math OCR / onnxruntime）

- `onnxruntime-node` はネイティブバイナリを含むため、ASAR 内だと動かないファイルがあります。
- `Resources/math-ocr/*`（モデル）も実ファイルパスが必要です。
- そのため `package.json` の `build.asarUnpack` で `Resources/math-ocr/**` とネイティブ拡張子（`.node/.dll/.dylib/.so*`）を unpack 対象にしています。

## 署名 / Notarization（後で必須）

現状の配布物は「動く」ことを優先しており、OS によっては警告が出ます。

- macOS: 署名（Developer ID）+ Notarization を追加する
- Windows: コード署名（Authenticode）を追加する

## CI（GitHub Actions）

- タグ push（例: `v0.1.0`）で各 OS 向けにビルドし、`downloads.tex64.com`（S3/R2 等のオブジェクトストレージ + CDN）へ配布物をアップロードします。
- 公開対象: `dmg/zip/exe/msi/AppImage/deb/rpm/tar.gz`（生成されるもののみ）
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
- `TEX64_PUBLISH_GITHUB_RELEASE`（任意。`true` にすると GitHub Releases にも assets を添付）

## リリース手順（推奨チェックリスト）

1. **バージョンを決める**（例: `0.1.0`）
2. **（任意）サイトのリリースノートを更新**（`tex64.com/src/content/releases.js`）
3. **タグを作成して push**

```bash
git tag -a v0.1.0 -m "TeX64 v0.1.0"
git push origin v0.1.0
```

4. GitHub Actions（`Build Distributables`）が完走し、`downloads.tex64.com` で配布物 + `checksums-sha256.txt` + `tex64/updates/stable.json` が見えることを確認
5. `tex64.com` 側で `/api/v2/updates/manifest` が配布物 URL / sha256 を返せる状態か確認（下記の連携方法）
6. アプリで更新チェック → ダウンロード → 検証 → インストーラ起動まで動作確認
7. アナウンス（tex64.com / X / Discord など）

## アップデート配信時の必須項目

- `GET /updates/manifest` には `artifactUrl` に加えて `artifactSha256`（推奨）を含める。
- アプリはダウンロード後に `sha256` を検証し、一致しない場合は適用しない。

配布物から `sha256` を作る（単体）:

```bash
npm run -s release:artifact-hash -- \
  --file dist/TeX64-0.1.0-mac-arm64.dmg \
  --url https://downloads.tex64.com/tex64/v0.1.0/TeX64-0.1.0-mac-arm64.dmg
```

（古い方式）出力される `TEX64_UPDATE_*` を `tex64.com` の環境変数（Production）へ設定する。

配布物から `sha256` をまとめて作る（複数）:

```bash
npm run -s release:checksums -- --dir dist --out dist/checksums-sha256.txt
```

## tex64.com 側の update manifest 連携（推奨）

`tex64.com` の `GET /api/v2/updates/manifest` は、`TEX64_UPDATE_REMOTE_BASE_URL` が設定されている場合、
`downloads.tex64.com` 側の update feed（`${base}/{channel}.json`）を参照して、配布物 URL と sha256 を自動解決できます。

- `TEX64_UPDATE_REMOTE_BASE_URL=https://downloads.tex64.com/tex64/updates`
- CI が `tex64/updates/stable.json` を更新するため、通常は `TEX64_UPDATE_*` を毎回変更しなくて良い

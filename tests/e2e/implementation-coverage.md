# implementation.md E2E Coverage

このファイルは `implementation.md` の章ごとに、UI操作ベースE2Eの対応状況を追跡する。

## 2. 起動とプロジェクト導線

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 2.1 ランチャー | 表示/非表示、ArrowUp/Down、Enter | `tests/e2e/launcher-workspace.e2e.mjs` Step 1-3 | ✅ |
| 2.2 フォルダを開く | ランチャーから開く、workspace/indexロード | `tests/e2e/launcher-workspace.e2e.mjs` Step 1 | ✅ |
| 2.3 新規プロジェクト作成 | `main.tex`作成、`main2.tex`採番、paperテンプレート | `tests/e2e/launcher-workspace.e2e.mjs` Step 2-3 | ✅ |
| 2.4 最近のプロジェクト | 初期3件、展開/折りたたみ、再オープン、存在確認で自動除去、最大10件 | `tests/e2e/launcher-workspace.e2e.mjs` Step 4-7 | ✅ |

## 3. ワークスペースモデル

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 3.2 root TeX（手動設定） | `settings-root-select` による手動root、`.tex64/settings.json`保存 | `tests/e2e/workspace-model-root.e2e.mjs` Step 2 | ✅ |
| 3.2 root TeX（自動検出/再検出） | `main.tex` 優先、自動復帰 | `tests/e2e/workspace-model-root.e2e.mjs` Step 1,3 | ✅ |
| 3.3 `%!TEX root` 追跡 | 相対パス+拡張子補完でmainへ解決、循環時は失敗側へ | `tests/e2e/workspace-model-root.e2e.mjs` Step 4,5 | ✅ |

## 4. ファイルツリーとファイル操作

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 4.1 ツリー表示 | 階層表示、開閉状態のlocalStorage保存/復元 | `tests/e2e/file-tree-ops.e2e.mjs` Step 2 | ✅ |
| 4.2 右クリックメニュー | ファイル/フォルダ別メニュー表示 | `tests/e2e/file-tree-ops.e2e.mjs` Step 3 | ✅ |
| 4.3 作成/改名/移動/コピー/削除 | create modal、rename validation、DnD move、shortcut copy、delete | `tests/e2e/file-tree-ops.e2e.mjs` Step 4-8 | ✅ |
| 4.4 Undo（move/delete） | move undo、delete undo、manual root復元 | `tests/e2e/file-tree-ops.e2e.mjs` Step 7-9 | ✅ |
| 4.5 ショートカット | Cmd/Ctrl+C/X/V/Z | `tests/e2e/file-tree-ops.e2e.mjs` Step 6-8 | ✅ |
| 4.6 安全ガード（未保存） | dirty時 rename/move/delete を拒否しIssues表示 | `tests/e2e/file-tree-ops.e2e.mjs` Step 10 | ✅ |

## 5. エディタ・タブ・分割表示

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 5.0 画面レイアウト | サイドバー主要タブの表示/非表示切替、最低1タブ制約、`localStorage`保存、サイドバー幅リサイズ最小/最大制約 | `tests/e2e/editor-tabs-layout.e2e.mjs` Step 2-3 | ✅ |
| 5.1 エディタ基盤 | split ON/OFF、split比率保存/復元 | `tests/e2e/editor-tabs-layout.e2e.mjs` Step 4-5 | ✅ |
| 5.2 タブ管理 | グループ別タブ、タブ移動(D&D)、クローズ、同一ファイル再利用 | `tests/e2e/editor-tabs-layout.e2e.mjs` Step 6 | ✅ |
| 5.3 ファイル種別ごとの開き方 | text/image/pdf/unsupported の表示分岐 | `tests/e2e/editor-tabs-layout.e2e.mjs` Step 7 | ✅ |
| 5.4 保存とdirty管理 | dirty表示、autosave反映、`beforeunload`ガード | `tests/e2e/editor-tabs-layout.e2e.mjs` Step 7 | ✅ |
| 5.5 カーソル/ジャンプ | Search/Outlineのsecondaryジャンプ（split自動ON, focus非奪取）、Issuesはactive groupへジャンプ | `tests/e2e/editor-tabs-layout.e2e.mjs` Step 8-9 | ✅ |

## 6. 入力支援（Completion / Hover / Ghost）

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 6.1 コード補完 | `\\ref`/`\\cite`/`\\input`/`\\include`/`\\includegraphics`/`\\begin` 候補、Tab/Shift+Tab/Enter 操作 | `tests/e2e/completion.e2e.mjs` Step 1-6, `tests/e2e/input-assist.e2e.mjs` `runCompletionChecks` | ✅ |
| 6.2 Hover | 数式プレビュー、`cite` 抜粋、`includegraphics` 画像/非画像、`input` 抜粋、`ref` 情報 | `tests/e2e/input-assist.e2e.mjs` `runHoverChecks` | ✅ |
| 6.3 Ghost Completion | ルールベース補完、ON/OFF、debounce、maxChars、API経路（proxy経由） | `tests/e2e/input-assist.e2e.mjs` `runGhostSettingsChecks`, `runGhostLocalChecks` | ✅ |
| 6.4 補助ブローカー | 画像プレビュー2MB上限（oversize fallback）、ファイル抜粋（input hover）、API usage snapshot保持 | `tests/e2e/input-assist.e2e.mjs` `runHoverChecks`, `assertApiUsageSnapshot` | ✅ |

## 7. ビューア（画像 / PDF）

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 7.1 タブ内ビューア | 画像表示、PDF iframe viewer 表示 | `tests/e2e/viewer-ops.e2e.mjs` Step 1 | ✅ |
| 7.2 PDF 別ウィンドウ | 設定切替、別ウィンドウ open/sync/reload/reverse | `tests/e2e/viewer-ops.e2e.mjs` Step 3-5 | ✅ |
| 7.3 PDF viewer 操作 | ページ移動、zoom(ボタン/wheel/pinch)、fit、回転、検索、Outline/Thumb、invert保存、Download/Print/Reload、reverse | `tests/e2e/viewer-ops.e2e.mjs` Step 4-5 | ✅ |
| 7.4 親子通信 | 親→iframe `open/sync`、iframe→親 `ready/reverse`、`source: \"tex64-pdf\"` | `tests/e2e/viewer-ops.e2e.mjs` Step 1-2, `tests/e2e/synctex-ui-element-matrix.e2e.mjs` | ✅ |

## 8. ビルド・clean・整形

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 8.1 ビルド | `latexmk` 実行、engine切替（`lualatex/pdflatex/xelatex` の成果物確認 + `uplatex` 選択適用） | `tests/e2e/build.e2e.mjs` Step 1 | ✅ |
| 8.2 Build Profiles | profile追加/選択、最大20制限、active fallback、自動保存、`.tex64/settings.json`反映 | `tests/e2e/build.e2e.mjs` Step 2-3 | ✅ |
| 8.3 outDir/args の扱い | `extraArgs` の `-outdir` 優先、不正 `outDir` 拒否、clean/deep cleanでも同一反映 | `tests/e2e/build.e2e.mjs` Step 2,4, `tests/e2e/clean.e2e.mjs` Step 1-2,5 | ✅ |
| 8.4 clean | clean(`-c`) と clean -C(`-C`) の実行結果 | `tests/e2e/clean.e2e.mjs` Step 3-4 | ✅ |
| 8.5 ビルド結果の解析 | error抽出、Issues表示（位置情報は取得時に表示）、失敗要約、build log保持、`latexmk`未導入時 `open-runtime` | `tests/e2e/build.e2e.mjs` Step 5-6 | ✅ |
| 8.6 整形（formatter） | save時整形、手動整形、設定反映（indent/blank lines/custom verbatim）、`latexindent`欠落時fallback+runtime導線 | `tests/e2e/formatter.e2e.mjs` Step 1-4 | ✅ |

## 9. SyncTeX（forward / reverse）

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 9.1 forward（トリガ） | SyncTeXボタン、build成功後auto-forward（ON時）、`tex64://view-on-pdf` deep link | `tests/e2e/synctex-controls.e2e.mjs` Step 2,6,8 | ✅ |
| 9.1 forward（挙動） | in-flight重複抑制、request order / stale破棄、短期キャッシュ、コメント行補助探索 | `tests/e2e/synctex-controls.e2e.mjs` Step 3-5,7 | ✅ |
| 9.2 reverse | PDF(page/x/y)→source逆引き、成功時エディタジャンプ、失敗時Issues反映 | `tests/e2e/synctex-controls.e2e.mjs` Step 9-10, `tests/e2e/synctex-viewer-modes.e2e.mjs`, `tests/e2e/synctex-ui-element-matrix.e2e.mjs` | ✅ |
| 9.3 reverse有効/無効 | reverse OFF時にPDF側reverse要求を無視 | `tests/e2e/synctex-controls.e2e.mjs` Step 9 | ✅ |

## 10. Outline / Search / Issues

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 10.1 Index 生成 | `.tex/.bib`走査で `labels/references/citations/sections/figures/tables/todos` 抽出、重複除去済み snapshot 反映 | `tests/e2e/outline.e2e.mjs` Step 1 | ✅ |
| 10.2 Outline | current/project切替、セクション階層、todo/label/citation/section のsecondaryジャンプ | `tests/e2e/outline.e2e.mjs` Step 2-4 | ✅ |
| 10.3 Search | `.tex`全文検索（大小無視）、最大200件、ファイル単位グループ、クリックでsecondaryジャンプ | `tests/e2e/search.e2e.mjs` Step 1-8 | ✅ |
| 10.4 Search 内シンボルリネーム | from/to検証、同一禁止、禁止文字検証、対象必須、`label/ref` + `cite(.bib)`、`search:renameResult`反映 | `tests/e2e/search.e2e.mjs` Step 9-12 | ✅ |
| 10.5 Issues | build/format/save/runtime + duplicate label の表示、severity/location/message/hint、`open-runtime`遷移、build失敗後のIssues自動フォーカス | `tests/e2e/issues.e2e.mjs` Error loop + Warning loop + sources/runtime/duplicate-label steps | ✅ |

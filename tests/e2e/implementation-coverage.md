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

## 11. Blocks（数式編集）

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 11.1 モード | `insert/edit` 切替、`.tex`のみ対象、Escapeで edit 離脱 | `tests/e2e/math-wysiwyg-boundary.e2e.mjs` [1/7], [4/7] | ✅ |
| 11.2 自動検出 | `$...$`/環境検出、comment/verbatim除外、env registry+ヒューリスティック判定、検出ハイライト | `tests/e2e/math-wysiwyg-boundary.e2e.mjs` [2/7], [3/7] | ✅ |
| 11.3 入力 UI | MathLive `<math-field>`、fallback textarea、captureボタン導線 | `tests/e2e/math-wysiwyg-basic.e2e.mjs`, `tests/e2e/math-wysiwyg-fallback.e2e.mjs`, `tests/e2e/math-wysiwyg-boundary.e2e.mjs` [5/7] | ✅ |
| 11.4 挿入フォーマット | `inline/display/align/gather/none` と wrap保持 | `tests/e2e/math-wysiwyg-insert-formats.e2e.mjs` [1/10]-[10/10] | ✅ |
| 11.5 適用フロー | Diff Modal確認→Submit適用、整形要求、`.tex64/blocks.json`追記 | `tests/e2e/math-wysiwyg-boundary.e2e.mjs` [6/7] | ✅ |
| 11.6 WYSIWYG 候補 | 自動/手動候補、キーボード操作、MRU/packs、trigger網羅 | `tests/e2e/math-wysiwyg-basic.e2e.mjs`, `tests/e2e/math-wysiwyg-interactions.e2e.mjs`, `tests/e2e/math-wysiwyg-advanced.e2e.mjs`, `tests/e2e/math-wysiwyg-specialized.e2e.mjs`, `tests/e2e/math-wysiwyg-discoverability.e2e.mjs`, `tests/e2e/math-wysiwyg-catalog.e2e.mjs` | ✅ |
| 11.7 数式キーボード | `MATH_KEYBOARD_VISIBLE=false` による常時非表示 | `tests/e2e/math-wysiwyg-boundary.e2e.mjs` [7/7] | ✅ |

## 12. 画面キャプチャ / OCR

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 12 画面ソース選択 | 画面ソース一覧の表示、検索、選択、キャンセル | `tests/e2e/math-capture.e2e.mjs` [1/9] | ✅ |
| 12 クロップ範囲指定 | 新規作成、移動、リサイズ、Escapeで選択解除 | `tests/e2e/math-capture.e2e.mjs` [2/9] | ✅ |
| 12 OCR 実行 | ONNX入力テンソル正規化、全体/部分クロップ、前処理バリエーション候補付与 | `tests/e2e/math-capture.e2e.mjs` [3/9], [4/9] | ✅ |
| 12 OCR 例外/再評価 | OCR失敗時Issues、multi-pass候補比較で最良結果採用 | `tests/e2e/math-capture.e2e.mjs` [7/9], [8/9] | ✅ |
| 12 Blocks 連携 | OCR結果をBlocks入力へ注入し、編集してDiff経由で挿入適用 | `tests/e2e/math-capture.e2e.mjs` [9/9] | ✅ |

## 13. AI アシスタント

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 13.1 チャット基本 | 複数会話、履歴切替、ストリーミング応答、停止、会話クリア | `tests/e2e/ai.e2e.mjs` [12/18], [17/18], [18/18], `tests/e2e/ai.input-send.e2e.mjs` step1-3 | ✅ |
| 13.2 コンテキスト注入 | active file / selection / open files / recent issues(最大5) の付与 | `tests/e2e/ai.e2e.mjs` [15/18]（context payload検証）, `tests/e2e/ai.functions.e2e.mjs`（index/issues参照ツール経由） | ✅ |
| 13.3 画像添付 | 画像のみ、最大4件、1件5MB、合計8MB、超過/非画像/読込失敗理由をUI通知 | `tests/e2e/ai.attachments.e2e.mjs`, `tests/e2e/ai.e2e.mjs` [13/18], `tests/e2e/ai.input-send.e2e.mjs` step4 | ✅ |
| 13.4 ツール実行と提案 | `list/read/search/index/run_build/run_command/get/set/propose*` の実行と提案作成 | `tests/e2e/ai.functions.e2e.mjs`（宣言済み全ツール成功/失敗経路）, `tests/e2e/ai.e2e.mjs` [1/18]-[11/18]（提案UI） | ✅ |
| 13.5 提案適用 | proposal card差分確認、Diff Modal適用、`適用して次へ`、apply失敗/競合、undo | `tests/e2e/ai.e2e.mjs` [1/18]-[11/18], `tests/e2e/ai.functions.e2e.mjs`（apply conflict/undo） | ✅ |
| 13.6 AI 実行制約 | policy制約（サイズ/件数/拡張子/許可禁止パス）、`run_command`制約（許可コマンド/演算子禁止/検証） | `tests/e2e/ai.functions.e2e.mjs`（`withPolicy` + `run_command` error path） | ✅ |
| 13.7 使用量記録 | input/output/total tokens、requests、概算コスト、リセット | `tests/e2e/ai.e2e.mjs` [16/18]（`tex64-api-usage.json` 記録確認 + reset後ゼロ化） | ✅ |

## 14. 設定

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 14.1 Editor | compile engine、build後auto-forward SyncTeX、reverse SyncTeX ON/OFF、PDF表示モード、Ghost ON/OFF・debounce・max chars、align env ON/OFF | `tests/e2e/build.e2e.mjs` [1/6], `tests/e2e/synctex-controls.e2e.mjs` [8/10]-[9/10], `tests/e2e/viewer-ops.e2e.mjs` [3/5], `tests/e2e/settings-runtime-env.e2e.mjs` [2/4] | ✅ |
| 14.2 Format | indent style、begin/end改行、`document` no-indent、math/table align、blank lines方針、custom verbatim追加/削除 | `tests/e2e/formatter.e2e.mjs` [1/4]-[3/4] | ✅ |
| 14.3 Build Profiles | プロファイル追加/削除/選択、`name/outDir/extraArgs`編集、clean/clean-all実行 | `tests/e2e/build.e2e.mjs` [2/6]-[4/6], `tests/e2e/clean.e2e.mjs` [1/5]-[5/5] | ✅ |
| 14.4 Runtime | `lualatex/pdflatex/xelatex/uplatex/latexmk/latexindent/synctex`チェック、再チェック、未導入時インストール導線 | `tests/e2e/settings-runtime-env.e2e.mjs` [1/4] | ✅ |
| 14.5 Env Registry | 既定+custom管理、math/table種別、有効/無効切替、discouraged/package表示、Blocks検出・整形設定反映 | `tests/e2e/settings-runtime-env.e2e.mjs` [3/4]-[4/4], `tests/e2e/math-wysiwyg-boundary.e2e.mjs` [3/7] | ✅ |

## 15. 永続化（どこに何を保存するか）

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 15.1 ワークスペース内 | `.tex64/settings.json`（`rootFile/buildProfiles/buildProfileId`） | `tests/e2e/workspace-model-root.e2e.mjs` Step 2, `tests/e2e/build.e2e.mjs` Step 2-3 | ✅ |
| 15.1 ワークスペース内 | `.tex64/.trash/*`（削除ファイル退避） | `tests/e2e/file-tree-ops.e2e.mjs` Step 8 | ✅ |
| 15.1 ワークスペース内 | `.tex64/blocks.json`（Blocks適用履歴） | `tests/e2e/math-wysiwyg-boundary.e2e.mjs` [6/7] | ✅ |
| 15.1 ワークスペース内 | `.tex64/.format/*`（formatter作業用） | `tests/e2e/persistence-surfaces.e2e.mjs` [6/6] | ✅ |
| 15.2 userData | `tex64-user-settings.json`（AI設定/ recent projects） | `tests/e2e/launcher-workspace.e2e.mjs` Step 4-7, `tests/e2e/persistence-surfaces.e2e.mjs` [1/6] | ✅ |
| 15.2 userData | `tex64-api-usage.json`（API usage集計） | `tests/e2e/ai.e2e.mjs` [16/18], `tests/e2e/input-assist.e2e.mjs` `assertApiUsageSnapshot` | ✅ |
| 15.3 localStorage | `compileEngine/autoSynctex/reverseSynctex/pdfViewerMode/ghost*` | `tests/e2e/persistence-surfaces.e2e.mjs` [2/6], `tests/e2e/settings-runtime-env.e2e.mjs` [2/4] | ✅ |
| 15.3 localStorage | `editorSplitRatio` | `tests/e2e/editor-tabs-layout.e2e.mjs` Step 4-5 | ✅ |
| 15.3 localStorage | `sidebar.primaryTabs` | `tests/e2e/editor-tabs-layout.e2e.mjs` Step 2,5 | ✅ |
| 15.3 localStorage | `activeTab` | `tests/e2e/persistence-surfaces.e2e.mjs` [3/6] | ✅ |
| 15.3 localStorage | `tree.<workspace>` | `tests/e2e/file-tree-ops.e2e.mjs` Step 2 | ✅ |
| 15.3 localStorage | `outline.mode` | `tests/e2e/persistence-surfaces.e2e.mjs` [3/6] | ✅ |
| 15.3 localStorage | `math-insert-* / math-wysiwyg.autoSuggest / packs / mru*` | `tests/e2e/persistence-surfaces.e2e.mjs` [4/6] | ✅ |
| 15.3 localStorage | `pdf.invert / pdf.sidebarTab` | `tests/e2e/persistence-surfaces.e2e.mjs` [5/6], `tests/e2e/viewer-ops.e2e.mjs` Step 4 | ✅ |

## 16. 外部リンク・ショートカット

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 16.1 `tex64://` アクション | `tex64://open-source?path=...&line=...&column=...` でエディタの該当位置を開く | `tests/e2e/external-links-shortcuts.e2e.mjs` [2/4] | ✅ |
| 16.1 `tex64://` アクション | `tex64://view-on-pdf?path=...&line=...&column=...` で forward SyncTeX を実行 | `tests/e2e/external-links-shortcuts.e2e.mjs` [3/4], `tests/e2e/synctex-controls.e2e.mjs` Step 6-7 | ✅ |
| 16.2 グローバル操作 | `Cmd/Ctrl+B` で build 実行 | `tests/e2e/external-links-shortcuts.e2e.mjs` [4/4] | ✅ |

## 17. 主要制限値（実装値）

| implementation.md | 要件 | E2E | 状態 |
| --- | --- | --- | --- |
| 17 制限値 | ワークスペース列挙 5000 | `tests/e2e/limits-constraints.e2e.mjs` [1/2] | ✅ |
| 17 制限値 | Search結果 200 | `tests/e2e/search.e2e.mjs` [8/12] | ✅ |
| 17 制限値 | Index/Issues の上位表示制御 | `tests/e2e/issues.e2e.mjs`（sources/runtime/duplicate-label 含む集約表示）, `tests/e2e/build.e2e.mjs` [5/6]（build解析結果表示） | ✅ |
| 17 制限値 | ファイルプレビュー画像 2MB | `tests/e2e/limits-constraints.e2e.mjs` [2/2], `tests/e2e/input-assist.e2e.mjs` `runHoverChecks` H-07 | ✅ |
| 17 制限値 | ファイル抜粋（radius/maxLines 上限運用、本文12KB切り詰め） | `tests/e2e/limits-constraints.e2e.mjs` [2/2], `tests/e2e/input-assist.e2e.mjs` `runHoverChecks` H-06 | ✅ |
| 17 制限値 | Ghost API（minPrefix 10 / cooldown 3s / 最大12 req/min） | `tests/e2e/input-assist.e2e.mjs` `runGhostApiLimitChecks`（`E2E_ONLY_GHOST=1` 実行） | ✅ |
| 17 制限値 | AI画像添付（最大4件 / 1件5MB / 合計8MB） | `tests/e2e/ai.attachments.e2e.mjs` | ✅ |
| 17 制限値 | 最近プロジェクト 10件 | `tests/e2e/launcher-workspace.e2e.mjs` [4/7], [7/7] | ✅ |

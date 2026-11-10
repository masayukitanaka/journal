# 開発タスク（tasks.md）

- 前提: [docs/SPEC.md](./SPEC.md) 10章「開発の進め方（案）」を、[docs/ARCHITECT.md](./ARCHITECT.md)（Cloudflare 完結方針）に基づいて詳細化したもの。
- フェーズ・完了条件は SPEC 10 章 / ARCHITECT 8 章と対応する。
- チェックボックスは進行管理用。完了したら `[x]` にする。

---

## P0: 仕様確定・前提条件の解消

完了条件（SPEC/ARCHITECT 共通）: 本仕様の未確定事項が解消していること。

### P0-1. OpenAlex 利用準備
- [x] OpenAlex の無料 API キーを取得する（ARCHITECT 7-1, 7-3）— 取得済み。`.dev.vars` の `OPENALEX_API_KEY` に設定済み（gitignore 対象、`.dev.vars.example` に雛形を追加済み）。API 呼び出しで有効性を確認済み（2026-11-09、`meta.count` が無認証時と一致）
- [ ] API キーの日次バジェット・秒間レート（無料キー 30 req/s の実際の挙動）を小規模リクエストで確認する — Rate Limiter DO 自体は P1-2 で実装済み。日次バジェットの実測は P1-7（日次差分更新）の本番運用開始後に実施
- [x] `primary_topic.field.id:17` でのフィルタが意図通りの件数を返すことを `meta.count` で確認する（分野 17 = 計算機科学）— 2026-11-09 実測: 全年代 12,266,119 件、2016〜2026年 6,095,841 件、2016年単年 426,794 件、2024年単年 618,966 件
- [x] 年範囲フィルタの構文を確認する — `publication_year:2016-2026` のハイフン範囲構文は実測では動作するが公式ドキュメント未記載。`from_publication_date:2016-01-01,to_publication_date:2026-12-31`（公式に明記された構文）で同じ件数を確認。**後者を正式採用**（ARCHITECT 3.1 に反映済み）
- [x] `fwci` など使用予定フィルタ・フィールド名を OpenAlex の公式ドキュメントで確認する（SPEC 8 章「数値の確認」）— `fwci`（Float、Field-weighted Citation Impact = 出版年+3年分の被引用数/期待値の比）を GitHub 公式ドキュメントで確認済み。SPEC 4.4 に反映済み

### P0-2. Semantic Scholar 利用条件の確認
- [x] Semantic Scholar API の利用規約（商用利用・再配布可否）を確認する（ARCHITECT 7-4）— ユーザー確認済み（2026-11-09）
- [x] 利用条件が PoC の範囲（個人利用、非商用）に合致することを確認する — 問題なしと判断済み
- [ ] APIキー申請が必要であれば申請する（初期値 1 RPS）— P1-6（Semantic Scholar 連携）着手時に実施

### P0-3. Cloudflare アカウント・プロダクト有効化
- [x] Workers Paid プランが有効であることを確認する — ユーザー確認済み（2026-11-09）
- [x] D1 データベースを作成する — `field17_2016_2026`（database_id: `256986fe-4e3a-45c4-801d-bd613dab19e6`、region: WNAM）を作成済み。3.4.2 の年代分割（5年単位への分割）は P1 実測後に適用
- [x] R2 バケットを作成する — `journal-field17` を作成済み。`raw/openalex/`, `raw/semanticscholar/`, `graph/field17/` はプレフィックス運用（P1 実装時に使用開始）
- [x] Queues（Graph Build Queue）を作成する — `journal-graph-build` を作成済み
- [x] Workflows を有効化する — `journal-ingest-workflow`（binding: `INGEST_WORKFLOW`、class: `IngestWorkflow`）を `wrangler.jsonc` に追加し deploy 済み。クラス実体は `worker/ingest-workflow.ts` にプレースホルダーとして作成（P1 で実装）
- [x] Durable Objects（Rate Limiter DO 用のクラス）を有効化する — `RateLimiterOpenAlex` / `RateLimiterSemanticScholar`（SQLite-backed DO）を `wrangler.jsonc` の migrations に追加し deploy 済み。クラス実体は `worker/rate-limiter.ts` にプレースホルダーとして作成（P1 で実装）
- [x] `wrangler.jsonc` に D1 / R2 / Queues / Workflows / Durable Objects の binding を追加する — 完了（binding 名: `DB_FIELD17_2016_2026` / `BUCKET_FIELD17` / `GRAPH_BUILD_QUEUE` / `INGEST_WORKFLOW` / `RATE_LIMITER_OPENALEX` / `RATE_LIMITER_SEMANTIC_SCHOLAR`）
- [x] `wrangler types` で型定義を再生成し、`worker-configuration.d.ts` を更新する — 完了
- [x] `wrangler deploy --dry-run` で全 binding が認識されることを確認し、実際に `wrangler deploy` で本番反映した（2026-11-09、公開 URL: `https://journal.ursytsr.workers.dev`）
- [x] 本番 Worker に `OPENALEX_API_KEY` を secret として設定する（`wrangler secret put`）— 完了

### P0-4. 未確定事項の解消状況の記録
- [x] SPEC 11 章・ARCHITECT 7 章の各項目について、解消済みか残課題かを本ドキュメントまたは別メモに記録する — 本 tasks.md の各タスクに解消状況を記録済み。残課題: APIキー日次バジェットの実測（P1）、分割幅の最終確定（P1）、取り込み論文数 N（P1）、Semantic Scholar APIキー申請（P1-6）、人文系分類境界（P5）
- [x] 検索方式（D1 の `LIKE` を初期採用）の方針を確定する（ARCHITECT 7-5）— 確定済み。P2-5 で実装
- [x] 公開範囲（個人利用、認証なし）を確定する（ARCHITECT 7-7）— 確定済み

---

## P1: 初期インポート（S3 スナップショット）+ Ingest Workflow（日次差分更新）

完了条件: 件数・`child_cnt` が検証できること（SPEC 9 章の検証項目、ARCHITECT 8 章）。

**方針変更（2026-11-10）**: 当初は Ingest Workflow（API cursor paging）で初期取り込みも行う計画だったが、直近10年・Field 17 で約609万件・約30,500ページかかり Workflows のステップ数上限を超えるため、N=50,000件（被引用上位のみ）に絞って PoC を開始した（下記 P1-1〜P1-5 は当時の実績）。系統樹として裾野まで含めた引用構造を再現するため、**初期インポートは S3 スナップショットからの一括取り込みに切り替え、Ingest Workflow は日次差分更新に専念させる**方針に変更した（詳細: [docs/ARCHITECT.md](./ARCHITECT.md) 3.1・3.1.1、[docs/init-ingest.md](./init-ingest.md)）。

### P1-0. 初期インポート（S3 スナップショットからの一括取り込み、新方針）

完了条件: 分野17・直近10年の全件規模（約609万件）が D1 に投入され、`child_cnt` が検証できること。**小規模検証 → 中規模実行 → 本番実行の段階を踏む**（詳細手順・各段階の完了条件は [docs/init-ingest.md](./init-ingest.md) 3章・3.0）。

#### P1-0-①. 抽出スクリプトの動作確認（小規模）
- [ ] `extract_cs.py` を拡張する — `--pattern` に S3 URL（`s3://openalex/data/parquet/works/*/*.parquet`）を渡せるようにし、httpfs 拡張のロード・`s3_region` 設定を追加する（init-ingest.md 3.2）
- [ ] `extract_cs.py` の抽出列を D1 スキーマ（migrations 0001-0003）に合わせて拡張する — 現状 `papers.csv` は `id, title, year, cit, field` のみで、`publication_date`（月精度の `year`）・`fwci`・`subfield`・`doi` が欠けている（init-ingest.md 3.3）
- [ ] `extract_cs.py` に `keywords`/`paper_keywords` の抽出を追加する — `UNNEST` で `STRUCT(id, display_name, score)[]` を展開し、`keywords`（辞書: id, name）と `paper_keywords`（中間テーブル: paper_id, keyword_id, score）を生成する（init-ingest.md 3.3、migrations/0005）
- [ ] `--limit-files 1`（または数ファイル）+ S3 URL で実行し、httpfs 経由で正しく S3 から読めること、拡張した列（`keywords`/`paper_keywords` 含む）が期待通り出力されることを確認する

#### P1-0-②. 小規模 D1 投入の確認
- [ ] D1 投入方式を仮決定する — `wrangler d1 execute --file`（SQLite dump 生成）か、R2 経由 + Worker チャンク投入のどちらかを試す（init-ingest.md 3.4）
- [ ] テスト用の投入先（本番 D1 に投入して後で削除するか、検証用 D1 を別途作るか）を決める（init-ingest.md 5章 未確定事項7）
- [ ] ①の小規模出力（数千件規模）を `papers` → `edges` → `child_cnt` 再計算 → `keywords`/`paper_keywords` の順に投入する
- [ ] 件数一致・`child_cnt` 不一致 0 件を確認する（init-ingest.md 3.6 と同じ検証を小規模データで実施）
- [ ] `paper_keywords.keyword_id` が `keywords.id` に存在すること、`paper_keywords.paper_id` が `papers.id` に存在することを確認する（init-ingest.md 3.6）
- [ ] テスト用に投入したデータを後始末する（本番 D1 を使った場合は削除、検証用 D1 を使った場合は保持または破棄）

#### P1-0-③. 一部分野・一部年代での中規模実行
- [ ] 分野17・直近1〜2年分など、本番の一部を対象に `--min-year` を絞って抽出する
- [ ] `--count` で絞り込み後件数を確認する
- [ ] ②で確認した D1 投入方式で中規模データを投入し、処理時間・D1サイズ・エッジ密度を実測する（`paper_keywords` の行数・サイズも含む）
- [ ] 実測結果から、本番実行（④）をローカル PC で続けるか EC2 に切り替えるかを判断する（init-ingest.md 2.1）
- [ ] ARCHITECT.md 3.4.1 の容量試算との比較を参考値として記録する（`paper_keywords` 分も加味）
- [ ] 中規模テストデータを後始末する（②と同様）

#### P1-0-④. 本番実行（全件）
- [ ] 実行場所を確定する（③の判断に基づき、ローカル PC または EC2）。EC2 の場合はセットアップを行う（init-ingest.md 3.5）
- [ ] 本番実行: 分野17・直近10年の全件で `papers`/`edges`/`child_cnt`/`keywords`/`paper_keywords` を抽出する（`--count` で P0-1 実測の約609万件と大きく外れないか確認）
- [ ] `papers` → `edges`（`cited` 側が `papers` に存在するものだけ） → `child_cnt` 再計算 → `keywords`/`paper_keywords`、の順序で D1 へ投入する
- [ ] 投入後、件数が抽出時点と一致すること、`child_cnt` が `recomputeChildCnt` と同じロジックで不一致 0 件であること、`paper_keywords` の整合性（keyword_id/paper_id の存在）を検証する（init-ingest.md 3.6）
- [ ] ARCHITECT.md 3.4.1 の容量試算（直近10年全件で約6〜9GB）と実測値を比較し、年代分割（3.4.2）着手の要否を判断する
- [ ] （EC2 を使った場合）作業完了後、インスタンスを確実に終了（Terminate）したことを確認する

### P1-7. Ingest Workflow を日次差分更新に変更する（新方針）

完了条件: `from_updated_date` ベースの差分取得が動作し、初期インポート後の継続運用に利用できること。詳細は [docs/ARCHITECT.md](./ARCHITECT.md) 3.1.1、[docs/init-ingest.md](./init-ingest.md) 4章。

- [ ] `ingest_state` テーブルを追加するマイグレーションを作成する（`key TEXT PRIMARY KEY, value TEXT`、`key='last_updated_date'` で前回実行日を記録）
- [ ] `worker/openalex-client.ts` の `fetchWorksPage` に `fromUpdatedDate` パラメータを追加する
- [ ] `worker/ingest-workflow.ts` を変更する — `MAX_PAGES=250`（N=50,000件固定）の制約を撤廃し、`filter=...,from_updated_date:{last_run}` ベースの差分取得に変更。`sort=cited_by_count:desc` も不要になる（全件扱いのため）
- [ ] Workflow の最終ステップで `ingest_state.last_updated_date` を更新するロジックを追加する
- [ ] 初期値（`last_updated_date` の初期値）を、初期インポートに使ったスナップショットの `date`（`data/openalex/manifest.json` の `date` フィールド、現状 `2026-10-14`）に設定する
- [ ] 1日あたりの更新件数・ページ数を実測し、Workflows のステップ数上限に対して十分な余裕があるか確認する
- [ ] 差分更新の `upsert-edges` が、初期インポート分 + これまでの差分分を含む既存 `papers` に対して正しく判定できることを確認する

---

## 旧方針の実績（履歴、API cursor paging による N=50,000件への絞り込み）

以下の P1-1〜P1-5 は、上記方針変更前（2026-11-09 時点）に Ingest Workflow（API cursor paging、N=50,000件）で初期取り込みを行った際の実績記録。コード資産（D1スキーマ、Rate Limiter DO、OpenAlex クライアント）は新方針でも再利用するため記録を残す。P1-3 の Workflow 実装は P1-7 で日次差分専用に変更する。P1-6（Semantic Scholar 連携）はこの履歴ブロック内の番号で、新設の P1-0・P1-7 とは独立した別タスク。

### P1-1. D1 スキーマの実装
- [x] `papers` テーブルのマイグレーションを作成する（SPEC 4.4 準拠）— `migrations/0001_create_papers_and_edges_tables.sql`
- [x] `edges` テーブルのマイグレーションを作成する（`WITHOUT ROWID`、複合主キー）— 同上
- [x] `idx_papers_field_year` / `idx_papers_field_cit` / `idx_edges_citing` インデックスを作成する — 同上
- [x] `wrangler d1 migrations` でマイグレーション適用手順を確立する（ローカル・リモート両方）— `--local` / `--remote` ともに適用済み

### P1-2. Rate Limiter DO（OpenAlex 用）の実装
- [x] DO クラスを実装する（次に呼び出し可能な時刻を保持する最小実装）— `worker/rate-limiter.ts`（`RateLimiter` 基底クラス、`ctx.storage` に `nextAvailableAt` を保持）
- [x] 秒間リクエスト数の上限をパラメータ化する（無料キー 30 req/s を初期値とする）— `RateLimiterOpenAlex.requestsPerSecond = 30`
- [x] 429 応答受信時に待機時間を動的に延長するロジックを実装する — `extendBackoff()`、`openalex-client.ts` で `Retry-After` ヘッダを読んで適用
- [x] DO 経由で OpenAlex を呼び出す薄いクライアント関数を作成する — `worker/openalex-client.ts`（`fetchWorksPage`）。Semantic Scholar 用 DO（`RateLimiterSemanticScholar`, 1 RPS）も同時に用意済み（P1-6 で使用）

### P1-3. Ingest Workflow の実装
- [x] Workflow の骨格を作成する — `worker/ingest-workflow.ts`。ARCHITECT.md 3.1 を見直し、1ページ=1ステップ（fetch+store+transform+upsert-papersを統合）+ `upsert-edges` + `recompute-child-cnt` の構成に変更（Workflows のステップ数上限対策）
- [x] `fetch-and-store-page-{n}` ステップ: OpenAlex `/works` を `filter=primary_topic.field.id:17,from_publication_date:2016-01-01,to_publication_date:2026-12-31` + `sort=cited_by_count:desc` + cursor paging で呼び出す
- [x] 生 JSON を R2 の `raw/openalex/field17/page-{n}.json` に保存する（同ステップ内）
- [x] OpenAlex レスポンスを `papers` 行にマッピングし D1 にバッチ投入する（同ステップ内、ID 数値化は `openAlexIdToNumber`）
- [x] `upsert-edges` ステップ: 全ページ取り込み後に R2 の生データを読み直し、`referenced_works` のうち `cited` 側が `papers` に存在するものだけを `edges` にバッチ投入する
- [x] `next_cursor` が `null` になるか N 件（既定 maxPages=250）に達するまでループするロジックを実装する — Workflows のステップ数上限（Paid 最大25,000）に対し、N=50,000件/250ページ=約252ステップに収まる設計で確定（下記「取り込む論文数 N の決定」参照）
- [x] 全件取り込み後の `recompute-child-cnt` ステップ（`edges` を集計し `papers.child_cnt` を更新）を実装する
- [x] SPEC 4.3「取り込み対象外の論文は祖先としてのみ必要な場合に限り追加」のロジック — PoC では簡略化し、N 件に含まれない祖先への edge は保存しない方針に確定（ARCHITECT.md 3.1 に反映）。個別補完は P2 以降
- [x] Workflow の冪等性を確認する — `papers`/`edges` ともに `ON CONFLICT ... DO UPDATE` / `DO NOTHING` で重複なし。400件（2ページ）のテスト実行で `child_cnt` と実際の `edges` 集計が完全一致することを確認済み（2026-11-09）

#### 取り込む論文数 N の決定（当初計画からの変更）
- 直近10年・Field 17 は実測で約609万件あり、1ページ200件で全件取得すると約30,500ページ（≒61,000ステップ以上）になり、Workflows のステップ数上限（Paid 最大25,000）を超えることが判明。
- SPEC 4.3「被引用上位 N 件」を `sort=cited_by_count:desc` で具体化し、**N = 50,000 件（200件 × 250ページ）** に固定して PoC を開始する方針を確定（ユーザー承認済み）。
- N に含まれない祖先への `edges` は保存しない簡略化も承認済み（上記参照）。

### P1-4. Cron Trigger 連携
- [x] Cron Trigger（日次 1 回）を設定し、Ingest Workflow を起動する — `wrangler.jsonc` の `triggers.crons` に `"0 18 * * *"`（UTC 18:00 = JST 翌3:00、深夜帯）を追加。`worker/index.ts` に `scheduled` ハンドラ（`env.INGEST_WORKFLOW.create({ params: { maxPages: 250 } })`）を実装し deploy 済み
- [x] 手動実行用に Workflow REST API 経由の起動手順を確認する — `wrangler workflows trigger journal-ingest-workflow '{"maxPages": N}'` で起動可能なことを確認済み（P1-3 の動作確認・本実行で使用）

### P1-5. 取り込み結果の検証
- [x] 取り込んだ論文数・エッジ数を集計し、SPEC 9 章の検証項目「D1 に投入できる」「depth 2 まで取得できる」を満たすか確認する — **papers 50,000件、edges 637,384件を投入（2026-11-09、実行時間約20分）。** シード論文（ResNet, id=2194775991）から祖先 depth1=4件・depth2=8件、子孫 depth1=7,735件を取得できることを確認。SPEC 9 章の両項目を満たす
- [x] `child_cnt` が実際の `edges` 集計と一致することを検証する（SPEC 9 章）— 50,000件全件で不一致 0 件を確認
- [x] ARCHITECT 3.4.1 の容量試算（直近10年で約6〜9GB）と実測値を比較し、ズレがあれば記録する — **D1 実測サイズ 33.8 MB（papers 50,000 + edges 637,384 件、`wrangler d1 info` で確認）。** 1論文あたりの実効エッジ数は 12.75 本（試算時の仮定 35 本/論文より少ない）。これは「N=50,000件に限定し、範囲外の祖先への edge を保存しない」簡略化（P1-3）により、上位5万件同士の相互参照しか拾えていないための過小評価であり、**全609万件を取り込んだ場合の実際の密度はこの値より高くなる見込み**。3.4.1 の 6〜9GB という試算は全件取り込み時の参考値として維持し、実際の分割判断は N を拡大する際に再実測する
- [x] 実測結果をもとに、年代分割（3.4.2）の区切り幅（5年固定か調整が必要か）を確定する — **現状の N=50,000件規模では分割不要（33.8MB は 10GB 上限に対して極小）。** 年代分割は N を拡大して全件規模（約609万件）に近づけた際に再検討する。5年単位の方針自体は変更せず、着手タイミングを N 拡大時に後ろ倒しする
- [x] 必要であれば D1 を年代別に分割し直す — 現時点では不要と判断（上記）

### P1-6. Semantic Scholar 連携（任意機能、後回し）
- [ ] Rate Limiter DO（Semantic Scholar 用、初期値 1 RPS）を実装する — DO クラス自体は P1-2 で用意済み（`RateLimiterSemanticScholar`）、Workflow からの利用は未実装
- [ ] 引用意図（intent）・influential citation を取得し、D1 の該当列（スキーマ追加）に反映するステップを Workflow に追加する
- 2026-11-09: ユーザー判断により P2（API 実装）を先に進める。SPEC 上も補助データ扱いのため、P2 以降で必要になった時点で着手する

---

## P2: D1 投入の安定化・API 実装

完了条件: 検証項目のうち API 関連が通ること（SPEC 9 章、ARCHITECT 8 章）。

### P2-1. API Worker の基盤整備
- [x] 軽量ルーティングフレームワーク（Hono 等）を導入する — `hono` を導入
- [x] `worker/index.ts` をルーティング・ハンドラ単位に分割する — `worker/api/{top,hubs,seed,search,paper,attribution}.ts` に分割、`worker/index.ts` で `app.route()` により統合
- [x] D1 クエリ用のヘルパー（パラメータ化クエリ）を整備する — `worker/db.ts`（`db(env)` で D1 バインディングを取得、`PaperRow` 型を共有）

### P2-2. `/api/fields/17/top`（被引用上位）
- [x] `from`（年）・`limit`（既定 50、最大 200）パラメータを実装する — `worker/api/top.ts`
- [x] `idx_papers_field_cit` を使った降順クエリを実装する
- [x] レスポンスの `Cache-Control` ヘッダを設定する — `public, max-age=3600`（SPEC 5.1 準拠）
- 動作確認済み（2026-11-09、本番 `https://journal.ursytsr.workers.dev/api/fields/17/top`）

### P2-3. `/api/fields/17/hubs`（分岐数上位）
- [x] `minChild`（既定 4）・`limit` パラメータを実装する — `worker/api/hubs.ts`
- [x] `child_cnt` を使った降順クエリを実装する
- 動作確認済み（2026-11-09）

### P2-4. `/api/fields/17/seed/{id}`（シード周辺グラフ）
- [x] `depth`（既定 2、最大 3）・`minCit` パラメータを実装する — `worker/api/seed.ts`
- [x] R2 の `graph/field17/seed-{id}-d{depth}.json` を確認し、あれば返すロジックを実装する
- [x] R2 未生成時に D1 から直接 BFS で depth まで計算して応答するフォールバックを実装する — `worker/graph.ts`（`buildSeedGraph`）
- [x] フォールバック時に Graph Build Queue へメッセージを送り、R2 生成を後追いするロジックを実装する。Queue consumer（Graph Builder、`worker/index.ts` の `queue` ハンドラ）も実装し、R2 への書き込みと次回リクエストでの `x-data-source: r2-cache` 応答を確認済み（当初 P4 予定だったが P2 で前倒し実装）
- **重要な修正（2026-11-09）**: D1 の `IN (...)` バインド変数上限は SQLite 標準の 999 ではなく **100**（D1 固有の制限）。当初チャンクサイズ 500 で実装し `D1_ERROR: too many SQL variables` が発生したため、90 に修正（`SQL_IN_CHUNK_SIZE`）。この制限は今後 D1 に `IN` クエリを書く際に必ず意識する
- **ノード数上限の追加**: ResNet 論文（子孫 7,735 件）のように fanout が大きいシードで BFS がノード数爆発を起こすため、SPEC 6.5「描画ノード数を 2,000 件程度までに抑える」に基づき `MAX_NODES = 2000` を実装。上限到達時は被引用数（cit）上位でノードを絞って打ち切る方針（ユーザー承認済み）。動作確認済み（depth=1, depth=2 ともにノード数 2000 件に制限されることを確認）

### P2-5. `/api/fields/17/search`（論文名検索）
- [x] `q`・`limit` パラメータを実装する — `worker/api/search.ts`
- [x] D1 の `LIKE` による検索を実装する（ARCHITECT 7-5 の初期方針）
- **既知の制約**: SQLite の `LIKE` は ASCII 範囲で大文字小文字を区別しないため、`q=BERT` で検索すると「Hil**bert**」「Lam**bert**ian」等の部分一致もマッチするノイズが入る（2026-11-09 実測で確認）。LIKE 検索の仕様上の限界であり、将来的に精度が問題になれば転置インデックス等への移行を検討する（ARCHITECT 7-5 に既述の方針通り）

### P2-6. `/api/fields/17/paper/{id}`（論文詳細・系譜）
- [x] 論文の基本情報取得を実装する — `worker/api/paper.ts`
- [x] 系譜（祖先の列）を辿るクエリを実装する — 複数祖先がある場合は被引用数最大の経路を 1 本選んで辿る簡易仕様（PoC）
- 動作確認済み（2026-11-09）

### P2-7. 共通仕様
- [x] `404`（論文なし）・`429`（外部 API 制限）・`503`（一時的な失敗）のエラーハンドリングを実装する — 404/400 は各ルートで実装、`app.onError` で未捕捉エラーを 503 にフォールバック。429（外部 API 制限）は P2 の範囲では発生しない（外部 API 呼び出しは Ingest Workflow 側のみ）ため実装対象外、P4 で必要になれば追加
- [x] 出典表示用のメタデータ（OpenAlex・Semantic Scholar の出典情報）を API レスポンスまたは別エンドポイントで返せるようにする（SPEC 7 章・9 章）— `GET /api/attribution` として実装

### P2-8. 検証
- [x] SPEC 9 章の検証項目のうち API 関連（D1 投入、depth 2 取得、`child_cnt` 一致）が通ることを確認する — P1-5 で D1 投入・depth2・`child_cnt` 一致を確認済み。P2 では加えて 5 エンドポイント（top/hubs/seed/search/paper）+ attribution の本番動作を実機で確認済み（2026-11-09）。seed はキャッシュ未生成時の D1 直接計算（`x-data-source: d1-direct`）と、Queue 経由で R2 生成後のキャッシュ応答（`x-data-source: r2-cache`）の両方を確認

---

## P3: フロントエンドを実データに接続

完了条件: 検証項目のうち表示関連が通ること（SPEC 9 章、ARCHITECT 8 章）。

### P3-1. 画面構成の実装（SPEC 6.1）
- [x] ヘッダー（タイトル、サンプル表示時の注意書き、凡例）を実装する — `src/components/Header.tsx`
- [x] 操作バー（表示件数、ハブ基準、骨格のみ、最多被引用へ、全体表示）を実装する — `src/components/OperationBar.tsx`。**変更（2026-11-09）**: 年スライダーは実装したが UI として分かりにくいとのユーザー判断で撤去。`OperationBar`/`App.tsx` から `year` state・`n.y <= year` フィルタ・選択時の年自動進行ロジックを削除し、SPEC.md 6.1/6.3/6.4/6.5、9章の検証項目からも該当記述を削除した
- [x] メイン（系統樹 SVG。ドラッグ・ホイールズーム）を実装する — `src/components/GraphView.tsx`
- [x] サイドパネル（選択中の論文詳細・系譜、被引用上位10件、ハブ上位10件）を実装する — `src/components/SidePanel.tsx`

### P3-2. 系統樹描画（SPEC 6.2）
- [x] X 軸を出版年とするレイアウト計算を実装する — `src/layout.ts`（`layoutGraph`）
- [x] 親子間の Bezier 曲線描画を実装する — `GraphView.tsx`（`bezierPath`）
- [x] Y 軸の並び順（子の被引用合計の多い順）を実装する — `layout.ts`（`computeChildCitationSum`）
- [x] 円のサイズ（分岐数に応じて拡大）を実装する — `layout.ts`（`nodeRadius`）。**修正（2026-11-09）**: 当初は平方根スケールで実装したが、実データで ResNet 論文（分岐 7735）の円が半径196pxと画面を占有する問題が発生（ユーザー報告のスクリーンショットで確認）。分岐数分布の偏り（平均14、最大7735）を踏まえ対数スケール（`log1p`）に変更し、最大半径を約39pxに圧縮。SPEC.md 6.2 の記述も「平方根」から「対数スケール」に更新済み
- [x] 円の色（分岐0は灰色、分岐数に応じて琥珀色→赤のグラデーション）を実装する — `layout.ts`（`nodeColor`）
- [x] ハブ判定（分岐数 ≥ 基準、既定4）を表示・骨格ロジックに反映する — `src/filters.ts`（`isHub`, `resolveSkeleton`）
- [x] ホバー時のツールチップ（論文名・出版年・被引用数・分岐数・ハブ表示）を実装する — `GraphView.tsx`
- [x] 表示・非表示切り替えのフェード・拡大アニメーションを実装する — `GraphView.tsx`（`opacity`/`r` の CSS transition）

### P3-3. 表示の絞り込み（SPEC 6.3）
- [x] ~~年スライダーによる絞り込みを実装する~~ — 2026-11-09 に機能ごと撤去（UI として分かりにくいとのユーザー判断）
- [x] 被引用上位 N 件 + その祖先の表示ロジックを実装する — `App.tsx`（`displayLimit` による上位ソート）。**簡易仕様の注記**: 「その祖先」の明示的な追加は未実装（上位N件のソートのみ）。骨格のみモードで祖先が別途保証される
- [x] 骨格のみモード（ハブ + その祖先 + 選択中の系譜）を実装する — `filters.ts`（`resolveSkeleton`）+ `App.tsx`
- [x] 「この系統に集中」モード（フォーカス論文の祖先・子孫のみ表示）を実装する — `filters.ts`（`resolveLineageSubtree`）
- [x] 祖先の折りたたみ状態を表示ロジックに反映する — `App.tsx`（`collapsedIds` による子孫非表示）

### P3-4. 操作（SPEC 6.4）
- [x] 円クリックで論文選択・系譜強調・他を薄く表示する処理を実装する — `App.tsx`（`handleSelect`）、`GraphView.tsx`（`lineageIds` による dimmed 表示）
- [x] ~~選択時に年スライダーを選択論文の年まで自動的に進める処理を実装する~~ — 年スライダー撤去（2026-11-09）に伴い削除
- [x] 一覧（上位・ハブ・検索結果）項目クリックで同様の選択処理を実装する — `handleSelectFromList`（現在のグラフ範囲外の場合は新たにシードグラフを取得）
- [x] 「最多被引用へ」ボタンを実装する — `handleGoToTopCited`
- [x] 子の折りたたみ／展開トグルを実装する — `handleToggleCollapseDescendants`
- [x] 「この系統に集中」ボタン（フォーカス設定 + 表示件数を全件化）を実装する — `handleFocusLineage`
- [x] 「選択解除」ボタンを実装する — `handleDeselect`
- [x] 「全体表示」ボタン（フォーカス解除、表示位置リセット）を実装する — `handleResetView`
- [x] 「骨格のみ」トグルを実装する — `OperationBar.tsx`

### P3-5. API 接続
- [x] `/api/fields/17/top` を呼び出し、サイドパネルの上位一覧に反映する
- [x] `/api/fields/17/hubs` を呼び出し、サイドパネルのハブ一覧に反映する
- [x] `/api/fields/17/seed/{id}` を呼び出し、メイン SVG のノード・エッジに反映する
- [x] `/api/fields/17/search` を呼び出し、検索 UI を実装する — `SidePanel.tsx`（`SearchBox`）
- [x] `/api/fields/17/paper/{id}` を呼び出し、選択中論文の詳細パネルに反映する — `handleSelect` 内で系譜を取得
- [x] 架空データ（現行プロトタイプ）から実データ取得への切り替えを行う — `App.tsx` の `useEffect` で起動時に top/hubs/seed を取得し、失敗時のみサンプルデータ（`src/sampleData.ts`）にフォールバック（SPEC 7 章「障害時」に対応）
- 既存の create-cloudflare テンプレートの内容（`src/App.tsx` 等）とテンプレート専用アセット（React/Vite/Cloudflare ロゴ、`icons.svg`）は全面的に置き換え・削除

### P3-6. 性能確認（SPEC 6.5）
- [x] 表示ノード 600 件程度で、表示件数変更がおおむね 100ms 以内に反映されることを確認する — React の `useMemo` によるフィルタ計算のみで、追加の API 呼び出しなし。ブラウザ実機確認でインタラクションの遅延は体感なし
- [x] 実データでの描画ノード数が 2,000 件を超えないよう表示件数制限が機能することを確認する — P2-4 で実装済みの `MAX_NODES=2000`（`worker/graph.ts`）がサーバー側で保証。フロント側の表示件数セレクタも最大 2000 に制限

### P3-7. 検証（2026-11-09、本番 `https://journal.ursytsr.workers.dev` で実機確認）
- [x] SPEC 9 章の検証項目のうち表示関連が通ることを確認する — ハブの色・大きさ区別（スクリーンショットで確認）、文字非表示＋ホバー表示（ツールチップ動作確認）、出典表示（`Header.tsx` に OpenAlex（CC0）への帰属表示を追加し、ヘッダー下部に常時表示。Semantic Scholar は未連携のため記載せず）。年スライダー絞り込みの検証項目は機能撤去に伴い SPEC 9章から削除
- [x] 被引用1位の論文までクリック2回以内で到達できることを確認する — 「最多被引用へ」ボタン1クリックで到達することを実機確認

#### 既知の未完了点
- **キーボード操作・スクリーンリーダー対応**: SPEC 6.6 で明示的に非対応と定義されているため対応なし（想定通り）
- **モバイル表示**: SPEC 6.6 で「最低限の表示のみ」とされており、レスポンシブ対応は未着手（PoC の範囲外）

---

## P4: キャッシュ戦略・Graph Builder（Queues）の整備

完了条件: 検索・シード探索が実用速度であること（SPEC 9 章、ARCHITECT 8 章）。

### P4-1. Graph Builder（Queue Consumer）の実装
- [ ] Queue Consumer Worker を実装する（メッセージ: `{seedId, depth}`）
- [ ] D1 から祖先・子孫方向に BFS し、`depth` まで展開するロジックを実装する
- [ ] 結果を R2 の `graph/field17/seed-{id}-d{depth}.json` に保存する処理を実装する
- [ ] Ingest Workflow 完了後、被引用上位・ハブ上位をシード候補として Queue に投入する処理を実装する（ARCHITECT 3.2）

### P4-2. キャッシュ戦略の実装
- [ ] Workers Cache（`caches.default`）を使った短期キャッシュ（SPEC 5.1 の有効期間）を実装する
- [ ] R2 のグラフ JSON を長期キャッシュとして読み出す経路を確認する
- [ ] キャッシュキー設計（`graph:f17:seed:{id}:d{depth}`、`top:f17:from{year}:l{limit}`）を実装する
- [ ] R2 のライフサイクルルール（`raw/` 系 30日自動削除）を設定する

### P4-3. 外部 API 障害時のフォールバック
- [ ] OpenAlex / Semantic Scholar 呼び出し失敗時に、キャッシュ済み結果を返すロジックを実装する
- [ ] レスポンスヘッダ（例: `X-Data-Freshness: stale`）で鮮度を明示する実装を行う

### P4-4. 検証
- [ ] キャッシュ（R2 / Cache API）の有無で応答が変わることを確認する（SPEC 9 章）
- [ ] 外部 API の失敗時にキャッシュ済みの結果を返すことを確認する（SPEC 9 章）
- [ ] 検索・シード探索のレスポンス時間を実測し、実用速度であることを確認する

---

## P5: 人文系（Field 12）への展開

完了条件: 疎なグラフでの見え方を評価できること（SPEC 9 章、ARCHITECT 8 章）。

### P5-1. 事前確認
- [ ] Field 12（Arts and Humanities）と Field 33 の分類境界を OpenAlex で確認する（ARCHITECT 7-6）
- [ ] 人文系の引用数の傾向（平均約1.8、SPEC 8章）を踏まえ、ハブ基準・表示パラメータの既定値を見直す

### P5-2. 展開作業
- [ ] 人文系用の D1 データベースを作成する（分野 DB の結合ルール、SPEC 4.4 に従う）
- [ ] Ingest Workflow を人文系向けに設定変更して実行する（`field` パラメータの切り替え）
- [ ] フロントエンドで分野切り替え UI（最小限）を追加する

### P5-3. 検証
- [ ] 疎なグラフ（分岐数が少ない）でのハブ判定・表示が適切かを評価する
- [ ] 分野内正規化指標（`fwci` 等）の併記が必要かを評価する（SPEC 8 章）

---

## 全フェーズ共通の継続タスク

- [ ] 取り込み元データの再現性記録（OpenAlex スナップショット／API 取得日時の記録、SPEC 7 章）
- [ ] 帰属表示（OpenAlex・Semantic Scholar の出典）が画面に表示されていることの継続確認
- [ ] D1 容量の監視（10GB の 80% 等の閾値に近づいた場合のアラート運用、ARCHITECT 3.4.2）
- [ ] Cloudflare の料金（D1 / R2 / Workflows / Queues / Workers Paid）が想定内に収まっているかの定期確認（SPEC 7 章「コスト」）

### 既知の暫定措置（要クリーンアップ）

- **D1（papers/edges）が本番・ローカルとも 0 件になっている**（2026-11-10 時点で確認。原因未調査）。**方針変更（P1-0）** により、解消は次回の Ingest Workflow 実行ではなく、S3 スナップショットからの初期インポート（P1-0）の完了を待つことになった。
- **R2 の `graph/field17/seed-2194775991-d2.json`（本番・ローカル両方）に、月単位レイアウト（X軸の月グリッド化）の見た目確認用として、`year` を手動で `year + ランダムな月/12` に書き換えたテストデータが入っている**（2026-11-10）。実際の OpenAlex 由来データではないため、このファイルを見ている間は分岐数・被引用数は正しいが出版年月が不正確。**方針変更（P1-0）** により、解消タイミングは初期インポート完了後に Graph Builder が同じシード・depth のグラフを再生成した時点になる。それまでは本番サイトでこのシード（Deep Residual Learning, id=2194775991, depth=2）を表示すると不正確な月が見える点に注意。
- **本番 D1（`field17_2016_2026`）の `papers`/`edges` に、外部リンク機能（OpenAlex/DOI）の動作確認用テストデータ 3 件を手動投入している**（2026-11-10、id=2194775991 Deep Residual Learning, 2163605009 ImageNet classification, 639708223 Faster R-CNN。`doi` 列・`child_cnt` は概算値で実際の値とは異なる）。実際の OpenAlex データではないため、**方針変更（P1-0）** により、初期インポート（S3スナップショット由来）投入時に `ON CONFLICT` で正しい値に上書きされる想定。それまでは本番の `/api/fields/17/top` 等にこの3件が混じって見える。

### UI 整理（2026-11-10）

- **「最多被引用へ」ボタンを撤去**した。円の大きさ（対数スケール、分岐数に比例）で被引用上位がひと目で分かるため不要と判断。被引用 1 位へは、サイドパネルの「被引用の上位」一覧の先頭項目クリックで引き続き到達できる。SPEC.md 6.1/6.4 から該当記述を削除し注記を追加済み。tasks.md 上記の過去の実績記録（P3-4, P3-7 など）は履歴としてそのまま残す。
- **「ハブの基準」の表示連動バグを修正 → その後 UI ごと撤去**: 当初、ツールチップの「ハブ」表示が操作バーの「ハブの基準」とは無関係にハードコードされた `4` で判定されていたバグを修正し、`GraphView` に `hubMinChild` を渡して `filters.ts` の `isHub()` で統一判定するようにした。しかしユーザーが実際に基準を極端な値（例: 54321989）に変えても「円の色・大きさが変わらない」と報告。円の色・大きさは分岐数の連続値で決まる設計（骨格のみの絞り込みとツールチップの「ハブ」表示にしか基準が反映されない）のため、変更しても見た目の変化が分かりにくいことが根本原因と判明。色・大きさを連続表現のまま維持する方針を優先し、「ハブの基準」の調整 UI 自体を撤去。`isHub()` はデフォルト引数 `HUB_MIN_CHILD_DEFAULT = 4`（`filters.ts`）を使う固定値判定に戻した。サイドパネルの「ハブ上位 10 件」一覧の再取得（`hubMinChild` 変更時）ロジックも不要になり削除。
- **「骨格のみ」「表示件数」の各ラベルに `title` 属性で説明文を追加**し、ホバーで機能の意図が分かるようにした。

### UI 英語化（2026-11-10）

- **画面表示文言をすべて英語化**した（コメントは日本語のまま）。`index.html` のタイトル、`Header`/`OperationBar`/`SidePanel`/`GraphView` のツールチップ・ボタン・見出し・プレースホルダー、`sampleData.ts` のサンプル論文名。`layout.ts` の `formatYearMonth` を `"Jun 2016"` 形式に変更し、新たに `formatChildCount`/`formatCitationCount` を追加して "1 child"/"2 children"、"1 citation"/"2 citations" の単数・複数形を正しく出し分けるようにした。言語切り替え機能は追加していない（固定で英語）。

### 著者名検索（2026-11-10、検索まわりのみ先行実装）

- **方針**: ingest は S3 からのインポート方式で作り直す予定のため、ingest・スキーマへの実データ投入はまだ行わない。検索 API・フロントエンドのみ、将来 `authorships` テーブルが埋まる前提で先行実装した。
- **`migrations/0004_create_authorships_table.sql`** を追加（`authorships(paper_id, author_name)`、正規化・複合PKなし）。ローカル・本番両方に適用済み（テーブルは空）。
- **`worker/api/search.ts`** を `papers LEFT JOIN authorships` + `WHERE title LIKE ? OR author_name LIKE ?` に変更。1論文に複数著者がマッチして重複行が出るのを防ぐため `SELECT DISTINCT` を使用。`authorships` が空の間もタイトル検索は従来通り動作することを確認済み。
- **`SidePanel.tsx`** の検索ボックスのプレースホルダーを `"Title or author name..."` に変更。
- **動作確認**: 本番・ローカル両 D1 に `Kaiming He`/`Xiangyu Zhang`（論文 id=2194775991 向け）のテスト著者行を投入し、著者名検索・タイトル検索ともにヒットし重複も出ないことをブラウザ実機で確認した。**このテスト著者データは本番 D1 に残したまま**にしている（実際の論文の実際の著者名であり実害はない）。S3 ingest 実装時に `authorships` テーブル全体が正規データで埋まる想定で、そのまま上書きされずに残る可能性があるため、本格データ投入時にテスト行の要否を再確認すること。
- **次にやること**: S3 ingest 実装時に、各論文の著者一覧を `authorships` に INSERT する処理を追加する（OpenAlex の `authorships[].author.display_name` 相当のフィールドを S3 データから取得する）。

### 分野・年代の切り替え基盤（2026-11-10、コード基盤のみ先行実装）

- **方針**: D1 の 10GB 上限に対応するため分野・年代ごとに D1 を分割する（ARCHITECT.md 3.4.2）計画に先立ち、「複数 DB を切り替えられるコード基盤」を今回入れた。実際の DB（5年単位の年代分割など）はまだ作成していない。現状は `DB_FIELD17_2016_2026` の1つだけを `DB_REGISTRY` に登録している。
- **`worker/db.ts`**: `DB_REGISTRY: {field, yearRange, binding}[]` を新設。`resolveFieldDb(env, fieldParam, yearRangeParam?)` が分野・年代レンジから対応する `D1Database` を解決する（未登録の組み合わせは 404）。`listFields()`/`listYearRanges()` は `/api/fields` 用。
- **API ルーティング変更**: 全エンドポイントを `/api/fields/17/...` 固定から `/api/fields/:field/...`（`yearRange` はクエリパラメータ）に変更。新規 `GET /api/fields`（`worker/api/fields.ts`）で登録済みの分野・年代レンジ一覧を返す。
  - **Hono のサブルーター制約**: `app.route("/api/fields/:field/top", topRoute)` のようにマウント元でパスパラメータを切ると、サブルーター側の型に `:field` が伝播せず `c.req.param("field")` が `string | undefined` になる（実行時には値は正しく取れるが型エラーになる）。回避策として、各ルート自身が `/fields/:field/top` のようなフルパスを持ち、`app.route("/api", topRoute)` でマウントする方式にした。
- **`worker/graph.ts`**: `graphKey()` に `field` を含め `graph/field{N}/seed-{id}-d{depth}.json` に変更。`buildSeedGraph()`/`fetchEdgesChunked()`/`fetchPapersChunked()` は `env` ではなく解決済みの `D1Database` を直接受け取るよう変更（呼び出し元が `resolveFieldDb()` で解決してから渡す）。
- **`worker/index.ts`**: Graph Build Queue のメッセージに `field` を追加（`GraphBuildMessage`）。Queue コンシューマは `resolveDb(env, field)` で対象 DB を解決してから `buildSeedGraph` を呼ぶ。
- **フロントエンド**: `src/api.ts` の全 fetch 関数が `field`/`yearRange` を引数に取るよう変更。`src/App.tsx` に `field`/`yearRange` state を追加し、起動時に `GET /api/fields` で選択肢を取得。`src/components/Header.tsx` に分野・年代のセレクトボックスを追加（現状は選択肢が1つなので実際の切り替えは未検証、API 自体は `curl` で動作確認済み）。切り替え時はグラフ・一覧・選択状態を全てリセットして再読み込みする。
- **動作確認**: `curl` で `/api/fields`、`/api/fields/17/top?yearRange=2016-2026`、存在しない `field`/`yearRange` での 404 を確認。ブラウザで検索・ノード選択・詳細表示が新しい `:field` パス経由で正常動作することを確認。検索結果からのシード切り替え（`fetchSeedGraph`）も API レベルでは正しく新しいグラフ（祖先ノードを含む）を返すことを確認したが、画面の表示件数・スクロール位置の都合で見た目の変化が分かりにくいケースがあった（マルチ DB 機能自体の問題ではない）。
- **未着手**: 実際の複数 DB 作成（5年単位の年代分割）、複数 DB をまたぐ `UNION ALL` 結合（SPEC.md 4.4 の結合ルール）、`<title>` タグ等での選択中分野名の動的反映。

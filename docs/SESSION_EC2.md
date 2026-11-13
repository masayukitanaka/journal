# EC2 作業セッションの記録（SESSION_EC2.md）

- 作業期間: 2026-11-11 〜 2026-11-13（この EC2 インスタンスは 2026-11-13 に破棄予定）
- 対象: [docs/init-ingest.md](./init-ingest.md) の初期インポート（OpenAlex S3 スナップショット → D1）
- 進捗: **本番データ（分野17・2006〜2026年、論文 11,438,011 件）を 5 つの年代 D1 へ投入し、検証済み**。その後、出版年の誤りの修正・性能改善（別セッション）も実施
- 関連: [docs/tasks.md](./tasks.md)（P1-0、末尾の 2026-11-11〜12 の作業記録）、[docs/optimizing.md](./optimizing.md)、[docs/SPEC.md](./SPEC.md) 4.3

---

## 0. 要約

| 項目 | 結果 |
|---|---|
| 取り込み範囲 | 分野 17、出版年 2006〜2026、`is_xpac` を除く全件（2026-10-14 スナップショット） |
| D1 | 5 年単位の 5 DB（`field17_2006_2010` 〜 `field17_2026_2030`）、合計約 13.3 GB |
| 処理時間（EC2） | stage 62 分 → build 5 分 → export_sql 9 分 → D1 投入 約 3 時間（5 DB 並列） |
| 検証 | 全 5 DB で件数・`child_cnt` 合計・被引用数合計・参照整合性がすべて一致 |
| EC2 破棄で失われるもの | `data/openalex/work/`（中間データ・ログ、約 13 GB）。**すべて再生成できる**（6 章） |

---

## 1. 作業環境（EC2、破棄予定）

| 項目 | 内容 |
|---|---|
| マシン | EC2、2 vCPU・メモリ 7.6 GB（スワップなし）・EBS 500 GB、Amazon Linux 2023 |
| ツール | Python 3.9、duckdb 1.4.5（pip）、wrangler 4.160.0（グローバル）、aws CLI |
| S3 読み込み速度 | 約 160〜200 MB/s（DuckDB httpfs、4 並列）。全 744 GB を約 1 時間で読めた |

**注意点（別マシンで再実行する場合も同様）**

- **Cloudflare 認証**: `~/.bashrc` に `CLOUDFLARE_API_TOKEN` を設定していた（EC2 破棄で消える）。Claude Code のシェルはセッション開始時の環境を引き継ぐため、wrangler を使うコマンドの前に `source ~/.bashrc` が必要だった。
- **`wrangler types` の注意**: `.dev.vars` が無いマシンで `wrangler types` を実行すると `worker-configuration.d.ts` から `OPENALEX_API_KEY` の型が消える。手で戻すこと。
- **長時間処理はセッションから切り離す**: `setsid nohup scripts/ingest/run_*.sh > /dev/null 2>&1 < /dev/null &` で起動し、`data/openalex/work/*.status` と `*.log` で進捗を見る（Claude Code や SSH が切れても止まらない）。

---

## 2. 決定事項

- **取り込み範囲**: 分野 17・**2006 年以降（約 20 年）の全件**（SPEC 4.3。当初の直近 10 年から拡大）。
- **`is_xpac` を除外**（2026-11-11 夜に追加、**SPEC.md・init-ingest.md には未反映**）: スナップショットには、OpenAlex API が既定で除外する `is_xpac = true` の論文（2025 年以降の拡張収録分。データセット・ソフトウェア・学位論文など）が含まれる。被引用・参考文献がほぼゼロで、含めると 2016〜2026 年が約 868 万件になり API 実測（P0-1、約 609 万件）より 4 割多かった。API・日次差分（API 経由）と揃えるため既定で除外した（`stage.py --include-xpac` で含められる）。サンプル 3 ファイルでは論文 -24%、edges -1%。
- **D1 の分割**: **5 年単位**の 5 DB。論文の所属 DB は出版年で決める（ARCHITECT.md 3.4.2）。
- **edges**: cited・citing とも取り込み範囲内の論文であるものだけを保存し、**citing 側の DB に置く**（SPEC 4.4 の結合ルール）。自己引用は除外。全 edges の約 67%（4,709 万 / 6,986 万）は cited が別の年代 DB にある。
- **child_cnt**: **全年代の edges から計算**（DB をまたぐ子も数える）。
- **D1 投入方式**: SQL ファイル（複数行 INSERT、1 文 90KB 以下）を `wrangler d1 execute --file` で投入。
- **抽出スクリプト**: 検証用の `data/openalex/extract_cs.py` は使わず、`scripts/ingest/` に新規作成。

---

## 3. スクリプト（`scripts/ingest/`、すべてコミット済み）

| ステップ | スクリプト | 内容 |
|---|---|---|
| 1 | `stage.py` | S3（`manifest.json` の URL を 1 ファイルずつ）を DuckDB httpfs で直接読み、分野・年・xpac で絞った中間 Parquet を `work/stage/` に出力。再開可能。条件が前回と違うと停止（`work/stage_params.json`）。接続ごとに `--memory-limit 1GB`（4 並列で OOM しないよう、別セッションで追加） |
| 2 | `build.py` | 中間 Parquet → `work/out/{DB名}/{papers,edges,authorships,keywords,paper_keywords}.parquet` + `out/stats.json`。重複 id は id だけで集計して判定（全列へのウィンドウ関数は OOM したため変更）。edges・authorships は論文ごとの `list_distinct` で重複除去 |
| 3 | `export_sql.py` | `out/` → `work/sql/{DB名}/{NN}_{table}_{part}.sql`（1 文 90KB 以下、1 ファイル 100MB 以下、主キーのあるテーブルは `INSERT OR REPLACE`） |
| 4 | `load_d1.py` | SQL ファイルを D1 に投入し検証。投入済みファイルを `work/load_progress/` に記録して再開可能。検証クエリは範囲分割・再試行つき（D1 の CPU 制限対策、別セッションで改修） |
| 通し | `run_local.sh` | 1〜3 を通しで実行（D1 投入は含まない）。状態 `work/pipeline.status`、ログ `work/pipeline.log`、メモリ `work/pipeline_mem.log` |
| 通し | `run_load.sh` | 5 DB を並列で `load_d1.py --remote` 実行。状態 `work/load.status`、ログ `work/load_{DB名}.log` |
| 通し | `run_verify.sh` | 5 DB を並列で `load_d1.py --verify-only` 実行。状態 `work/verify.status`、ログ `work/verify_{DB名}.log` |
| 修正 | `fix_misyeared_papers.py` | 出版年の誤りの検出・DB 間移動（5.2 参照） |

---

## 4. 作業の経緯

### 4.1 段階①・②（2026-11-11 午前）

- 3 ファイル（2.2 GB）で stage・build を確認（論文 42,337 件、チェック項目すべて 0）。
- D1 を 5 つ作成（WNAM）し、`wrangler.jsonc`・`DB_REGISTRY` に登録、migrations 0001〜0005 を適用。

  | DB | database_id |
  |---|---|
  | field17_2006_2010 | 674c579d-23d3-43c3-985e-61ec1d6bf7b5 |
  | field17_2011_2015 | 964d0981-ad71-41ad-bb02-88c81993fc3e |
  | field17_2016_2020 | fc881b17-24af-4eee-90e7-ec6d91f59eba |
  | field17_2021_2025 | 2dcce76f-dc22-49bc-9731-d65fc6826b02 |
  | field17_2026_2030 | c1e37da2-dd71-4ae6-b9e7-b722d29ba58d |

- ローカル D1・本番 D1 とも小規模データの投入・検証が全項目一致。

### 4.2 全件パイプライン 1 回目（2026-11-11 17:00 頃、失敗）

- 別セッションで `run_local.sh` を作成・実行。stage（xpac を含む、1,401 万件）は完了したが、**build が OOM で失敗**（重複除去の `row_number() OVER (PARTITION BY id ...)` を全列にかけていた。重複 id は実際には 0 件）。ログは `work/pipeline.prev-oom.log`（EC2 とともに消える）。

### 4.3 全件パイプライン 2 回目（2026-11-11 22:33〜23:50、成功）

- 修正内容: build の重複除去を軽量化、stage で `is_xpac` を除外（2 章）。
- 所要時間: stage 61.9 分（1,898 ファイル、失敗 0）→ build 5 分 → export_sql 9 分。メモリ使用量は stage 中 約 4.5 GB で安定。
- 作業領域: stage 2.4 GB / out 2.1 GB / sql 8.3 GB。

| DB | papers | edges（うち cited が別 DB） | authorships | keywords | paper_keywords | SQL |
|---|---|---|---|---|---|---|
| field17_2006_2010 | 1,932,850 | 3,072,398（189,835） | 4,426,213 | 443,391 | 10,565,552 | 1.1 GB / 13 ファイル |
| field17_2011_2015 | 2,436,353 | 10,291,552（6,728,820） | 5,850,778 | 518,022 | 13,771,688 | 1.6 GB / 18 |
| field17_2016_2020 | 2,693,374 | 19,159,162（12,782,406） | 7,319,358 | 575,258 | 16,011,926 | 2.0 GB / 23 |
| field17_2021_2025 | 3,340,772 | 32,930,571（23,055,581） | 11,148,218 | 636,741 | 22,825,086 | 3.0 GB / 33 |
| field17_2026_2030 | 1,034,662 | 4,405,995（4,330,867） | 3,206,170 | 411,488 | 7,093,028 | 0.8 GB / 10 |
| **合計** | **11,438,011** | **69,859,678（47,087,509）** | 31,950,737 | 88.5 万語（全体の異なり語数） | 70,267,280 | 8.3 GB / 97 |

- 参考文献の総数 1 億 4,683 万件のうち、両端が取り込み範囲内の edges は 6,986 万件（約 48%）。
- 重複 id 0 件。build のチェック項目（NOT NULL 違反、年代外の論文、DB 内に citing が無いエッジ、辞書に無い keyword_id、`child_cnt` 合計とエッジ総数の差）はすべて 0。
- keywords の語彙は全体で約 88 万語（当初見積もりの「数万語」より大きい）。

### 4.4 容量の事前測定（2026-11-12 未明、別セッション）

- 最大の `field17_2021_2025` の SQL をローカル SQLite に流して容量を測定（`work/measure.log`）: **4.74 GB**（約 22 分）。内訳の目安は papers 0.74 GB・edges 1.31 GB・authorships 0.83 GB・paper_keywords 1.8 GB 程度。10 GB 上限に対し余裕があると判断。

### 4.5 本番 D1 への投入・検証（2026-11-12 03:31〜07:10、別セッション）

- 投入前に段階②の小規模データを削除し、`run_load.sh` で 5 DB を並列投入（約 3 時間 15 分）。全 97 ファイルの投入は完了（`work/load_progress/` に記録）。
- `load.status` は `FAILED` になったが、原因は投入後の検証クエリが D1 の制限（`D1 DB exceeded its CPU time limit and was reset` / `D1 DB is overloaded`、code 7429）に当たったこと。`load_d1.py` の検証を範囲分割・再試行つきに改修し、`run_verify.sh` で再検証して **全 5 DB で全項目 OK**（`verify.status`: `DONE ...:OK`）。

| DB | D1 サイズ（2026-11-13） | child_cnt 合計 | 被引用数合計 |
|---|---|---|---|
| field17_2006_2010 | 1.64 GB | 16,787,055 | 23,336,756 |
| field17_2011_2015 | 2.37 GB | 17,216,767 | 24,245,313 |
| field17_2016_2020 | 3.19 GB | 22,963,322 | 32,317,917 |
| field17_2021_2025 | 4.82 GB | 12,775,042 | 18,638,678 |
| field17_2026_2030 | 1.26 GB | 117,492 | 185,407 |

（child_cnt・被引用数は投入直後の検証時点の値。サイズには migration 0006 のインデックスと 5.2 の移動分を含む）

---

## 5. 投入後の作業（別セッション、詳細は tasks.md 末尾・optimizing.md）

### 5.1 アプリ側の切り替え

- `DB_REGISTRY` の既定（先頭）を `field17_2021_2025` に変更し、旧 `field17_2016_2026` をレジストリから外した。**`wrangler.jsonc` の binding と D1 本体（約 0.04 GB）は残っている**。

### 5.2 出版年の誤りの修正（`fix_misyeared_papers.py`）

- 「Attention Is All You Need」が 2025 年扱いになっていたことから発覚。スナップショット時点で一部の著名論文の `publication_year` が誤っていた（OpenAlex 側のデータ品質問題。現在の API では修正済み）。
- 各 DB の `cit >= 1000`（計 5,011 件）を OpenAlex API で再確認し、**21 件を正しい年代 DB へ移動**（papers・edges(citing 側)・authorships・paper_keywords・keywords）。OpenAlex の Work ID マージにも対応。
- 既知の制約: 正しい年が範囲外（2005 年以前など）の論文は移動せず残している。マージされた Work のタイトルが古いまま残る例がある。`cit < 1000` の論文は未検証。

### 5.3 性能改善

- `migrations/0006_add_child_cnt_index.sql`（`papers(field, child_cnt DESC)`）を全 5 DB に適用。hubs API が約 8 秒 → 約 10 ms。
- `worker/graph.ts` のチャンク問い合わせを並列化（20 件ずつ）、初期表示の seed depth を 1 に、seed 取得に 8 秒のタイムアウトとフォールバックを追加。
- 残課題（検索 API の遅さ・短いクエリでの 503、R2 キャッシュの実効性、超高被引用論文の seed など）は `docs/optimizing.md` に記載。

---

## 6. EC2 破棄の影響と再現手順

**コード・ドキュメントはすべて GitHub（`origin/main`）に push 済み**（この SESSION_EC2.md の更新を除く）。D1 のデータは Cloudflare 上にあり、EC2 破棄の影響を受けない。

**EC2 とともに消えるもの**（`.gitignore` 対象の `data/openalex/work/`）:

- `stage/`（2.4 GB）・`out/`（2.1 GB、DB ごとの Parquet と `stats.json`）・`sql/`（8.3 GB）・`build.duckdb`
- ログ・状態ファイル（`pipeline*.log`、`load_*.log`、`verify_*.log`、`measure.log`、`*.status`、`load_progress/`）
- `measure_2021_2025.sqlite`（容量測定用、4.7 GB）
- `~/.bashrc` の `CLOUDFLARE_API_TOKEN`

本書と tasks.md に主要な数値を残したので、ログが無くても経緯は追える。中間データが必要になった場合は、同じスナップショット（`manifest.json` の `date: 2026-10-14`）から以下で再生成できる（同規模の EC2 で約 1 時間 15 分）。**ただし OpenAlex は S3 を週次で更新するため、古いスナップショットのファイルが S3 から消えていると同じ結果にはならない**（新しい `manifest.json` を取得して作り直すことになる）。

```bash
# us-east-1 の EC2（S3 と同一リージョン）推奨。メモリ 8 GB 程度で可
pip install duckdb
cd journal
setsid nohup scripts/ingest/run_local.sh > /dev/null 2>&1 < /dev/null &   # stage → build → export_sql
cat data/openalex/work/pipeline.status                                     # DONE になるまで待つ
# D1 へ投入する場合（対象 DB が空であること。空でなければ load_d1.py が停止する）
export CLOUDFLARE_API_TOKEN=...
setsid nohup scripts/ingest/run_load.sh > /dev/null 2>&1 < /dev/null &
setsid nohup scripts/ingest/run_verify.sh > /dev/null 2>&1 < /dev/null &
```

---

## 7. 残タスク

### 7.1 ドキュメントの更新漏れ

- **`is_xpac` の除外**を SPEC.md 4.3・init-ingest.md 3.3 に反映する（2 章）。
- **tasks.md P1-0 の ③・④ のチェックボックスが未更新**（実際には全件投入・検証まで完了。本書 4.3〜4.5 の内容で更新する）。完了条件の「直近10年・約609万件」も実態（2006 年以降・1,144 万件）に合わせる。
- init-ingest.md の 3.4 に、本番での投入時間（約 3 時間）・検証クエリの CPU 制限対策（`run_load.sh`・`run_verify.sh`）を追記する。

### 7.2 設計・実装の課題

- **日次差分（P1-7）**: `recomputeChildCnt` は DB 単体で数えるため、初期インポートの `child_cnt`（DB をまたぐ子を含む）を小さく上書きしてしまう。差分取得の実装時に、年代 DB への振り分け・DB をまたぐ子の数え方を合わせる必要がある。`ingest_state.last_updated_date` の初期値はスナップショット日 `2026-10-14`。
- **出版年の誤り**: `cit < 1000` の論文は未検証。日次差分で `updated_date` 以降の更新を取り込めば、多くは自然に修正される見込み（年代が変わる論文の DB 移動が差分処理側でも必要）。
- **旧 DB `field17_2016_2026` の廃止**: `wrangler.jsonc` の binding 削除と D1 本体の削除（要確認のうえ実施）。中にはテスト用の論文 3 件・著者行のみ。
- **性能**: `docs/optimizing.md` の残課題（検索 API、R2 キャッシュ、超高被引用論文の seed グラフなど）。

# 初期インポート設計書（init-ingest.md）

- ステータス: ドラフト（PoC フェーズ）
- 前提: [docs/SPEC.md](./SPEC.md)（要求仕様）、[docs/ARCHITECT.md](./ARCHITECT.md)（Cloudflare 完結方針）
- 最終更新: 2026-11-10

---

## 1. 背景・目的

[docs/ARCHITECT.md](./ARCHITECT.md) 3.1 では、OpenAlex REST API を cursor paging で呼び出し、分野 17・直近 10 年の論文を Cloudflare Workflows 経由で取り込む方針を採っていた。しかし P1 の実装・実行で以下の問題が判明した。

- 直近10年・分野17だけで約609万件あり、API からの cursor paging では 1 ページ 200 件としても約30,500 ページかかり、取得に数時間〜日単位の時間を要する。
- Workflows の 1 インスタンスあたりステップ数上限（Paid: 最大25,000）により、全件を 1 回の Workflow 実行に収めることができない（ARCHITECT.md 3.1 で N=50,000 件に絞ったのはこの制約の回避策）。
- 結果として、系統樹として見せたい「被引用上位だけでなく裾野も含めた実際の引用構造」を初期データで再現できていない。

一方、OpenAlex は全データを **S3 スナップショット**（`s3://openalex/data/parquet/works/`、Parquet 形式、2026-10-14 時点で約744 GB・約4.6億件）として CC0 で公開しており、`data/openalex/manifest.json` に全ファイルの一覧を既に取得済みである。スナップショットからのバルク抽出は、API の cursor paging と比べてネットワーク往復・レート制限を伴わず、ローカルでの集計処理（DuckDB）に帰着するため大幅に高速になる。

本書では、**初期インポートは S3 スナップショットから一括抽出し、日々の差分は OpenAlex API から取得する**という二系統の取り込み方式に設計変更する。これに伴う ARCHITECT.md 3.1 の置き換えとして本書を位置づける。

### 1.1 方針転換の要点

| 項目 | 旧方針（ARCHITECT.md 3.1） | 新方針（本書） |
|---|---|---|
| 初期データ | OpenAlex API（cursor paging、N=50,000件に限定） | S3 スナップショット（Parquet）から分野・年で絞り込み全件抽出 |
| 実行場所 | Cloudflare Workflows（Cloudflare 上で完結） | ローカル PC または EC2 インスタンス（データ量次第）でオフライン抽出 → D1 へ投入 |
| 差分更新 | （初期取り込みと同じ Workflow を日次実行） | OpenAlex API（`from_updated_date` 等）を使い、スナップショット取得日以降の更新分のみ取得 |
| 取り込み件数 | N=50,000件（被引用上位のみ）に限定 | 分野・年で絞り込んだ全件（約609万件規模を想定） |

### 1.2 非ゴール

- OpenAlex 全エンティティ（`works` 以外の `authors`/`institutions` 等）のスナップショット取り込みは対象外。`works` のみを扱う。
- スナップショットの差分更新（OpenAlex が週次で更新する S3 側のマージ処理）には追従しない。初期インポート以降は API 経由の差分取得に一本化する。
- EC2 インスタンスの運用自動化（Terraform 等での IaC 化）は本書の範囲外。手動起動・手動停止を前提とする。

---

## 2. 全体構成

```
[初期インポート（一度だけ、または分野拡張時に再実行）]
  S3 スナップショット（s3://openalex/data/parquet/works/）
      │  DuckDB httpfs 拡張で S3 を直接読む（ダウンロードしない）
      ▼
  ローカル PC または EC2 インスタンス（帯域次第で選択）
      │  DuckDB で分野・年を絞り込み抽出（extract_cs.py を拡張）
      │    - papers.csv / edges.csv（または parquet）を生成
      ▼
  D1 への一括投入
      │  wrangler d1 execute --file（SQLite dump）
      │  または Workers から chunk 分割 INSERT
      ▼
  D1（field17_2016_2026 ほか、年代分割後は複数 DB）

[差分更新（日次、Cloudflare 上で継続）]
  Cron Trigger
      └─▶ Ingest Workflow（既存実装を流用）
            └─▶ OpenAlex API（filter=from_updated_date:{last_run}）
                  └─▶ D1 へ UPSERT（papers / edges）
```

### 2.1 抽出方式: DuckDB httpfs で S3 を直接読む

スナップショット全体（`works` だけで約693 GiB / 744 GB、1,898 ファイル、`data/openalex/manifest.json` 実測）を**ローカルにダウンロードする必要はない**。DuckDB の [httpfs 拡張](https://duckdb.org/docs/extensions/httpfs/s3api) を使い、`read_parquet('s3://openalex/data/parquet/works/*/*.parquet', ...)` のように S3 上のファイルを直接読む。

```sql
INSTALL httpfs; LOAD httpfs;
-- OpenAlex バケットは公開（認証不要）のため、リージョンのみ設定すればよい
SET s3_region = 'us-east-1';
SET s3_endpoint = 's3.amazonaws.com';
```

- **ローカルディスクに必要な容量は、ダウンロード方式（744 GB 規模）と比べて大幅に小さくなる**。必要なのは ① DuckDB の一時スピル領域（メモリに載らないソート・集計がある場合に `/tmp` 等へ書き出す）と ② 抽出後の出力（papers/edges）のみ。目安は **200〜400 GB の空き容量**（内訳は 2.2 参照）。
- 一方で、1,898 ファイル × 平均392 MB をネットワーク越しに読むため、**処理時間はローカル回線の帯域に強く依存する**。ローカル回線が細い・不安定な場合は処理が長時間化する、またはタイムアウト・再試行が増える。
- この帯域依存を解消したい場合は、EC2（OpenAlex バケットと同じ `us-east-1`）上で同じ httpfs 処理を実行する。EC2 を使う場合もダウンロードはしないため、EBS 容量の要件は同じく 200〜400 GB 程度で済む（3.5 参照）。
- **結論**: 本書では実行場所を確定しない。まずローカル PC で httpfs 経由の実行を試し、帯域不足で現実的な時間（目安 2〜3 時間以内）に収まらなければ EC2 に切り替える。いずれの場所でも、ダウンロード方式のような TB 級のディスクは不要。

### 2.2 ディスク容量の見積もり（httpfs 方式）

| 内訳 | サイズの目安 | 根拠 |
|---|---|---|
| DuckDB の一時スピル領域 | 100〜300 GB | メモリに載らないソート・集計がある場合に発生。本抽出は `WHERE` フィルタ + `GROUP BY`（child_cnt）が主体で、全693GB分のジョインではないため、上限（693GBの数十%）より小さく収まる見込み。実測して調整する |
| 抽出後の出力（papers/edges 等） | 数 GB | 609万件規模で papers 数百MB〜1GB、edges（1論文あたり平均12.75〜35本想定）で数GB程度（現状の試験出力は1ファイルのみ処理で papers.csv 531KB・edges.parquet 27KB、スケールして見積もり） |
| OS・作業領域の余白 | 50 GB程度 | 一般的な安全マージン |

**合計の目安: 200〜400 GB の空き容量があれば十分**（ダウンロード方式の場合に必要な約1〜1.3 TBより大幅に小さい）。実際のスピル量はクエリ実行時に DuckDB のプロファイル出力で確認し、不足が判明したら `--threads` を減らすかメモリ上限を調整する。

---

## 3. 初期インポート手順

### 3.1 対象ファイルの選定

`data/openalex/manifest.json` の `files[].url` は `s3://openalex/data/parquet/works/updated_date={YYYY-MM-DD}/part_{NNNN}.parquet` の形式で、OpenAlex 側の「更新日」単位にパーティション分割されている。

- **注意**: このパーティションは論文の `publication_year`（出版年）ではなく、OpenAlex 側のレコード更新日である。分野・出版年による絞り込みは、ファイルを選ぶ段階では行えず、**ファイルの内容を読んだ後に `WHERE` で絞り込む**必要がある。つまり原則として全 1,898 ファイルを読む対象にする必要がある（既存の `extract_cs.py` もこの前提で実装されている）。
- ファイル単位の絞り込みで時間を短縮できる余地があるとすれば、「更新日が極端に古い（2016年頃）ファイルは件数が少ない」程度で、全件スキップには使えない。
- 実務上は、DuckDB の `read_parquet(..., union_by_name=true)` に全ファイルの glob パターン（S3 の URL も glob 可）を渡し、一度のクエリで絞り込みと集計を行う（`extract_cs.py` と同方式）。これにより個々のファイルを明示的に選別する手間を省く。

### 3.2 S3 への接続（ダウンロードしない）

2.1 の方針に従い、`aws s3 sync` によるダウンロードは行わない。DuckDB の httpfs 拡張で S3 上の Parquet ファイルを直接読む。

```sql
INSTALL httpfs; LOAD httpfs;
SET s3_region = 'us-east-1';
SET s3_endpoint = 's3.amazonaws.com';
-- OpenAlex バケットは公開（認証不要）。Requester Pays でもない。
```

```python
# extract_cs.py 側でも、--pattern に S3 の URL を glob で渡せるようにする
# 例: --pattern "s3://openalex/data/parquet/works/*/*.parquet"
```

- ネットワーク帯域が処理時間を左右する（2.1 参照）。回線が細い場合は EC2（3.5）に切り替える。
- 動作確認は、まず `--limit-files` で少数ファイルに絞って S3 から正しく読めるか確認してから、全ファイルに対象を広げる。

### 3.3 DuckDB での抽出

既存の `data/openalex/extract_cs.py` をベースに、以下を変更して本番実行する。

- `--pattern` に S3 上の全ファイルの glob（例: `s3://openalex/data/parquet/works/*/*.parquet`）を渡す（3.2 参照、ローカルパスではなく S3 URL になる点が変更点）。
- `--field 17 --min-year 2016` （分野17・直近10年、SPEC 4.3 準拠）で実行する。
- 出力は `papers.csv` / `edges.parquet`（または `.csv`）とし、既存スクリプトの出力形式をそのまま使う。
- 実行前に `--count` で絞り込み後の件数を確認し、想定（約609万件、P0-1 実測値）から大きく外れないかチェックする。
- `external_ids.csv`（分野外から引用されている ID）は、SPEC 4.3「取り込み対象外の論文は祖先としてのみ必要な場合に限り追加」への対応候補として保持するが、PoC では当面使用しない（ARCHITECT.md 3.1 の簡略化方針を維持）。

**スクリプトへの追加検討事項**（本番実行前に対応）:
- `publication_date`（月精度）・`doi`・`fwci` ・`subfield` 列は現状 `extract_cs.py` の抽出対象に含まれていない（`papers.csv` は `id, title, year, cit, field` のみ）。D1 スキーマ（SPEC 4.4、`migrations/0003`）は `year`（月精度の小数）・`fwci`・`subfield`・`doi` 列を持つため、スクリプトを拡張してこれらの列も抽出する必要がある。
- `child_cnt` は現行スクリプトでは分野内の「直接の子の数」を別テーブルとして出している。D1 投入時は `papers` 行に `child_cnt` 列として結合するか、投入後に `UPDATE ... SET child_cnt = (SELECT COUNT(*) ...)`（既存の `recomputeChildCnt` と同じクエリ）を流す。

### 3.4 D1 への投入

データ量が大きいため、Workers 経由のバッチ INSERT（既存の `upsertPapers`/`upsertEdgesFromRaw` と同じ方式）は現実的でない（数百万〜1千万行規模になると、HTTP 経由のバッチ投入では時間がかかりすぎる）。以下のいずれかを使う。

1. **`wrangler d1 execute --file`**（第一候補）: CSV/Parquet から SQLite の `INSERT` 文（または `.import` 相当）を生成し、SQL ファイルとして投入する。ARCHITECT.md 3.4 で「最大 5 GB」までの一括インポートの選択肢として既に挙がっている。
   - DuckDB から直接 SQLite ファイルを生成できる（`ATTACH 'out.sqlite' AS sq (TYPE sqlite); CREATE TABLE sq.papers AS SELECT * FROM papers;` 等）。生成した SQLite ファイルを `wrangler d1 execute --file` で読み込ませる、または [D1 のインポート機能](https://developers.cloudflare.com/d1/best-practices/import-export-data/)（`wrangler d1 export`/`import` 相当）を使う。
   - 大きい場合はテーブル単位・チャンク単位で SQL ファイルを分割し、順次実行する。
2. **R2 経由 + Worker 側バッチ処理**（代替案）: 抽出した CSV/Parquet を R2 にアップロードし、1 回限りの投入用 Worker スクリプト（またはローカルから `wrangler d1 execute` を繰り返し呼ぶスクリプト）で chunk 分割 INSERT を行う。既存の `BATCH_CHUNK_SIZE=500`、`SQL_IN_CHUNK_SIZE=90`（D1 のバインド変数上限）の制約を踏まえて実装する。
3. 件数・ファイルサイズを実測した上で、どちらを採用するか P1 再着手時に決定する。目安として D1 の 1 データベース上限は 10 GB、行サイズ上限は 2 MB。

投入順序は既存 Workflow と同じ依存関係を守る: `papers` を先に全件投入 → `edges` を `cited` 側が `papers` に存在するものだけ投入 → `child_cnt` を再計算。

### 3.5 EC2 を使う場合の構成（データ量次第）

ローカル PC での処理が時間的に厳しい場合に限り、以下の構成で実行する。

- **リージョン**: OpenAlex の S3 バケットと同一（`us-east-1`）を選ぶ。httpfs 経由の読み込みでも、同リージョンなら帯域が太く・レイテンシが低く、S3→EC2 の転送料もかからない（これが EC2 を使う主な理由。2.1 参照）。
- **インスタンスタイプ**: DuckDB 処理はメモリと（httpfs の場合は）ネットワークスループットが支配的。メモリ最適化系（例: `r6i`/`r7i` 系）を候補とし、必要メモリ量（抽出対象の中間データサイズ）を見て決める。ダウンロードを行わないため、ローカル NVMe の太さは必須要件ではない。具体的なインスタンスタイプ・サイズは実行時点の価格・在庫を見て選定する（本書では固定しない）。
- **ストレージ**: ダウンロードしないため、EBS は 2.2 の見積もり（**200〜400 GB 程度**、DuckDB の一時スピル領域 + 出力ファイル）で足りる。744 GB 規模のダウンロード用ストレージは不要。
- **セットアップ**: Amazon Linux 2023 等に Python 3・`duckdb`（pip、httpfs 拡張同梱）をインストールする最小構成。`awscli` は S3 からのダウンロードをしないため必須ではないが、出力を S3 経由でやり取りする場合は入れておく。既存の `extract_cs.py` をそのまま転送して実行する。
- **運用**:
  - 起動 → `extract_cs.py` を S3 URL 指定で実行（3.2〜3.3） → 出力（`papers.csv`/`edges.parquet` 等）を S3 または R2 にアップロード → **インスタンスを終了（Terminate、課金停止）**。
  - 本書では IaC 化・自動終了の仕組みは範囲外とする。手動でのインスタンス終了を徹底する（課金継続の事故を避けるため、作業完了後すぐに終了することをチェックリスト化する）。
  - R2 へのアップロードは `aws s3 cp`（S3 互換 API）または Cloudflare の R2 API で行い、ローカル PC を経由せず EC2 → R2 で完結させる。
- **コスト感覚**: スポットインスタンスではなくオンデマンドで数時間程度の使用を想定（ダウンロード工程がないため、ダウンロード方式より短くなる見込み）。長時間かかる見込みが事前に判明した場合は、抽出ロジック（DuckDB のクエリ最適化、`--threads` 増加、必要列のみ読む）を先に見直す。

### 3.6 検証

- 抽出した論文数・エッジ数が、P0-1 で確認した推定件数（分野17・直近10年で約609万件）と大きくズレていないか確認する。
- D1 投入後、`SELECT COUNT(*) FROM papers` / `edges` が抽出時の件数と一致することを確認する。
- `child_cnt` を再計算し、既存 Workflow 実装と同じロジック（`recomputeChildCnt`）で不一致がないか確認する（P1-5 と同様の検証）。
- ARCHITECT.md 3.4.1 の容量試算（直近10年・全件規模で約6〜9 GB）と実測値を比較し、年代分割（3.4.2）の着手が必要かここで判断する。

---

## 4. 差分更新（API 経由、継続運用）

初期インポート後は、スナップショット取得日以降の更新・新規論文のみを OpenAlex API から取得する。既存の Ingest Workflow（`worker/ingest-workflow.ts`）・Rate Limiter DO（`worker/rate-limiter.ts`）・OpenAlex クライアント（`worker/openalex-client.ts`）の実装はそのまま再利用できるが、取得条件を変更する。

### 4.1 変更点

- **フィルタ条件の追加**: 既存の `primary_topic.field.id:17,from_publication_date:...,to_publication_date:...` に加えて、`from_updated_date:{last_run_date}` を追加する。OpenAlex の `/works` エンドポイントは `filter=from_updated_date:{YYYY-MM-DD}` で、その日以降に更新されたレコードのみを返せる（新規作成・既存レコードの更新の両方を含む）。
- **`sort=cited_by_count:desc` の扱い**: 初期インポートが全件を扱うようになるため、差分更新では「被引用上位 N 件」に絞る必要がなくなる。`from_updated_date` だけで絞り込んだ全件を取得する（1日あたりの更新件数は全件数よりずっと少ないため、Workflows のステップ数上限の懸念はなくなる想定。実測して確認する）。
- **`last_run` の記録**: 次回の差分取得の起点となる日付を記録する必要がある。D1 に小さなメタテーブル（例: `ingest_state(key TEXT PRIMARY KEY, value TEXT)`、`key='last_updated_date'`）を追加し、Workflow の最後のステップで更新する。初期値は初期インポートに使ったスナップショットの `date`（`manifest.json` の `date` フィールド、現状 `2026-10-14`）とする。
- **エッジの扱い**: 差分で新規・更新された論文の `referenced_works` のうち、`cited` 側が既存の `papers`（初期インポート分 + これまでの差分分）に存在するものを `edges` に UPSERT する。既存の `upsertEdgesFromRaw` と同じロジックで対応できるが、全件を R2 から読み直す必要はなく、差分ページの `referenced_works` だけを処理すればよい（既存実装より軽くなる）。
- **削除・撤回（retraction）の扱い**: OpenAlex 側で論文が撤回・非公開化された場合の扱いは未確定（本書の範囲外、5章の未確定事項に記載）。

### 4.2 実行頻度

ARCHITECT.md 3.1 と同様、Cron Trigger による日次実行を基本とする。1日あたりの更新件数が少なければ、Workflows のステップ数上限に対して十分な余裕がある。

### 4.3 旧方針との差分（コードへの影響）

| ファイル | 変更内容 |
|---|---|
| `worker/ingest-workflow.ts` | `MAX_PAGES=250`（N=50,000件固定）の制約を撤廃し、`from_updated_date` ベースの差分取得に変更。全件取得ではなくなるため、ページ数の上限は「安全マージンとしての上限」のみ残す |
| `worker/openalex-client.ts` | `fetchWorksPage` のパラメータに `fromUpdatedDate` を追加 |
| 新規マイグレーション | `ingest_state` テーブルを追加（`last_updated_date` の記録用） |
| D1 投入ロジック | 初期インポート分（3章、一括投入）とその後の差分分（Workflow、UPSERT）が同じテーブルに積み重なるため、主キー（`papers.id`、`edges (cited, citing)`）による UPSERT の整合性を初期インポート後に再確認する |

---

## 5. 未確定事項

1. **実行場所の最終決定（ローカル PC か EC2 か）**: httpfs 経由の読み込みがローカル回線の帯域で現実的な時間に収まるか試してから決める（2.1 参照）。ディスク容量はどちらでも 200〜400 GB 程度で足りるため、決定要因は帯域・レイテンシのみ。
2. **D1 投入方式（`wrangler d1 execute --file` か Worker 経由チャンク投入か）**: 実際の抽出データ量を見てから決める（3.4 参照）。
3. **年代分割（ARCHITECT.md 3.4.2）の着手タイミング**: 初期インポートで全件規模（約609万件）を取り込んだ時点の実測 D1 サイズを見て判断する。
4. **`from_updated_date` フィルタの実際の挙動**: 1日あたりの更新件数・ページ数を小規模リクエストで確認する（Rate Limiter DO の既存実装がそのまま使えるか含め検証）。
5. **撤回・削除された論文の扱い**: OpenAlex 側の変更をどう検知し、D1 側にどう反映するか（PoC では対応しない選択肢も含めて検討）。
6. **`extract_cs.py` の拡張範囲**: `publication_date`（月精度）・`fwci`・`subfield`・`doi` 列の抽出、および `child_cnt` の結合方法を実装する（3.3 参照）。

---

## 6. 参考リンク

- OpenAlex スナップショット: https://help.openalex.org/download-all-data/snapshot-data-format
- OpenAlex API フィルタ（`from_updated_date` 等）: https://help.openalex.org/how-to-use-the-api/get-lists-of-entities/filter-entity-lists
- Cloudflare D1 インポート/エクスポート: https://developers.cloudflare.com/d1/best-practices/import-export-data/
- DuckDB httpfs（S3 読み込み）: https://duckdb.org/docs/extensions/httpfs/s3api
- AWS CLI `s3 sync`: https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html

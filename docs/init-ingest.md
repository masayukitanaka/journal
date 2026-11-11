# 初期インポート設計書（init-ingest.md）

- ステータス: ドラフト（PoC フェーズ）
- 前提: [docs/SPEC.md](./SPEC.md)（要求仕様）、[docs/ARCHITECT.md](./ARCHITECT.md)（Cloudflare 完結方針）
- 最終更新: 2026-11-11

---

## 1. 背景・目的

[docs/ARCHITECT.md](./ARCHITECT.md) 3.1 では、OpenAlex REST API を cursor paging で呼び出し、分野 17・直近 10 年の論文を Cloudflare Workflows 経由で取り込む方針を採っていた。しかし P1 の実装・実行で以下の問題が判明した。

- 直近10年・分野17だけで約609万件あり、API からの cursor paging では 1 ページ 200 件としても約30,500 ページかかり、取得に数時間〜日単位の時間を要する。
- Workflows の 1 インスタンスあたりステップ数上限（Paid: 最大25,000）により、全件を 1 回の Workflow 実行に収めることができない（ARCHITECT.md 3.1 で N=50,000 件に絞ったのはこの制約の回避策）。
- 結果として、系統樹として見せたい「被引用上位だけでなく裾野も含めた実際の引用構造」を初期データで再現できていない。

一方、OpenAlex は全データを **S3 スナップショット**（`s3://openalex/data/parquet/works/`、Parquet 形式、2026-10-14 時点で約744 GB・約4.6億件）として CC0 で公開しており、`data/openalex/manifest.json` に全ファイルの一覧を既に取得済みである。スナップショットからのバルク抽出は、API の cursor paging と比べてネットワーク往復・レート制限を伴わず、ローカルでの集計処理（DuckDB）に帰着するため大幅に高速になる。

本書では、**初期インポートは S3 スナップショットから一括抽出し、日々の差分は OpenAlex API から取得する**という二系統の取り込み方式に設計変更する。これに伴う ARCHITECT.md 3.1 の置き換えとして本書を位置づける。

**取り込み範囲の変更（2026-11-11）**: 取り込み範囲を直近 10 年（2016〜2026）から **2006 年以降の約 20 年（2006〜2026）** に広げ、D1 を **5 年単位**（`field17_2006_2010` / `field17_2011_2015` / `field17_2016_2020` / `field17_2021_2025` / `field17_2026_2030`）に分割する（SPEC 4.3、ARCHITECT.md 3.4.2）。以下の「約609万件」は直近 10 年（2016〜2026）の P0-1 実測値であり、2006 年以降の件数は段階③・④で実測する。

### 1.1 方針転換の要点

| 項目 | 旧方針（ARCHITECT.md 3.1） | 新方針（本書） |
|---|---|---|
| 初期データ | OpenAlex API（cursor paging、N=50,000件に限定） | S3 スナップショット（Parquet）から分野・年で絞り込み全件抽出 |
| 実行場所 | Cloudflare Workflows（Cloudflare 上で完結） | ローカル PC または EC2 インスタンス（データ量次第）でオフライン抽出 → D1 へ投入 |
| 差分更新 | （初期取り込みと同じ Workflow を日次実行） | OpenAlex API（`from_updated_date` 等）を使い、スナップショット取得日以降の更新分のみ取得 |
| 取り込み件数 | N=50,000件（被引用上位のみ）に限定 | 分野17・2006年以降の全件（2016年以降だけで約609万件。20年分の件数は要実測） |
| D1 の分割 | `field17_2016_2026` の 1 DB | 5 年単位の 5 DB（2006-2010 〜 2026-2030） |

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
      │  scripts/ingest/stage.py: ファイルごとに分野・年で絞り込み → 中間 Parquet
      │  scripts/ingest/build.py: 結合・重複除去・5年単位の DB ごとに papers/edges/... を生成
      ▼
  D1 への一括投入
      │  wrangler d1 execute --file（SQLite dump）
      │  または Workers から chunk 分割 INSERT
      ▼
  D1（field17_2006_2010 〜 field17_2026_2030 の 5 DB）

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

### 3.0 段階実行の方針（小規模検証 → 本番実行）

S3 スナップショットからの抽出・D1 投入は、スクリプト改修・実行環境・D1 投入方式のいずれも未検証の要素を含む。本番規模（約609万件、全1,898ファイル）に対して一度に流すと、不具合があった場合の手戻りコスト（処理時間・EC2利用料・D1への誤投入の後始末）が大きい。そのため、**小規模（1〜数ファイル）での動作確認を先に行い、各ステップが正しく動くことを確認してから、本番規模（全件・全ファイル）に移る**。

| 段階 | 対象データ | 目的 | 完了条件 |
|---|---|---|---|
| **① 抽出スクリプトの動作確認** | `--limit-files` で 1〜数ファイルに限定 | httpfs 経由の S3 読み込み・列拡張（3.3 の追加検討事項）が正しく動くか確認。ダウンロード不要の確認も含む | `papers.csv`/`edges.parquet` が期待する列・形式で出力される |
| **② 小規模 D1 投入の確認** | ①の出力（数千件規模） | D1 投入方式（3.4）・投入順序（papers→edges→child_cnt）が正しく動くか、既存の `recomputeChildCnt` と整合するかを確認 | 件数一致・`child_cnt` 不一致 0 件（3.6 と同じ検証を小規模データで実施） |
| **③ 一部分野・一部年代での中規模実行** | 分野17・直近1〜2年分など、本番の一部 | 本番規模に近いデータで処理時間・D1サイズ・エッジ密度の見積もりを実測し、本番実行の計画（実行場所・バッチサイズ・所要時間）を確定する | 処理時間・出力サイズが見積もり通りか確認。EC2が必要かどうかの判断もここで行う |
| **④ 本番実行（全件）** | 分野17・2006年以降の全件 | 3.1〜3.6 の手順通り、本番データを一括投入する | 3.6 の検証項目を満たす |

- ①〜③は同じローカル PC で実施できる想定（データ量が小さいため、2.1 のネットワーク帯域問題は発生しにくい）。③の実測結果を見て、④をローカル PC で続けるか EC2 に切り替えるかを決める。
- ②・③で D1 に投入したテストデータは、④の本番投入前に削除する（`DELETE FROM papers; DELETE FROM edges;` 等）か、④を別の D1 データベースに対して行い検証後に本番 DB を切り替える。どちらの方式を取るかは③の結果を見て決める（5章の未確定事項に記載）。
- 各段階の完了をもって次段階に進む。①の時点で列不足やスキーマ不整合が見つかれば、そこで `scripts/ingest/` を修正し、②以降はやり直す。
- 段階①は完了（2026-11-11、3.3 末尾の実測を参照）。

### 3.1 対象ファイルの選定

`data/openalex/manifest.json` の `files[].url` は `s3://openalex/data/parquet/works/updated_date={YYYY-MM-DD}/part_{NNNN}.parquet` の形式で、OpenAlex 側の「更新日」単位にパーティション分割されている。

- **注意**: このパーティションは論文の `publication_year`（出版年）ではなく、OpenAlex 側のレコード更新日である。分野・出版年による絞り込みは、ファイルを選ぶ段階では行えず、**ファイルの内容を読んだ後に `WHERE` で絞り込む**必要がある。つまり原則として全 1,898 ファイルを読む対象にする必要がある（`scripts/ingest/stage.py` もこの前提で全ファイルを順に読む）。
- ファイル単位の絞り込みで時間を短縮できる余地があるとすれば、「更新日が極端に古い（2016年頃）ファイルは件数が少ない」程度で、全件スキップには使えない。
- 実装（`scripts/ingest/stage.py`）では、全ファイルを 1 クエリで読むのではなく `manifest.json` の URL を 1 ファイルずつ処理する。メモリ使用量をファイル単位に抑え、失敗時の再開を可能にするため。

### 3.2 S3 への接続（ダウンロードしない）

2.1 の方針に従い、`aws s3 sync` によるダウンロードは行わない。DuckDB の httpfs 拡張で S3 上の Parquet ファイルを直接読む。

```sql
INSTALL httpfs; LOAD httpfs;
SET s3_region = 'us-east-1';
SET s3_endpoint = 's3.amazonaws.com';
-- OpenAlex バケットは公開（認証不要）。Requester Pays でもない。
```

- ネットワーク帯域が処理時間を左右する（2.1 参照）。回線が細い場合は EC2（3.5）に切り替える。
- 動作確認は、まず `--limit-files` で少数ファイルに絞って S3 から正しく読めるか確認してから、全ファイルに対象を広げる。

### 3.3 DuckDB での抽出（`scripts/ingest/`）

検証用の `data/openalex/extract_cs.py` は使わず、`scripts/ingest/` に新規作成した 2 段構成のスクリプトで抽出する（2026-11-11）。実行マシンのメモリが小さくても（EC2 7.6 GB で確認）動くよう、S3 を読む段階と結合・集計する段階を分けている。

**Step 1: `stage.py`（S3 → 中間 Parquet）**

```bash
python3 scripts/ingest/stage.py --limit-files 3   # 段階①: 更新日の新しい順に 3 ファイル
python3 scripts/ingest/stage.py --min-year 2021   # 段階③: 一部の年代
python3 scripts/ingest/stage.py                   # 段階④: 全 1,898 ファイル（既定 --field 17 --min-year 2006 --max-year 2026）
```

- `data/openalex/manifest.json` の S3 URL を 1 ファイルずつ DuckDB httpfs で直接読み（ダウンロードなし、必要な列だけを Range 読み）、`primary_topic.field.id` と `publication_year` で絞り込んで `data/openalex/work/stage/{updated_date}__{part}.parquet` に書く。
- 一時ファイルに書いてから rename するため、出力済みのファイルはスキップして途中から再開できる。読み込み失敗は再試行する（既定 3 回）。
- 前回と異なる条件（分野・年範囲）で再実行すると、新旧の条件が混ざらないよう停止する（`stage_params.json` で判定）。
- 変換内容:
  - `id`: `https://openalex.org/W123` → `123`（BIGINT）
  - `title`: 空・NULL は `(no title)`（D1 の NOT NULL 制約、既存 Workflow と同じ）
  - `year`: `publication_year + (month(publication_date) - 1) / 12`。`publication_date` 欠損時は `worker/ingest-workflow.ts` の `yearWithMonth` と同じく id から決定的に月を割り当てる
  - `subfield`: `primary_topic.subfield.id` の数値部分。`fwci`・`doi`・`cited_by_count` はそのまま
  - `referenced_works` → 数値 ID の配列、`authorships[].author.display_name` → 著者名の配列、`keywords` → `{id(スラッグ), name, score}` の配列

**Step 2: `build.py`（中間 Parquet → DB ごとの D1 投入用テーブル）**

```bash
python3 scripts/ingest/build.py   # 出力: data/openalex/work/out/{DB名}/{table}.parquet, out/stats.json
```

- 同じ id が複数ファイルにある場合は `updated_date` が最新の行を採用する。
- 論文の所属 DB を出版年で決め、5 年単位（2006-2010, 2011-2015, 2016-2020, 2021-2025, 2026-2030）に分けて出力する（SPEC 4.3、ARCHITECT.md 3.4.2）。
- 出力テーブル（migrations 0001〜0005 と同じ列）:
  - `papers`: id, field, title, year, cit, fwci, subfield, child_cnt, doi
  - `edges`: cited が取り込んだ全年代の `papers` のどこかに存在するものだけ。**citing 側の DB に置く**（SPEC 4.4 の結合ルール）。自己引用は除外
  - `authorships`: paper_id, author_name（論文内の重複は除く）
  - `paper_keywords`: paper_id, keyword_id, score / `keywords`: その DB の `paper_keywords` が参照する語だけ
- `child_cnt` は**全年代の edges から計算**する（DB をまたぐ子も数える）。DB 単体で `recomputeChildCnt`（`UPDATE papers SET child_cnt = (SELECT COUNT(*) FROM edges WHERE cited = papers.id)`）を流すと、後の年代 DB にある子が数えられず値が小さくなるため、日次差分側のロジックも合わせて変更する必要がある（4.3）。
- 中間計算は `data/openalex/work/build.duckdb`（ディスク）で行い、メモリに載らない分は `data/openalex/work/tmp` にスピルする（既定 `--memory-limit 5GB`）。
- 抽出時点の整合性チェック（NOT NULL 違反、年代外の論文、DB 内に citing が無いエッジ、辞書に無い keyword_id、`child_cnt` 合計とエッジ総数の差）を `stats.json` に出力する。

**段階①の実測（2026-11-11、EC2 上、更新日 2026-10-14 の 3 ファイル 2.2 GB）**

- stage: 約 14 秒（S3 読み込み 約 160 MB/s）。全 744 GB でも 1〜2 時間程度の見込み → ローカル PC ではなく EC2 で本番まで実行できる見込み。
- 論文 42,337 件・edges 4,768（うち約 61% が cited を別の年代 DB に持つ）・チェック項目はすべて 0。
- keywords の語彙は 3 ファイルだけで 8.3 万語あり、当初の「全体で数万語」という見積もりより大きい。
- `publication_date` が 1 月の論文が約 27% と多い（OpenAlex 側で月不明の論文が 1/1 になっていると思われる）。

### 3.4 D1 への投入

データ量が大きいため、Workers 経由のバッチ INSERT（既存の `upsertPapers`/`upsertEdgesFromRaw` と同じ方式）は使わず、**SQL ファイルを生成して `wrangler d1 execute --file` で投入する**（2026-11-11 採用。ローカル D1 で動作確認済み）。

**Step 3: `export_sql.py`（Parquet → SQL ファイル）**

```bash
python3 scripts/ingest/export_sql.py   # 出力: data/openalex/work/sql/{DB名}/{NN}_{table}_{part}.sql
```

- 1 文あたり最大 90 KB の複数行 INSERT にまとめる（D1 の SQL 文長上限 100 KB 未満）。1 ファイルあたり最大 100 MB で分割する。
- ファイル名の番号が投入順: `01_papers` → `02_edges` → `03_authorships` → `04_keywords` → `05_paper_keywords`。
- 主キーのあるテーブルは `INSERT OR REPLACE`（同じファイルを再投入しても重複しない）。`authorships` は主キーが無いため、空のテーブルへの投入を前提とする。
- 補足: 「DuckDB で SQLite ファイルを生成して `wrangler d1 execute --file` で読み込む」案は採らない（`--file` が受け付けるのは SQL 文のファイルで、SQLite のデータベースファイルではないため）。

**Step 4: `load_d1.py`（SQL ファイル → D1、検証）**

```bash
python3 scripts/ingest/load_d1.py --local --config <検証用 wrangler 設定>   # ローカル D1 で試す
python3 scripts/ingest/load_d1.py --remote                                 # 本番 D1（wrangler.jsonc に登録済みの DB）
python3 scripts/ingest/load_d1.py --remote --only field17_2006_2010        # DB を指定
python3 scripts/ingest/load_d1.py --remote --verify-only                   # 検証だけ
```

- 投入先は `sql/` のフォルダ名と同じ名前の D1（事前に作成し、migrations 0001〜0005 を適用しておく）。
- 投入前に各テーブルが空であることを確認し、空でなければ停止する（誤った二重投入を防ぐ）。
- 投入後、3.6 の検証（件数・`child_cnt` 合計・被引用数合計を build の出力と照合、DB 内の参照整合性）を行う。

投入順序は既存 Workflow と同じ依存関係を守る（`papers` → `edges` → その他）。`child_cnt` は build 時に全年代の edges から計算済みのため、投入後の再計算は行わない（DB 単体で再計算すると DB をまたぐ子が数えられず値が変わる。3.3 参照）。

**本番規模での注意**: 本番（段階④）では 1 DB あたり数 GB 規模の SQL ファイルになる見込み。D1 のインポート上限・所要時間・投入中の DB の応答性は段階③で実測し、必要ならファイル分割サイズやインデックスの作成タイミング（投入後に作成するなど）を見直す。

**段階②の実績（2026-11-11）**: 3 ファイル分（論文 42,337 件）を 5 DB に投入し、ローカル D1・本番 D1 とも全項目で一致した（本番は約 1 分半）。本番 D1 のサイズは合計約 54 MB（論文 1 件あたり約 1.3 KB。edges はサンプルでは両端が揃いにくく少ないため、全件時は edges 分が上乗せになる）。

### 3.5 EC2 を使う場合の構成（データ量次第）

ローカル PC での処理が時間的に厳しい場合に限り、以下の構成で実行する。

- **リージョン**: OpenAlex の S3 バケットと同一（`us-east-1`）を選ぶ。httpfs 経由の読み込みでも、同リージョンなら帯域が太く・レイテンシが低く、S3→EC2 の転送料もかからない（これが EC2 を使う主な理由。2.1 参照）。
- **インスタンスタイプ**: DuckDB 処理はメモリと（httpfs の場合は）ネットワークスループットが支配的。メモリ最適化系（例: `r6i`/`r7i` 系）を候補とし、必要メモリ量（抽出対象の中間データサイズ）を見て決める。ダウンロードを行わないため、ローカル NVMe の太さは必須要件ではない。具体的なインスタンスタイプ・サイズは実行時点の価格・在庫を見て選定する（本書では固定しない）。
- **ストレージ**: ダウンロードしないため、EBS は 2.2 の見積もり（**200〜400 GB 程度**、DuckDB の一時スピル領域 + 出力ファイル）で足りる。744 GB 規模のダウンロード用ストレージは不要。
- **セットアップ**: Amazon Linux 2023 等に Python 3・`duckdb`（pip、httpfs 拡張同梱）をインストールする最小構成。`awscli` は S3 からのダウンロードをしないため必須ではないが、出力を S3 経由でやり取りする場合は入れておく。リポジトリの `scripts/ingest/` を実行する。
- **実績（2026-11-11）**: 段階①は EC2（2 vCPU・メモリ 7.6 GB・EBS 500 GB、Amazon Linux 2023、Python 3.9、duckdb 1.4.5）で実行した。
- **運用**:
  - 起動 → `scripts/ingest/stage.py` → `build.py` を実行（3.2〜3.3） → 出力（`papers.csv`/`edges.parquet` 等）を S3 または R2 にアップロード → **インスタンスを終了（Terminate、課金停止）**。
  - 本書では IaC 化・自動終了の仕組みは範囲外とする。手動でのインスタンス終了を徹底する（課金継続の事故を避けるため、作業完了後すぐに終了することをチェックリスト化する）。
  - R2 へのアップロードは `aws s3 cp`（S3 互換 API）または Cloudflare の R2 API で行い、ローカル PC を経由せず EC2 → R2 で完結させる。
- **コスト感覚**: スポットインスタンスではなくオンデマンドで数時間程度の使用を想定（ダウンロード工程がないため、ダウンロード方式より短くなる見込み）。長時間かかる見込みが事前に判明した場合は、抽出ロジック（DuckDB のクエリ最適化、`--threads` 増加、必要列のみ読む）を先に見直す。

### 3.6 検証

以下は段階③・④（3.0）で共通して行う検証。段階②（小規模）でも件数一致・`child_cnt` 一致の2点は同様に確認する。

- 抽出した論文数・エッジ数が、想定件数（段階④なら OpenAlex API の `meta.count`（`primary_topic.field.id:17,from_publication_date:2006-01-01`）、段階③ならその年代の `meta.count`）と大きくズレていないか確認する。
- D1 投入後、`SELECT COUNT(*) FROM papers` / `edges` / `paper_keywords` が抽出時の件数と一致することを確認する。
- `child_cnt` が全 DB の edges から数えた直接の子の数と一致することを確認する（DB をまたぐ子を含むため、DB 単体の `recomputeChildCnt` とは一致しない。3.3 参照）。
- `paper_keywords.keyword_id` が `keywords.id` に存在すること（外部キー相当の整合性）、`paper_keywords.paper_id` が `papers.id` に存在することを確認する（D1 は外部キー制約を強制しないため、投入後に `SELECT` で明示的に検証する）。
- 各年代 DB の実測サイズが 10 GB 上限に対して十分な余裕があるか確認する（ARCHITECT.md 3.4.1 の試算は直近10年・1 DB で約6〜9 GB。5 年単位分割後は 1 DB あたりおおむねその半分以下の見込み）。余裕がなければ区切り幅（5年→3年など）を見直す（ARCHITECT.md 3.4.2）。`paper_keywords`・`authorships` の実測サイズもここで確認する。

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
2. ~~**D1 投入方式**~~ → `wrangler d1 execute --file`（SQL ファイル）を採用（2026-11-11、3.4）。本番規模での所要時間は段階③で実測する。
3. ~~**年代分割（ARCHITECT.md 3.4.2）の着手タイミング**~~ → 初期インポートから 5 年単位で分割する（2026-11-11 決定）。区切り幅が妥当かは段階④の実測 D1 サイズで確認する。
4. **`from_updated_date` フィルタの実際の挙動**: 1日あたりの更新件数・ページ数を小規模リクエストで確認する（Rate Limiter DO の既存実装がそのまま使えるか含め検証）。
5. **撤回・削除された論文の扱い**: OpenAlex 側の変更をどう検知し、D1 側にどう反映するか（PoC では対応しない選択肢も含めて検討）。
6. ~~**`extract_cs.py` の拡張範囲**~~ → `scripts/ingest/` を新規作成して対応済み（2026-11-11、3.3）。
8. **DB をまたぐ処理**: edges の約 6 割は cited が別の年代 DB にある。系統樹・系譜追跡（`worker/graph.ts`）の DB 横断結合（ARCHITECT.md 3.4.0 で未実装）と、日次差分での `child_cnt` 更新（DB をまたぐ子を数える方法）を設計する必要がある。
7. **段階②・③（3.0）のテストデータの後始末方法**: 本番の D1 に対して小規模・中規模データをそのまま投入して検証するか、別の D1 データベース（例: 検証用に新規作成）に対して行うかを決める。前者なら本番投入前に `DELETE` で消す手順を確立する必要があり、後者なら検証用 D1 の作成・破棄の手順を決める必要がある。

---

## 6. 参考リンク

- OpenAlex スナップショット: https://help.openalex.org/download-all-data/snapshot-data-format
- OpenAlex API フィルタ（`from_updated_date` 等）: https://help.openalex.org/how-to-use-the-api/get-lists-of-entities/filter-entity-lists
- Cloudflare D1 インポート/エクスポート: https://developers.cloudflare.com/d1/best-practices/import-export-data/
- DuckDB httpfs（S3 読み込み）: https://duckdb.org/docs/extensions/httpfs/s3api
- AWS CLI `s3 sync`: https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html

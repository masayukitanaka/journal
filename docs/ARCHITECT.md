# アーキテクチャ設計書（ARCHITECT.md）

- ステータス: ドラフト（PoC フェーズ）
- 前提: [docs/SPEC.md](./SPEC.md) の要求を、**インフラを Cloudflare のみで完結させる**方針で実現する。
- 最終更新: 2026-11-09

---

## 1. 方針

SPEC.md 3章は「オフライン処理（PC/VM）」で ETL を行う前提だったが、本書では配信系（API 提供・フロントエンド配信・グラフ事前構築）を **Cloudflare Workflows / Queues / Cron Triggers** に置き換え、Cloudflare 上で完結させる。

ただし **初期インポートに限り**、[docs/init-ingest.md](./init-ingest.md) で詳述する通り、OpenAlex REST API の cursor paging では直近10年・分野17だけで約609万件・約30,500ページかかり、Workflows のステップ数上限（Paid 最大25,000）を超えるという制約に直面した（3.1 に経緯を記載）。これを解消するため、**初期インポートは OpenAlex の S3 スナップショット（CC0、Parquet 形式）から分野・年を絞り込んで一括抽出し、ローカル PC または EC2 インスタンス上の DuckDB（httpfs 経由で S3 を直接読む）で処理した上で D1 へ投入する**。この初期インポート工程のみ、Cloudflare の外（ローカル PC・EC2）で実行する。日次の**差分更新は OpenAlex REST API 経由（`from_updated_date` フィルタ）で取得し、Cloudflare Workflows 上で完結させる**（詳細は init-ingest.md 4章）。

OpenAlex の全件スナップショット（`works` のみで Parquet 約744 GB、2026-10 時点、`data/openalex/manifest.json` 実測）を丸ごと Cloudflare に持ち込むのは本 PoC の範囲外（非ゴール、SPEC 1.2）であり、容量的にも対象にしない。初期インポートでも分野17・直近10年に絞り込んだ範囲だけを D1 に取り込む。日次差分は OpenAlex 側が「cursor paging で全データをダウンロードしないこと」を明示している方針と整合する絞り込み取得（`from_updated_date` + 分野・年フィルタ）のみを行う。

フロントエンドは現行リポジトリ（create-cloudflare の React + Vite テンプレート）の構成を維持し、SVG 描画を React コンポーネントとして実装する。単一 HTML・バニラ JS という SPEC 6 章の記述は「フレームワーク非依存で軽量に動く」という意図を汲み取り、React + Workers Static Assets で代替する。

---

## 2. 全体構成

```
┌───────────────────────────┐   ┌─────────────────────────────────────────────────────────────────┐
│  [初期インポート（一度だけ）]  │   │                           Cloudflare アカウント                     │
│   ローカル PC または EC2     │   │                                                                   │
│    └─▶ DuckDB（httpfs 経由  │   │  [差分取り込み系（ETL、日次）]                                       │
│         で S3 を直接読む）   │   │   Cron Trigger（日次）                                             │
│    └─▶ D1 へ一括投入 ───────┼──▶│     └─▶ Ingest Workflow ─┬─▶ OpenAlex API（from_updated_date）    │
│  （docs/init-ingest.md）    │   │                           ├─▶ Semantic Scholar API（補助データ）     │
└───────────────────────────┘   │                           ├─▶ R2（生レスポンスの保存。再処理・検証用）  │
                                 │                           └─▶ D1（分野DBへ整形済みデータを投入）       │
                                 │         │                                                         │
                                 │         ▼                                                         │
                                 │   Rate Limiter DO（外部API呼び出しを 1 本の列に直列化）               │
                                 │         │                                                         │
                                 │   Graph Build Queue ─▶ Graph Builder Worker ─▶ R2（シード単位グラフJSON）│
                                 │                                                                   │
                                 │  [配信系（API / フロントエンド）]                                     │
                                 │   Workers（Hono 等でルーティング）                                   │
                                 │     ├─ Cache API（短期キャッシュ）                                   │
                                 │     ├─ R2（グラフJSON読み出し）                                      │
                                 │     ├─ D1（検索・一覧・詳細）                                        │
                                 │     └─ Rate Limiter DO（オンデマンド取得が必要な場合のみ経由）          │
                                 │                                                                   │
                                 │   Workers Static Assets（React SPA をホスティング）                  │
                                 │     └─ /api/* へフェッチしてグラフを描画（SVG, React）               │
                                 └─────────────────────────────────────────────────────────────────┘
```

### 2.1 SPEC からの変更点

| SPEC の記述 | 本書での扱い | 理由 |
|---|---|---|
| オフライン処理（PC/VM）で OpenAlex スナップショットを抽出・整形 | **初期インポートのみ** PC/EC2 + DuckDB（S3 スナップショットを httpfs で直接読む）で抽出し D1 へ投入。**日次の差分更新**は Cloudflare Workflows + Cron Triggers + Queues で OpenAlex API から取得 | API の cursor paging だけでは直近10年・分野17で約609万件・約30,500ページかかり Workflows のステップ数上限を超えるため、初期投入のみオフライン処理を残す（詳細: [docs/init-ingest.md](./init-ingest.md)）。スナップショット全体（`works` のみで約744GB）は Cloudflare に持ち込まず、分野・年で絞り込んだ範囲のみ D1 に取り込む |
| Queues / Cron は「PoC では任意」 | 必須コンポーネントとして採用 | 差分更新 ETL の中核のため |
| 単一 HTML・バニラ JS | React + Vite + Workers Static Assets | 既存テンプレートを活かし、実装・保守コストを下げる（ユーザー承認済み） |

---

## 3. コンポーネント詳細

### 3.1 初期インポート（S3 スナップショットからの一括取り込み）

**役割**: OpenAlex の S3 スナップショット（CC0、Parquet）から分野 17・直近 10 年の論文と引用エッジを抽出し、D1 に一括投入する。SPEC 4.3 の取り込み範囲・4.4 のスキーマに従う。詳細は [docs/init-ingest.md](./init-ingest.md)。

- **経緯（当初計画からの変更）**: 当初は OpenAlex REST API の cursor paging で初期取り込みも行う計画だったが、直近10年・Field 17 は実測で約609万件あり、1ページ200件で全件取得すると約30,500ページ（≒ 61,000 ステップ以上）になり、Workflows の 1 インスタンスあたりステップ数上限（Paid: デフォルト10,000 / 最大25,000）を超えることが判明した。これを回避するため、一時的に N=50,000 件（被引用上位のみ、`sort=cited_by_count:desc`）に絞って PoC を開始したが、系統樹として見せたい「裾野まで含めた実際の引用構造」を再現できないという課題が残った。このため **初期インポートは Cloudflare Workflows の制約を受けない S3 スナップショットからの一括抽出に切り替え、API 経由の取り込みは日次差分更新（3.1.1）に専念させる**。
- **実行主体**: Cloudflare の外（ローカル PC または EC2 インスタンス）。DuckDB の httpfs 拡張で S3 を直接読み（ダウンロードしない）、分野・年で絞り込んだ範囲を抽出する。
- **範囲外の祖先の扱い**: `referenced_works` が参照する論文が取り込み対象の範囲（分野17・直近10年）に含まれない場合、その `edges` 行は保存しない（`cited` 側の論文が `papers` に存在しない行を作らない）。SPEC 4.3「取り込み対象外の論文は祖先としてのみ必要な場合に限り追加」は、P2 以降でシード周辺探索の需要が出た時点で、不足する祖先を個別に OpenAlex API から補完する方式に拡張する。
- **手順概要**（詳細は init-ingest.md 3章）: ① DuckDB（httpfs 経由）で S3 上の Parquet から分野・年を絞り込み抽出 → ② `papers`/`edges`/`keywords`/`paper_keywords` を CSV/Parquet で出力 → ③ `wrangler d1 execute --file` 等で D1 へ一括投入 → ④ `edges` 集計で `papers.child_cnt` を再計算。
- **keywords の辞書化**: OpenAlex `keywords`（`STRUCT(id, display_name, score)[]`）は D1 で配列を直接扱えないため、`keywords`（辞書）+ `paper_keywords`（中間テーブル）に正規化する（SPEC 4.4、`migrations/0005`、詳細は init-ingest.md 3.3）。
- **冪等性**: `papers`/`edges` は主キーで UPSERT するため、投入を再実行しても安全。日次差分更新（3.1.1）との重複投入も同じ主キー制約で安全に吸収される。

#### 3.1.1 Ingest Workflow（日次差分更新）

**役割**: 初期インポート（3.1）以降、OpenAlex 側で更新・新規作成された論文のみを日次で取得し、D1 に反映する。

- **トリガー**: Cron Trigger（日次 1 回、深夜帯）。手動実行用に Workflow の REST API 経由でも起動可能にする。
- **実行主体**: Cloudflare Workflows。ステップ境界で状態を永続化し、失敗時は該当ステップから再開できる（SPEC にはなかった耐障害性の強化）。
- **取得条件**: `filter=primary_topic.field.id:17,from_publication_date:2016-01-01,to_publication_date:2026-12-31,from_updated_date:{last_run}` で絞り込み、cursor paging で取得する。`last_run` は前回実行時の日付で、D1 の `ingest_state` テーブル（`key='last_updated_date'`）に記録する（init-ingest.md 4.1）。1日あたりの更新件数は全件数よりずっと少ないため、Workflows のステップ数上限（Paid 最大25,000）に対して十分な余裕がある想定（実測して確認する）。
- **ステップ構成（概要）**:
  1. `fetch-and-store-page-{n}`: OpenAlex `/works` を上記フィルタで cursor paging により 1 ページ（200 件）取得する。`publication_year:2016-2026` というハイフン範囲構文は実測では動作するが公式ドキュメントに明記がないため、`from_publication_date`/`to_publication_date`（公式に明記された構文）を正式採用する（2026-11 時点で実測し、両者とも 6,095,841 件で一致することを確認済み）。同一ステップ内で、取得した生 JSON を R2 に保存（キー例: `raw/openalex/field17/{cursor}.json`）し、`papers` 行に変換して D1 にバッチ投入（`INSERT ... ON CONFLICT`）する。この時点では `edges` は投入しない。
  2. `next_cursor` が `null` になるまで 1 を繰り返す（初期インポートと異なり、全件を扱うわけではないため N 件での打ち切りは不要）。
  3. `upsert-edges`: 差分ページの `referenced_works` のうち `cited` 側が既存の `papers`（初期インポート分 + これまでの差分分）に存在するものだけを `edges` に UPSERT する。
  4. `recompute-child-cnt`: `edges` を集計して `papers.child_cnt` を確定（分野内）。
  5. `update-last-run`: `ingest_state.last_updated_date` を今回の実行日時で更新する。
- **レート制御**: OpenAlex 呼び出しは Rate Limiter DO（3.3）を経由し、キー利用時の上限（秒間 30 リクエスト、日次バジェット）を超えないよう直列化・待機する。
- **Semantic Scholar 連携**: 引用意図（intent）・influential citation の補助データを、同じ Workflow の後続ステップまたは別 Workflow で、Rate Limiter DO 経由（初期値 1 RPS）で取得し、D1 の該当列（次フェーズで追加）を更新する。
- **冪等性**: `papers`/`edges` は主キーで UPSERT するため、同じページを再取得しても安全（Workflows のステップ再実行に対する要件、[Rules of Workflows] 準拠）。

### 3.2 Graph Builder（シード単位グラフの事前構築）

**役割**: SPEC 4.5 の R2 グラフ JSON（`graph/field{分野ID}/seed-{id}-d{depth}.json`）を事前構築する。

- **トリガー**: 以下のいずれか。
  - Ingest Workflow 完了後、被引用上位・ハブ上位の論文をシード候補として Graph Build Queue にまとめて投入。
  - API（`/api/fields/:field/seed/{id}`）側でキャッシュミスかつ R2 未生成の場合、オンデマンドで Queue にメッセージを送り、非同期生成（この場合 API は D1 から直接 depth 2 までを計算して即時応答し、裏側で R2 を後追い生成してもよい）。Queue メッセージには `field` も含める（2026-11-10、`worker/index.ts` の `GraphBuildMessage`）。
- **実行主体**: Queue Consumer Worker。D1 に対し `edges` を祖先・子孫方向に BFS し、`depth`（既定 2、最大 3）まで展開。結果を R2 に書き込む。
- **キュー分離の理由**: グラフ構築は D1 への読み取りクエリが連続するため、API Worker のリクエスト処理から分離し、バースト（多数のシードを一括生成する場合）を Queues で吸収する。

### 3.3 Rate Limiter DO（外部 API 呼び出しの直列化）

**役割**: SPEC 3.1 の Durable Objects の役割を具体化。OpenAlex・Semantic Scholar への呼び出しを、サービスごとに 1 つの Durable Object インスタンス（シングルトン）を通して直列化し、レート制限を超えないよう間隔を空けて実行する。

- OpenAlex 用・Semantic Scholar 用に DO を分ける（レート制限の基準が異なるため）。
- DO 内部で「次に呼び出し可能になる時刻」を保持し、Ingest Workflow や API Worker からのリクエストをこの DO 経由にすることで、複数の実行主体（Workflow・オンデマンド API）が同時に外部 API を叩いても全体で 1 列に収まる。
- 429 応答を受けた場合は DO 側で待機時間を動的に延長する。

### 3.4 D1（分野 DB）

SPEC 4.4 のスキーマをそのまま採用する。Cloudflare 完結化に伴う追加事項:

- マイグレーションは `wrangler d1 migrations` で管理し、リポジトリにマイグレーションファイルを含める。
- 大量データの初期投入（バックフィル）は、Ingest Workflow のバッチ投入に加えて、`d1 execute --file` による一括インポート（最大 5 GB）も選択肢とする。日次の増分更新は Workflow 経由のみとする。
- **D1 のバインド変数上限は 100 件**（SQLite 標準の 999 より小さい、D1 固有の制限）。`WHERE id IN (...)` のような可変長 `IN` クエリは必ずチャンク分割すること（P2 実装時に実測で確認、`worker/graph.ts` の `SQL_IN_CHUNK_SIZE = 90` が実装例）。

#### 3.4.0 分野・年代レンジから D1 binding を引くレジストリ（2026-11-10 実装）

3.4.2 の年代分割方針を実コードに落とし込むため、`worker/db.ts` に `DB_REGISTRY`（`{field, yearRange, binding}` の配列）を設け、「どの分野・年代レンジがどの D1 binding に対応するか」を一元管理する。

- **binding 命名規則**: `DB_FIELD{分野ID}_{開始年}_{終了年}`（例: `DB_FIELD17_2016_2026`）。
- **新しい DB を追加する手順**: ① `wrangler d1 create` で DB 作成 → ② `wrangler.jsonc` に binding 追加 → ③ `wrangler types` で `Env` 型を再生成 → ④ `DB_REGISTRY` に 1 行追加。
- **API ルーティング**: 5 章の全エンドポイントが `/api/fields/:field/...` のパスパラメータで分野を受け取り、`yearRange` クエリパラメータ（`"2016-2026"` 形式、省略時はその分野の既定レンジ）で年代を指定する。`worker/db.ts` の `resolveFieldDb()` が両パラメータを検証し、対応する `D1Database` を返す（未登録の組み合わせは 404）。
- **フロントエンド**: `GET /api/fields` で登録済みの分野・年代レンジ一覧を取得し、ヘッダーのセレクトボックス（`src/components/Header.tsx`）で切り替える。切り替えると `src/App.tsx` がグラフ・一覧・選択状態を全て再読み込みする（別 DB のデータのため、選択 ID 等は引き継がない）。
- **複数 DB をまたぐクエリ**（例: 年代分割後の系譜追跡が DB をまたぐ場合）は、4.4 の結合ルール（`UNION ALL`）に従う実装は未着手（2026-11-10 時点ではレジストリ・切り替え基盤のみ。実際に年代分割が必要になった時点で対応する）。

#### 3.4.1 なぜ「分野だけ」では不十分か（容量試算）

計算機科学（Field 17）は OpenAlex 上で**全年代 約1,227万件**、**単年（2024年）だけで約62万件**という、分野の中でも特に論文数が多いカテゴリである（2026-11 時点で OpenAlex API `meta.count` を実測）。1 行あたりのサイズを概算すると:

| テーブル | 1 行あたりの概算サイズ | 根拠 |
|---|---|---|
| `papers` | 150〜250 バイト | `id`/`field`/`year`/`cit`/`fwci`/`subfield`/`child_cnt` の固定長列 + `title`（可変、平均100〜150バイト）+ インデックス2本 |
| `edges` | 20〜30 バイト | `cited`/`citing` の2列のみ（`WITHOUT ROWID`）+ `idx_edges_citing` |

これを論文数に掛けると:

| 範囲 | 論文数（目安） | 参考文献数込みの `edges`（1論文あたり平均35本と仮定） | 概算合計 |
|---|---|---|---|
| 単年（2024年） | 約62万件 | 約2,170万エッジ | 約0.7〜1 GB |
| 直近10年（2016〜2026、SPEC 4.3 の取り込み範囲） | 約500〜600万件（年あたり論文数は年々増加するため単純な10倍にはならない） | 約2億エッジ | **約6〜9 GB** |
| 全年代 | 約1,227万件 | — | **10 GB 上限を確実に超過** |

「直近10年」という SPEC の取り込み範囲でも、計算機科学は論文数が多いため **D1 の 10 GB 上限に対してすでに余裕がない**。かつ年々の論文数は増加傾向にあるため、分野だけで固定していると数年の運用で確実に上限へ到達する。したがって「分野」だけの分割では不十分で、**年代方向の分割が実質的に必須**になる。

**P1 実測との比較（2026-11-09、旧方針時点）**: 当時は旧方針（API cursor paging、N=50,000 件に限定）で取り込んだ結果、D1 実測サイズは **33.8 MB**（papers 50,000 件、edges 637,384 件）だった。1 論文あたりの実効エッジ数は 12.75 本で、上記試算の仮定（35 本/論文）より少ない。これは「N 件に含まれない祖先への edge を保存しない」簡略化により、被引用上位 5 万件同士の相互参照しか拾えていないための過小評価であり、**全件（約609万件）を取り込んだ場合の実効密度はこれより高くなる見込み**。したがって上表の 6〜9 GB という試算は無効化されたわけではない。

**初期インポート方式変更後の扱い（2026-11-10）**: 初期インポートを S3 スナップショットからの一括取り込み（3.1、docs/init-ingest.md）に切り替えたことで、PoC 開始時点から分野17・直近10年の**全件（約609万件）規模**を取り込む想定になった。したがって上記 33.8 MB は参考値に過ぎず、**初期インポート実行後に改めて D1 サイズを実測し、6〜9 GB という試算との比較・年代分割の着手判断を行う**（3.4.2 の運用ルールに従う）。

#### 3.4.2 年代分割の方針

5 年単位で DB を分割する（例: `field17_2016_2020` / `field17_2021_2025` / `field17_2026_2030` ...）。

- **分割の基準**: 論文の `papers.year` を基準に、どの年代 DB に属するかを決める。`edges` は 4.4 の結合ルール（引用する側 `citing` の DB に保存）に従う。
- **5 年単位を選ぶ理由**:
  - 単年分割（候補案の一つ）は DB 数が増えすぎ、系譜追跡（祖先が別 DB をまたぐ）のための結合クエリが頻発し複雑になる。
  - 分割なし（動的に閾値で追加）は、運用開始時点で境界を決めずに済む利点はあるが、「どの年がどの DB にあるか」をクエリ側が都度判定する必要があり、かつ 10 GB 超過の検知が後手に回るリスクがある。
  - 5 年単位は、直近10年の取り込み範囲（SPEC 4.3）がちょうど 2 DB に収まり、容量試算（3.4.1）でも 1 DB あたり 3〜5 GB 程度となり 10 GB 上限に対して十分なバッファを持てる。
- **運用ルール**:
  - 新しい 5 年区切りに入ったら、新しい DB を作成し Ingest Workflow の投入先を切り替える（コード上は `year` から対象 DB 名を算出する関数を 1 箇所に持つ）。
  - 既存 DB が 10 GB の 80% 等の閾値に近づいた場合は、取り込み範囲（SPEC 4.3 の「上位 N 件」の N）を絞るか、分割粒度を見直す（例: 直近5年のみ3年単位にする）。
  - 複数 DB をまたぐ検索・系譜追跡は、4.4 の結合ルールに従い `UNION ALL` で結合し、`field` 列および年代で絞り込む。実装上は、どの DB 群を結合対象にするかを Worker 側の設定（バインディングのリスト）で持つ。
- **この方針は P1（取り込みスクリプトでの実測）で確定する仮置きである**。実データの `title` 長・参考文献数の平均が試算と異なる場合、年代の区切り幅（5年→3年など）を調整する。

### 3.5 R2（オブジェクトストレージ）

用途ごとにバケット内でプレフィックスを分ける（バケット自体は 1 つで運用し、将来的に用途分割を検討）。

| プレフィックス | 内容 | 保持期間の目安 |
|---|---|---|
| `raw/openalex/field17/` | OpenAlex API の生レスポンス | 30 日（SPEC 5.1 準拠） |
| `raw/semanticscholar/` | Semantic Scholar の生レスポンス | 30 日 |
| `graph/field17/` | シード単位の完成済みグラフ JSON（SPEC 4.5） | 7 日（再取得はキュー経由） |

R2 のライフサイクルルールで `raw/` 系を自動削除し、保持コストを抑える。

### 3.6 API Worker

SPEC 5 章のエンドポイントをそのまま採用する。Cloudflare 完結化に伴う実装上の方針:

- ルーティングは軽量フレームワーク（例: Hono）を利用し、`worker/index.ts` を分割する。
- キャッシュ戦略（SPEC 5.1）は **Workers Cache（`caches.default`）を第一選択**とする。SPEC 原案の「Cache API」はこれに相当する。R2 を長期キャッシュ、D1 を正データとする二層構成を維持する。
- 外部 API 障害時（SPEC 7 章）は、Cache API または R2 の最新キャッシュを返し、レスポンスヘッダ（例: `X-Data-Freshness: stale`）で鮮度を明示する。

### 3.7 フロントエンド

- 既存の React + Vite + Workers Static Assets 構成を維持する（`src/`）。
- SVG 描画は React コンポーネントとして実装し、D3 等のレイアウト計算ライブラリを必要に応じて導入するが、DOM 操作自体は React に委ねる（vanilla JS 直接操作は避ける）。
- 状態管理はまず React の標準フック（`useState`/`useReducer`）で十分とし、肥大化した場合のみ外部ライブラリ導入を検討する。
- SPEC 6 章の描画ルール・操作仕様はそのまま適用する。

---

## 4. データフロー（詳細）

### 4.0 初期インポート（一度だけ、docs/init-ingest.md）

```
ローカル PC または EC2
  → DuckDB（httpfs で S3 の OpenAlex スナップショットを直接読む）
    → 分野17・直近10年で絞り込み、papers / edges を抽出
  → wrangler d1 execute 等で D1 へ一括投入
  → child_cnt を再集計して D1 更新
```

### 4.1 差分取り込み（日次バッチ）

```
Cron Trigger
  → Ingest Workflow 起動
    → [ループ] Rate Limiter DO 経由で OpenAlex /works を
      filter=...,from_updated_date:{last_run} で cursor paging 取得
        → R2 に生データ保存
        → papers / edges に整形
        → D1 へ UPSERT
    → child_cnt を再集計して D1 更新
    → ingest_state.last_updated_date を更新
    → 被引用上位・ハブ上位をもとに Graph Build Queue へシード候補を送信
```

### 4.2 グラフ事前構築（非同期）

```
Graph Build Queue（メッセージ: {seedId, depth}）
  → Graph Builder Worker（Queue Consumer）
    → D1 で祖先・子孫を depth まで BFS
    → R2 に graph/field17/seed-{id}-d{depth}.json を保存
```

### 4.3 配信（リクエスト時）

```
クライアント → Workers (API)
  → Cache API を確認（ヒットなら即応答）
  → ミスの場合:
    - /seed/{id}: R2 のグラフ JSON を確認 → あれば返す
                  → なければ D1 から depth まで直接計算して応答し、
                    裏側で Graph Build Queue にメッセージを送って R2 生成を後追い
    - /top, /hubs, /search, /paper/{id}: D1 に直接クエリ
  → Cache API に短期保存（SPEC 5.1 の有効期間）
```

---

## 5. 使用する Cloudflare プロダクト一覧

| プロダクト | 用途 | SPEC 上の対応箇所 |
|---|---|---|
| Workers | API 提供、フロントエンド配信、Queue Consumer | 3 章 |
| Workers Static Assets | React SPA のホスティング | 6 章 |
| Workflows | OpenAlex からの日次差分取り込み ETL（多段ステップ、再試行・再開） | 3.1.1 |
| Queues | グラフ構築の非同期化、外部 API 呼び出しのバースト吸収 | 3 章 |
| Cron Triggers | 日次の差分取り込みバッチ起動 | 3.1.1 |
| Durable Objects | OpenAlex / Semantic Scholar 呼び出しのレート制御直列化 | 3.3 |
| D1 | 分野ごとの論文・引用エッジ DB | 4.4 |
| R2 | 生データ保存、シード単位グラフ JSON、長期キャッシュ | 4.5, 5.1 |
| Workers Cache（Cache API） | 同一リクエストの短期キャッシュ | 5.1 |

初期インポート（3.1、一度だけ実行）のみ、Cloudflare の外（ローカル PC または EC2 インスタンス + DuckDB）で行う。詳細は [docs/init-ingest.md](./init-ingest.md)。

初期インポート（3.1）を除き、PC・VM・外部サーバー・外部ジョブランナー（GitHub Actions 等）は使用しない。初期インポートはスナップショットからの一度限りの一括抽出のため、ローカル PC または EC2 インスタンスを使用する（docs/init-ingest.md）。

---

## 6. 制約・リスク（SPEC 8 章の更新）

| 項目 | 内容 | 対応 |
|---|---|---|
| D1 の容量 | 1 DB 10 GB、行サイズ上限 2 MB、クエリ結果上限 50 MB。計算機科学は単年で約62万件、直近10年で約500〜600万件（3.4.1 参照）あり、分野だけの絞り込みでは上限に対して余裕がない | 分野に加えて 5 年単位で DB を分割（3.4.2）。`title` 等の大きい列を 2MB 制限内に収める |
| 初期インポートのデータ量・実行時間 | S3 スナップショット（`works` のみで約744 GB）を分野・年で絞り込むが、httpfs 経由で全1,898ファイルを読むため帯域に処理時間が依存する | ローカル PC で現実的な時間に収まらない場合は EC2（同リージョン）に切り替える（docs/init-ingest.md 2.1） |
| Workflows の制限（日次差分） | Paid: ステップ CPU 時間デフォルト30秒（最大5分まで設定可）、ステップ数デフォルト10,000（最大25,000） | 1 ページ取得＝1 ステップとして分割し、1 ステップの処理量を小さく保つ。日次差分は全件取得ではないため上限に対して余裕がある想定（実測して確認） |
| Queues の制限 | メッセージサイズ 128 KB、コンシューマーバッチ最大 100 件、5,000 msg/秒 | グラフ構築メッセージは `{seedId, depth}` のみの小さいペイロードにする |
| Workers CPU 時間 | Paid: HTTP リクエストはデフォルト 30 秒（最大 5 分まで設定可）。Cron Trigger は最大 15 分 | グラフ構築など重い処理は Queue Consumer に逃し、API Worker 自体は短時間で返す |
| OpenAlex のレート制限 | キー無し 10 req/s、無料キー 30 req/s、日次バジェットあり。cursor paging で全件ダウンロードしないよう明記されている | 日次差分更新は `from_updated_date` + 分野・年で絞り込んだフィルタのみ使用。Rate Limiter DO で制御 |
| Semantic Scholar の制限 | キー無し共有プール、キーあり初期値 1 RPS | Rate Limiter DO で直列化。利用条件（商用・再配布可否）は P0 で確認 |
| 外部 API の障害 | OpenAlex/Semantic Scholar が一時的に利用不可 | Cache API / R2 の最新キャッシュを返す（SPEC 7 章） |
| 見た目の過密 | ノードが多いと線が絡む | 表示件数・骨格・ハブ基準で絞る（SPEC 6.3） |

---

## 7. 未確定事項（SPEC 11 章との関連）

本書の設計により、SPEC 11 章の一部が以下のように整理される。

1. **OpenAlex API キーの上限** → Rate Limiter DO 側で安全マージンを持った値を仮設定し、429 応答の実測で調整する（日次差分更新で検証）。
2. **分野 DB の分割単位** → 分野（Field 17）のみでは全年代 約1,227万件・直近10年でも約500〜600万件と D1 の 10 GB 上限に対して余裕がないため、**5 年単位の年代分割を併用する**方針とした（3.4.1, 3.4.2）。初期インポート（全件規模）実行後の実測を見て、区切り幅（5年固定か、3年など可変にするか）を確定する。
3. **初期インポートの実行場所・D1 投入方式** → ローカル PC か EC2 か、`wrangler d1 execute --file` か Worker 経由チャンク投入か、を実測を見て確定する（docs/init-ingest.md 5章）。
4. **Semantic Scholar の利用条件** → P0 で確認済みにする（実装着手の前提条件）。
5. **論文名の検索方式** → D1 の `LIKE` をまず採用し、速度が問題になった場合に FTS5 相当の仕組み（D1 では別テーブルでの転置インデックス等）を検討する。
6. **人文系の分類** → P5 で Field 12/33 の境界を確認してから着手。
7. **公開範囲** → 個人利用を前提に Cloudflare Access 等での制限は本 PoC では設けない（必要になれば Cloudflare Access を追加）。

---

## 8. 開発フェーズへの反映（SPEC 10 章の更新）

| フェーズ | 内容（更新後） | 完了条件 |
|---|---|---|
| P0 | 仕様確定、OpenAlex API キー取得、Semantic Scholar 利用条件確認、Workflows/Queues の有効化 | 本書・SPEC の未確定事項が解消 |
| P1 | 初期インポート（S3 スナップショットから分野 17・直近 10 年を一括取り込み、docs/init-ingest.md）+ Ingest Workflow（日次差分更新、Cron Triggers + Rate Limiter DO）の実装 | 件数・`child_cnt` が検証できる |
| P2 | D1 投入の安定化、API（top / hubs / seed / search / paper）実装 | 検証項目のうち API 関連が通る |
| P3 | フロントエンド（React + SVG）を実データに接続 | 検証項目のうち表示関連が通る |
| P4 | Graph Builder（Queues）、Cache API/R2 キャッシュ戦略の調整 | 検索・シード探索が実用速度 |
| P5 | 人文系（Field 12）で同じ仕組みを試す | 疎なグラフでの見え方を評価 |

---

## 9. 参考リンク

- 初期インポートの詳細設計: [docs/init-ingest.md](./init-ingest.md)
- Cloudflare Workflows: https://developers.cloudflare.com/workflows/
- Cloudflare Queues: https://developers.cloudflare.com/queues/
- Cloudflare D1: https://developers.cloudflare.com/d1/
- Cloudflare D1 インポート/エクスポート: https://developers.cloudflare.com/d1/best-practices/import-export-data/
- Cloudflare R2: https://developers.cloudflare.com/r2/
- Cloudflare Durable Objects: https://developers.cloudflare.com/durable-objects/
- Cloudflare Workers Cache: https://developers.cloudflare.com/workers/runtime-apis/cache/
- OpenAlex API ページング: https://help.openalex.org/how-to-use-the-api/get-lists-of-entities/paging
- OpenAlex API フィルタ（`from_updated_date` 等）: https://help.openalex.org/how-to-use-the-api/get-lists-of-entities/filter-entity-lists
- OpenAlex レート制限: https://help.openalex.org/how-to-use-the-api/rate-limits-and-authentication
- OpenAlex スナップショット: https://help.openalex.org/download-all-data/snapshot-data-format
- DuckDB httpfs（S3 読み込み）: https://duckdb.org/docs/extensions/httpfs/s3api

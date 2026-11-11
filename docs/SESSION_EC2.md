# EC2 作業セッションの記録（SESSION_EC2.md）

- 作業日: 2026-11-11
- 対象: [docs/init-ingest.md](./init-ingest.md) の初期インポート（OpenAlex S3 スナップショット → D1）
- 進捗: 段階①（抽出スクリプトの動作確認）・段階②（小規模 D1 投入）完了。**次は段階③（中規模での実測）**
- 関連: [docs/tasks.md](./tasks.md) P1-0、[docs/SPEC.md](./SPEC.md) 4.3

---

## 1. 作業環境（EC2）

| 項目 | 内容 |
|---|---|
| マシン | EC2、2 vCPU・メモリ 7.6 GB（スワップなし）・EBS 500 GB（空き約 490 GB）、Amazon Linux 2023 |
| ツール | Python 3.9、duckdb 1.4.5（pip、httpfs 拡張は初回に自動インストール済み）、wrangler 4.160.0（グローバル）、aws CLI |
| リポジトリ | `/home/ec2-user/journal`（`node_modules` は未インストール） |
| S3 読み込み速度 | 約 160 MB/s（DuckDB httpfs、3 ファイル並列）→ 全 744 GB で 1〜2 時間の見込み |

**注意点**

- **Cloudflare 認証**: `~/.bashrc` に `CLOUDFLARE_API_TOKEN` を設定済み。Claude Code のシェルはセッション開始時の環境を引き継ぐため、wrangler を使うコマンドの前に `source ~/.bashrc` が必要。
- **`wrangler types` の注意**: この EC2 には `.dev.vars` が無いため、`wrangler types` を実行すると `worker-configuration.d.ts` から `OPENALEX_API_KEY` の型が消える。再生成した場合は手で戻すこと（今回は戻し済み）。
- **型チェック・ビルド未確認**: `node_modules` が無いため `npm run build` は未実行。手元で `npm install && npm run build` を通すこと。

---

## 2. 決定事項（ドキュメント反映済み）

- **取り込み範囲**: 分野 17・**2006 年以降（約 20 年、2006〜2026）の全件**（SPEC 4.3。当初の直近 10 年から拡大）。
- **D1 の分割**: **5 年単位**の 5 DB — `field17_2006_2010` / `field17_2011_2015` / `field17_2016_2020` / `field17_2021_2025` / `field17_2026_2030`（ARCHITECT.md 3.4.2）。論文の所属 DB は出版年で決める。
- **edges**: cited・citing とも取り込み範囲内の論文であるものだけを保存し、**citing 側の DB に置く**（SPEC 4.4 の結合ルール）。cited が別 DB にあるエッジを含む。自己引用は除外。
- **child_cnt**: **全年代の edges から計算**（DB をまたぐ子も数える）。
- **D1 投入方式**: SQL ファイル（複数行 INSERT）を生成し `wrangler d1 execute --file` で投入。
- **抽出スクリプト**: 検証用の `data/openalex/extract_cs.py` は使わず、`scripts/ingest/` に新規作成。

---

## 3. 作成・変更したもの

### 3.1 スクリプト（`scripts/ingest/`）

| ステップ | スクリプト | 入力 → 出力 |
|---|---|---|
| 1 | `stage.py` | S3（`manifest.json` の URL を 1 ファイルずつ）→ `data/openalex/work/stage/*.parquet`（分野・年で絞った中間ファイル） |
| 2 | `build.py` | 中間 Parquet → `data/openalex/work/out/{DB名}/{papers,edges,authorships,keywords,paper_keywords}.parquet` + `out/stats.json` |
| 3 | `export_sql.py` | `out/` → `data/openalex/work/sql/{DB名}/{NN}_{table}_{part}.sql` |
| 4 | `load_d1.py` | `sql/` → 各 D1 に投入し、件数・`child_cnt` 合計・被引用数合計・参照整合性を検証 |

- `stage.py`: 出力済みファイルはスキップして再開可能。前回と異なる条件（分野・年範囲）での再実行は停止する（`work/stage_params.json` で判定、やり直すときは `work/stage/` を削除）。既定は `--field 17 --min-year 2006 --max-year 2026 --jobs 4`。
- `build.py`: 重複 id は最新 `updated_date` を採用。DuckDB の作業 DB（`work/build.duckdb`）とスピル領域（`work/tmp`）はディスク上。既定 `--memory-limit 5GB`。
- `load_d1.py`: 投入前に対象 DB が空であることを確認（空でなければ停止、`--allow-nonempty` で無視）。`--only <DB名>`、`--verify-only`、`--local --config <設定>` に対応。
- 作業領域 `data/openalex/work/` は `.gitignore` に追加済み。

### 3.2 Cloudflare / コード

- D1 を 5 つ作成（WNAM）し、migrations 0001〜0005 を適用。

  | DB | database_id |
  |---|---|
  | field17_2006_2010 | 674c579d-23d3-43c3-985e-61ec1d6bf7b5 |
  | field17_2011_2015 | 964d0981-ad71-41ad-bb02-88c81993fc3e |
  | field17_2016_2020 | fc881b17-24af-4eee-90e7-ec6d91f59eba |
  | field17_2021_2025 | 2dcce76f-dc22-49bc-9731-d65fc6826b02 |
  | field17_2026_2030 | c1e37da2-dd71-4ae6-b9e7-b722d29ba58d |

- `wrangler.jsonc`: 上記 5 DB の binding（`DB_FIELD17_{開始年}_{終了年}`、`remote: true`）を追加。
- `worker/db.ts` の `DB_REGISTRY`: 5 DB を追加。旧 `field17_2016_2026` は**先頭（既定）のまま残している**。デプロイすると年代切り替え UI に新 DB も表示される。
- `worker-configuration.d.ts`: `wrangler types` で再生成（`OPENALEX_API_KEY` は手で復元）。

### 3.3 ドキュメント

- `docs/SPEC.md`: 4.3 取り込み範囲（2006 年以降・5 年単位 DB・edges の置き場所）、4.4 補足、P1 の表、API の例。
- `docs/init-ingest.md`: 冒頭に範囲変更、3.3（新スクリプト・段階①の実測）・3.4（D1 投入手順・段階②の実績）を書き直し、3.6 検証項目・5 章未確定事項を更新。
- `docs/tasks.md`: P1-0-①・② の完了と残タスク。

**未コミット**（`git status` で確認。`scripts/ingest/*.py` はステージ済み）。

---

## 4. 検証結果

### 段階①（2026-11-11、更新日 2026-10-14 の 3 ファイル・2.2 GB）

- stage 約 14 秒。論文 42,337 件・edges 4,768。build のチェック項目はすべて 0。
- **edges の約 61% は cited が別の年代 DB**にある。
- keywords の語彙は 3 ファイルだけで 8.3 万語（当初見積もりの「全体で数万語」より大きい）。
- `publication_date` が 1 月の論文が約 27%（OpenAlex 側で月不明 → 1/1 と思われる）。

### 段階②（同データを本番 D1 に投入）

ローカル D1・本番 D1 とも全項目一致（本番は約 1 分半）。

| DB | 論文 | edges | D1 サイズ |
|---|---|---|---|
| field17_2006_2010 | 5,056 | 71 | 5.8 MB |
| field17_2011_2015 | 6,306 | 222 | 7.4 MB |
| field17_2016_2020 | 8,426 | 803 | 10.6 MB |
| field17_2021_2025 | 19,760 | 3,306 | 25.6 MB |
| field17_2026_2030 | 2,789 | 366 | 4.2 MB |

- 論文 1 件あたり約 1.3 KB（edges を除く）。全件では 2021-2025 DB が論文分だけで数 GB、edges を足すと 10 GB 上限の半分を超える可能性がある（段階③で実測）。
- **5 つの新 DB には段階②の小規模データが入ったまま**。

---

## 5. 次の作業

### 5.1 段階③: 中規模での実測（次にやること）

提案している進め方: S3 の読み込み時間は年範囲を絞ってもほぼ変わらないため、**最初から全期間（2006 年以降）を stage し**、build 以降を DB 1 つ分ずつ試す。

```bash
cd /home/ec2-user/journal
source ~/.bashrc
rm -rf data/openalex/work/stage          # 段階①の 3 ファイル分（条件は同じなので残しても可）
python3 scripts/ingest/stage.py          # 全 1,898 ファイル、1〜2 時間の見込み（バックグラウンド推奨）
python3 scripts/ingest/build.py          # メモリ 7.6 GB で回るか・所要時間・スピル量を確認
python3 scripts/ingest/export_sql.py
```

実測する項目:

- stage・build の所要時間とメモリ・ディスク使用量（build がメモリ不足になる場合は `--memory-limit`・`--threads` を調整）
- 各 DB の論文数・edges 数（OpenAlex API の `meta.count` と比較）
- 1 DB 分（例: `field17_2021_2025`）を D1 に投入したときの所要時間・D1 サイズ・大きい SQL ファイルでの挙動
- 10 GB 上限に対する余裕（足りなければ区切り幅の見直し、ARCHITECT.md 3.4.2）

### 5.2 段階④: 本番実行

1. 5 DB の小規模データを削除（各テーブルを空にする）
2. `load_d1.py --remote` で全 DB に投入 → 検証
3. 旧 `field17_2016_2026` を `DB_REGISTRY`・`wrangler.jsonc` から外し、既定 DB を切り替える（その後 D1 を削除するかは要相談）

### 5.3 未解決の設計課題

- **DB をまたぐ処理**: edges の約 6 割は cited が別 DB。系統樹・系譜追跡（`worker/graph.ts`）の DB 横断結合は未実装（ARCHITECT.md 3.4.0）。
- **日次差分の `child_cnt`**: `recomputeChildCnt` は DB 単体で数えるため、初期インポートの値（DB をまたぐ子を含む）を小さく上書きしてしまう。P1-7 で合わせて変更が必要。
- **keywords の語彙サイズ**: 全件での語数・容量を段階③で確認。
- **本番 D1 のテスト行**: 旧 `field17_2016_2026` に手動投入したテストデータ（論文 3 件・著者行）が残っている（tasks.md「既知の暫定措置」）。旧 DB 廃止時に一緒に片付く。

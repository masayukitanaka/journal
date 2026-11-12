#!/usr/bin/env python3
"""
初期インポート Step 2（build）: stage.py の中間 Parquet を結合し、D1 スキーマ（migrations 0001〜0005）
に合わせたテーブルを、分野 × 5 年単位の DB ごとに作る（docs/init-ingest.md 3.3〜3.4、ARCHITECT.md 3.4.2）。

DB の区切り: anchor 年（既定 2011）から bucket 年（既定 5）ごと → 2006-2010, 2011-2015, 2016-2020, 2021-2025, 2026-2030 ...
  論文の所属 DB は publication_year（= floor(year)）で決める。DB 名は field{分野}_{開始年}_{終了年}。

処理:
  1. 同じ id が複数ファイルに現れた場合は updated_date が最新の行を採用する（id だけで集計して判定）
  2. papers         : id, field, title, year, cit, fwci, subfield, child_cnt, doi（論文の年代の DB）
  3. edges          : cited = 引用された側（祖先）, citing = 引用した側（子孫）。
                      cited が「取り込んだ全年代の papers」のどこかに存在するものだけ残し、
                      引用する側（citing）の年代の DB に置く（ARCHITECT.md 4.4 の結合ルール）。
                      したがって cited が別 DB（過去の年代）にあるエッジを含む。自己引用は除外
  4. child_cnt      : 全年代の edges から計算した直接の子の数（DB をまたぐ子も数える）
  5. authorships    : paper_id, author_name（論文の年代の DB）
  6. paper_keywords : paper_id, keyword_id, score（論文の年代の DB）
  7. keywords       : id, name（その DB の paper_keywords が参照する語だけ）

出力: {work}/out/{db名}/{table}.parquet、{work}/out/stats.json
中間計算は {work}/build.duckdb（ディスク上）で行い、メモリに載らない分は {work}/tmp にスピルする。

使い方:
  python3 scripts/ingest/build.py
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import time

import duckdb

DEFAULT_WORK = os.path.join(os.path.dirname(__file__), "../../data/openalex/work")
TABLES = ["papers", "edges", "authorships", "keywords", "paper_keywords"]


def q(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def main() -> None:
    ap = argparse.ArgumentParser(description="中間 Parquet から D1 投入用テーブルを DB（分野×年代）ごとに作る")
    ap.add_argument("--work", default=DEFAULT_WORK)
    ap.add_argument("--bucket-anchor", type=int, default=2011, help="年代区切りの起点年")
    ap.add_argument("--bucket-years", type=int, default=5, help="1 DB あたりの年数")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--memory-limit", default="5GB")
    args = ap.parse_args()

    params = json.load(open(os.path.join(args.work, "stage_params.json")))
    stage_glob = os.path.join(args.work, "stage", "*.parquet")
    out_root = os.path.join(args.work, "out")
    if os.path.exists(out_root):
        shutil.rmtree(out_root)
    os.makedirs(out_root)
    db_path = os.path.join(args.work, "build.duckdb")
    if os.path.exists(db_path):
        os.remove(db_path)

    con = duckdb.connect(db_path)
    con.execute(f"SET threads TO {args.threads}")
    con.execute(f"SET memory_limit = {q(args.memory_limit)}")
    con.execute(f"SET temp_directory = {q(os.path.join(args.work, 'tmp'))}")
    con.execute("SET preserve_insertion_order = false")

    def step(label: str, sql: str) -> None:
        t = time.time()
        con.execute(sql)
        print(f"{label}: {time.time() - t:.1f}s", flush=True)

    a, w = args.bucket_anchor, args.bucket_years
    # 重複 id は id だけで集計して確認する（全列にウィンドウ関数をかけると 7.6 GB のマシンで OOM になったため）。
    # 同じ id が複数ファイルにあれば updated_date が最新の行を採用する（2026-10-14 スナップショットでは重複 0 件）。
    step("dup（重複 id の確認）", f"""
        CREATE TABLE dup AS
        SELECT id, max(updated_date) AS ud FROM read_parquet({q(stage_glob)}, filename = false)
        GROUP BY id HAVING count(*) > 1
    """)
    n_stage = con.execute(f"SELECT count(*) FROM read_parquet({q(stage_glob)})").fetchone()[0]
    n_dup = con.execute("SELECT count(*) FROM dup").fetchone()[0]
    step("raw（年代 bucket 付与）", f"""
        CREATE TABLE raw AS
        SELECT s.*, ({a} + {w} * floor((floor(s.year) - {a}) / {w}))::INTEGER AS bucket
        FROM read_parquet({q(stage_glob)}) s
        LEFT JOIN dup d ON d.id = s.id
        WHERE d.id IS NULL OR s.updated_date = d.ud
    """)
    if n_dup:
        # 同じ id・同じ updated_date の行が残った場合は 1 行に絞る
        con.execute("DELETE FROM raw WHERE id IN (SELECT id FROM dup) AND rowid NOT IN "
                    "(SELECT min(rowid) FROM raw WHERE id IN (SELECT id FROM dup) GROUP BY id)")
    step("ids", "CREATE TABLE ids AS SELECT id, bucket FROM raw")

    # edges は citing 側の bucket に置く。cited は全年代のどこかに存在すればよい
    step("edges", """
        CREATE TABLE edges AS
        SELECT e.cited, e.citing, e.bucket
        FROM (SELECT unnest(list_distinct(refs)) AS cited, id AS citing, bucket FROM raw) e
        SEMI JOIN ids p ON p.id = e.cited
        WHERE e.cited <> e.citing
    """)
    n_refs_total = con.execute("SELECT coalesce(sum(len(refs)), 0) FROM raw").fetchone()[0]

    step("papers（child_cnt は全年代の edges から計算）", """
        CREATE TABLE papers AS
        SELECT r.id, r.field, r.title, r.year, r.cit, r.fwci, r.subfield,
               coalesce(c.child_cnt, 0)::INTEGER AS child_cnt, r.doi, r.bucket
        FROM raw r
        LEFT JOIN (SELECT cited AS id, count(*) AS child_cnt FROM edges GROUP BY cited) c USING (id)
    """)

    step("authorships", """
        CREATE TABLE authorships AS
        SELECT id AS paper_id, unnest(list_distinct(authors)) AS author_name, bucket FROM raw
    """)

    step("paper_keywords / keywords", """
        CREATE TABLE kw AS SELECT id AS paper_id, bucket, unnest(keywords) AS k FROM raw;
        CREATE TABLE paper_keywords AS
        SELECT paper_id, k.id AS keyword_id, max(k.score) AS score, bucket FROM kw GROUP BY ALL;
        CREATE TABLE keywords AS
        SELECT k.id AS id, min(k.name) AS name, bucket FROM kw GROUP BY ALL;
        DROP TABLE kw;
    """)
    con.execute("DROP TABLE raw")

    buckets = [r[0] for r in con.execute("SELECT DISTINCT bucket FROM papers ORDER BY 1").fetchall()]
    stats: dict = {
        "params": {**params, "bucket_anchor": a, "bucket_years": w},
        "stage_rows": n_stage,
        "duplicate_ids_removed": n_dup,
        "refs_total": n_refs_total,
        "edges_total": con.execute("SELECT count(*) FROM edges").fetchone()[0],
        "edges_cross_db": con.execute(
            "SELECT count(*) FROM edges e JOIN ids p ON p.id = e.cited WHERE p.bucket <> e.bucket"
        ).fetchone()[0],
        "keywords_distinct_all": con.execute("SELECT count(DISTINCT id) FROM keywords").fetchone()[0],
        "dbs": {},
    }

    for b in buckets:
        name = f"field{params['field']}_{b}_{b + w - 1}"
        d = os.path.join(out_root, name)
        os.makedirs(d)
        s = {}
        for t in TABLES:
            s[t] = con.execute(f"SELECT count(*) FROM {t} WHERE bucket = {b}").fetchone()[0]
            con.execute(f"COPY (SELECT * EXCLUDE (bucket) FROM {t} WHERE bucket = {b}) "
                        f"TO {q(os.path.join(d, t + '.parquet'))} (FORMAT parquet, COMPRESSION zstd)")
        # 抽出時点の整合性チェック（init-ingest.md 3.6）
        checks = con.execute(f"""
            SELECT
              (SELECT count(*) FROM papers WHERE bucket = {b} AND (title IS NULL OR year IS NULL OR cit IS NULL)),
              (SELECT count(*) FROM papers WHERE bucket = {b} AND (year < {b} OR year >= {b + w})),
              (SELECT count(*) FROM edges e ANTI JOIN papers p ON p.id = e.citing AND p.bucket = e.bucket
                 WHERE e.bucket = {b}),
              (SELECT count(*) FROM paper_keywords pk
                 ANTI JOIN keywords k ON k.id = pk.keyword_id AND k.bucket = pk.bucket
                 WHERE pk.bucket = {b}),
              (SELECT count(*) FROM edges e JOIN ids p ON p.id = e.cited
                 WHERE e.bucket = {b} AND p.bucket <> {b})
        """).fetchone()
        s["checks"] = dict(zip(
            ["papers_not_null_violations", "year_out_of_bucket", "edges_citing_not_in_db",
             "paper_keywords_dangling"], checks[:4]))
        s["edges_cited_in_other_db"] = checks[4]
        stats["dbs"][name] = s

    stats["child_cnt_sum_minus_edges"] = con.execute(
        "SELECT (SELECT sum(child_cnt) FROM papers) - (SELECT count(*) FROM edges)").fetchone()[0]

    with open(os.path.join(out_root, "stats.json"), "w") as f:
        json.dump(stats, f, indent=2, ensure_ascii=False)
    print(json.dumps(stats, indent=2, ensure_ascii=False))
    con.close()


if __name__ == "__main__":
    main()

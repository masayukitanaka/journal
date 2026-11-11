#!/usr/bin/env python3
"""
初期インポート Step 1（stage）: OpenAlex S3 スナップショット（works, Parquet）を 1 ファイルずつ
DuckDB httpfs で直接読み、分野・出版年で絞り込んだ中間 Parquet を書き出す（docs/init-ingest.md 3.1〜3.3）。

- ダウンロードはしない（必要な列だけを S3 から Range 読みする）。
- 入力ファイル 1 つにつき出力 1 つ（{work}/stage/{updated_date}__{part}.parquet）。
  一時ファイルに書いてから rename するため、出力が存在するファイルは完了済みとしてスキップし、途中から再開できる。
- 該当 0 件のファイルも空の Parquet を書く（完了の印を兼ねる）。

中間 Parquet の列:
  id BIGINT, field INT, title VARCHAR, year DOUBLE（year + (month-1)/12）, cit INT, fwci DOUBLE,
  subfield INT, doi VARCHAR, updated_date DATE, refs BIGINT[], authors VARCHAR[],
  keywords STRUCT(id VARCHAR, name VARCHAR, score FLOAT)[]

使い方:
  python3 scripts/ingest/stage.py --limit-files 2          # 動作確認（段階①）
  python3 scripts/ingest/stage.py --min-year 2021          # 中規模（段階③）
  python3 scripts/ingest/stage.py                          # 本番（段階④、全 1,898 ファイル）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import duckdb

DEFAULT_MANIFEST = os.path.join(os.path.dirname(__file__), "../../data/openalex/manifest.json")
DEFAULT_WORK = os.path.join(os.path.dirname(__file__), "../../data/openalex/work")

_local = threading.local()


def connection(threads: int) -> duckdb.DuckDBPyConnection:
    con = getattr(_local, "con", None)
    if con is None:
        con = duckdb.connect()
        con.execute("LOAD httpfs")
        con.execute("SET s3_region = 'us-east-1'")
        con.execute(f"SET threads TO {threads}")
        con.execute("SET preserve_insertion_order = false")
        _local.con = con
    return con


def stage_name(url: str) -> str:
    # s3://openalex/data/parquet/works/updated_date=2026-10-10/part_0098.parquet
    #   -> 2026-10-10__part_0098.parquet
    parts = url.rstrip("/").split("/")
    return f"{parts[-2].split('=', 1)[1]}__{parts[-1]}"


def q(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def stage_sql(url: str, out_tmp: str, field: int, min_year: int, max_year: int) -> str:
    # 月が欠損している場合は worker/ingest-workflow.ts の yearWithMonth と同じく id から決定的に割り当てる。
    return f"""
    COPY (
        WITH src AS (
            SELECT
                CAST(regexp_extract(id, 'W([0-9]+)$', 1) AS BIGINT) AS id,
                title, doi, publication_date, publication_year, cited_by_count, fwci,
                primary_topic.subfield.id AS subfield_url,
                referenced_works, authorships, keywords, updated_date
            FROM read_parquet({q(url)})
            WHERE publication_year BETWEEN {min_year} AND {max_year}
              AND primary_topic.field.id = 'https://openalex.org/fields/{field}'
        )
        SELECT
            id,
            {field}::INTEGER AS field,
            coalesce(nullif(trim(title), ''), '(no title)') AS title,
            publication_year
              + (coalesce(month(publication_date), (id % 12) + 1) - 1) / 12.0 AS year,
            coalesce(cited_by_count, 0)::INTEGER AS cit,
            fwci,
            CAST(regexp_extract(subfield_url, '([0-9]+)$', 1) AS INTEGER) AS subfield,
            doi,
            updated_date,
            list_filter(
                list_transform(referenced_works, r -> TRY_CAST(regexp_extract(r, 'W([0-9]+)$', 1) AS BIGINT)),
                x -> x IS NOT NULL
            ) AS refs,
            list_filter(
                list_transform(authorships, a -> trim(a.author.display_name)),
                x -> x IS NOT NULL AND x <> ''
            ) AS authors,
            list_filter(
                list_transform(keywords, k -> {{
                    'id': regexp_extract(k.id, 'keywords/([^/]+)$', 1),
                    'name': k.display_name,
                    'score': k.score
                }}),
                k -> k.id IS NOT NULL AND k.id <> '' AND k.name IS NOT NULL
            ) AS keywords
        FROM src
        WHERE id IS NOT NULL
    ) TO {q(out_tmp)} (FORMAT parquet, COMPRESSION zstd)
    """


def stage_one(url: str, out_dir: str, args) -> tuple[str, int, float]:
    out = os.path.join(out_dir, stage_name(url))
    tmp = out + ".tmp"
    t0 = time.time()
    last_err: Exception | None = None
    for attempt in range(1, args.retries + 1):
        try:
            con = connection(args.threads)
            con.execute(stage_sql(url, tmp, args.field, args.min_year, args.max_year))
            n = con.execute(f"SELECT count(*) FROM read_parquet({q(tmp)})").fetchone()[0]
            os.replace(tmp, out)
            return url, n, time.time() - t0
        except Exception as e:  # ネットワーク瞬断などは再試行する
            last_err = e
            _local.con = None
            time.sleep(min(60, 5 * attempt))
    if os.path.exists(tmp):
        os.remove(tmp)
    raise RuntimeError(f"{url}: {last_err}")


def main() -> None:
    ap = argparse.ArgumentParser(description="OpenAlex S3 スナップショットから分野・年で絞った中間 Parquet を作る")
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST)
    ap.add_argument("--work", default=DEFAULT_WORK, help="作業フォルダ（stage/ 以下に出力）")
    ap.add_argument("--field", type=int, default=17)
    ap.add_argument("--min-year", type=int, default=2006)
    ap.add_argument("--max-year", type=int, default=2026)
    ap.add_argument("--limit-files", type=int, default=0, help="更新日の新しい順に N ファイルだけ処理（0 = 全部）")
    ap.add_argument("--jobs", type=int, default=4, help="同時に処理するファイル数")
    ap.add_argument("--threads", type=int, default=2, help="ファイル 1 つあたりの DuckDB スレッド数")
    ap.add_argument("--retries", type=int, default=3)
    args = ap.parse_args()

    manifest = json.load(open(args.manifest))
    urls = [f["url"] for f in manifest["files"]]
    sizes = {f["url"]: f["meta"]["content_length"] for f in manifest["files"]}
    # 新しい更新日のファイルほど件数が多く、分野・年の該当も多いため、動作確認では新しい側から取る
    urls.sort(reverse=True)
    if args.limit_files > 0:
        urls = urls[: args.limit_files]

    out_dir = os.path.join(args.work, "stage")
    os.makedirs(out_dir, exist_ok=True)
    # 条件の違う中間ファイルが混ざらないよう、既存の stage と条件が違う場合は止める
    params = {"snapshot_date": manifest.get("date"), "field": args.field,
              "min_year": args.min_year, "max_year": args.max_year}
    params_path = os.path.join(args.work, "stage_params.json")
    if os.path.exists(params_path) and os.listdir(out_dir):
        prev = json.load(open(params_path))
        if prev != params:
            sys.exit(f"既存の stage と条件が異なります: {prev} != {params}\n"
                     f"やり直す場合は {out_dir} を削除してから実行してください")
    with open(params_path, "w") as f:
        json.dump(params, f, indent=2)

    todo = [u for u in urls if not os.path.exists(os.path.join(out_dir, stage_name(u)))]
    total_bytes = sum(sizes[u] for u in todo)
    print(f"対象 {len(urls)} ファイル / 未処理 {len(todo)} ファイル（{total_bytes / 1e9:.1f} GB）", flush=True)

    t0 = time.time()
    done_bytes = 0
    rows = 0
    failed: list[str] = []
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(stage_one, u, out_dir, args): u for u in todo}
        for i, fut in enumerate(as_completed(futs), 1):
            u = futs[fut]
            try:
                _, n, secs = fut.result()
                rows += n
                done_bytes += sizes[u]
                el = time.time() - t0
                eta = el / done_bytes * (total_bytes - done_bytes) if done_bytes else 0
                print(f"[{i}/{len(todo)}] {stage_name(u)} {n:,} 件 {secs:.1f}s "
                      f"| 累計 {rows:,} 件 {done_bytes / 1e9:.1f}/{total_bytes / 1e9:.1f} GB "
                      f"| 経過 {el / 60:.1f} 分 残り約 {eta / 60:.1f} 分", flush=True)
            except Exception as e:
                failed.append(u)
                print(f"[{i}/{len(todo)}] 失敗: {e}", file=sys.stderr, flush=True)

    print(f"完了: {rows:,} 件（今回処理分）/ 失敗 {len(failed)} ファイル / {(time.time() - t0) / 60:.1f} 分")
    if failed:
        print("失敗したファイルは再実行で再処理される（完了済みはスキップ）", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

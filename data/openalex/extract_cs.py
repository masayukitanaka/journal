#!/usr/bin/env python3
"""
OpenAlex works（Parquet）から、指定分野の論文と引用エッジを抽出する。

出力（--out 以下）:
  papers.parquet        論文（タイトル・年・被引用数・分野）
  papers.csv            同上（D1 への投入用、参考文献の列は含まない）
  edges.parquet         引用エッジ（cited = 祖先, citing = 子孫）
  child_cnt.csv         分岐数（分野内の直接の子の数）
  external_ids.csv      引用先のうち、この分野に含まれない論文の ID（後で個別に取得する）

使い方:
  # まず列名と型を確認（1 ファイルだけ読む）
  python extract_cs.py --pattern "/data/openalex/works/*/*.parquet" --describe --limit-files 1

  # 省略なしで全列・全文字を表示（ネストしたスキーマの確認に）
  python extract_cs.py --pattern "/data/openalex/works/*/*.parquet" --describe-full --limit-files 1

  # 件数だけ数える（全件数と、絞り込み後の件数）
  python extract_cs.py --pattern "/data/openalex/works/*/*.parquet" --count

  # 動作確認（先頭 2 ファイルだけ）
  python extract_cs.py --pattern "/data/openalex/works/*/*.parquet" --limit-files 2

  # 本番（分野 17、2016 年以降）
  python extract_cs.py --pattern "/data/openalex/works/*/*.parquet" --field 17 --min-year 2016

前提（実データのスキーマで要確認）:
  - id                      例: https://openalex.org/W2741809807
  - title, publication_year, cited_by_count
  - primary_topic.field.id  例: https://openalex.org/fields/17
  - referenced_works        参考文献 ID のリスト
"""
import argparse
import glob
import os
import sys

import duckdb


def files_for(pattern: str, limit: int) -> list[str]:
    files = sorted(glob.glob(pattern, recursive=True))
    if not files:
        sys.exit(f"ファイルが見つかりません: {pattern}")
    return files[:limit] if limit > 0 else files


def sql_list(paths: list[str]) -> str:
    """Parquet パスの配列を SQL のリテラルにする（単一引用符をエスケープ）。"""
    return "[" + ", ".join("'" + p.replace("'", "''") + "'" for p in paths) + "]"


def main() -> None:
    ap = argparse.ArgumentParser(description="OpenAlex works から分野の論文と引用を抽出")
    ap.add_argument("--pattern", required=True, help="works の Parquet（glob 可）")
    ap.add_argument("--out", default="out", help="出力フォルダ")
    ap.add_argument("--field", type=int, default=17, help="OpenAlex Field ID（既定 17）")
    ap.add_argument("--min-year", type=int, default=2016, help="この年以降の論文のみ")
    ap.add_argument("--limit-files", type=int, default=0, help="先頭 N ファイルだけ読む（0 = 全部）")
    ap.add_argument("--threads", type=int, default=4, help="DuckDB のスレッド数")
    ap.add_argument("--describe", action="store_true", help="スキーマを表示して終了")
    ap.add_argument(
        "--describe-full",
        action="store_true",
        help="スキーマを省略なし（列・文字数とも全表示）で表示して終了",
    )
    ap.add_argument(
        "--count",
        action="store_true",
        help="全件数と --field / --min-year 絞り込み後の件数を表示して終了",
    )
    args = ap.parse_args()

    files = files_for(args.pattern, args.limit_files)
    print(f"対象ファイル: {len(files)} 件")
    flist = sql_list(files)

    con = duckdb.connect()
    con.execute(f"SET threads TO {args.threads}")

    if args.describe:
        con.sql(f"DESCRIBE SELECT * FROM read_parquet({flist}, union_by_name=true)").show()
        return

    if args.describe_full:
        con.sql(
            f"DESCRIBE SELECT * FROM read_parquet({flist}, union_by_name=true)"
        ).show(max_rows=10_000, max_width=10_000)
        return

    if args.count:
        n_total, n_filtered = con.execute(f"""
            SELECT
                COUNT(*),
                COUNT(*) FILTER (
                    publication_year >= {args.min_year}
                    AND CAST(regexp_extract(primary_topic.field.id, '([0-9]+)$', 1) AS INTEGER) = {args.field}
                )
            FROM read_parquet({flist}, union_by_name=true)
        """).fetchone()
        print(f"全件数: {n_total:,} 件")
        print(f"絞り込み後（field={args.field}, min-year={args.min_year}）: {n_filtered:,} 件")
        return

    os.makedirs(args.out, exist_ok=True)
    out = lambda name: os.path.join(args.out, name).replace("'", "''")

    # 1. 必要な列だけを読み、分野で絞り込む（列の絞り込みはエンジンが自動で行う）
    con.execute(f"""
        CREATE TABLE papers_raw AS
        SELECT
            CAST(regexp_extract(id, 'W([0-9]+)$', 1) AS BIGINT)            AS id,
            title,
            publication_year                                             AS year,
            cited_by_count                                               AS cit,
            CAST(regexp_extract(primary_topic.field.id, '([0-9]+)$', 1) AS INTEGER) AS field,
            referenced_works
        FROM read_parquet({flist}, union_by_name=true)
        WHERE publication_year >= {args.min_year}
    """)
    con.execute(f"DELETE FROM papers_raw WHERE field IS NULL OR field <> {args.field}")

    # 2. 論文テーブル（参考文献の列を外す）
    con.execute("""
        CREATE TABLE papers AS
        SELECT id, title, year, cit, field FROM papers_raw
    """)

    # 3. 引用エッジ：分野内の論文が引用している先（参考文献）を展開する
    #    cited = 引用された側（祖先）, citing = 引用した側（子孫）
    con.execute("""
        CREATE TABLE edges AS
        WITH e AS (
            SELECT id AS citing, unnest(referenced_works) AS ref
            FROM papers_raw
        )
        SELECT DISTINCT
            CAST(regexp_extract(ref, 'W([0-9]+)$', 1) AS BIGINT) AS cited,
            citing
        FROM e
        WHERE ref IS NOT NULL
    """)
    con.execute("DELETE FROM edges WHERE cited IS NULL")

    # 4. 分岐数（分野内で、直接の子になっている論文の数）
    con.execute("""
        CREATE TABLE child_cnt AS
        SELECT cited AS id, COUNT(*) AS child_cnt
        FROM edges
        GROUP BY cited
    """)

    # 5. 分野外の引用先（後で個別に取得する対象）
    con.execute("""
        CREATE TABLE external_ids AS
        SELECT DISTINCT cited AS id
        FROM edges
        WHERE cited NOT IN (SELECT id FROM papers)
    """)

    # 統計
    n_papers, n_edges, n_ext = con.execute("""
        SELECT
          (SELECT COUNT(*) FROM papers),
          (SELECT COUNT(*) FROM edges),
          (SELECT COUNT(*) FROM external_ids)
    """).fetchone()
    print(f"論文: {n_papers:,} 件 / 引用エッジ: {n_edges:,} 件 / 分野外の引用先: {n_ext:,} 件")

    # 出力
    con.execute(f"COPY papers TO '{out('papers.parquet')}' (FORMAT parquet)")
    con.execute(f"COPY papers TO '{out('papers.csv')}' (HEADER, DELIMITER ',')")
    con.execute(f"COPY edges TO '{out('edges.parquet')}' (FORMAT parquet)")
    con.execute(f"COPY child_cnt TO '{out('child_cnt.csv')}' (HEADER, DELIMITER ',')")
    con.execute(f"COPY external_ids TO '{out('external_ids.csv')}' (HEADER, DELIMITER ',')")
    print(f"出力先: {args.out}/")


if __name__ == "__main__":
    main()
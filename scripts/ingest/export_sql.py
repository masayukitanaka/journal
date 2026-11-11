#!/usr/bin/env python3
"""
初期インポート Step 3（export_sql）: build.py の出力（out/{DB名}/{table}.parquet）を、
`wrangler d1 execute --file` で投入できる SQL ファイルに変換する（docs/init-ingest.md 3.4）。

- 投入順序: papers → edges → authorships → keywords → paper_keywords（ファイル名の番号順）
- 1 文あたり最大 --max-stmt-kb（既定 90KB）の複数行 INSERT にまとめる（D1 の SQL 文長上限 100KB 未満）
- 1 ファイルあたり最大 --max-file-mb（既定 100MB）で分割する
- 主キーのあるテーブルは INSERT OR REPLACE（再投入しても重複しない）。authorships は主キーが無いため、
  空のテーブルへの投入を前提とする（load_d1.py が投入前に確認する）

出力: {work}/sql/{DB名}/{NN}_{table}_{part}.sql

使い方:
  python3 scripts/ingest/export_sql.py
"""
from __future__ import annotations

import argparse
import math
import os
import shutil

import duckdb

DEFAULT_WORK = os.path.join(os.path.dirname(__file__), "../../data/openalex/work")

# (テーブル, 列, 主キーの有無) 投入順
TABLES = [
    ("papers", ["id", "field", "title", "year", "cit", "fwci", "subfield", "child_cnt", "doi"], True),
    ("edges", ["cited", "citing"], True),
    ("authorships", ["paper_id", "author_name"], False),
    ("keywords", ["id", "name"], True),
    ("paper_keywords", ["paper_id", "keyword_id", "score"], True),
]


def lit(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return "NULL"
        return repr(v)
    s = str(v).replace("\x00", "").replace("'", "''")
    return f"'{s}'"


class Writer:
    def __init__(self, out_dir: str, prefix: str, max_file_bytes: int):
        self.out_dir, self.prefix, self.max = out_dir, prefix, max_file_bytes
        self.part, self.f, self.size, self.files = 0, None, 0, []

    def write(self, stmt: str) -> None:
        data = stmt.encode()
        if self.f is None or self.size + len(data) > self.max:
            self.close()
            path = os.path.join(self.out_dir, f"{self.prefix}_{self.part:04d}.sql")
            self.f, self.size = open(path, "wb"), 0
            self.files.append(path)
            self.part += 1
        self.f.write(data)
        self.size += len(data)

    def close(self) -> None:
        if self.f:
            self.f.close()
            self.f = None


def export_table(con, parquet: str, out_dir: str, idx: int, table: str, cols: list[str], has_pk: bool,
                 max_stmt: int, max_file: int) -> tuple[int, int]:
    head = f"INSERT {'OR REPLACE ' if has_pk else ''}INTO {table} ({', '.join(cols)}) VALUES\n"
    w = Writer(out_dir, f"{idx:02d}_{table}", max_file)
    rows_total = 0
    buf: list[str] = []
    buf_len = len(head)
    cur = con.execute(f"SELECT {', '.join(cols)} FROM read_parquet('{parquet}')")
    while True:
        batch = cur.fetchmany(10_000)
        if not batch:
            break
        for row in batch:
            t = "(" + ", ".join(lit(v) for v in row) + ")"
            if buf and buf_len + len(t) + 2 > max_stmt:
                w.write(head + ",\n".join(buf) + ";\n")
                buf, buf_len = [], len(head)
            buf.append(t)
            buf_len += len(t.encode()) + 2
            rows_total += 1
    if buf:
        w.write(head + ",\n".join(buf) + ";\n")
    w.close()
    return rows_total, len(w.files)


def main() -> None:
    ap = argparse.ArgumentParser(description="build.py の出力を D1 投入用 SQL ファイルにする")
    ap.add_argument("--work", default=DEFAULT_WORK)
    ap.add_argument("--max-stmt-kb", type=int, default=90)
    ap.add_argument("--max-file-mb", type=int, default=100)
    args = ap.parse_args()

    out_root = os.path.join(args.work, "out")
    sql_root = os.path.join(args.work, "sql")
    if os.path.exists(sql_root):
        shutil.rmtree(sql_root)

    con = duckdb.connect()
    for db in sorted(d for d in os.listdir(out_root) if os.path.isdir(os.path.join(out_root, d))):
        d = os.path.join(sql_root, db)
        os.makedirs(d)
        for i, (table, cols, has_pk) in enumerate(TABLES, 1):
            n, nf = export_table(con, os.path.join(out_root, db, f"{table}.parquet"), d, i, table, cols, has_pk,
                                 args.max_stmt_kb * 1024, args.max_file_mb * 1024 * 1024)
            print(f"{db} {table}: {n:,} 行 → {nf} ファイル", flush=True)


if __name__ == "__main__":
    main()

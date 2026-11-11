#!/usr/bin/env python3
"""
初期インポート Step 4（load_d1）: export_sql.py の SQL ファイルを `wrangler d1 execute --file` で
各 D1 に投入し、件数と整合性を検証する（docs/init-ingest.md 3.4・3.6）。

- 投入先の DB 名は {work}/sql/ のフォルダ名（field17_2006_2010 など）。wrangler.jsonc に登録済みであること
- 投入前に対象 DB の各テーブルが空であることを確認する（空でなければ停止。--allow-nonempty で無視）
- 投入後、件数・child_cnt 合計・DB 内の参照整合性を build.py の出力（Parquet）と照合する

使い方:
  python3 scripts/ingest/load_d1.py --local                    # ローカル D1（.wrangler/state）で試す
  python3 scripts/ingest/load_d1.py --remote                   # 本番 D1
  python3 scripts/ingest/load_d1.py --remote --only field17_2006_2010
  python3 scripts/ingest/load_d1.py --remote --verify-only     # 検証だけ
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

import duckdb

DEFAULT_WORK = os.path.join(os.path.dirname(__file__), "../../data/openalex/work")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
TABLES = ["papers", "edges", "authorships", "keywords", "paper_keywords"]


def wrangler(args, db: str, extra: list[str]) -> str:
    cmd = ["wrangler", "d1", "execute", db, "--remote" if args.remote else "--local", "--yes"] + extra
    if args.config:
        cmd += ["--config", args.config]
    # ローカル D1 の保存先（.wrangler/state）は実行ディレクトリ基準のため、設定ファイルのある場所で実行する
    cwd = os.path.dirname(os.path.abspath(args.config)) if args.config else REPO
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"wrangler 失敗: {' '.join(cmd)}\n{r.stdout}\n{r.stderr}")
    return r.stdout


def query(args, db: str, sql: str) -> list[dict]:
    out = wrangler(args, db, ["--json", "--command", sql])
    return json.loads(out)[0]["results"]


def verify(args, db: str, out_dir: str) -> bool:
    con = duckdb.connect()
    p = lambda t: f"read_parquet('{os.path.join(out_dir, t + '.parquet')}')"
    expect = {t: con.execute(f"SELECT count(*) FROM {p(t)}").fetchone()[0] for t in TABLES}
    expect["child_cnt_sum"] = con.execute(f"SELECT coalesce(sum(child_cnt), 0) FROM {p('papers')}").fetchone()[0]
    expect["cit_sum"] = con.execute(f"SELECT coalesce(sum(cit), 0) FROM {p('papers')}").fetchone()[0]

    row = query(args, db, " , ".join([
        "SELECT (SELECT count(*) FROM papers) AS papers",
        "(SELECT count(*) FROM edges) AS edges",
        "(SELECT count(*) FROM authorships) AS authorships",
        "(SELECT count(*) FROM keywords) AS keywords",
        "(SELECT count(*) FROM paper_keywords) AS paper_keywords",
        "(SELECT coalesce(sum(child_cnt), 0) FROM papers) AS child_cnt_sum",
        "(SELECT coalesce(sum(cit), 0) FROM papers) AS cit_sum",
        "(SELECT count(*) FROM edges e WHERE NOT EXISTS (SELECT 1 FROM papers p WHERE p.id = e.citing)) AS edges_citing_missing",
        "(SELECT count(*) FROM authorships a WHERE NOT EXISTS (SELECT 1 FROM papers p WHERE p.id = a.paper_id)) AS authorships_orphan",
        "(SELECT count(*) FROM paper_keywords k WHERE NOT EXISTS (SELECT 1 FROM papers p WHERE p.id = k.paper_id)) AS pk_paper_orphan",
        "(SELECT count(*) FROM paper_keywords k WHERE NOT EXISTS (SELECT 1 FROM keywords w WHERE w.id = k.keyword_id)) AS pk_keyword_orphan",
    ]))[0]
    ok = True
    for k, v in expect.items():
        mark = "OK" if row[k] == v else "NG"
        ok &= row[k] == v
        print(f"  {k}: D1={row[k]:,} 期待={v:,} {mark}")
    for k in ["edges_citing_missing", "authorships_orphan", "pk_paper_orphan", "pk_keyword_orphan"]:
        mark = "OK" if row[k] == 0 else "NG"
        ok &= row[k] == 0
        print(f"  {k}: {row[k]:,} {mark}")
    return ok


def main() -> None:
    ap = argparse.ArgumentParser(description="SQL ファイルを D1 に投入して検証する")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--local", action="store_true")
    g.add_argument("--remote", action="store_true")
    ap.add_argument("--work", default=DEFAULT_WORK)
    ap.add_argument("--config", help="wrangler の設定ファイル（既定はリポジトリの wrangler.jsonc）")
    ap.add_argument("--only", action="append", help="この DB だけ（複数指定可）")
    ap.add_argument("--allow-nonempty", action="store_true")
    ap.add_argument("--verify-only", action="store_true")
    args = ap.parse_args()

    sql_root = os.path.join(args.work, "sql")
    out_root = os.path.join(args.work, "out")
    dbs = sorted(os.listdir(sql_root))
    if args.only:
        dbs = [d for d in dbs if d in args.only]

    all_ok = True
    for db in dbs:
        print(f"== {db}", flush=True)
        if not args.verify_only:
            counts = query(args, db, " , ".join(
                ["SELECT " + ", ".join(f"(SELECT count(*) FROM {t}) AS {t}" for t in TABLES)]))[0]
            if any(counts.values()) and not args.allow_nonempty:
                sys.exit(f"{db} は空ではありません: {counts}（--allow-nonempty で続行）")
            files = sorted(os.listdir(os.path.join(sql_root, db)))
            for i, f in enumerate(files, 1):
                t = time.time()
                wrangler(args, db, ["--file", os.path.join(sql_root, db, f)])
                print(f"  [{i}/{len(files)}] {f} {time.time() - t:.1f}s", flush=True)
        all_ok &= verify(args, db, os.path.join(out_root, db))

    print("検証: すべて OK" if all_ok else "検証: NG あり")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
初期インポート Step 4（load_d1）: export_sql.py の SQL ファイルを `wrangler d1 execute --file` で
各 D1 に投入し、件数と整合性を検証する（docs/init-ingest.md 3.4・3.6）。

- 投入先の DB 名は {work}/sql/ のフォルダ名（field17_2006_2010 など）。wrangler.jsonc に登録済みであること
- 投入前に対象 DB の各テーブルが空であることを確認する（空でなければ停止。--allow-nonempty で無視）
- 投入後、件数・child_cnt 合計・DB 内の参照整合性を build.py の出力（Parquet）と照合する
- 再開可能: 完了したファイルを {work}/load_progress/{remote|local}_{DB名}.json に記録し、再実行時はスキップする。
  進捗ファイルがある DB は空チェックをしない（--reset-progress で記録を消して最初から）
- ファイル単位で再試行する（--retries）。主キーの無い authorships は投入前の max(rowid) を記録し、
  再試行・再開の前にそれより後の行を消してから入れ直す（途中まで書かれた分の重複を防ぐ）。
  他のテーブルは INSERT OR REPLACE なので、そのまま入れ直してよい
- DB ごとに別プロセスで並列に動かしてよい（scripts/ingest/run_load.sh）

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


class WranglerError(RuntimeError):
    pass


def wrangler_retry(args, db: str, extra: list[str], before_retry=None) -> str:
    for attempt in range(1, args.retries + 1):
        try:
            return wrangler_raw(args, db, extra)
        except WranglerError as e:
            if attempt == args.retries:
                sys.exit(str(e))
            wait = min(300, 30 * attempt)
            print(f"    失敗（{attempt}/{args.retries}）、{wait}s 後に再試行: {str(e)[-500:]}", flush=True)
            time.sleep(wait)
            if before_retry:
                before_retry()
    raise AssertionError


def wrangler_raw(args, db: str, extra: list[str]) -> str:
    cmd = ["wrangler", "d1", "execute", db, "--remote" if args.remote else "--local", "--yes"] + extra
    if args.config:
        cmd += ["--config", args.config]
    # ローカル D1 の保存先（.wrangler/state）は実行ディレクトリ基準のため、設定ファイルのある場所で実行する
    cwd = os.path.dirname(os.path.abspath(args.config)) if args.config else REPO
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise WranglerError(f"wrangler 失敗: {' '.join(cmd)}\n{r.stdout}\n{r.stderr}")
    return r.stdout


def query(args, db: str, sql: str) -> list[dict]:
    out = wrangler_retry(args, db, ["--json", "--command", sql])
    return json.loads(out)[0]["results"]


def load_db(args, db: str, sql_root: str) -> None:
    prog_dir = os.path.join(args.work, "load_progress")
    os.makedirs(prog_dir, exist_ok=True)
    prog_path = os.path.join(prog_dir, f"{'remote' if args.remote else 'local'}_{db}.json")
    if args.reset_progress and os.path.exists(prog_path):
        os.remove(prog_path)
    prog = json.load(open(prog_path)) if os.path.exists(prog_path) else {"done": [], "inflight": None}

    def save() -> None:
        tmp = prog_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(prog, f, indent=1)
        os.replace(tmp, prog_path)

    if not prog["done"] and not prog["inflight"]:
        counts = query(args, db, " , ".join(
            ["SELECT " + ", ".join(f"(SELECT count(*) FROM {t}) AS {t}" for t in TABLES)]))[0]
        if any(counts.values()) and not args.allow_nonempty:
            sys.exit(f"{db} は空ではありません: {counts}（--allow-nonempty で続行）")
    else:
        print(f"  再開: 完了済み {len(prog['done'])} ファイル", flush=True)

    files = sorted(os.listdir(os.path.join(sql_root, db)))
    t_db = time.time()
    for i, f in enumerate(files, 1):
        if f in prog["done"]:
            continue
        rollback = None
        if "_authorships_" in f:
            inf = prog["inflight"]
            if inf and inf["file"] == f:
                base = inf["max_rowid"]
            else:
                base = query(args, db, "SELECT coalesce(max(rowid), 0) AS m FROM authorships")[0]["m"]
                prog["inflight"] = {"file": f, "max_rowid": base}
                save()

            def rollback(base=base) -> None:
                query(args, db, f"DELETE FROM authorships WHERE rowid > {base}")

            rollback()  # 前回途中で止まった分があれば消す（無ければ 0 行）
        t = time.time()
        wrangler_retry(args, db, ["--file", os.path.join(sql_root, db, f)], before_retry=rollback)
        prog["done"].append(f)
        prog["inflight"] = None
        save()
        print(f"  [{i}/{len(files)}] {f} {time.time() - t:.1f}s（累計 {(time.time() - t_db) / 60:.1f} 分）", flush=True)


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
    ap.add_argument("--retries", type=int, default=4, help="wrangler 1 回あたりの試行回数")
    ap.add_argument("--reset-progress", action="store_true", help="進捗記録を消して最初から投入する")
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
            load_db(args, db, sql_root)
        all_ok &= verify(args, db, os.path.join(out_root, db))

    print("検証: すべて OK" if all_ok else "検証: NG あり")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
出版年の誤りを修正する（docs/init-ingest.md の初期インポート完了後、2026-11-11 発覚）。

背景: OpenAlex の S3 スナップショット（2026-10-14 時点）では、一部の著名論文（"Attention Is All
You Need" 等）の publication_year が誤った値になっていた（OpenAlex 側のデータ品質問題。現在の
OpenAlex API では既に修正されている）。本スクリプトは、誤った年のせいで本来と違う年代 DB に
入ってしまった論文を検出し、OpenAlex API の最新値で正しい年代 DB へ完全に移動する（papers・
edges(citing 側)・authorships・paper_keywords・keywords を移す）。

全件（1,144万件）を OpenAlex API で再検証するのは現実的でないため、各 DB で被引用数が高い論文
（既定 --min-cit 1000、全 DB 合計で約5,000件）だけを対象にする。出版年の誤りは、被引用数が
突出して多い著名な古典論文に偏って起きていた（Deep Residual Learning、GAN、Batch Normalization、
Bitcoin 論文など実測で確認済み）という前提に基づく絞り込み。

処理の流れ:
  1. 各 DB から cit >= min_cit の papers (id, year, cit) を取得
  2. OpenAlex API に 50 件ずつバッチ問い合わせ（filter=openalex_id:W1|W2|...）し、
     publication_year + publication_date から正しい year（年+月/12）を計算
  3. 正しい年代バケットが現在の DB と異なるものだけを「移動対象」とする
  4. 移動対象ごとに、移動元 DB から papers 1行・edges(citing=id)・authorships(paper_id=id)・
     paper_keywords(paper_id=id)・参照される keywords を SELECT し、移動先 DB へ INSERT OR REPLACE、
     移動元 DB から DELETE する（1件ずつトランザクション的に、失敗したら途中で止めて再実行可能にする）

使い方:
  python3 scripts/ingest/fix_misyeared_papers.py --remote --dry-run        # 検出のみ、変更しない
  python3 scripts/ingest/fix_misyeared_papers.py --remote                  # 検出して実際に移動する
  python3 scripts/ingest/fix_misyeared_papers.py --remote --min-cit 500    # 閾値を変える
  python3 scripts/ingest/fix_misyeared_papers.py --remote --only field17_2021_2025
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time

import requests

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
FIELD = 17
BUCKET_ANCHOR = 2011
BUCKET_YEARS = 5
DB_NAMES = [
    "field17_2006_2010",
    "field17_2011_2015",
    "field17_2016_2020",
    "field17_2021_2025",
    "field17_2026_2030",
]
OPENALEX_BATCH_SIZE = 50
PROGRESS_PATH = os.path.join(REPO, "data/openalex/work/fix_misyeared_progress.json")


class WranglerError(RuntimeError):
    pass


def wrangler_exec_chunked(db: str, statements: list[str], remote: bool) -> None:
    """D1 の1リクエストあたりの SQL 文長上限を避けるため、statements を適度なサイズに分割して投げる
    （著名論文は edges/authorships が数百〜数千件になることがあるため、2026-11-11 安全策として追加）。"""
    MAX_CHARS = 80_000  # D1 の上限（約100KB）より十分小さいマージン
    chunk: list[str] = []
    chunk_len = 0
    for stmt in statements:
        if chunk and chunk_len + len(stmt) > MAX_CHARS:
            wrangler_query(db, " ".join(chunk), remote)
            chunk, chunk_len = [], 0
        chunk.append(stmt)
        chunk_len += len(stmt)
    if chunk:
        wrangler_query(db, " ".join(chunk), remote)


def wrangler_query(db: str, sql: str, remote: bool, retries: int = 3) -> list[dict]:
    cmd = ["wrangler", "d1", "execute", db, "--remote" if remote else "--local", "--yes", "--json", "--command", sql]
    for attempt in range(1, retries + 1):
        r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)
        if r.returncode == 0:
            return json.loads(r.stdout)[0]["results"]
        if attempt == retries:
            raise WranglerError(f"wrangler 失敗: {' '.join(cmd)}\n{r.stdout}\n{r.stderr}")
        time.sleep(5 * attempt)
    raise AssertionError


def db_for_year(year_int: int) -> str:
    bucket = BUCKET_ANCHOR + BUCKET_YEARS * math.floor((year_int - BUCKET_ANCHOR) / BUCKET_YEARS)
    return f"field{FIELD}_{bucket}_{bucket + BUCKET_YEARS - 1}"


def fetch_openalex_single(paper_id: int, api_key: str | None) -> dict | None:
    """id単体を /works/W{id} で取る。OpenAlex が Work をマージ（重複排除）した場合、
    古い ID へのアクセスは新しい ID のレコードへ自動的にリダイレクトされる（2026-11-11、
    fetch_openalex_batch のバッチ filter クエリではこのマージが解決できず検出漏れになったため追加）。"""
    params = {"api_key": api_key} if api_key else {}
    r = requests.get(f"https://api.openalex.org/works/W{paper_id}", params=params, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def fetch_openalex_batch(ids: list[int], api_key: str | None) -> dict[int, dict]:
    """id一覧を filter=openalex_id:... でまとめて取る（高速、通常ケース用）。
    OpenAlex が Work をマージ済みの ID（レスポンスの id が検索語と一致しない）はここでは解決できず、
    戻り値に含まれない。呼び出し側が fetch_openalex_single でフォールバックする。"""
    filter_val = "openalex_id:" + "|".join(f"W{i}" for i in ids)
    params = {"filter": filter_val, "per-page": str(len(ids))}
    if api_key:
        params["api_key"] = api_key
    r = requests.get("https://api.openalex.org/works", params=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    id_set = set(ids)
    out: dict[int, dict] = {}
    for w in data["results"]:
        wid = int(w["id"].rsplit("/", 1)[-1].lstrip("W"))
        if wid in id_set:
            out[wid] = w
        # wid が検索語のどれとも一致しない場合、マージ済み ID の可能性がある。
        # どの元 ID に対応するか batch レスポンスからは分からないため、呼び出し側のフォールバックに委ねる。
    return out


def compute_year(pub_year: int, pub_date: str | None, paper_id: int) -> float:
    # worker/ingest-workflow.ts の yearWithMonth / scripts/ingest/stage.py と同じ規則。
    if pub_date:
        month = int(pub_date.split("-")[1])
    else:
        month = (paper_id % 12) + 1
    return pub_year + (month - 1) / 12.0


def load_progress() -> dict:
    if os.path.exists(PROGRESS_PATH):
        return json.load(open(PROGRESS_PATH))
    return {"moved": [], "checked": []}


def save_progress(prog: dict) -> None:
    os.makedirs(os.path.dirname(PROGRESS_PATH), exist_ok=True)
    tmp = PROGRESS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(prog, f, indent=1)
    os.replace(tmp, PROGRESS_PATH)


def move_paper(args, from_db: str, to_db: str, paper_id: int, new_year: float, new_cit: int) -> None:
    """1件の論文を from_db → to_db へ、関連テーブルごと移動する。"""
    papers = wrangler_query(from_db, f"SELECT * FROM papers WHERE id = {paper_id}", args.remote)
    if not papers:
        print(f"    skip {paper_id}: {from_db} に papers が見当たらない（既に移動済み？）", flush=True)
        return
    p = papers[0]

    edges = wrangler_query(from_db, f"SELECT cited, citing FROM edges WHERE citing = {paper_id}", args.remote)
    authorships = wrangler_query(from_db, f"SELECT author_name FROM authorships WHERE paper_id = {paper_id}", args.remote)
    paper_keywords = wrangler_query(
        from_db, f"SELECT keyword_id, score FROM paper_keywords WHERE paper_id = {paper_id}", args.remote
    )
    keyword_ids = [pk["keyword_id"] for pk in paper_keywords]
    keywords: list[dict] = []
    if keyword_ids:
        placeholders = ",".join(f"'{k}'" for k in keyword_ids)
        keywords = wrangler_query(from_db, f"SELECT id, name FROM keywords WHERE id IN ({placeholders})", args.remote)

    def esc(s: str) -> str:
        return s.replace("'", "''")

    # --- 移動先 DB へ INSERT ---
    doi_val = "NULL" if p["doi"] is None else f"'{esc(p['doi'])}'"
    fwci_val = "NULL" if p["fwci"] is None else p["fwci"]
    subfield_val = "NULL" if p["subfield"] is None else p["subfield"]
    insert_sql = [
        f"INSERT OR REPLACE INTO papers (id, field, title, year, cit, fwci, subfield, child_cnt, doi) "
        f"VALUES ({p['id']}, {p['field']}, '{esc(p['title'])}', {new_year}, {new_cit}, {fwci_val}, {subfield_val}, {p['child_cnt']}, {doi_val});"
    ]
    for e in edges:
        insert_sql.append(f"INSERT OR REPLACE INTO edges (cited, citing) VALUES ({e['cited']}, {e['citing']});")
    for a in authorships:
        insert_sql.append(f"INSERT INTO authorships (paper_id, author_name) VALUES ({paper_id}, '{esc(a['author_name'])}');")
    for k in keywords:
        insert_sql.append(f"INSERT OR REPLACE INTO keywords (id, name) VALUES ('{esc(k['id'])}', '{esc(k['name'])}');")
    for pk in paper_keywords:
        score_val = "NULL" if pk["score"] is None else pk["score"]
        insert_sql.append(
            f"INSERT OR REPLACE INTO paper_keywords (paper_id, keyword_id, score) VALUES ({paper_id}, '{esc(pk['keyword_id'])}', {score_val});"
        )
    wrangler_exec_chunked(to_db, insert_sql, args.remote)

    # --- 移動元 DB から DELETE（INSERT が成功した後に行う） ---
    delete_sql = [
        f"DELETE FROM papers WHERE id = {paper_id};",
        f"DELETE FROM edges WHERE citing = {paper_id};",
        f"DELETE FROM authorships WHERE paper_id = {paper_id};",
        f"DELETE FROM paper_keywords WHERE paper_id = {paper_id};",
    ]
    wrangler_exec_chunked(from_db, delete_sql, args.remote)

    print(
        f"    moved {paper_id} ({p['title'][:50]!r}): {from_db} -> {to_db}  "
        f"year {p['year']:.2f} -> {new_year:.2f}  cit {p['cit']} -> {new_cit}  "
        f"edges={len(edges)} authorships={len(authorships)} keywords={len(paper_keywords)}",
        flush=True,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--remote", action="store_true", help="本番 D1 に対して実行する（省略時はローカル D1）")
    ap.add_argument("--min-cit", type=int, default=1000, help="検証対象とする被引用数の下限（既定 1000）")
    ap.add_argument("--only", help="対象 DB を1つに絞る（例: field17_2021_2025）")
    ap.add_argument("--dry-run", action="store_true", help="検出のみ行い、実際の移動は行わない")
    ap.add_argument("--reset-progress", action="store_true", help="進捗記録を消して最初からやり直す")
    args = ap.parse_args()

    api_key = os.environ.get("OPENALEX_API_KEY") or None
    prog = {"moved": [], "checked": []} if args.reset_progress else load_progress()
    checked = set(prog["checked"])

    dbs = [args.only] if args.only else DB_NAMES

    candidates: list[tuple[str, dict]] = []
    for db in dbs:
        print(f"=== {db}: cit >= {args.min_cit} の論文を取得 ===", flush=True)
        rows = wrangler_query(db, f"SELECT id, year, cit FROM papers WHERE cit >= {args.min_cit}", args.remote)
        print(f"  {len(rows)} 件", flush=True)
        for r in rows:
            if r["id"] not in checked:
                candidates.append((db, r))

    print(f"\n合計検証対象: {len(candidates)} 件（チェック済みを除く）\n", flush=True)

    moved_count = 0
    for i in range(0, len(candidates), OPENALEX_BATCH_SIZE):
        batch = candidates[i : i + OPENALEX_BATCH_SIZE]
        ids = [c[1]["id"] for c in batch]
        try:
            fetched = fetch_openalex_batch(ids, api_key)
        except requests.RequestException as e:
            print(f"  OpenAlex API 失敗（{i}件目〜）、10秒後に再試行: {e}", flush=True)
            time.sleep(10)
            fetched = fetch_openalex_batch(ids, api_key)

        for db, row in batch:
            paper_id = row["id"]
            w = fetched.get(paper_id)
            if w is None:
                # バッチ filter で見つからない場合、OpenAlex が Work をマージ（重複排除）して
                # id が変わっている可能性があるため、個別取得でリダイレクトを解決してから再確認する。
                try:
                    w = fetch_openalex_single(paper_id, api_key)
                except requests.RequestException:
                    w = None
            if w is None:
                print(f"  {paper_id}: OpenAlex 側に見つからず（削除/非公開の可能性）、スキップ", flush=True)
                prog["checked"].append(paper_id)
                continue

            new_year = compute_year(w["publication_year"], w.get("publication_date"), paper_id)
            new_cit = w["cited_by_count"]
            correct_db = db_for_year(w["publication_year"])

            if correct_db != db:
                print(
                    f"  [MISMATCH] {paper_id} {w['title'][:60]!r}: "
                    f"{db}(year={row['year']:.2f}) -> {correct_db}(year={new_year:.2f})",
                    flush=True,
                )
                if not args.dry_run and correct_db in DB_NAMES:
                    move_paper(args, db, correct_db, paper_id, new_year, new_cit)
                    moved_count += 1
                    prog["moved"].append(paper_id)

            prog["checked"].append(paper_id)

        save_progress(prog)
        time.sleep(0.5)  # OpenAlex への配慮（秒間 2 リクエスト程度に収める）

    print(f"\n完了: 検証 {len(candidates)} 件、移動 {moved_count} 件", flush=True)


if __name__ == "__main__":
    main()

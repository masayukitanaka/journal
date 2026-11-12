#!/usr/bin/env bash
# 初期インポート Step 4: 全 DB を本番 D1 へ並列投入して検証する（DB ごとに load_d1.py を別プロセスで起動）。
# D1 は DB ごとに独立して書き込みが直列化されるため、DB 単位の並列化は効く（同じ DB への並列は効かない）。
# load_d1.py は再開可能なので、途中で止まっても同じコマンドを再実行すれば続きから入る。
#
# Claude Code や SSH のセッションが切れても止まらないよう、切り離して起動すること:
#   source ~/.bashrc   # CLOUDFLARE_API_TOKEN
#   setsid nohup scripts/ingest/run_load.sh > /dev/null 2>&1 < /dev/null &
#
# ログ:   data/openalex/work/load_{DB名}.log
# 状態:   data/openalex/work/load.status（RUNNING / DONE / FAILED <DB名...>）
set -u
cd "$(dirname "$0")/../.."
WORK=data/openalex/work
STATUS=$WORK/load.status
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "CLOUDFLARE_API_TOKEN が未設定（source ~/.bashrc）" > "$STATUS"; exit 1; }

echo "RUNNING" > "$STATUS"
declare -A pids
for db in $(ls "$WORK/sql"); do
  echo "[$(date '+%F %T')] 開始" >> "$WORK/load_$db.log"
  python3 scripts/ingest/load_d1.py --remote --only "$db" "$@" >> "$WORK/load_$db.log" 2>&1 &
  pids[$db]=$!
done

failed=()
for db in "${!pids[@]}"; do
  if wait "${pids[$db]}"; then
    echo "[$(date '+%F %T')] 終了: OK" >> "$WORK/load_$db.log"
  else
    echo "[$(date '+%F %T')] 終了: 失敗" >> "$WORK/load_$db.log"
    failed+=("$db")
  fi
done

if [ ${#failed[@]} -eq 0 ]; then echo "DONE" > "$STATUS"; else echo "FAILED ${failed[*]}" > "$STATUS"; fi

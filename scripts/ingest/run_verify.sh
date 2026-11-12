#!/usr/bin/env bash
# 本番 D1 の検証だけを DB ごとに並列で実行する（load_d1.py --verify-only）。
# 投入中の DB は、その load_d1.py プロセスが終わるのを待ってから検証する。
# 全ファイルが投入済み（load_progress に記録）でない DB は検証せず「未完了」とする。
#
#   source ~/.bashrc
#   setsid nohup scripts/ingest/run_verify.sh > /dev/null 2>&1 < /dev/null &
#
# ログ: data/openalex/work/verify_{DB名}.log   状態: data/openalex/work/verify.status
set -u
cd "$(dirname "$0")/../.."
WORK=data/openalex/work
STATUS=$WORK/verify.status
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "CLOUDFLARE_API_TOKEN が未設定" > "$STATUS"; exit 1; }
echo "RUNNING" > "$STATUS"

verify_db() {
  local db=$1 log=$WORK/verify_$1.log
  while pgrep -f "load_d1.py --remote --only $db\$" > /dev/null; do sleep 60; done
  local n_files n_done
  n_files=$(ls "$WORK/sql/$db" | wc -l)
  n_done=$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['done']))" \
           "$WORK/load_progress/remote_$db.json" 2>/dev/null || echo 0)
  if [ "$n_done" != "$n_files" ]; then
    echo "[$(date '+%F %T')] 投入未完了（$n_done/$n_files）のため検証しない" >> "$log"
    return 2
  fi
  echo "[$(date '+%F %T')] 検証開始" >> "$log"
  python3 scripts/ingest/load_d1.py --remote --only "$db" --verify-only >> "$log" 2>&1
}

declare -A pids
for db in $(ls "$WORK/sql"); do
  verify_db "$db" &
  pids[$db]=$!
done
res=()
for db in $(ls "$WORK/sql"); do
  wait "${pids[$db]}"
  case $? in 0) res+=("$db:OK");; 2) res+=("$db:未完了");; *) res+=("$db:NG");; esac
done
echo "DONE ${res[*]}" > "$STATUS"

#!/usr/bin/env bash
# 初期インポートのローカル部分（stage → build → export_sql）を通しで実行する。
# 本番 D1 への投入（load_d1.py）は含めない（確認のうえ手動で行う）。
#
# Claude Code や SSH のセッションが切れても止まらないよう、切り離して起動すること:
#   setsid nohup scripts/ingest/run_local.sh > /dev/null 2>&1 < /dev/null &
#
# ログ:   data/openalex/work/pipeline.log（各ステップの出力）
#         data/openalex/work/pipeline_mem.log（30 秒ごとのメモリ・ディスク使用量）
# 状態:   data/openalex/work/pipeline.status（RUNNING <step> / DONE / FAILED <step>）
set -u
cd "$(dirname "$0")/../.."
WORK=data/openalex/work
LOG=$WORK/pipeline.log
STATUS=$WORK/pipeline.status
mkdir -p "$WORK"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

(while true; do
   echo "$(date '+%F %T') mem_used=$(free -m | awk '/Mem/{print $3}')MB disk_work=$(du -sm "$WORK" 2>/dev/null | cut -f1)MB" >> "$WORK/pipeline_mem.log"
   sleep 30
 done) &
MON=$!
trap 'kill $MON 2>/dev/null' EXIT

run() {
  local name=$1; shift
  echo "RUNNING $name" > "$STATUS"
  log "=== $name 開始: $*"
  local t0=$SECONDS
  "$@" >> "$LOG" 2>&1
  local rc=$?
  log "=== $name 終了: exit=$rc $(( (SECONDS - t0) / 60 )) 分"
  return $rc
}

# stage は失敗ファイルがあると exit 1（再実行で失敗分だけ処理）なので数回まで再試行する
ok=0
for i in 1 2 3; do
  if run "stage (試行 $i)" python3 scripts/ingest/stage.py; then ok=1; break; fi
  sleep 60
done
[ $ok = 1 ] || { echo "FAILED stage" > "$STATUS"; exit 1; }

run build python3 scripts/ingest/build.py || { echo "FAILED build" > "$STATUS"; exit 1; }
run export_sql python3 scripts/ingest/export_sql.py || { echo "FAILED export_sql" > "$STATUS"; exit 1; }

echo "DONE" > "$STATUS"
log "=== 全ステップ完了（D1 投入は未実施）"

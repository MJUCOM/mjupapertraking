#!/usr/bin/env bash
# 사이트 서버가 떠 있지 않으면 띄운다 (127.0.0.1 전용 — 외부에서는 SSH 터널로 접속).
# cron에서 @reboot 및 5분마다 실행.
cd "$(dirname "$0")/.."
port="${1:-8000}"
if curl -s -o /dev/null -m 5 "http://127.0.0.1:${port}/"; then
  exit 0
fi
mkdir -p logs
echo "$(date '+%F %T') starting server on 127.0.0.1:${port}" >> logs/serve.log
nohup python3 -m http.server "$port" --bind 127.0.0.1 --directory docs >> logs/serve.log 2>&1 &

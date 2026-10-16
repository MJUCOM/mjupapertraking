#!/usr/bin/env bash
# GitHub Actions가 매일 수집한 최신 데이터를 받아와서 로컬에서 사이트를 띄운다.
#   ./serve.sh          # http://localhost:8000
#   ./serve.sh 9000     # 포트 지정
set -euo pipefail
cd "$(dirname "$0")"
git pull --ff-only --quiet || echo "git pull 실패 — 기존 데이터로 실행합니다" >&2
port="${1:-8000}"
echo "Paper Tracker: http://localhost:${port}"
exec python3 -m http.server "$port" --bind 127.0.0.1 --directory docs

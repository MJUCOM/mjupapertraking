#!/usr/bin/env bash
# 매일 cron으로 실행: 최신 코드를 받아 논문을 수집하고, 바뀐 데이터를 GitHub에 push한다.
# (usenix.org가 GitHub Actions IP를 403으로 막아서 수집은 이 서버에서 한다.)
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
exec >>"logs/update-$(date +%Y-%m).log" 2>&1
echo "=== $(date '+%F %T') ==="

git pull --ff-only --quiet || { echo "git pull 실패"; exit 1; }
SITE_URL="https://mjucom.github.io/mjupapertraking/" python3 tracker/update.py || { echo "update.py 실패"; exit 1; }

git add docs/
if git diff --cached --quiet; then
  echo "No changes"
else
  git -c user.name="paper-tracker" -c user.email="paper-tracker@localhost" \
    commit -q -m "data: update papers $(date +%F)"
  git push -q && echo "pushed"
fi

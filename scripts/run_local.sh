#!/usr/bin/env bash
# Збір оголошень на вашому комп'ютері й відправка даних у гілку data на GitHub.
# Запуск щогодини (Linux/macOS): crontab -e →  5 * * * * /шлях/до/olx-tovary/scripts/run_local.sh >> /tmp/olx.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
git pull -q --ff-only || true
WORK=".data-work"
rm -rf "$WORK"; mkdir -p "$WORK"
if git ls-remote --exit-code --heads origin data >/dev/null 2>&1; then
  git fetch -q --depth 1 origin data
  git --work-tree="$WORK" checkout FETCH_HEAD -- . && git reset -q
fi
python3 scraper/olx_scraper.py --config config.json --data "$WORK"
cd "$WORK"
git init -q && git checkout -q -b data && git add -A
git -c user.name="olx-bot" -c user.email="olx-bot@localhost" commit -qm "Дані $(date -u +%F_%H:%M)"
git push -qf "$(git -C .. remote get-url origin)" data
cd .. && rm -rf "$WORK"
echo "Готово: $(date)"

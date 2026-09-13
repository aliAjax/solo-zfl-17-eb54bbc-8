#!/usr/bin/env bash
# 用真实 Chrome 在中文时区与 UTC 下各跑一遍端到端验证。
# 依赖：node_modules/playwright 与可用的 Chromium（可用 CHROME_PATH / EXTRA_LD 覆盖）。
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8923
export CHROME_PATH="${CHROME_PATH:-/tmp/chromium-arm64/chrome-linux/chrome}"
[ -n "${EXTRA_LD:-}" ] && export LD_LIBRARY_PATH="${EXTRA_LD}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

python3 -m http.server "$PORT" >/tmp/digitdesk-e2e.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
sleep 1

BASE="http://127.0.0.1:$PORT"
echo "########## Asia/Shanghai ##########"
TZ=Asia/Shanghai node test/browser-e2e.js "$BASE"
echo
echo "########## UTC ##########"
TZ=UTC node test/browser-e2e.js "$BASE"
echo
echo "两个时区的真实 Chrome 端到端验证全部通过。"

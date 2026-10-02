#!/usr/bin/env bash
# ==========================================================================
# 语文课堂提问系统 · 一键测试
#   bash tests/run.sh          # 逻辑层 + 浏览器端（有 Chrome 时自动跑）
#   bash tests/run.sh logic    # 只跑逻辑层
# 逻辑层直接加载 assets/js 里的生产代码，浏览器端用无头 Chrome 真实走一遍流程。
# ==========================================================================
set -u
cd "$(dirname "$0")/.." || exit 1

MODE="${1:-all}"

echo "▶ 逻辑层测试（node vm 沙箱加载生产代码）"
node tests/logic.test.js || exit 1

if [ "$MODE" = "logic" ]; then
  exit 0
fi

# ---- 找浏览器 ----
CHROME=""
for c in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "$(command -v google-chrome 2>/dev/null || true)" \
  "$(command -v chromium 2>/dev/null || true)" \
  "$(command -v chromium-browser 2>/dev/null || true)"
do
  if [ -n "$c" ] && [ -x "$c" ]; then CHROME="$c"; break; fi
done

if [ -z "$CHROME" ]; then
  printf '\n⚠ 没找到 Chrome / Chromium，跳过浏览器端测试（逻辑层已通过）\n'
  exit 0
fi

# ---- 起一个本地服务，用无头浏览器跑 tests/browser-smoke.html ----
PORT="${PORT:-8765}"
if command -v lsof >/dev/null 2>&1 && lsof -i ":$PORT" >/dev/null 2>&1; then
  PORT=$((PORT + 1))
fi

python3 -m http.server "$PORT" >/tmp/yw-quiz-test-server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1.2

printf '\n▶ 浏览器端测试（无头 Chrome：名单 → 随机分题 → 记录 → 小结）\n'
OUT="$("$CHROME" --headless=new --disable-gpu --no-sandbox --virtual-time-budget=20000 \
  --dump-dom "http://localhost:$PORT/tests/browser-smoke.html" 2>/dev/null)"

# 只取 <pre id="out"> 里的结果（dump 出来的 script 源码里也有 PASS/FAIL 字样）
RESULT="$(echo "$OUT" | sed -n '/<pre id="out">/,/<\/pre>/p' | sed 's/<[^>]*>//g')"
echo "$RESULT"

if echo "$RESULT" | grep -q "FAIL"; then
  printf '\n✗ 浏览器端测试未通过\n'
  exit 1
fi
if echo "$RESULT" | grep -q "DONE"; then
  printf '\n✓ 全部测试通过\n'
else
  printf '\n✗ 浏览器端测试没有跑完（请确认 python3 与 Chrome 可用）\n'
  exit 1
fi

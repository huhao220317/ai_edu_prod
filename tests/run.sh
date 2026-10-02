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

# 后台运行时关掉定时器节流，否则页面里的 setTimeout 会被浏览器拖慢甚至冻住
CHROME_ARGS="--headless=new --disable-gpu --no-sandbox --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding"

python3 -m http.server "$PORT" >/tmp/yw-quiz-test-server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1.2

# 打开一个页面，把 dump 出来的 HTML 写到文件里。
# 注意：Chrome 有时候 dump 完并不会自己退出，所以后面统一用「等标记 + 主动关闭」的方式。
fetch_page() {
  local url="$1" outfile="$2" profile="$3"
  "$CHROME" $CHROME_ARGS --user-data-dir="$profile" --dump-dom "$url" > "$outfile" 2>/dev/null &
  echo $!
}

# 从 dump 出来的 HTML 里取出 <pre id="out"> 的内容
# 注意：这里不能用 macOS 自带的 BSD sed 做区间匹配——当起止标记落在同一行时
# （比如页面还没跑完，只有 <pre id="out">running…</pre>），它会一直匹配到文件末尾。
report_of() {
  python3 - "$1" <<'PY'
import html, re, sys
try:
    data = open(sys.argv[1], encoding='utf-8', errors='replace').read()
except OSError:
    data = ''
m = re.search(r'<pre id="out">(.*?)</pre>', data, re.S)
print(html.unescape(m.group(1)).strip() if m else '')
PY
}

# 等页面里的测试跑完（<pre id="out"> 中出现 DONE），最多 20 秒
wait_report() {
  local file="$1" i
  for i in $(seq 1 40); do
    report_of "$file" 2>/dev/null | grep -q "DONE" && return 0
    sleep 0.5
  done
  return 1
}

# 等输出文件里出现某个标记（最多 20 秒）
wait_marker() {
  local file="$1" marker="$2" i
  for i in $(seq 1 40); do
    grep -q "$marker" "$file" 2>/dev/null && return 0
    sleep 0.5
  done
  return 1
}

# 用无头 Chrome 跑一个测试页面，把 <pre id="out"> 里的结果打印出来。
# 这里的页面全靠 setTimeout 推进，用 --virtual-time-budget 让无头浏览器
# 把定时器快进完再抓 DOM，一条命令就能拿到完整结果。
run_page() {
  local file="$1" label="$2" tmp result
  printf '\n▶ %s\n' "$label"
  tmp="$(mktemp "${TMPDIR:-/tmp}/yw-page.XXXXXX")"
  "$CHROME" --headless=new --disable-gpu --no-sandbox --virtual-time-budget=25000 \
    --dump-dom "http://localhost:$PORT/tests/$file" > "$tmp" 2>/dev/null
  result="$(report_of "$tmp")"
  echo "$result"
  if echo "$result" | grep -q "FAIL"; then
    printf '\n✗ %s 未通过\n' "$label"
    exit 1
  fi
  if ! echo "$result" | grep -q "DONE"; then
    printf '\n✗ %s 没有跑完（请确认 python3 与 Chrome 可用）\n' "$label"
    exit 1
  fi
}

# 关掉后台运行的浏览器，并确认它真的退出了
# （同一个 --user-data-dir 如果还被占用，下一次启动会挂住不返回）
stop_browser() {
  local pid="${1:-}"
  [ -z "$pid" ] && return 0
  kill "$pid" 2>/dev/null
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null
  sleep 0.5
}

run_page "browser-smoke.html" "浏览器端测试（名单 → 随机分题 → 记录 → 小结）"

# ---- PWA / 离线 ----
# Service Worker 的安装是真实异步过程，无头浏览器的虚拟时钟会抢跑，
# 所以这里用「真实时间跑一遍 → 二次读取结果 → 关掉服务器验证离线」三步。
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/yw-quiz-pwa.XXXXXX")"
printf '\n▶ PWA 检查（manifest / 图标 / Service Worker / 离线缓存）\n'
#   第 1 步：不给 --dump-dom，让浏览器在真实时间里把 Service Worker 装好
"$CHROME" $CHROME_ARGS --user-data-dir="$PROFILE" \
  "http://localhost:$PORT/tests/pwa-check.html" >/dev/null 2>&1 &
CHPID=$!
sleep 8
stop_browser "$CHPID"

#   第 2 步：把第 1 步写进 localStorage 的结果读出来
TMP_REPORT="$(mktemp "${TMPDIR:-/tmp}/yw-pwa.XXXXXX")"
CHPID="$(fetch_page "http://localhost:$PORT/tests/pwa-check.html?read=1" "$TMP_REPORT" "$PROFILE")"
wait_report "$TMP_REPORT" || true
stop_browser "$CHPID"
RESULT="$(report_of "$TMP_REPORT")"
echo "$RESULT"
if echo "$RESULT" | grep -q "FAIL"; then
  printf '\n✗ PWA 检查未通过\n'
  exit 1
fi
if ! echo "$RESULT" | grep -q "DONE"; then
  printf '\n✗ PWA 检查没有跑完\n'
  exit 1
fi

#   第 3 步：关掉服务器，确认离线还能打开
printf '\n▶ 离线检查（把服务器关掉之后再打开网站）\n'
kill "$SRV" 2>/dev/null
wait "$SRV" 2>/dev/null
sleep 1
TMP_OFFLINE="$(mktemp "${TMPDIR:-/tmp}/yw-offline.XXXXXX")"
CHPID="$(fetch_page "http://localhost:$PORT/index.html" "$TMP_OFFLINE" "$PROFILE")"
wait_marker "$TMP_OFFLINE" "观潮" || true
stop_browser "$CHPID"
if grep -q "观潮" "$TMP_OFFLINE"; then
  printf 'PASS  服务器已关闭，首页仍然打得开（界面与题库都来自本机缓存）\n'
else
  printf 'FAIL  服务器关闭后打不开首页，离线缓存没生效\n'
  exit 1
fi

printf '\n✓ 全部测试通过\n'

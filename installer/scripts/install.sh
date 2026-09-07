#!/usr/bin/env sh
#
# BeatCursor 一键安装 —— 放在 beatapi.io 上供客户 curl 执行。
#
#   curl -fsSL https://beatapi.io/install.sh | sh
#
# 这个脚本本身不做任何补丁,只负责把环境凑齐,然后把活交给
# `beatcursor install`。所有安装逻辑只有一份,在 npm 包里。
#
# ⚠️ 刻意用 sh 而不是 bash:macOS 自带的 bash 是 3.2,而不少发行版的
# 容器镜像里根本没有 bash。POSIX sh 到处都在。
#
# ⚠️ 走管道执行时 stdin 是脚本自己,不是终端。所以这里显式调子命令
# `install` 而不是让它进交互菜单 —— 菜单在没有键盘的地方会挂死。

set -eu

BLUE='\033[38;2;18;88;255m'
RED='\033[31m'
YELLOW='\033[33m'
DIM='\033[2m'
RESET='\033[0m'

say()  { printf '%b\n' "$1"; }
die()  { printf '%b\n' "${RED}error${RESET}  $1" >&2; exit 1; }

say ""
say "${BLUE}BeatCursor${RESET} ${DIM}— BeatAPI client for Cursor${RESET}"
say ""

# ── Node ────────────────────────────────────────────────────────────────
# npx 从 npm 5.2 起自带,所以有 node 基本就有 npx;但仍然分开检查,
# 因为部分发行版把 npm 拆成了独立包,只装 nodejs 时 npx 是缺的。
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node 18+ from https://nodejs.org and re-run."
command -v npx  >/dev/null 2>&1 || die "npx not found. Install npm (it ships with Node.js) and re-run."

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "Node 18+ required, found $(node -v 2>/dev/null || echo unknown)."

say "${DIM}node $(node -v)${RESET}"

# ── Cursor 是否在运行 ───────────────────────────────────────────────────
# 安装要改 Cursor.app 里的文件。开着改不会立刻出错,但那些文件已经被
# 载进内存,重启前不生效,而用户会以为装好了。所以先提醒。
if pgrep -x Cursor >/dev/null 2>&1 || pgrep -x cursor >/dev/null 2>&1; then
  say "${YELLOW}warning${RESET}  Cursor is running — quit it, then run this again."
  say "${DIM}         Installing while it runs leaves the patches inactive until restart.${RESET}"
  say ""
fi

# ── 交给 CLI ────────────────────────────────────────────────────────────
# @latest:客户可能几个月前跑过一次,npx 会用缓存里的旧版本。
say "${DIM}running: npx -y beatcursor@latest install${RESET}"
say ""
npx -y beatcursor@latest install

say ""
say "${BLUE}Done.${RESET} Restart Cursor, then sign in from the BeatAPI panel."
say ""

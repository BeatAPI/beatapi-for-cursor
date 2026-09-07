# BeatCursor 一键安装(Windows) —— 放在 beatapi.io 上供客户执行。
#
#   irm https://beatapi.io/install.ps1 | iex
#
# 为什么要单独一份而不是让 Windows 用户跑 install.sh:原生 Windows 上没有 sh。
# Git Bash 和 WSL 里当然能跑,但那是"装过开发环境的人"才有的东西,
# 而这个脚本存在的意义正是给没装过的人用。
#
# 与 install.sh 严格对等:两边都只做环境检查,然后把活交给
# `beatcursor install`。安装逻辑只有一份,在 npm 包里 —— 两个脚本各自
# 实现一遍安装,迟早会变成两种行为。
#
# ⚠️ 目标是 Windows 10 自带的 PowerShell 5.1,不是 PowerShell 7。
# 所以这里不用 `??`、三元运算符、`Write-Host -ForegroundColor` 之外的着色方式 ——
# 5.1 上那些要么报错,要么把转义序列原样打出来。
#
# ⚠️ `irm | iex` 的方式绕过执行策略(内容不落盘,不算脚本文件),
# 所以客户不需要动 Set-ExecutionPolicy。存成 .ps1 再跑才需要。

$ErrorActionPreference = 'Stop'

function Write-Step($text)  { Write-Host $text }
function Write-Dim($text)   { Write-Host $text -ForegroundColor DarkGray }
function Write-Warn($text)  { Write-Host "warning  $text" -ForegroundColor Yellow }
function Die($text) {
    Write-Host "error  $text" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'BeatCursor' -ForegroundColor Blue -NoNewline
Write-Dim ' - BeatAPI client for Cursor'
Write-Host ''

# ---- Node ----------------------------------------------------------------
# npx 从 npm 5.2 起随 npm 分发,但仍然分开检查:有人用 nvm-windows 装了 node
# 却让 npm 落在另一个版本目录里,那时 node 在而 npx 不在。
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die 'Node.js not found. Install Node 18+ from https://nodejs.org and re-run.'
}
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Die 'npx not found. Install npm (it ships with Node.js) and re-run.'
}

$nodeVersion = (node -v)
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 18) {
    Die "Node 18+ required, found $nodeVersion."
}
Write-Dim "node $nodeVersion"

# ---- Cursor 是否在运行 ----------------------------------------------------
# 安装要改 Cursor 安装目录里的文件。开着改不会立刻报错,但那些文件已经
# 载进内存,重启前不生效 —— 而用户会以为装好了。
if (Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue) {
    Write-Warn 'Cursor is running - quit it, then run this again.'
    Write-Dim  '         Installing while it runs leaves the patches inactive until restart.'
    Write-Host ''
}

# ---- 交给 CLI ------------------------------------------------------------
# @latest:客户可能几个月前跑过一次,npx 会直接用缓存里的旧版本。
Write-Dim 'running: npx -y beatcursor@latest install'
Write-Host ''

# 用 cmd /c 调,是为了拿到 npx 真正的退出码:PowerShell 5.1 直接调 .cmd 时
# $LASTEXITCODE 不总是可靠,而这里必须能区分装成功和装失败。
& cmd /c 'npx -y beatcursor@latest install'
if ($LASTEXITCODE -ne 0) {
    Die "Installation failed (exit $LASTEXITCODE)."
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Blue -NoNewline
Write-Host ' Restart Cursor, then sign in from the BeatAPI panel.'
Write-Host ''

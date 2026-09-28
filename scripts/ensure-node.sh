#!/usr/bin/env bash
# ============================================================
#  ensure-node.sh —— 让 macOS / Linux 也具备可用的 Node.js（>= 22.5.0）
#
#  对齐 Windows 侧的 scripts/ensure-node.bat：优先级
#    [1] 仓库内便携版 runtime/node  ->  [2] 系统 Node  ->  [3] 自动下载官方便携包
#
#  用法：由 start.sh **source**（需要把选中的 PATH 带回调用方），也可单独执行。
#
#  为什么整体包在 _en_main 里：被 source 时不能靠 `exit 0` 收尾（那会顺手把调用方
#  start.sh 一起结束掉）；而 `return` 写在辅助函数里又只是退出**那个函数**、退出不了脚本。
#  所以统一由一个主函数承载「提前成功返回 / 致命退出」，脚本最后一行调用它。
#  致命错误才 die(exit 1)：本机既无合格 Node 又拉不到时，明确停下来，
#  也不要像旧版那样提示一句就继续往下跑、启动一个注定起不来的裸进程。
#
#  需要 >= 22.5.0 的原因：审核记录双写直连 node:sqlite（见 src/audit-db.js），
#  低版本会静默退化为纯 JSONL，让人误以为双写在生效。
# ============================================================

NODE_VERSION="${GRS_NODE_VERSION:-22.22.2}"
MIN_NODE="${GRS_MIN_NODE:-22.5.0}"
_EN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
_EN_PORTABLE="$_EN_ROOT/runtime/node"

_en_info(){ echo "[node] $*"; }
_en_die(){
  echo "[node] ERROR: $*" >&2
  echo "[node] GRS 需要 Node.js >= ${MIN_NODE}（node:sqlite 审核记录双写依赖它）。" >&2
  echo "[node] 手动安装：macOS 用 brew install node@22 或 nvm install 22；Linux 用 nvm 或发行版包管理器。" >&2
  exit 1
}

# 取版本号 / 比较必须先定义再调用 —— bash 函数「执行到才存在」，没有 JS 那样的提升。
_ver_ge(){ [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }
_node_ver(){ "$1" -v 2>/dev/null | sed 's/^v//'; }

_en_use(){ export PATH="$(dirname "$1"):$PATH"; _en_info "使用 $2 Node v$3（$1）"; return 0; }

_en_main(){
  # ─── [1] 仓库内便携版（unix: bin/node｜Windows: node.exe）───
  for _cand in "$_EN_PORTABLE/bin/node" "$_EN_PORTABLE/node.exe"; do
    [ -f "$_cand" ] || continue
    _v="$(_node_ver "$_cand")"
    if [ -n "$_v" ] && _ver_ge "$_v" "$MIN_NODE"; then _en_use "$_cand" "仓库便携版" "$_v"; return 0; fi
    _en_info "仓库便携版 Node v${_v:-未知} 低于 $MIN_NODE，继续找或拉新版"
  done

  # ─── [2] 系统 Node ───
  if command -v node >/dev/null 2>&1; then
    _v="$(_node_ver "$(command -v node)")"
    if [ -n "$_v" ] && _ver_ge "$_v" "$MIN_NODE"; then _en_use "$(command -v node)" "系统" "$_v"; return 0; fi
    _en_info "系统 Node v${_v:-未知} 低于 $MIN_NODE，改为自动获取便携版"
  fi

  # Windows 的官方包是 zip + node.exe，本脚本不做那条下载路径 —— 交给配套的 .bat。
  case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*|Windows*)
      _en_die "Windows 请运行 start.bat（它会 call scripts\\ensure-node.bat：便携版 -> 系统 Node -> 自动下载）" ;;
  esac

  # ─── [3] 自动下载官方便携包（macOS / Linux）───
  _dl=""
  if command -v curl >/dev/null 2>&1; then _dl="curl -fL --retry 3 --connect-timeout 20 -o"
  elif command -v wget >/dev/null 2>&1; then _dl="wget -q -O"
  else _en_die "既没有 curl 也没有 wget，无法自动下载 Node；请先手动安装 >= $MIN_NODE"; fi

  _os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$_os" in
    darwin|linux|freebsd|openbsd|netbsd|sunos|dragonfly) : ;;
    *) _en_die "不支持的平台：$_os（请用系统包管理器安装 Node >= $MIN_NODE）" ;;
  esac
  _arch="$(uname -m)"
  case "$_arch" in
    x86_64|amd64) _arch=x64 ;;
    arm64|aarch64) _arch=arm64 ;;
    armv7l|armhf) _arch=armv7l ;;
    *) : ;;   # ppc64le / s390x / riscv64 等沿用 uname 原值（官方 dist 有对应包）
  esac

  _pkg="node-v${NODE_VERSION}-${_os}-${_arch}"
  _url="https://nodejs.org/dist/v${NODE_VERSION}/${_pkg}.tar.gz"
  _tmp="${TMPDIR:-/tmp}/${_pkg}.tar.gz"

  _en_info "本机没有满足要求的 Node，正在下载官方便携包"
  _en_info "  $_url"
  $_dl "$_tmp" "$_url" || _en_die "下载失败：$_url（网络/代理问题？也可手动安装 Node >= $MIN_NODE 后重试）"
  [ -s "$_tmp" ] || _en_die "下载内容为空：$_tmp"

  mkdir -p "$_EN_ROOT/runtime" || _en_die "无法创建目录 $_EN_ROOT/runtime"
  tar -xzf "$_tmp" -C "$_EN_ROOT/runtime" || _en_die "解压失败（需要支持 gzip 的 tar）；或手动安装 Node >= $MIN_NODE"
  rm -f "$_tmp"
  [ -d "$_EN_ROOT/runtime/$_pkg" ] || _en_die "解压后找不到 runtime/$_pkg（包名与该平台不匹配：$_os/$_arch）"

  # 旧便携版改名保留而不是删除 —— 回滚时还能用（本目录由 ensure-node.sh 与 .bat 共同管理）
  if [ -e "$_EN_PORTABLE" ]; then
    _bak="${_EN_PORTABLE}.old-$(date +%Y%m%d%H%M%S)"
    mv "$_EN_PORTABLE" "$_bak" && _en_info "旧便携版已保留为 $(basename "$_bak")"
  fi
  mv "$_EN_ROOT/runtime/$_pkg" "$_EN_PORTABLE" || _en_die "无法移动到 $_EN_PORTABLE"

  _v="$(_node_ver "$_EN_PORTABLE/bin/node")"
  [ -n "$_v" ] && _ver_ge "$_v" "$MIN_NODE" || _en_die "获取到的 Node v${_v:-未知} 仍低于 $MIN_NODE"
  _en_use "$_EN_PORTABLE/bin/node" "便携版(新下载)" "$_v"
  return 0
}

_en_main

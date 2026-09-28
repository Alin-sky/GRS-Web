#!/bin/bash
cd "$(dirname "$0")" || exit 1

# ---- [0] Node 自补齐（对齐 Windows：start.bat 先 call scripts\ensure-node.bat）----
# 必须用 `.`（source）而不是子进程执行：选中的便携版要写回当前 shell 的 PATH，
# 后面两处 `node ...` 才找得到解释器。ensure-node.sh 只在致命情况下 exit 1 ——
# 本机既无 >=22.5 的 Node 又无法自动下载时，宁可停下来给明确原因，
# 也不要像旧版那样提示一句就继续往下跑、启动一个注定起不来的裸进程。
if [ -f scripts/ensure-node.sh ]; then
  . scripts/ensure-node.sh || exit 1
else
  command -v node >/dev/null 2>&1 || { echo "[prep] ERROR: 未找到 node，且缺少 scripts/ensure-node.sh" >&2; exit 1; }
fi

# ---- T08c: bootstrap runtime env (deps / dirs / config seed / prompts+optional checks) ----
# Skip with:  ./start.sh --skip-bootstrap
if [ "$1" != "--skip-bootstrap" ]; then
  echo "[prep] Bootstrapping GRS runtime environment..."
  if ! node scripts/bootstrap.js; then
    # 这里不阻断启动：缺提示词/缺密钥时服务仍可起（对应请求返回结构化 4xx），
    # 逐行原因已由 bootstrap 打印；补齐后重跑即可，或 ./start.sh --skip-bootstrap 直接启动。
    echo "[prep] 环境未完全就绪 —— 上方已逐条给出原因与修复方式（缺 prompts 正文或云端密钥最常见）。"
  fi
fi

echo ""
echo "  GRS-通用审核系统 - 云端版"
echo "  ========================"
echo ""
export MODERATION_MODE=cloud-only
node src/server.js

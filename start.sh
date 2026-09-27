#!/bin/bash
cd "$(dirname "$0")" || exit 1

# ---- T08c: bootstrap runtime env (deps / dirs / config seed / prompts+optional checks) ----
# Skip with:  ./start.sh --skip-bootstrap
if [ "$1" != "--skip-bootstrap" ]; then
  echo "[prep] Bootstrapping GRS runtime environment..."
  if ! node scripts/bootstrap.js; then
    echo "[prep] WARNING: environment not fully ready - startup may fail"
  fi
fi

echo ""
echo "  GRS-通用审核系统 - 云端版"
echo "  ========================"
echo ""
export MODERATION_MODE=cloud-only
node src/server.js

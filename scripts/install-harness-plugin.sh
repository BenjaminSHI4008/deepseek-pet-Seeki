#!/usr/bin/env bash
# 把 dsh-pet-status 插件安装到 dsh web profile，使 `pnpm dsh web` 自动拉起桌宠。
# 用法：bash scripts/install-harness-plugin.sh
set -euo pipefail

# 默认取本脚本所在仓库（scripts/ 的上一级），避免写死 ~/Projects/deepseek-pet。
PET_REPO="${PET_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROFILE_ROOT="${DSH_HOME:-$HOME/.dsh}/profiles"
WEB_DIR="$PROFILE_ROOT/web"
NM_DIR="$PROFILE_ROOT/node_modules"
PLUGIN_DIR="$NM_DIR/dsh-pet-status"

# 1) 复制插件到 profile 共享 node_modules（真实目录，非软链，保证 @deepseek-ai/* 能解析）
mkdir -p "$PLUGIN_DIR/src" "$PLUGIN_DIR/dist"
cp "$PET_REPO/harness-plugin/src/index.ts" "$PLUGIN_DIR/src/index.ts"
cp "$PET_REPO/harness-plugin/package.json" "$PLUGIN_DIR/package.json"
cp "$PET_REPO/harness-plugin/settings.html" "$PLUGIN_DIR/settings.html"
cp "$PET_REPO/harness-plugin/dist/index.js" "$PLUGIN_DIR/dist/index.js"

# 2) 把插件名写进 profile 的依赖清单（resolver manifest）
node - "$WEB_DIR/package.json" <<'NODE'
const fs = require('fs')
const p = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies['dsh-pet-status'] = '*'
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n')
NODE

# 3) 写 cordis.patch.yml：挂载插件 + 自动拉起桌宠
cat > "$WEB_DIR/cordis.patch.yml" <<EOF
- insert:
    - id: pet-status
      name: 'dsh-pet-status'
      config:
        autoStart: true
        petDir: '$PET_REPO'
EOF

echo "✅ 插件已安装。现在运行 pnpm dsh web 会自动加载插件并拉起桌宠。"

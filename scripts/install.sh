#!/usr/bin/env bash
# Seeki 桌宠一键安装（macOS）：
#   1) 把 dsh-pet-status 插件装进 dsh 的 web profile（复用 install-harness-plugin.sh）
#   2) 在桌面生成一个「伪可执行文件」Seeki.app —— 只内置一段启动指令，
#      双击即后台拉起 deepseek-harness 并唤起桌宠，无需 Electron 打包 / 安装器。
# 用法：bash scripts/install.sh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌ 本脚本仅支持 macOS；Windows 请运行 scripts/install.ps1" >&2
  exit 1
fi

PET_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="${DESKTOP_DIR:-$HOME/Desktop}"
if [[ ! -d "$DESKTOP" ]]; then DESKTOP="$HOME"; fi

# ── 0) 前置依赖 ──────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || { echo "❌ 未找到 node，请先安装 Node.js ≥22"; exit 1; }
command -v sips >/dev/null 2>&1 || { echo "⚠️  未找到 sips，跳过图标生成（仍会生成可用的 .app）"; }
command -v iconutil >/dev/null 2>&1 || { echo "⚠️  未找到 iconutil，跳过图标生成（仍会生成可用的 .app）"; }

NODE_BIN="$(command -v node)"

# ── 1) 定位 deepseek-harness 仓库 ─────────────────────────────────────
resolve_harness_dir() {
  [[ -n "${DEEPSEEK_HARNESS_DIR:-}" ]] && { echo "$DEEPSEEK_HARNESS_DIR"; return; }
  local c
  for c in "$PET_REPO/../deepseek-harness" "$HOME/deepseek-harness" "$HOME/Projects/deepseek-harness"; do
    [[ -f "$c/package.json" && -f "$c/apps/cli/src/bin.ts" ]] && { echo "$c"; return; }
  done
  echo ""
}
HARNESS_DIR="$(resolve_harness_dir)"
if [[ -z "$HARNESS_DIR" ]]; then
  read -r -p "请输入 deepseek-harness 仓库路径（含 package.json）：" HARNESS_DIR
fi
HARNESS_DIR="$(cd "$HARNESS_DIR" 2>/dev/null && pwd)" || { echo "❌ harness 路径无效：$HARNESS_DIR"; exit 1; }
[[ -f "$HARNESS_DIR/package.json" ]] || { echo "❌ 未找到 $HARNESS_DIR/package.json"; exit 1; }
[[ -d "$HARNESS_DIR/node_modules" ]] || echo "⚠️  $HARNESS_DIR/node_modules 不存在，请先在 harness 仓库执行 pnpm install"

PORT="${PET_PORT:-3080}"

# ── 2) 安装插件到 web profile ────────────────────────────────────────
PET_REPO="$PET_REPO" bash "$PET_REPO/scripts/install-harness-plugin.sh"

# ── 3) 生成图标（south.png → .icns）──────────────────────────────────
ICON_SRC="$PET_REPO/Deepseek/rotations/south.png"
ICNS="$PET_REPO/assets/Seeki.icns"
mkdir -p "$PET_REPO/assets"
if [[ -f "$ICON_SRC" ]] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  iconset="$(mktemp -d)/Seeki.iconset"
  mkdir -p "$iconset"
  sips -z 16 16     "$ICON_SRC" --out "$iconset/icon_16x16.png"       >/dev/null
  sips -z 32 32     "$ICON_SRC" --out "$iconset/icon_16x16@2x.png"    >/dev/null
  sips -z 32 32     "$ICON_SRC" --out "$iconset/icon_32x32.png"       >/dev/null
  sips -z 64 64     "$ICON_SRC" --out "$iconset/icon_32x32@2x.png"    >/dev/null
  sips -z 128 128   "$ICON_SRC" --out "$iconset/icon_128x128.png"     >/dev/null
  sips -z 256 256   "$ICON_SRC" --out "$iconset/icon_128x128@2x.png"  >/dev/null
  sips -z 256 256   "$ICON_SRC" --out "$iconset/icon_256x256.png"     >/dev/null
  sips -z 512 512   "$ICON_SRC" --out "$iconset/icon_256x256@2x.png"  >/dev/null
  sips -z 512 512   "$ICON_SRC" --out "$iconset/icon_512x512.png"     >/dev/null
  sips -z 1024 1024 "$ICON_SRC" --out "$iconset/icon_512x512@2x.png"  >/dev/null
  iconutil -c icns "$iconset" -o "$ICNS"
  rm -rf "$(dirname "$iconset")"
  echo "✅ 图标已生成：$ICNS"
fi

# ── 4) 生成 Seeki.app（伪可执行文件：Info.plist + 启动脚本 + 图标）──────
# 先在临时目录构建完整 .app，再尝试放桌面：macOS 对 ~/Desktop 有「deny delete」TCC 保护，
# 直接 rm -rf 旧图标会报 Operation not permitted，故把「删除旧图标」做成尽力而为 + 友好提示。
APP_DIR="$DESKTOP/Seeki.app"
TMP_ROOT="$(mktemp -d)"
APP_SRC="$TMP_ROOT/Seeki.app"
mkdir -p "$APP_SRC/Contents/MacOS" "$APP_SRC/Contents/Resources"

cat > "$APP_SRC/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Seeki</string>
  <key>CFBundleDisplayName</key><string>Seeki</string>
  <key>CFBundleIdentifier</key><string>com.deepseek.pet.launcher</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleExecutable</key><string>Seeki</string>
  <key>CFBundleIconFile</key><string>Seeki.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# 启动脚本：占位符随后由 sed 写入真实 node / harness / port 绝对路径
cat > "$APP_SRC/Contents/MacOS/Seeki" <<'LAUNCH'
#!/bin/bash
# Seeki 桌宠启动器（由 install.sh 生成）
set -u
PORT="${PET_PORT:-__PORT__}"
NODE="__NODE__"
HARNESS_DIR="__HARNESS_DIR__"
LOG_DIR="${HOME}/.dsh/logs"
LOG="${LOG_DIR}/pet-harness.log"
CURL="/usr/bin/curl"

is_up() { "$CURL" -sf -o /dev/null "http://127.0.0.1:${PORT}/"; }

# harness 未运行 → 后台拉起（PET_LAUNCHER=1 让插件托管生命周期：桌宠退出即停 harness）
# 同时把 node 所在目录补进 PATH：Finder 双击环境是「最小 PATH」，子进程 `env node` 会找不到 node。
if ! is_up; then
  mkdir -p "${LOG_DIR}"
  NODE_BIN_DIR="$(dirname "${NODE}")"
  ( cd "${HARNESS_DIR}" && PATH="${NODE_BIN_DIR}:${PATH}" PET_LAUNCHER=1 nohup "${NODE}" --import tsx/esm apps/cli/src/bin.ts web --port "${PORT}" >>"${LOG}" 2>&1 & )
  for _ in $(seq 1 60); do is_up && break; sleep 1; done
fi

# 幂等唤起桌宠（已在运行则 no-op）
"$CURL" -sf -X POST "http://127.0.0.1:${PORT}/api/pet.start" >/dev/null 2>&1 || true
LAUNCH

sed -i '' \
  -e "s|__PORT__|${PORT}|" \
  -e "s|__NODE__|${NODE_BIN}|" \
  -e "s|__HARNESS_DIR__|${HARNESS_DIR}|" \
  "$APP_SRC/Contents/MacOS/Seeki"
chmod +x "$APP_SRC/Contents/MacOS/Seeki"

if [[ -f "$ICNS" ]]; then
  cp "$ICNS" "$APP_SRC/Contents/Resources/Seeki.icns"
fi

# 把临时构建的 .app 安装到桌面；桌面受 TCC 保护时删除旧图标会失败 → 提示用户手动删，不中断。
if [[ -e "$APP_DIR" ]]; then
  if rm -rf "$APP_DIR" 2>/dev/null; then
    cp -R "$APP_SRC" "$APP_DIR"
    ICON_STATE="updated"
  else
    ICON_STATE="kept"
  fi
else
  cp -R "$APP_SRC" "$APP_DIR"
  ICON_STATE="created"
fi
rm -rf "$TMP_ROOT"

echo ""
echo "✅ 安装完成："
echo "   插件：dsh-pet-status → ~/.dsh/profiles/web"
if [[ "$ICON_STATE" == "kept" ]]; then
  echo "   桌面图标：${APP_DIR}（已保留旧图标，仍可正常使用）"
  echo "   ⚠️  macOS 桌面保护禁止自动删除旧图标，如需更新请手动把 ${APP_DIR} 拖入废纸篓后重跑本脚本。"
else
  echo "   桌面图标：${APP_DIR}（双击即后台拉起 harness 并唤起桌宠）"
fi
echo "   harness：${HARNESS_DIR}（端口 ${PORT}）"
echo ""
has_key() {
  [[ -n "${DEEPSEEK_API_KEY:-}" ]] && return 0
  [[ -f "$HARNESS_DIR/.env" ]] && grep -q '^DEEPSEEK_API_KEY=' "$HARNESS_DIR/.env" && return 0
  [[ -f "$HOME/.dsh/.credentials.yaml" ]] && grep -q '^DEEPSEEK_API_KEY:' "$HOME/.dsh/.credentials.yaml" && return 0
  return 1
}
if ! has_key; then
  echo "⚠️  未检测到 DEEPSEEK_API_KEY：桌宠能正常显示，但对话需要模型 key。"
  echo "   请任选其一配置：${HARNESS_DIR}/.env（DEEPSEEK_API_KEY=sk-...）或 ~/.dsh/.credentials.yaml。"
fi

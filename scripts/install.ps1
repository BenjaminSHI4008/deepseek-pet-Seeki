# Seeki 桌宠一键安装（Windows）：
#   1) 把 dsh-pet-status 插件装进 dsh 的 web profile（%USERPROFILE%\.dsh\profiles）
#   2) 生成 start-pet.ps1（内置启动指令）+ 桌面 Seeki.lnk（伪可执行文件的图标）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\install.ps1
$ErrorActionPreference = 'Stop'

$PetRepo = Split-Path -Parent $PSScriptRoot
$ProfileRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$WebDir = Join-Path $ProfileRoot 'profiles\web'
$NmDir = Join-Path $ProfileRoot 'profiles\node_modules'
$PluginDir = Join-Path $NmDir 'dsh-pet-status'
$Desktop = [Environment]::GetFolderPath('Desktop')

# ── 0) 前置依赖 ──────────────────────────────────────────────────────
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw '未找到 node，请先安装 Node.js >= 22' }

# ── 1) 定位 deepseek-harness 仓库 ─────────────────────────────────────
$HarnessDir = $env:DEEPSEEK_HARNESS_DIR
if (-not $HarnessDir) {
  foreach ($c in @(
    (Join-Path (Split-Path -Parent $PetRepo) 'deepseek-harness'),
    (Join-Path $env:USERPROFILE 'deepseek-harness'),
    (Join-Path $env:USERPROFILE 'Projects\deepseek-harness')
  )) {
    if (Test-Path (Join-Path $c 'package.json')) { $HarnessDir = $c; break }
  }
}
if (-not $HarnessDir) {
  $HarnessDir = Read-Host '请输入 deepseek-harness 仓库路径（含 package.json）'
}
if (-not (Test-Path (Join-Path $HarnessDir 'package.json'))) { throw "未找到 harness package.json：$HarnessDir" }
if (-not (Test-Path (Join-Path $HarnessDir 'node_modules'))) { Write-Warning "$HarnessDir\node_modules 不存在，请先在 harness 仓库执行 pnpm install" }

$Port = if ($env:PET_PORT) { $env:PET_PORT } else { '3080' }

# ── 2) 安装插件到 web profile ────────────────────────────────────────
New-Item -ItemType Directory -Force -Path (Join-Path $PluginDir 'src') | Out-Null
Copy-Item (Join-Path $PetRepo 'harness-plugin\src\index.ts') (Join-Path $PluginDir 'src\index.ts') -Force
Copy-Item (Join-Path $PetRepo 'harness-plugin\package.json') (Join-Path $PluginDir 'package.json') -Force
Copy-Item (Join-Path $PetRepo 'harness-plugin\settings.html') (Join-Path $PluginDir 'settings.html') -Force

$webPkgPath = Join-Path $WebDir 'package.json'
$webPkg = Get-Content -Raw $webPkgPath | ConvertFrom-Json
if (-not $webPkg.dependencies) { $webPkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
$webPkg.dependencies | Add-Member -NotePropertyName 'dsh-pet-status' -NotePropertyValue '*' -Force
# 无 BOM 的 UTF-8（避免 Node JSON.parse 撞到 BOM）
[System.IO.File]::WriteAllText($webPkgPath, ($webPkg | ConvertTo-Json -Depth 10))

# 插件挂载补丁（autoStart 由桌宠启动器唤起；petDir 用正斜杠避免 YAML/反斜杠问题）
$petDirYaml = $PetRepo -replace '\\','/'
$patch = @"
- insert:
    - id: pet-status
      name: 'dsh-pet-status'
      config:
        autoStart: true
        petDir: '$petDirYaml'
"@
[System.IO.File]::WriteAllText((Join-Path $WebDir 'cordis.patch.yml'), $patch)

# ── 3) 生成图标（south.png → .ico，PNG 载荷单图 ICO）─────────────────
$IconSrc = Join-Path $PetRepo 'Deepseek\rotations\south.png'
$AssetsDir = Join-Path $PetRepo 'assets'
New-Item -ItemType Directory -Force -Path $AssetsDir | Out-Null
$IcoPath = Join-Path $AssetsDir 'Seeki.ico'

function New-IcoFromPng {
  param([string]$PngPath, [string]$IcoOut)
  $png = [System.IO.File]::ReadAllBytes($PngPath)
  # PNG IHDR 宽高为 16/20 偏移的大端 32 位无符号整数
  $w = ($png[16] -shl 24) + ($png[17] -shl 16) + ($png[18] -shl 8) + $png[19]
  $h = ($png[20] -shl 24) + ($png[21] -shl 16) + ($png[22] -shl 8) + $png[23]
  $len = $png.Length

  $header = New-Object byte[] 6          # ICONDIR
  $header[2] = 1; $header[4] = 1          # type=1(icon), count=1

  $entry = New-Object byte[] 16           # ICONDIRENTRY
  $entry[0] = if ($w -ge 256) { 0 } else { $w }   # 0 表示 256
  $entry[1] = if ($h -ge 256) { 0 } else { $h }
  $entry[4] = 1                           # planes=1（小端）
  $entry[6] = 32                          # bitcount=32（小端）
  [System.BitConverter]::GetBytes([int]$len).CopyTo($entry, 8)   # bytesInRes
  [System.BitConverter]::GetBytes([int]22).CopyTo($entry, 12)    # imageOffset

  $out = New-Object byte[] (22 + $len)
  $header.CopyTo($out, 0); $entry.CopyTo($out, 6); $png.CopyTo($out, 22)
  [System.IO.File]::WriteAllBytes($IcoOut, $out)
}
if (Test-Path $IconSrc) {
  New-IcoFromPng $IconSrc $IcoPath
  Write-Host "图标已生成：$IcoPath"
}

# ── 4) 生成 start-pet.ps1（内置启动指令）──────────────────────────────
$LauncherDir = Join-Path $env:APPDATA 'dsh-pet'
New-Item -ItemType Directory -Force -Path $LauncherDir | Out-Null
$Ps1Path = Join-Path $LauncherDir 'start-pet.ps1'

$launcher = @"
# Seeki 桌宠启动器（由 install.ps1 生成）
`$ErrorActionPreference = 'SilentlyContinue'
`$PORT = if (`$env:PET_PORT) { `$env:PET_PORT } else { '$Port' }
`$NODE = '$($node.Source)'
`$env:PATH = (Split-Path `$NODE -Parent) + ';' + `$env:PATH
`$HARNESS_DIR = '$HarnessDir'
`$LOG_DIR = Join-Path `$env:USERPROFILE '.dsh\logs'
`$LOG = Join-Path `$LOG_DIR 'pet-harness.log'
`$BASE = "http://127.0.0.1:`$PORT"

function Test-Up { try { (Invoke-WebRequest -Uri "`$BASE/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { `$false } }

if (-not (Test-Up)) {
  New-Item -ItemType Directory -Force -Path `$LOG_DIR | Out-Null
  `$env:PET_LAUNCHER = '1'
  Start-Process -FilePath `$NODE `
    -ArgumentList '--import','tsx/esm','apps/cli/src/bin.ts','web','--port',`$PORT `
    -WorkingDirectory `$HARNESS_DIR -WindowStyle Hidden `
    -RedirectStandardOutput `$LOG -RedirectStandardError "`$LOG.err"
  for (`$i = 0; `$i -lt 60; `$i++) { if (Test-Up) { break }; Start-Sleep 1 }
}

# 幂等唤起桌宠（已在运行则 no-op）
try { Invoke-WebRequest -Uri "`$BASE/api/pet.start" -Method POST -UseBasicParsing -TimeoutSec 5 | Out-Null } catch {}
"@
Set-Content -Encoding UTF8 $Ps1Path $launcher

# ── 5) 生成桌面 Seeki.lnk（指向 powershell 隐藏窗口运行 start-pet.ps1）─
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $Desktop 'Seeki.lnk'))
$lnk.TargetPath = 'powershell.exe'
$lnk.Arguments = "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Ps1Path`""
$lnk.WorkingDirectory = $HarnessDir
$lnk.Description = '启动 Seeki 桌宠'
if (Test-Path $IcoPath) { $lnk.IconLocation = "$IcoPath,0" }
$lnk.Save()

Write-Host ''
Write-Host '安装完成：'
Write-Host "  插件：dsh-pet-status → $ProfileRoot\profiles\web"
Write-Host "  桌面图标：$(Join-Path $Desktop 'Seeki.lnk')（双击即后台拉起 harness 并唤起桌宠）"
Write-Host "  启动脚本：$Ps1Path"
Write-Host "  harness：$HarnessDir（端口 $Port）"
Write-Host ''
$hasKey = $false
if ($env:DEEPSEEK_API_KEY) { $hasKey = $true }
if (-not $hasKey -and (Test-Path (Join-Path $HarnessDir '.env'))) {
  $hasKey = (Get-Content (Join-Path $HarnessDir '.env') -Raw) -match '(?m)^DEEPSEEK_API_KEY='
}
if (-not $hasKey -and (Test-Path (Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'))) {
  $hasKey = (Get-Content (Join-Path $env:USERPROFILE '.dsh\.credentials.yaml') -Raw) -match '(?m)^DEEPSEEK_API_KEY:'
}
if (-not $hasKey) {
  Write-Warning '未检测到 DEEPSEEK_API_KEY：桌宠能正常显示，但对话需要模型 key。请任选其一配置：harness/.env（DEEPSEEK_API_KEY=sk-...）或 ~/.dsh/.credentials.yaml。'
}

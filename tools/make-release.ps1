# OpenLAN 发布打包脚本
# 用法:  powershell -ExecutionPolicy Bypass -File tools/make-release.ps1 [-NoNodeModules]
# 默认产出（含 node_modules，解压即用）:  dist\OpenLAN-<版本>.zip  +  .sha256
# 加 -NoNodeModules 时产出纯净源码包（体积更小，用户需自行 npm install）
[CmdletBinding()]
param(
  [switch]$NoNodeModules,
  [string]$Root = ''
)
$ErrorActionPreference = 'Stop'
if (-not $Root) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $Root = Join-Path $scriptDir '..'
}
$Root = [System.IO.Path]::GetFullPath($Root)
Set-Location $Root

$pkg = Get-Content -LiteralPath package.json -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $pkg.version
if (-not $ver) { throw 'package.json 缺少 version' }
$zipName = "OpenLAN-$ver.zip"
$zipDir  = Join-Path $Root 'dist'
$stageBase = Join-Path $Root '.tmp\release-stage'
$stagePkg  = Join-Path $stageBase 'OpenLAN'
New-Item -ItemType Directory -Force -Path $stageBase, $zipDir | Out-Null

Write-Host "OpenLAN v$ver -> $zipName  (NoNodeModules=$NoNodeModules)"

# 1) 复制源码（排除目录/zip）
$excludeDirs = @('.git', '.codebuddy', '.tmp', 'dist', 'logs', 'data', 'node_modules')
if (-not $NoNodeModules) { $excludeDirs = @($excludeDirs | Where-Object { $_ -ne 'node_modules' }) }
if (Get-Command robocopy -ErrorAction SilentlyContinue) {
  $rc = @($Root, $stagePkg, '/E') + @('/XD') + $excludeDirs + @('/XF', '*.zip', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS')
  robocopy @rc | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }
} else {
  Copy-Item -Path (Get-ChildItem $Root -Force | Where-Object {
    $_.Name -notin $excludeDirs -and $_.Extension -ne '.zip'
  }) -Destination $stagePkg -Recurse -Force
}

# 2) 运行期目录只保留 .gitkeep
foreach ($rd in @('shared', 'downloads')) {
  $dir = Join-Path $stagePkg $rd
  if (Test-Path $dir) {
    Get-ChildItem $dir -Force | Where-Object { $_.Name -ne '.gitkeep' } | Remove-Item -Recurse -Force
  }
}

# 3) 打 zip（优先 tar.exe，确保压缩包内顶层目录为 OpenLAN\）
$zip = Join-Path $zipDir $zipName
Remove-Item $zip -Force -ErrorAction SilentlyContinue
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (Test-Path $tar) {
  & $tar -a -c -f $zip -C $stageBase OpenLAN
  if ($LASTEXITCODE -ne 0) { throw 'tar 打包失败' }
} else {
  Compress-Archive -Path (Join-Path $stageBase 'OpenLAN') -DestinationPath $zip -CompressionLevel Optimal
}

# 4) 校验清单：解压临时目录核对顶层结构
$verify = Join-Path $env:TEMP ('openlan-verify-' + [guid]::NewGuid().ToString('N'))
Expand-Archive -Path $zip -DestinationPath $verify -Force
$top = Get-ChildItem $verify | Select-Object -First 1
if (-not (Test-Path (Join-Path $top.FullName 'server\index.js'))) { throw '压缩包结构异常：缺少 server/index.js' }
$nodeModulesOk = (Test-Path (Join-Path $top.FullName 'node_modules\qrcode'))
if (-not $NoNodeModules -and -not $nodeModulesOk) { throw '压缩包缺少 node_modules/qrcode' }
Remove-Item $verify -Recurse -Force

# 5) SHA-256
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Set-Content -Path "$zip.sha256" -Value "$hash  $zipName" -Encoding ascii
$mb = '{0:N2}' -f ((Get-Item $zip).Length / 1MB)
Write-Host "✔ 完成: $zip  ($mb MB)"
Write-Host "  SHA256: $hash"
Write-Host "  校验文件: $zip.sha256"
Remove-Item $stageBase -Recurse -Force

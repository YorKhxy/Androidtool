$ErrorActionPreference = "Stop"

# 打「热更包」：用 electron-builder 产出 NSIS 安装包 + latest.yml + .blockmap，
# 这三类是 electron-updater 自动更新必需的产物，全部落在 dist\ 下，直接用更新服务器对外服务即可。
#
# 与 build-and-package.ps1 的区别：那个是手工拼 portable 包、不产 latest.yml，跟自动更新不兼容；
# 这里走标准 electron-builder NSIS，并复用其更新元数据生成。
#
# 流程：备好内置 adb/scrcpy -> 编译主进程并切到生产入口(index-prod) -> 编译渲染层 -> electron-builder。

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path (Join-Path $ScriptDir "..")

Push-Location $ProjectRoot
try {
    $pkg = Get-Content (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json
    $version = $pkg.version

    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Make Update Package (electron-updater)" -ForegroundColor Cyan
    Write-Host "  Version: $version" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Reminder: bump 'version' in package.json before each release," -ForegroundColor DarkYellow
    Write-Host "  otherwise clients won't see it as an update." -ForegroundColor DarkYellow
    Write-Host ""

    Write-Host "[1/5] Preparing bundled adb..." -ForegroundColor Yellow
    npm run adb:prepare
    if ($LASTEXITCODE -ne 0) { throw "Bundled adb preparation failed" }

    Write-Host "[2/5] Preparing bundled scrcpy..." -ForegroundColor Yellow
    npm run scrcpy:prepare
    if ($LASTEXITCODE -ne 0) { throw "Bundled scrcpy preparation failed" }

    Write-Host "[3/5] Compiling main process (production entry)..." -ForegroundColor Yellow
    npm run build:main
    if ($LASTEXITCODE -ne 0) { throw "Main process compilation failed" }
    # 切换到生产入口：把 index-prod 覆盖到打包入口 index.js（从文件加载渲染层，而非 localhost）。
    Copy-Item -Path "$ProjectRoot\dist\main\main\index-prod.js" -Destination "$ProjectRoot\dist\main\main\index.js" -Force

    Write-Host "[4/5] Compiling renderer process..." -ForegroundColor Yellow
    npm run build:renderer
    if ($LASTEXITCODE -ne 0) { throw "Renderer process compilation failed" }

    Write-Host "[5/5] Packaging NSIS installer + update metadata (electron-builder)..." -ForegroundColor Yellow
    # --publish never：只在本地生成产物（含 latest.yml / .blockmap），不自动上传，由你的更新服务器对外服务。
    npx electron-builder --publish never
    if ($LASTEXITCODE -ne 0) { throw "electron-builder packaging failed" }

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Update package ready (in dist\)" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan
    $artifacts = Get-ChildItem (Join-Path $ProjectRoot "dist") -File |
        Where-Object { $_.Name -match 'Setup .*\.exe$' -or $_.Name -eq 'latest.yml' -or $_.Name -match '\.blockmap$' }
    foreach ($a in $artifacts) {
        Write-Host ("  {0}  ({1:N1} MB)" -f $a.Name, ($a.Length / 1MB)) -ForegroundColor White
    }
    Write-Host ""
    Write-Host "Next: run update-server-start.bat to serve dist\ to your friends' apps." -ForegroundColor Gray
    Write-Host ""
}
catch {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "  Make update package FAILED" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
finally {
    Pop-Location
}

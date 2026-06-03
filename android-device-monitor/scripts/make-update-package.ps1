param(
    # 默认每次打包自动把版本号 patch +1（1.0.0 -> 1.0.1），省得忘了改导致客户端不更新。
    # 已手动改好版本、不想自增时，加 -NoVersionBump。
    [switch]$NoVersionBump
)

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
    $pkgPath = Join-Path $ProjectRoot "package.json"
    $oldVersion = (Get-Content $pkgPath -Raw | ConvertFrom-Json).version

    if ($NoVersionBump) {
        $version = $oldVersion
        Write-Host "Version: $version (auto-bump skipped via -NoVersionBump)" -ForegroundColor Cyan
    }
    else {
        # 自动把 patch 段 +1，不打 git tag、不提交（仅改 package.json / package-lock.json）。
        Write-Host "Bumping version (patch)..." -ForegroundColor Yellow
        npm version patch --no-git-tag-version | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "npm version patch failed" }
        $version = (Get-Content $pkgPath -Raw | ConvertFrom-Json).version
        Write-Host "Version: $oldVersion -> $version" -ForegroundColor Green
    }

    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Make Update Package (electron-updater)" -ForegroundColor Cyan
    Write-Host "  Version: $version" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Note: version was auto-bumped; remember to commit package.json" -ForegroundColor DarkYellow
    Write-Host "  (and package-lock.json) after a successful build." -ForegroundColor DarkYellow
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

    # 国内网络：用 npmmirror 镜像加速 electron 运行时（首次 ~108MB）与 electron-builder 二进制下载。
    # 用 if (-not ...) 是为了：你若已自己设了环境变量，则尊重你的设置，不覆盖。
    if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/" }
    if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) { $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/" }
    Write-Host "  Using mirrors: ELECTRON_MIRROR=$env:ELECTRON_MIRROR" -ForegroundColor DarkGray

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

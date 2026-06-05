$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path (Join-Path $ScriptDir "..")
$ReleaseDir = Join-Path $ProjectRoot "src\release"

Push-Location $ProjectRoot

try {
    $timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
    $dateFolder = Get-Date -Format "yyyy-MM"
    $timeStr = Get-Date -Format "HHmmss"
    $dateStr = Get-Date -Format "MMdd"

    $outputDir = Join-Path $ReleaseDir $dateFolder
    if (-not (Test-Path $outputDir)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
        Write-Host "Created directory: $outputDir" -ForegroundColor Green
    }

    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Android Device Monitor - Build & Package" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    Write-Host "[1/5] Preparing bundled adb..." -ForegroundColor Yellow
    npm run adb:prepare
    if ($LASTEXITCODE -ne 0) {
        throw "Bundled adb preparation failed"
    }
    Write-Host "Bundled adb is ready" -ForegroundColor Green

    Write-Host "[1/5] Preparing bundled scrcpy..." -ForegroundColor Yellow
    npm run scrcpy:prepare
    if ($LASTEXITCODE -ne 0) {
        throw "Bundled scrcpy preparation failed"
    }
    Write-Host "Bundled scrcpy is ready" -ForegroundColor Green

    Write-Host "[2/5] Compiling main process..." -ForegroundColor Yellow
    npm run build:main
    if ($LASTEXITCODE -ne 0) {
        throw "Main process compilation failed"
    }
    Copy-Item -Path "$ProjectRoot\dist\main\main\index-prod.js" -Destination "$ProjectRoot\dist\main\main\index.js" -Force
    Write-Host "Main process compiled successfully" -ForegroundColor Green

    Write-Host "[3/5] Compiling renderer process..." -ForegroundColor Yellow
    npm run build:renderer
    if ($LASTEXITCODE -ne 0) {
        throw "Renderer process compilation failed"
    }
    Write-Host "Renderer process compiled successfully" -ForegroundColor Green

    Write-Host "[4/5] Creating portable package..." -ForegroundColor Yellow
    $winUnpackedDir = Join-Path $ProjectRoot "dist\win-unpacked"
    node "$ProjectRoot\scripts\ensure-electron-runtime.js"
    if ($LASTEXITCODE -ne 0) {
        throw "Electron runtime check failed"
    }

    if (Test-Path $winUnpackedDir) {
        Remove-Item -Path $winUnpackedDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Path $winUnpackedDir -Force | Out-Null

    $localElectron = Join-Path $ProjectRoot "node_modules\electron\dist"
    Copy-Item -Path "$localElectron\*" -Destination $winUnpackedDir -Recurse -Force

    $appResources = Join-Path $winUnpackedDir "resources"
    New-Item -ItemType Directory -Path $appResources -Force | Out-Null

    Copy-Item -Path "$ProjectRoot\dist\main" -Destination "$appResources\app" -Recurse -Force
    Copy-Item -Path "$ProjectRoot\dist\renderer" -Destination "$appResources\app\renderer" -Recurse -Force
    Copy-Item -Path "$ProjectRoot\vendor\platform-tools" -Destination "$appResources\platform-tools" -Recurse -Force
    Copy-Item -Path "$ProjectRoot\vendor\scrcpy" -Destination "$appResources\scrcpy" -Recurse -Force

    $pkgJsonPath = "$appResources\app\package.json"
    Copy-Item -Path "$ProjectRoot\package.json" -Destination $pkgJsonPath -Force
    
    (Get-Content $pkgJsonPath -Raw) -replace '"main":\s*"./dist/main/main/index.js"', '"main": "./main/index.js"' | Set-Content $pkgJsonPath -NoNewline

    # 主进程运行时依赖第三方包（adm-zip 做采集 zip 导入导出、electron-updater 做热更）。
    # 这些不会被 tsc 打包进 dist，必须把生产依赖装进 resources/app/node_modules，否则运行时
    # require 直接崩（Cannot find module 'adm-zip'）。--omit=dev 只装 dependencies，
    # 不会重装 devDependencies 里 ~200MB 的 electron；react 等 renderer 依赖虽会被装入但已由
    # webpack 打进 bundle，体积小可接受。
    Write-Host "Installing production dependencies into app..." -ForegroundColor Yellow
    $appDir = Join-Path $appResources "app"
    Push-Location $appDir
    npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock
    $npmExit = $LASTEXITCODE
    Pop-Location
    if ($npmExit -ne 0) {
        throw "Production dependency install failed (exit $npmExit)"
    }
    Write-Host "Production dependencies installed" -ForegroundColor Green

    Write-Host "Created portable package in: $winUnpackedDir" -ForegroundColor Green

    Write-Host "[5/5] Copying to release directory..." -ForegroundColor Yellow
    $exeName = "AndroidDeviceMonitor_${dateStr}_${timeStr}.exe"
    
    $releaseAppDir = Join-Path $outputDir "AndroidDeviceMonitor_${dateStr}_${timeStr}"
    if (Test-Path $releaseAppDir) {
        Remove-Item -Path $releaseAppDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Path $releaseAppDir -Force | Out-Null

    Copy-Item -Path "$winUnpackedDir\electron.exe" -Destination "$releaseAppDir\$exeName" -Force
    Write-Host "Copied exe to: $releaseAppDir\$exeName" -ForegroundColor Green

    Copy-Item -Path "$winUnpackedDir\resources" -Destination "$releaseAppDir\resources" -Recurse -Force
    Write-Host "Copied resources to: $releaseAppDir\resources" -ForegroundColor Green

    $dllFiles = @(
        "chrome_100_percent.pak",
        "chrome_200_percent.pak",
        "d3dcompiler_47.dll",
        "dxcompiler.dll",
        "dxil.dll",
        "ffmpeg.dll",
        "icudtl.dat",
        "libEGL.dll",
        "libGLESv2.dll",
        "resources.pak",
        "v8_context_snapshot.bin",
        "vk_swiftshader.dll",
        "vulkan-1.dll"
    )
    foreach ($dll in $dllFiles) {
        $src = Join-Path $winUnpackedDir $dll
        if (Test-Path $src) {
            Copy-Item -Path $src -Destination $releaseAppDir -Force
        }
    }
    Copy-Item -Path "$winUnpackedDir\locales" -Destination "$releaseAppDir\locales" -Recurse -Force

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Build completed successfully!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Output location: $releaseAppDir" -ForegroundColor White
    Write-Host "Executable: $exeName" -ForegroundColor White
    Write-Host ""
    Write-Host "To run the application:" -ForegroundColor Gray
    Write-Host "  1. Open folder: $releaseAppDir" -ForegroundColor Gray
    Write-Host "  2. Double-click: $exeName" -ForegroundColor Gray
    Write-Host ""

} catch {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "  Build failed!" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}

<#
.SYNOPSIS
    重新编译 hev-socks5-tunnel 的 native tun2socks 内核（libhev-socks5-tunnel.so，arm64-v8a），
    并落地到 app/src/main/jniLibs/arm64-v8a/。

.DESCRIPTION
    本仓库采用「预编译 .so 入库」策略：.so 已提交到版本库，任何机器无需 NDK 即可
    `gradlew assembleDebug` 出带 tun2socks 的 APK。只有需要升级 hev 版本或更换 ABI 时，
    才在装有 NDK 的开发机上跑本脚本重新生成 .so。

    步骤：
      1. 递归 clone heiher/sockstun（自带 hev-socks5-tunnel 子模块与 jni 构建脚本）到临时目录。
      2. 解析 Windows 上被 git 写成纯文本的符号链接（hev 的 include/ 大量用 symlink 指向 ../src）。
      3. 用 NDK 的 ndk-build 以本项目的包名/类名编译，注入 JNI 注册目标。
      4. 把产出的 .so 复制进 jniLibs。

    JNI 注册：hev-jni.c 用 FindClass(PKGNAME "/" CLSNAME) 动态注册 native 方法，
    因此编译期通过 -DPKGNAME / -DCLSNAME 把目标指向 com.androidtool.piconetworkhelper.vpn.HevSocks5Tunnel。

    版本记录见 docs/adr/0003-hev-tun2socks-prebuilt-so.md。

.PARAMETER NdkPath
    NDK 根目录。缺省时从 local.properties 的 sdk.dir 下挑选最新的 ndk/<version>。

.PARAMETER Abi
    目标 ABI，缺省 arm64-v8a。

.EXAMPLE
    pwsh scripts/build-native.ps1
#>
[CmdletBinding()]
param(
    [string]$NdkPath,
    [string]$Abi = 'arm64-v8a'
)

$ErrorActionPreference = 'Stop'

# 所有路径从脚本锚点推导，不硬编码盘符/绝对路径。
$scriptDir = $PSScriptRoot
$projectRoot = Split-Path -Parent $scriptDir          # pico-network-helper/
$jniLibsDir = Join-Path $projectRoot "app\src\main\jniLibs\$Abi"
$localProps = Join-Path $projectRoot 'local.properties'

# JNI 注册目标（必须与 HevSocks5Tunnel.java 的包名/类名一致）。
$pkgName = 'com/androidtool/piconetworkhelper/vpn'
$clsName = 'HevSocks5Tunnel'

function Resolve-NdkPath {
    param([string]$explicit, [string]$localPropsFile)
    if ($explicit) {
        if (-not (Test-Path $explicit)) { throw "指定的 NdkPath 不存在: $explicit" }
        return $explicit
    }
    if ($env:ANDROID_NDK_HOME -and (Test-Path $env:ANDROID_NDK_HOME)) { return $env:ANDROID_NDK_HOME }

    $sdkDir = $null
    if (Test-Path $localPropsFile) {
        $line = Get-Content $localPropsFile | Where-Object { $_ -match '^\s*sdk\.dir=' } | Select-Object -First 1
        if ($line) { $sdkDir = ($line -replace '^\s*sdk\.dir=', '').Trim() -replace '\\\\', '\' }
    }
    if (-not $sdkDir) { $sdkDir = $env:ANDROID_HOME }
    if (-not $sdkDir) { throw '无法定位 Android SDK：请传 -NdkPath 或设置 ANDROID_HOME / local.properties 的 sdk.dir。' }

    $ndkRoot = Join-Path $sdkDir 'ndk'
    if (-not (Test-Path $ndkRoot)) { throw "未发现 NDK 目录: $ndkRoot（请用 sdkmanager 安装 NDK）。" }
    $latest = Get-ChildItem $ndkRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $latest) { throw "NDK 目录为空: $ndkRoot" }
    return $latest.FullName
}

function Repair-GitSymlinks {
    param([string]$repoRoot)
    Push-Location $repoRoot
    try {
        $prefixes = @('.')
        git submodule foreach --recursive --quiet 'echo $displaypath' 2>$null |
            ForEach-Object { if ($_ -and $_ -notmatch '^Entering') { $prefixes += $_.Trim() } }
        $fixed = 0
        foreach ($p in $prefixes) {
            $subAbs = if ($p -eq '.') { $repoRoot } else { Join-Path $repoRoot $p }
            Push-Location $subAbs
            try {
                $links = git ls-files -s 2>$null | Where-Object { $_ -match '^120000' }
                foreach ($l in $links) {
                    $relPath = ($l -split "`t", 2)[1]
                    $linkFile = Join-Path $subAbs $relPath
                    if (-not (Test-Path $linkFile)) { continue }
                    $target = (Get-Content $linkFile -TotalCount 1).Trim()
                    $targetFull = Join-Path (Split-Path $linkFile -Parent) $target
                    if (Test-Path $targetFull) { Copy-Item -Force $targetFull $linkFile; $fixed++ }
                    else { throw "符号链接目标缺失: $relPath -> $target" }
                }
            } finally { Pop-Location }
        }
        Write-Host "已解析 git 符号链接: $fixed 个"
    } finally { Pop-Location }
}

$ndk = Resolve-NdkPath -explicit $NdkPath -localPropsFile $localProps
$ndkBuild = Join-Path $ndk 'ndk-build.cmd'
if (-not (Test-Path $ndkBuild)) { throw "未找到 ndk-build: $ndkBuild" }
Write-Host "使用 NDK: $ndk"

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("hev-build-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force $scratch | Out-Null
try {
    Write-Host '递归 clone sockstun（含 hev 子模块）...'
    Push-Location $scratch
    git clone --recursive --depth 1 https://github.com/heiher/sockstun.git
    if ($LASTEXITCODE -ne 0) { throw 'git clone 失败' }
    Pop-Location

    $repo = Join-Path $scratch 'sockstun'
    Repair-GitSymlinks -repoRoot $repo

    Write-Host "ndk-build 编译 $Abi ..."
    Push-Location $repo
    & $ndkBuild NDK_PROJECT_PATH=. `
        'APP_BUILD_SCRIPT=app/src/main/jni/Android.mk' `
        'NDK_APPLICATION_MK=app/src/main/jni/Application.mk' `
        "APP_ABI=$Abi" `
        "APP_CFLAGS=-O3 -DPKGNAME=$pkgName -DCLSNAME=$clsName" `
        NDK_LIBS_OUT=./libs NDK_OUT=./obj -j4
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { throw "ndk-build 失败（退出码 $code）" }

    $built = Join-Path $repo "libs\$Abi\libhev-socks5-tunnel.so"
    if (-not (Test-Path $built)) { throw "未找到编译产物: $built" }
    New-Item -ItemType Directory -Force $jniLibsDir | Out-Null
    Copy-Item -Force $built (Join-Path $jniLibsDir 'libhev-socks5-tunnel.so')
    Write-Host "已更新: $(Join-Path $jniLibsDir 'libhev-socks5-tunnel.so')"
    Write-Host '完成。请提交更新后的 .so，并在 ADR 记录新的子模块版本。'
} finally {
    if (Test-Path $scratch) { Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue }
}

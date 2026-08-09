#Requires -Version 5.1

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$failures = New-Object 'System.Collections.Generic.List[string]'
$warnings = New-Object 'System.Collections.Generic.List[string]'

function Add-Failure([string]$Message) {
    [void]$failures.Add($Message)
}

function Add-Warning([string]$Message) {
    [void]$warnings.Add($Message)
}

function Get-Tool([string]$Name) {
    return Get-Command $Name -ErrorAction SilentlyContinue
}

function Get-ToolOutput([string]$Name, [string[]]$Arguments) {
    try {
        return (& $Name @Arguments 2>$null | Out-String).Trim()
    } catch {
        return ""
    }
}

Write-Host "Cadilume Windows 开发环境检查"
Write-Host "仓库：$repoRoot"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Add-Failure "此脚本只能在 Windows PowerShell 中运行。macOS/Linux 请使用 pnpm check:windows:cross。"
}

$requiredFiles = @(
    "package.json",
    "pnpm-lock.yaml",
    "src-tauri\Cargo.toml",
    "src-tauri\tauri.windows.conf.json",
    "src-tauri\icons\icon.ico"
)
foreach ($relativePath in $requiredFiles) {
    if (-not (Test-Path (Join-Path $repoRoot $relativePath))) {
        Add-Failure "仓库缺少必要文件：$relativePath"
    }
}

$node = Get-Tool "node"
if (-not $node) {
    Add-Failure "未找到 Node.js。请安装 Node.js 20 或更高版本。"
} else {
    $nodeVersion = Get-ToolOutput "node" @("--version")
    if ($nodeVersion -notmatch "^v(?<major>\d+)") {
        Add-Failure "无法识别 Node.js 版本：$nodeVersion"
    } elseif ([int]$Matches.major -lt 20) {
        Add-Failure "Node.js 版本过低（$nodeVersion），项目要求 20 或更高版本。"
    } else {
        Write-Host "[OK] $nodeVersion"
    }
}

$pnpm = Get-Tool "pnpm"
if (-not $pnpm) {
    Add-Failure "未找到 pnpm。请启用 Corepack，或安装 pnpm 10 或更高版本。"
} else {
    $pnpmVersion = Get-ToolOutput "pnpm" @("--version")
    if ($pnpmVersion -notmatch "^(?<major>\d+)") {
        Add-Failure "无法识别 pnpm 版本：$pnpmVersion"
    } elseif ([int]$Matches.major -lt 10) {
        Add-Failure "pnpm 版本过低（$pnpmVersion），项目要求 10 或更高版本。"
    } else {
        Write-Host "[OK] pnpm $pnpmVersion"
    }
}

$git = Get-Tool "git"
if (-not $git) {
    Add-Failure "未找到 Git。首次获取代码和 verify:windows 的差异检查都需要 Git。"
} else {
    $gitVersion = Get-ToolOutput "git" @("--version")
    if ($gitVersion -notmatch "^git version (?<version>\d+(?:\.\d+)+)") {
        Add-Failure "无法识别 Git 版本：$gitVersion"
    } else {
        Write-Host "[OK] Git $($Matches.version)"
    }
}

$cmake = Get-Tool "cmake"
if (-not $cmake) {
    Add-Failure "未找到 CMake。Rust TLS 依赖需要 CMake；请安装 Visual Studio 的 C++ CMake tools for Windows，或独立 CMake。"
} else {
    $cmakeVersion = Get-ToolOutput "cmake" @("--version")
    if ($cmakeVersion -notmatch "^cmake version (?<version>\d+(?:\.\d+)+)") {
        Add-Failure "无法识别 CMake 版本：$cmakeVersion"
    } else {
        Write-Host "[OK] CMake $($Matches.version)"
    }
}

$rustc = Get-Tool "rustc"
$cargo = Get-Tool "cargo"
$rustup = Get-Tool "rustup"
if (-not $rustc -or -not $cargo -or -not $rustup) {
    Add-Failure "Rust 工具链不完整。请安装 rustup，并选择 stable-msvc。"
} else {
    $rustInfo = Get-ToolOutput "rustc" @("-vV")
    if ($rustInfo -notmatch "host:\s+(x86_64|aarch64)-pc-windows-msvc") {
        Add-Failure "当前 Rust host 不是 MSVC（需要 x86_64-pc-windows-msvc；当前输出：$rustInfo）。"
    } else {
        Write-Host "[OK] Rust MSVC host"
    }
    $installedTargets = Get-ToolOutput "rustup" @("target", "list", "--installed")
    if ($installedTargets -notmatch "x86_64-pc-windows-msvc") {
        Add-Failure "缺少 x86_64-pc-windows-msvc target。运行：rustup target add x86_64-pc-windows-msvc"
    } else {
        Write-Host "[OK] x86_64-pc-windows-msvc target"
    }
    if (-not (Get-Tool "cargo-fmt")) {
        Add-Failure "未找到 rustfmt；cargo fmt --check 将无法运行。运行：rustup component add rustfmt"
    }
}

$vswhereCandidates = @()
if (${env:ProgramFiles(x86)}) {
    $vswhereCandidates += (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe")
}
if ($env:ProgramFiles) {
    $vswhereCandidates += (Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vswhere.exe")
}
$vswhere = $vswhereCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $vswhere) {
    Add-Failure "未找到 Visual Studio Installer 的 vswhere.exe。请安装 Microsoft C++ Build Tools 的“使用 C++ 的桌面开发”工作负载。"
} else {
    $vsInstall = Get-ToolOutput $vswhere @("-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath")
    if (-not $vsInstall) {
        Add-Failure "Visual Studio 未安装 MSVC x64 工具。请在安装器中勾选“使用 C++ 的桌面开发”。"
    } else {
        Write-Host "[OK] MSVC：$vsInstall"
    }
}

$sdkRoots = @()
if (${env:ProgramFiles(x86)}) {
    $sdkRoots += (Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\Include")
}
if ($env:ProgramFiles) {
    $sdkRoots += (Join-Path $env:ProgramFiles "Windows Kits\10\Include")
}
$sdkVersion = $null
foreach ($sdkRoot in $sdkRoots) {
    if (-not (Test-Path $sdkRoot)) { continue }
    $sdkVersion = Get-ChildItem $sdkRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName "um\Windows.h") } |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if ($sdkVersion) { break }
}
if (-not $sdkVersion) {
    Add-Failure "未找到 Windows SDK 的 Windows.h。请通过 C++ 工作负载安装 Windows 10/11 SDK。"
} else {
    Write-Host "[OK] Windows SDK：$($sdkVersion.Name)"
}

$webViewRoots = @()
if (${env:ProgramFiles(x86)}) {
    $webViewRoots += (Join-Path ${env:ProgramFiles(x86)} "Microsoft\EdgeWebView\Application")
}
if ($env:ProgramFiles) {
    $webViewRoots += (Join-Path $env:ProgramFiles "Microsoft\EdgeWebView\Application")
}
if ($env:LocalAppData) {
    $webViewRoots += (Join-Path $env:LocalAppData "Microsoft\EdgeWebView\Application")
}
$webViewExecutable = $null
foreach ($webViewRoot in $webViewRoots) {
    if (-not (Test-Path $webViewRoot)) { continue }
    $webViewExecutable = Get-ChildItem $webViewRoot -Filter "msedgewebview2.exe" -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($webViewExecutable) { break }
}
if (-not $webViewExecutable) {
    Add-Failure "未找到 Microsoft Edge WebView2 Runtime。请安装 Evergreen Runtime；Windows 10 1803+ 通常已预装。"
} else {
    Write-Host "[OK] WebView2：$($webViewExecutable.FullName)"
}

$longPathsKey = "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem"
$longPathsEnabled = (Get-ItemProperty -Path $longPathsKey -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
if ($longPathsEnabled -ne 1) {
    Add-Warning "Windows 长路径支持未明确开启。建议将仓库放在 C:\src\Cadilume，或由管理员开启 LongPathsEnabled=1。"
}

if ($warnings.Count -gt 0) {
    Write-Host ""
    Write-Host "警告：" -ForegroundColor Yellow
    foreach ($warning in $warnings) { Write-Host "  - $warning" -ForegroundColor Yellow }
}

if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "未满足的条件：" -ForegroundColor Red
    foreach ($failure in $failures) { Write-Host "  - $failure" -ForegroundColor Red }
    exit 1
}

Write-Host ""
Write-Host "Windows 开发环境检查通过。可以运行：pnpm tauri dev" -ForegroundColor Green

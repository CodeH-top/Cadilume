#Requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$Bundle,
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Invoke-Step([string]$Label, [scriptblock]$Action) {
    Write-Host ""
    Write-Host "== $Label ==" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Label 失败（退出码 $LASTEXITCODE）"
    }
}

Push-Location $repoRoot
try {
    Invoke-Step "检查 Windows 工具链" { & (Join-Path $PSScriptRoot "check-windows-env.ps1") }

    if (-not $SkipInstall) {
        Invoke-Step "安装锁定的 JavaScript 依赖" { pnpm install --frozen-lockfile }
    }

    Invoke-Step "TypeScript 类型检查" { pnpm check }
    Invoke-Step "前端单元测试" { pnpm test }
    Invoke-Step "前端生产构建" { pnpm build }
    Invoke-Step "Rust 格式检查" { cargo fmt --manifest-path src-tauri/Cargo.toml --check }
    # Native audio tests create real WASAPI streams. Serial execution prevents
    # overlapping teardown callbacks from crashing the Windows test process.
    Invoke-Step "Rust 测试" { cargo test --manifest-path src-tauri/Cargo.toml --locked -- --test-threads=1 }
    Invoke-Step "Rust Windows Release 检查" { cargo check --manifest-path src-tauri/Cargo.toml --release --locked }
    Invoke-Step "Tauri Windows 构建" {
        if ($Bundle) {
            pnpm tauri build --debug --bundles nsis --ci --no-sign
        } else {
            pnpm tauri build --debug --no-bundle --ci
        }
    }

    if ($Bundle) {
        $installerRoot = Join-Path $repoRoot "src-tauri\target\debug\bundle\nsis"
        $installer = Get-ChildItem $installerRoot -Filter "*-setup.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $installer) {
            throw "NSIS 构建完成但没有找到安装包：$installerRoot"
        }
        Write-Host "安装包：$($installer.FullName)" -ForegroundColor Green
    }

    Invoke-Step "Git 差异空白检查" { git diff --check }
    Write-Host ""
    Write-Host "Windows 验证全部通过。" -ForegroundColor Green
} finally {
    Pop-Location
}

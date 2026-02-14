# Build silent-launcher.exe from SilentLauncher.cs
# Requires .NET Framework csc.exe (ships with Windows)
#
# Usage: powershell -ExecutionPolicy Bypass -File hooks/build.ps1

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cs = Join-Path $scriptDir 'SilentLauncher.cs'
$exe = Join-Path $scriptDir 'silent-launcher.exe'

# Find csc.exe from the .NET Framework directory
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) {
    Write-Error "csc.exe not found. Ensure .NET Framework 4.x is installed."
    exit 1
}

Write-Host "Building silent-launcher.exe ..."
& $csc /nologo /out:$exe /platform:anycpu /target:winexe $cs

if ($LASTEXITCODE -eq 0) {
    Write-Host "Built: $exe"
} else {
    Write-Error "Build failed (exit code $LASTEXITCODE)"
    exit $LASTEXITCODE
}

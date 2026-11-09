[CmdletBinding()]
param(
    [string]$NodePath,
    [ValidateRange(1, 65535)]
    [int]$Port = 3100,
    [switch]$PrepareOnly,
    [switch]$InstallLocalNode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Find-CompatibleNode {
    param([string]$ExplicitPath)

    $candidates = New-Object 'System.Collections.Generic.List[string]'
    if ($ExplicitPath) {
        $candidates.Add($ExplicitPath)
    } else {
        foreach ($command in @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue)) {
            $candidates.Add($command.Source)
        }
        foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
            if ($base) { $candidates.Add((Join-Path $base 'nodejs\node.exe')) }
        }
        if ($env:LOCALAPPDATA) {
            $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))
            $candidates.Add((Join-Path $env:LOCALAPPDATA 'Volta\bin\node.exe'))
        }
        if ($env:USERPROFILE) {
            $candidates.Add((Join-Path $env:USERPROFILE 'scoop\apps\nodejs\current\node.exe'))
            $candidates.Add((Join-Path $env:USERPROFILE 'scoop\apps\nodejs-lts\current\node.exe'))
        }
        foreach ($base in @($env:NVM_SYMLINK, $env:VOLTA_HOME)) {
            if ($base) {
                $candidates.Add((Join-Path $base 'node.exe'))
                $candidates.Add((Join-Path $base 'bin\node.exe'))
            }
        }
        if ($env:NVM_HOME -and (Test-Path -LiteralPath $env:NVM_HOME -PathType Container)) {
            foreach ($directory in @(Get-ChildItem -LiteralPath $env:NVM_HOME -Directory -Filter 'v*' |
                Sort-Object Name -Descending)) {
                $candidates.Add((Join-Path $directory.FullName 'node.exe'))
            }
        }
    }

    $checked = @()
    foreach ($candidate in @($candidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            $resolved = (Resolve-Path -LiteralPath $candidate).ProviderPath
            $version = (& $resolved --version 2>$null | Out-String).Trim()
            if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
                if ([int]$Matches[1] -ge 22) {
                    Write-Host "Node.js $version : $resolved"
                    return $resolved
                }
            }
            $checked += "$candidate ($version)"
        } catch {
            $checked += "$candidate (could not run)"
        }
    }
    $details = if ($checked.Count) { "`nChecked: " + ($checked -join '; ') } else { '' }
    if ($ExplicitPath) {
        throw "The specified Node.js must be version 22 or newer.$details"
    }
    Write-Host "No compatible installed Node.js found.$details"
    return $null
}

foreach ($required in @('server.js', 'history-store.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $required) -PathType Leaf)) {
        throw "$required is missing. Extract the complete distribution first."
    }
}
if ($NodePath -and $InstallLocalNode) { throw 'Use either -NodePath or -InstallLocalNode, not both.' }
$nodeExecutable = if ($InstallLocalNode) { $null } else { Find-CompatibleNode -ExplicitPath $NodePath }
if (-not $nodeExecutable) {
    $nodeExecutable = & (Join-Path $PSScriptRoot 'scripts\ensure-node.ps1') -InstallLocalNode:$InstallLocalNode
}
if ($PrepareOnly) {
    Write-Output $nodeExecutable
    exit 0
}
$previousPort = $env:PORT
$serverExitCode = 1
Push-Location -LiteralPath $PSScriptRoot
try {
    $env:PORT = [string]$Port
    Write-Host "Open http://localhost:$Port (loopback only). Keep this window open; Ctrl+C stops the server."
    Write-Host 'Press Ctrl+C once and wait for shutdown. Do not close this window or force-kill Node.'
    Write-Host 'Restart from this same extracted folder to reuse its local history.'
    # 別プロセス化や強制停止を避け、Node の SIGINT 処理による履歴の書き込み完了とロック解除を妨げない。
    & $nodeExecutable server.js
    $serverExitCode = $LASTEXITCODE
} finally {
    $env:PORT = $previousPort
    Pop-Location
}
exit $serverExitCode

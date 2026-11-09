[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Destination
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

$requiredFiles = @(
    'package.json',
    'package-lock.json',
    'server.js',
    'history-store.js',
    'fleet-session.js',
    'playwright.config.js',
    'public\app.js',
    'public\automatic-doors.js',
    'public\autosave.js',
    'public\demo-map.js',
    'public\floor-plan.js',
    'public\history-client.js',
    'public\index.html',
    'public\map-editor.css',
    'public\map-editor.js',
    'public\model.js',
    'public\safety.js',
    'public\style.css',
    'public\timed-plan.js',
    'public\timeline-edit.js',
    'public\scenario-export.js',
    'public\fleet-bundle.js',
    'public\scenario-library.js',
    'public\scenario-presentation.js',
    'test\automatic-doors.test.js',
    'test\demo-map.test.js',
    'test\door-controls.test.js',
    'test\equipment-sizing.test.js',
    'test\floor-plan.test.js',
    'test\history-http.test.js',
    'test\fleet.test.js',
    'test\history.test.js',
    'test\model.test.js',
    'test\scene-features.test.js',
    'test\scenario-library.test.js',
    'test\startup.test.js',
    'test\timed.test.js',
    'browser-tests\studio.spec.js',
    'browser-tests\history.spec.js',
    'browser-tests\fleet-exhibition.spec.js',
    'browser-tests\equipment-sizing.spec.js',
    'browser-tests\sequence-editor.spec.js',
    'browser-tests\scenario-library.spec.js',
    'AGENTS.md',
    'AI_HANDOFF.md',
    '.github\copilot-instructions.md',
    '.github\prompts\start.prompt.md',
    'start.ps1',
    'scripts\package.ps1',
    'scripts\ensure-node.ps1',
    'scripts\export-fleet-bundle.js',
    'fleet-bundle.example.json',
    'FLEET_INTEGRATION.md',
    'system-overview.svg'
)
$optionalFiles = @('README.md', 'INTEGRATION.md', '.gitignore')
$files = @($requiredFiles)
foreach ($relative in $optionalFiles) {
    if (Test-Path -LiteralPath (Join-Path $root $relative)) { $files += $relative }
}

foreach ($relative in $files) {
    if ($relative -match '(^|\\)(data|runtime|history|node_modules|test-results|playwright-report|config|configs|user-data)(\\|$)' -or
        $relative -match '(^|\\)writer\.lock$' -or
        $relative -match '\.(log|lock|tmp)$' -or
        $relative -match '(^|\\)\.env(?:\.|$)') {
        throw "Runtime, private configuration, and user data must not be distributed: $relative"
    }
    $source = Join-Path $root $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required distribution file is missing: $relative"
    }
    $current = $source
    while ($true) {
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Distribution files and directories must not be links: $current"
        }
        if ($current -eq $root) { break }
        $current = Split-Path -Parent $current
    }
}

$destinationPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Destination)
if ([System.IO.Path]::GetExtension($destinationPath) -ine '.zip') {
    throw 'Destination must have a .zip extension.'
}
if (Test-Path -LiteralPath $destinationPath) {
    throw "Destination already exists; choose a new ZIP path: $destinationPath"
}
if (-not $PSCmdlet.ShouldProcess($destinationPath, "Create portable ZIP with $($files.Count) allowlisted files")) {
    return
}

Add-Type -AssemblyName System.IO.Compression
$parent = Split-Path -Parent $destinationPath
if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
}
$stream = $null
$archive = $null
$created = $false
try {
    $stream = [System.IO.File]::Open(
        $destinationPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    $created = $true
    $archive = [System.IO.Compression.ZipArchive]::new(
        $stream, [System.IO.Compression.ZipArchiveMode]::Create, $true
    )
    foreach ($relative in $files) {
        $entryName = 'robot-scene-studio/' + $relative.Replace('\', '/')
        $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
        $inputStream = $null
        $outputStream = $null
        try {
            $inputStream = [System.IO.File]::OpenRead((Join-Path $root $relative))
            $outputStream = $entry.Open()
            $inputStream.CopyTo($outputStream)
        } finally {
            if ($outputStream) { $outputStream.Dispose() }
            if ($inputStream) { $inputStream.Dispose() }
        }
    }
    $archive.Dispose()
    $archive = $null
    $stream.Dispose()
    $stream = $null
} catch {
    if ($archive) { $archive.Dispose(); $archive = $null }
    if ($stream) { $stream.Dispose(); $stream = $null }
    if ($created) { Remove-Item -LiteralPath $destinationPath -Force }
    throw
} finally {
    if ($archive) { $archive.Dispose() }
    if ($stream) { $stream.Dispose() }
}
Write-Host "Created $destinationPath ($($files.Count) allowlisted files; no dependencies or user data)."

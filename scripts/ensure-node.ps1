[CmdletBinding()]
param(
    [switch]$InstallLocalNode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $env:LOCALAPPDATA) {
    throw 'LOCALAPPDATA is unavailable. A writable Windows user profile is required.'
}
$cache = Join-Path $env:LOCALAPPDATA 'RobotSceneStudio\runtime'
if (-not $InstallLocalNode -and (Test-Path -LiteralPath $cache -PathType Container)) {
    foreach ($directory in @(Get-ChildItem -LiteralPath $cache -Directory -Filter 'node-v*' |
        Sort-Object Name -Descending)) {
        $candidate = Join-Path $directory.FullName 'node.exe'
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $version = (& $candidate --version | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.\d+\.\d+$' -and
            [int]$Matches[1] -ge 22) {
            return $candidate
        }
        throw "The cached Node.js runtime cannot run: $candidate. Inspect it before retrying."
    }
}

$architecture = $env:PROCESSOR_ARCHITEW6432
if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($architecture) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { throw "Unsupported Windows architecture: $architecture. Use Windows x64 or ARM64." }
}

Write-Host 'Preparing a user-local Node.js LTS runtime from https://nodejs.org (no administrator rights or PATH changes).'
Write-Host 'Only public runtime files are downloaded; project files and history are not uploaded.'
$previousProtocol = [Net.ServicePointManager]::SecurityProtocol
$staging = $null
try {
    [Net.ServicePointManager]::SecurityProtocol = $previousProtocol -bor [Net.SecurityProtocolType]::Tls12
    $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 60
    $release = $releases | Where-Object {
        $_.lts -and $_.version -match '^v(\d+)\.\d+\.\d+$' -and [int]$Matches[1] -ge 22 -and
        $_.files -contains "win-$arch-zip"
    } | Sort-Object { [version]$_.version.Substring(1) } -Descending | Select-Object -First 1
    if (-not $release) { throw 'No supported Windows Node.js LTS release was found.' }
    $version = $release.version
    $name = "node-$version-win-$arch"
    $destination = Join-Path $cache $name
    if (Test-Path -LiteralPath $destination) {
        $candidate = Join-Path $destination 'node.exe'
        $actual = (& $candidate --version | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $actual -ne $version) {
            throw "Existing runtime is invalid: $destination. It was not overwritten."
        }
        return $candidate
    }
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $staging = Join-Path $cache ("download-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging | Out-Null
    $archive = Join-Path $staging "$name.zip"
    $base = "https://nodejs.org/dist/$version"
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt" -TimeoutSec 60).Content
    $pattern = '(?m)^([a-fA-F0-9]{64})\s+' + [regex]::Escape("$name.zip") + '\r?$'
    if ($checksums -notmatch $pattern) { throw 'The official runtime checksum was not found.' }
    $expectedHash = $Matches[1]
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$name.zip" -OutFile $archive -TimeoutSec 300
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $expectedHash) {
        throw 'Node.js download checksum mismatch. The downloaded program will not be executed.'
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $staging
    $extracted = Join-Path $staging $name
    $candidate = Join-Path $extracted 'node.exe'
    $actual = (& $candidate --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $actual -ne $version) {
        throw "Downloaded Node.js could not run (expected $version, got $actual)."
    }
    Move-Item -LiteralPath $extracted -Destination $destination
    Write-Host "Prepared Node.js $version : $destination"
    return (Join-Path $destination 'node.exe')
} catch {
    throw "Node.js preparation failed: $($_.Exception.Message) Check internet access, proxy and organization policy. Do not disable TLS, security software or execution policy."
} finally {
    [Net.ServicePointManager]::SecurityProtocol = $previousProtocol
    if ($staging -and (Test-Path -LiteralPath $staging)) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}

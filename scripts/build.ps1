<#
.SYNOPSIS
Builds the Zotero Sideline XPI from src/.

.DESCRIPTION
Packages src/ with Python's zipfile using fixed timestamps, so identical sources produce
a byte-identical XPI. The archive root is the plugin root, therefore manifest.json,
bootstrap.js and prefs.js must stay at the top level of src/.

NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less files as ANSI.
#>
[CmdletBinding()]
param([string]$OutputPath = "")

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$source = Join-Path $projectRoot "src"
if (-not (Test-Path -LiteralPath $source)) { throw "source directory not found: $source" }
foreach ($name in @("manifest.json", "bootstrap.js", "prefs.js")) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $name))) { throw "missing required file: $name" }
}

if (-not $OutputPath) { $OutputPath = Join-Path $projectRoot "runtime\zotero-sideline.xpi" }
$output = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output) | Out-Null
Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue

$manifest = Get-Content -LiteralPath (Join-Path $source "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$python = Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1
@'
from pathlib import Path
import sys
import zipfile

source = Path(sys.argv[1])
output = Path(sys.argv[2])
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(item for item in source.rglob("*") if item.is_file()):
        relative = path.relative_to(source).as_posix()
        info = zipfile.ZipInfo(relative, date_time=(2026, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
'@ | & $python.Source - $source $output
if ($LASTEXITCODE -ne 0) { throw "packaging failed" }

$versioned = Join-Path (Split-Path -Parent $output) "zotero-sideline-$($manifest.version).xpi"
Copy-Item -LiteralPath $output -Destination $versioned -Force

[pscustomobject]@{
    xpi          = $output
    versionedXpi = $versioned
    plugin_id    = $manifest.applications.zotero.id
    version      = $manifest.version
} | ConvertTo-Json -Compress

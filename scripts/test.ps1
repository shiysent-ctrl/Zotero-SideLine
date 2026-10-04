<#
.SYNOPSIS
Runs the Zotero Sideline logic tests.

.DESCRIPTION
Runs test/run-tests.mjs, which loads the real src/ modules inside a Node vm sandbox with a
fake Zotero host. It covers config parsing, markdown rendering, context building, session
trimming, note writing, the model client (including SSE parsing and abort), the local
endpoint contracts, the sidebar UI logic and bootstrap registration. Zotero is not required
and is not started.

NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less files as ANSI.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
& $node.Source (Join-Path $projectRoot "test\run-tests.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$python = Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1
& $python.Source (Join-Path $projectRoot "scripts\release-tests.py")
exit $LASTEXITCODE

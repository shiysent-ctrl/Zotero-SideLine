<#
.SYNOPSIS
Exports an allowlisted standalone source tree and verifies a release candidate.
.DESCRIPTION
Uses Python standard-library tooling. Outputs are restricted to a new runtime child.
Runs static checks, fake-host tests and two builds in the clean export, without model calls.
#>
[CmdletBinding()]
param([switch]$ListOnly)
$ErrorActionPreference = "Stop"
$python = Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1
$arguments = @((Join-Path $PSScriptRoot "export-release.py"))
if ($ListOnly) { $arguments += "--list" }
else { $arguments += "--verify" }
& $python.Source @arguments
if ($LASTEXITCODE -ne 0) { throw "release preparation failed" }

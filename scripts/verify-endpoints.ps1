<#
.SYNOPSIS
Smoke-tests the Zotero Sideline local endpoints.

.DESCRIPTION
Runs GET /sideline/status, then POST /sideline/selftest (read-only: config, startup
diagnostics, and - when -ItemID is given - item, attachment and full-text availability).
The model is only called with -Chat; a child note is only written with -Save.
Zotero must be running with the Zotero Sideline plugin enabled.

.PARAMETER ItemID
Numeric Zotero item ID. The Sideline sidebar status line shows it as "item #1234".

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-endpoints.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-endpoints.ps1 -ItemID 1234
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-endpoints.ps1 -ItemID 1234 -Chat

NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less files as ANSI.
#>
[CmdletBinding()]
param(
    [string]$BaseURL = "http://127.0.0.1:23119",
    [int]$ItemID = 0,
    [switch]$Chat,
    [string]$Question = "",
    [switch]$Save,
    [string]$Mode = ""
)

$ErrorActionPreference = "Stop"
$BaseURL = $BaseURL.TrimEnd("/")

function Invoke-Sideline {
    param([string]$Path, [string]$Method = "GET", $Body = $null, [int]$TimeoutSec = 30)
    $params = @{ Uri = "$BaseURL$Path"; Method = $Method; TimeoutSec = $TimeoutSec }
    if ($null -ne $Body) {
        $params.ContentType = "application/json; charset=utf-8"
        $params.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
    }
    return Invoke-RestMethod @params
}

Write-Output "== GET /sideline/status =="
try {
    $status = Invoke-Sideline -Path "/sideline/status" -TimeoutSec 20
    $status | ConvertTo-Json -Depth 6
    if (-not $status.ready) { throw "endpoint not ready" }
}
catch {
    Write-Output "status endpoint did not respond: $($_.Exception.Message)"
    Write-Output "Known cause on 0.1.0: StatusEndpoint.init was declared with zero parameters, so Zotero"
    Write-Output "called it as a legacy endpoint and never sent a response."
    Write-Output "Fix: reinstall 0.1.2 or later. Other endpoints are unaffected; the checks below continue."
}

Write-Output ""
Write-Output "== POST /sideline/selftest =="
$selfTestBody = @{}
if ($ItemID -gt 0) { $selfTestBody.itemID = $ItemID }
$selfTest = Invoke-Sideline -Path "/sideline/selftest" -Method "POST" -Body $selfTestBody
foreach ($entry in $selfTest.checks) {
    Write-Output ("[{0}] {1} {2}" -f $entry.status, $entry.name, $entry.detail)
}
Write-Output "selftest ok=$($selfTest.ok) failed=$($selfTest.failed)"
if ($selfTest.diagnostics.errors.Count) {
    Write-Output "startup errors:"
    $selfTest.diagnostics.errors | ForEach-Object { Write-Output (" - {0}: {1}" -f $_.key, $_.message) }
}
if (-not $selfTest.config.configured) {
    Write-Warning "api / model / secretKey not configured yet; the -Chat check will fail"
}

Write-Output ""
Write-Output "== POST /sideline/sessions =="
$sessions = Invoke-Sideline -Path "/sideline/sessions" -Method "POST" -Body @{}
Write-Output "stored sessions=$($sessions.count) path=$($sessions.stats.path) enabled=$($sessions.stats.enabled) loadError=$($sessions.stats.loadError)"

if ($ItemID -le 0) {
    Write-Output ""
    Write-Output "No -ItemID given, skipping context / chat checks."
    Write-Output "Read the item ID from the Sideline sidebar status line (item #1234)."
    return
}

$contextBody = @{ itemID = $ItemID; includeText = $false }
if ($Mode) { $contextBody.mode = $Mode }
Write-Output ""
Write-Output "== POST /sideline/context (itemID=$ItemID) =="
$context = Invoke-Sideline -Path "/sideline/context" -Method "POST" -Body $contextBody
$context | ConvertTo-Json -Depth 6

if (-not $Chat) {
    Write-Output ""
    Write-Output "No -Chat given, skipping the model call."
    return
}

if (-not $Question) { $Question = "Summarize this item in three sentences and state the problem it solves." }
$chatBody = @{ itemID = $ItemID; question = $Question }
if ($Mode) { $chatBody.mode = $Mode }
if ($Save) { $chatBody.save = $true }
Write-Output ""
Write-Output "== POST /sideline/chat (itemID=$ItemID) =="
$reply = Invoke-Sideline -Path "/sideline/chat" -Method "POST" -Body $chatBody -TimeoutSec 300
Write-Output "model=$($reply.model) elapsed=$($reply.elapsedMs)ms contextChars=$($reply.stats.contextChars)"
Write-Output "--- answer ---"
Write-Output $reply.answer
if ($reply.note) { Write-Output "note saved: $($reply.note.key) (parent $($reply.note.parentID))" }

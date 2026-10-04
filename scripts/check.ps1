<#
.SYNOPSIS
Static checks for Zotero Sideline sources. Does not start Zotero.

.DESCRIPTION
Checks performed:
1. required files exist;
2. JavaScript syntax of every .js file (node --check);
3. manifest.json parses and carries the required fields;
4. default preferences in prefs.js match the fallback keys in modules/config.js;
5. content/prefs-pane.xhtml is well-formed XML (namespace declarations are injected for
   the check only; Zotero's parseXULToFragment handles the real load, same as built-in panes);
6. braces balance in both stylesheets.

NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less files as ANSI,
so non-ASCII text here would corrupt the script itself.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$src = Join-Path $projectRoot "src"
$problems = New-Object System.Collections.Generic.List[string]

# 1. required files
$required = @(
    "src\manifest.json",
    "src\bootstrap.js",
    "src\prefs.js",
    "src\modules\util.js",
    "src\modules\chatservice.js",
    "src\modules\readerhighlights.js",
    "src\modules\readerrequests.js",
    "src\modules\prosematch.js",
    "src\modules\storecodec.js",
    "src\modules\modelrequest.js",
    "src\modules\diagnostics.js",
    "src\modules\jsonfile.js",
    "src\modules\config.js",
    "src\modules\prompts.js",
    "src\modules\functions.js",
    "src\modules\materials.js",
    "src\modules\citations.js",
    "src\modules\context.js",
    "src\modules\readertext.js",
    "src\modules\highlights.js",
    "src\modules\summary.js",
    "src\modules\notetext.js",
    "src\modules\inputs.js",
    "src\modules\history.js",
    "src\modules\excerpt.js",
    "src\modules\client.js",
    "src\modules\providers.js",
    "src\modules\session.js",
    "src\modules\notes.js",
    "src\modules\annotations.js",
    "src\modules\store.js",
    "src\modules\writes.js",
    "src\modules\proc.js",
    "src\modules\codex.js",
    "src\modules\agentinstall.js",
    "src\modules\agentimages.js",
    "src\modules\dshstream.js",
    "src\modules\agentweb.js",
    "src\modules\acp.js",
    "src\modules\agentacp.js",
    "src\modules\opencode.js",
    "src\modules\dsh.js",
    "src\modules\agents.js",
    "src\modules\agentconversation.js",
    "src\modules\prefservice.js",
    "src\modules\readerprobe.js",
    "src\modules\reader.js",
    "src\modules\readermessages.js",
    "src\modules\readerreplies.js",
    "src\modules\readermenu.js",
    "src\modules\readerside.js",
    "src\modules\endpoints.js",
    "src\content\reader-panel.css",
    "src\content\prefs-pane.xhtml",
    "src\content\prefs-pane.js",
    "src\content\prefs-pane.css",
    "src\content\vision-test.json",
    "src\content\icons\sideline.svg",
    "src\vendor\katex\katex.min.js",
    "src\vendor\katex\katex.min.css",
    "src\vendor\katex\LICENSE",
    "src\vendor\katex\fonts\KaTeX_Main-Regular.woff2",
    "test\run-tests.mjs",
    "test\dom-host.mjs",
    "test\request-tests.mjs",
    "test\fixtures\summary-prompt.md",
    "test\agent-host.mjs",
    "test\agent-tests.mjs",
    "scripts\test.ps1",
    "scripts\release.ps1",
    "scripts\export-release.py",
    "scripts\release-tests.py",
    ".github\workflows\release-candidate.yml"
    "updates.json"
)
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relative))) {
        $problems.Add("missing file: $relative")
    }
}
if ($problems.Count) {
    $problems | ForEach-Object { Write-Output "FAIL $_" }
    throw "required file check failed"
}
Write-Output "ok   required files present ($($required.Count))"

# 2. JavaScript syntax
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
    throw "node is required for JavaScript syntax checks"
}
else {
    $jsFiles = @(Get-ChildItem -LiteralPath $src -Recurse -Filter *.js) + @(Get-ChildItem -LiteralPath (Join-Path $projectRoot "test") -Recurse -Filter *.mjs)
    $jsFailures = 0
    foreach ($file in $jsFiles) {
        $output = & $node.Source --check $file.FullName 2>&1
        if ($LASTEXITCODE -ne 0) {
            $jsFailures++
            $problems.Add("JavaScript syntax error: $($file.Name) -> $output")
        }
    }
    if ($jsFailures -eq 0) { Write-Output "ok   JavaScript syntax ($($jsFiles.Count) files)" }
}

# 3. manifest.json
$manifest = Get-Content -LiteralPath (Join-Path $src "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($field in @("manifest_version", "name", "version")) {
    if (-not $manifest.$field) { $problems.Add("manifest.json missing field: $field") }
}
$pluginID = $manifest.applications.zotero.id
# Zotero 10 Extension.sys.mjs requires all three application fields for installation.
foreach ($field in @("id", "update_url", "strict_max_version")) {
    $value = $manifest.applications.zotero.$field
    if ($value -isnot [string] -or -not $value.Trim()) {
        $problems.Add("manifest.json missing installation field: applications.zotero.$field")
    }
}
# XPIDatabase.sys.mjs also rejects data/http updates when update security is enabled.
# Read the selected URL from the manifest; never invent hosting or disable security.
$updateURL = [string]$manifest.applications.zotero.update_url
$selectedUpdateURL = "https://raw.githubusercontent.com/shiysent-ctrl/Zotero-SideLine/main/updates.json"
[uri]$updateURI = $null
if ($updateURL -cne $selectedUpdateURL -or
    -not $updateURL.StartsWith("https://", [StringComparison]::Ordinal) -or
    -not [uri]::TryCreate($updateURL, [UriKind]::Absolute, [ref]$updateURI) -or
    -not $updateURI.Host -or $updateURI.UserInfo -or
    $manifest.PSObject.Properties.Name -contains "update_url") {
    $problems.Add("Zotero installation requires the explicitly selected HTTPS update URL")
}
$updateManifest = Get-Content -LiteralPath (Join-Path $projectRoot "updates.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$updateIDs = @($updateManifest.addons.PSObject.Properties.Name)
if (@($updateManifest.PSObject.Properties.Name).Count -ne 1 -or
    $updateIDs.Count -ne 1 -or $updateIDs[0] -cne $pluginID -or
    @($updateManifest.addons.$pluginID.PSObject.Properties.Name).Count -ne 1 -or
    -not ($updateManifest.addons.$pluginID.updates -is [array]) -or
    @($updateManifest.addons.$pluginID.updates).Count -ne 0) {
    $problems.Add("first release update manifest must contain only this plugin ID with no update candidates")
}
Write-Output "ok   manifest.json (id=$pluginID version=$($manifest.version))"

# 3b. manifest version must match SIDELINE_VERSION in bootstrap.js
$bootstrapVersion = ""
Select-String -LiteralPath (Join-Path $src "bootstrap.js") -Pattern 'SIDELINE_VERSION = "([^"]+)"' |
    ForEach-Object { $bootstrapVersion = $_.Matches[0].Groups[1].Value }
if (-not $bootstrapVersion) {
    $problems.Add("bootstrap.js: no SIDELINE_VERSION found")
}
elseif ($bootstrapVersion -ne $manifest.version) {
    $problems.Add("version mismatch: manifest=$($manifest.version) bootstrap=$bootstrapVersion")
}
else {
    Write-Output "ok   version consistency ($bootstrapVersion)"
}

# 4. preference consistency
$prefKeys = New-Object System.Collections.Generic.List[string]
Select-String -LiteralPath (Join-Path $src "prefs.js") -Pattern 'pref\("extensions\.zotero\.sideline\.([A-Za-z0-9_.]+)"' |
    ForEach-Object { $prefKeys.Add($_.Matches[0].Groups[1].Value) }
$configText = Get-Content -LiteralPath (Join-Path $src "modules\config.js") -Raw -Encoding UTF8
$fallbackMatch = [regex]::Match($configText, 'const FALLBACK = \{(?<body>[\s\S]*?)\n  \};')
if (-not $fallbackMatch.Success) {
    $problems.Add("cannot locate FALLBACK block in modules/config.js")
}
else {
    $fallbackKeys = New-Object System.Collections.Generic.List[string]
    [regex]::Matches($fallbackMatch.Groups["body"].Value, '(?m)^\s{4}([A-Za-z0-9_]+):') |
        ForEach-Object { $fallbackKeys.Add($_.Groups[1].Value) }
    foreach ($key in $fallbackKeys) {
        if ($prefKeys -notcontains $key) { $problems.Add("prefs.js has no default for: $key") }
    }
    foreach ($key in $prefKeys) {
        if ($fallbackKeys -notcontains $key) { $problems.Add("config.js FALLBACK has no key: $key") }
    }
    Write-Output "ok   preference consistency ($($prefKeys.Count) keys)"
}

# 5. XHTML well-formedness
$python = Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $python) {
    throw "python is required for XHTML checks"
}
else {
    $checker = @'
import pathlib
import sys
import xml.dom.minidom

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

# (1) A pane fragment must not carry an XML declaration: Zotero wraps it inside a
# <div> before parsing (_parseXHTMLToFragment), where a mid-document declaration is
# a syntax error and makes the pane open empty.
if text.lstrip().lower().startswith("<?xml"):
    print("FAIL %s: must not start with an XML declaration" % path.name)
    sys.exit(1)

# (2) Parse it the way Zotero does. Gecko pre-registers the html: and xul: prefixes,
# so declare them explicitly here.
wrapped = (
    '<div xmlns="http://www.w3.org/1999/xhtml" '
    'xmlns:html="http://www.w3.org/1999/xhtml" '
    'xmlns:xul="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul">'
    + text +
    '</div>'
)
try:
    xml.dom.minidom.parseString(wrapped)
except Exception as error:
    print("FAIL %s: %s" % (path.name, error))
    sys.exit(1)
print("ok   %s is a valid pane fragment" % path.name)
'@
    foreach ($fragment in Get-ChildItem -LiteralPath (Join-Path $src "content") -Filter *.xhtml) {
        $checker | & $python.Source - $fragment.FullName
        if ($LASTEXITCODE -ne 0) { $problems.Add("$($fragment.Name): invalid preference pane fragment") }
    }
}

# 6. CSS brace balance
$cssProblems = 0
foreach ($name in @("prefs-pane.css", "reader-panel.css")) {
    $css = Get-Content -LiteralPath (Join-Path $src "content\$name") -Raw -Encoding UTF8
    $open = ([regex]::Matches($css, "\{")).Count
    $close = ([regex]::Matches($css, "\}")).Count
    if ($open -ne $close) {
        $cssProblems++
        $problems.Add("$name brace mismatch: $open / $close")
    }
}
if ($cssProblems -eq 0) { Write-Output "ok   CSS braces balanced" }

# 7. PowerShell scripts must stay ASCII-only: PowerShell 5.1 reads BOM-less .ps1 as ANSI,
# and non-ASCII text there corrupts the script (or any here-string piped to another tool).
$scriptProblems = 0
foreach ($script in Get-ChildItem -LiteralPath (Join-Path $projectRoot "scripts") -Filter *.ps1) {
    $scriptText = [System.IO.File]::ReadAllText($script.FullName, [System.Text.Encoding]::UTF8)
    $nonAscii = ($scriptText.ToCharArray() | Where-Object { [int]$_ -gt 126 }).Count
    if ($nonAscii -gt 0) {
        $scriptProblems++
        $problems.Add("$($script.Name): $nonAscii non-ASCII characters (scripts must stay ASCII-only)")
    }
}
if ($scriptProblems -eq 0) { Write-Output "ok   PowerShell scripts are ASCII-only" }

# 8. Validate Python tooling without creating __pycache__ or installing dependencies.
$pythonSyntax = @'
from pathlib import Path
import sys
for entry in Path(sys.argv[1]).glob("*.py"):
    compile(entry.read_text(encoding="utf-8"), str(entry), "exec")
print("ok   Python tooling syntax")
'@
$pythonSyntax | & $python.Source - (Join-Path $projectRoot "scripts")
if ($LASTEXITCODE -ne 0) { $problems.Add("Python tooling syntax failed") }

if ($problems.Count) {
    Write-Output ""
    $problems | ForEach-Object { Write-Output "FAIL $_" }
    throw "static checks failed ($($problems.Count))"
}
Write-Output ""
Write-Output "All static checks passed."

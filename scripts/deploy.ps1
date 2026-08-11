<#
.SYNOPSIS
    Publishes dist/ to kcbrazos/Elden-Battleship, whose main branch IS the GitHub Pages root.

.DESCRIPTION
    Clean replace: the deploy repo's tree is emptied before the fresh dist/ is copied in, so
    stale hashed bundles from old builds don't pile up.

    Run this as a FILE, never by pasting its contents into a prompt - `npm` reads from stdin
    and will swallow the lines that follow it, leaving later variables unset.

.EXAMPLE
    .\scripts\deploy.ps1 -WhatIf
    .\scripts\deploy.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Fail([string]$Message) { Write-Host "`nABORT: $Message" -ForegroundColor Red; exit 1 }

# Resolved from this script's own location so the working directory can't change the target.
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Dist        = Join-Path $ProjectRoot 'dist'
$RepoUrl     = 'https://github.com/kcbrazos/Elden-Battleship.git'
$Work        = Join-Path $env:TEMP 'eb-deploy'

if ([string]::IsNullOrWhiteSpace($env:TEMP)) { Fail 'TEMP is not set.' }
if ([string]::IsNullOrWhiteSpace($Work))     { Fail 'Work path resolved empty.' }

Set-Location $ProjectRoot

# --- Build ------------------------------------------------------------------
if (-not $SkipBuild) {
    Step 'Building'
    npm run build
    if ($LASTEXITCODE -ne 0) { Fail 'Build failed - nothing deployed.' }
}

# The whole point of the guard: never wipe the remote unless we hold a real build to replace it.
if (-not (Test-Path (Join-Path $Dist 'index.html'))) { Fail "No index.html in $Dist" }
$distFiles = @(Get-ChildItem $Dist -Recurse -File)
if ($distFiles.Count -lt 5) { Fail "dist/ has only $($distFiles.Count) files - refusing to deploy." }
Write-Host "    dist/ holds $($distFiles.Count) files"

# --- Identity ---------------------------------------------------------------
$name  = (git -C $ProjectRoot config user.name)
$email = (git -C $ProjectRoot config user.email)
if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($email)) {
    Fail 'No user.name / user.email in the project repo. Set them there first.'
}

# --- Clone ------------------------------------------------------------------
Step "Cloning deploy repo"
Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
git clone --quiet $RepoUrl $Work
if ($LASTEXITCODE -ne 0) { Fail 'Clone failed.' }
if (-not (Test-Path (Join-Path $Work '.git'))) { Fail "Clone produced no .git at $Work" }

try {
    # --- Wipe ---------------------------------------------------------------
    Step 'Removing old build'
    Get-ChildItem -LiteralPath $Work -Force |
        Where-Object { $_.Name -ne '.git' } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }

    # --- Copy ---------------------------------------------------------------
    Step 'Copying new build'
    Copy-Item -Path (Join-Path $Dist '*') -Destination $Work -Recurse -Force

    # Post-copy verification. Without this, a failed copy commits an empty repo and 404s the site.
    $landed = @(Get-ChildItem $Work -Recurse -File | Where-Object { $_.FullName -notmatch '\\\.git\\' })
    if (-not (Test-Path (Join-Path $Work 'index.html'))) { Fail 'Copy failed - no index.html. Nothing pushed.' }
    if ($landed.Count -ne $distFiles.Count) {
        Fail "Copied $($landed.Count) files but dist/ has $($distFiles.Count). Nothing pushed."
    }
    Write-Host "    verified $($landed.Count) files"

    # --- Commit + push ------------------------------------------------------
    Set-Location $Work
    git config user.name  $name
    git config user.email $email
    git add -A

    if (-not (git status --porcelain)) { Step 'Already up to date - nothing to push.'; return }

    Step 'Changes'
    git status --short

    if ($WhatIf) { Step 'WhatIf - stopping before commit/push.'; return }

    $sha = (git -C $ProjectRoot rev-parse --short HEAD)
    git commit --quiet -m "deploy: build $(Get-Date -Format 'yyyy-MM-dd HH:mm') (source $sha)"
    if ($LASTEXITCODE -ne 0) { Fail 'Commit failed.' }

    Step 'Pushing'
    git push origin main
    if ($LASTEXITCODE -ne 0) { Fail 'Push failed.' }

    Step 'Live at https://kcbrazos.github.io/Elden-Battleship/'
}
finally {
    Set-Location $ProjectRoot
}

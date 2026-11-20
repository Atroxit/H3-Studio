# Creates a Windows Desktop shortcut for the packaged H3 Studio desktop app.
#
# The shortcut runs `node scripts/desktop.mjs`, which is the supported launcher: it clears
# ELECTRON_RUN_AS_NODE before starting Electron, so the window appears even when the shell
# was opened from inside another Electron based tool.
#
#   npm run desktop:shortcut
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/desktop-shortcut.ps1 -Destination D:\Shortcuts

[CmdletBinding()]
param(
    # Where the .lnk file is written. Defaults to the current user's Desktop folder.
    [string]$Destination = [Environment]::GetFolderPath('Desktop')
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $repoRoot 'scripts\desktop.mjs'
$bundle = Join-Path $repoRoot 'dist\server\main.cjs'
$icon = Join-Path $repoRoot 'electron\h3-studio.ico'

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "The desktop launcher is missing: $launcher"
}

if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
}

# The window loads the built app, so build it once when it is not there yet.
if (-not (Test-Path -LiteralPath $bundle)) {
    Write-Host 'The desktop bundle is missing, building it first...'
    Push-Location $repoRoot
    try {
        & npm run desktop:build
        if ($LASTEXITCODE -ne 0) {
            throw 'npm run desktop:build failed.'
        }
    }
    finally {
        Pop-Location
    }
}

# Resolve node now, so the shortcut keeps working when PATH later does not include it.
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    throw 'node was not found on PATH. Install Node 24 or newer, then run this again.'
}

$shortcutPath = Join-Path $Destination 'H3 Studio.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $nodeCommand.Source
$shortcut.Arguments = '"' + $launcher + '"'
$shortcut.WorkingDirectory = $repoRoot
$shortcut.Description = 'H3 Studio, local MiniMax H3 Image studio'
$shortcut.WindowStyle = 7
if (Test-Path -LiteralPath $icon) {
    $shortcut.IconLocation = "$icon,0"
}
$shortcut.Save()

Write-Host "Shortcut created: $shortcutPath"
Write-Host "Target: $($nodeCommand.Source) `"$launcher`""

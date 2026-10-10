<# :
@echo off
setlocal
title Apply models to the Minecraft server
set "MCMODELS_SELF=%~f0"
set "MCMODELS_ARG=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([IO.File]::ReadAllText($env:MCMODELS_SELF))"
exit /b %errorlevel%
#>
# ==========================================================================================
#  apply-models.cmd  -  run inside the Minecraft server folder (next to fabric-server-launch.jar).
#
#  1. On the LAN File Share site, Models tab, click "Download all for the server". That marks the
#     models as uploaded and gives you models.zip.
#  2. Put models.zip next to this file (or leave it in Downloads) and double-click this file,
#     or drag the zip / an unpacked folder onto it.
#  3. Restart the Minecraft server.
#
#  What it does: copies every model jar from the zip into mods\, replacing older builds of the same
#  model, and does the same for the player pack folder below so players get the models with the
#  mods installer (re-zip that folder and upload it as a new installer version afterwards).
# ==========================================================================================

$PackDir = 'C:\Users\fakerdog1\Desktop\MinecraftModPack'   # player pack folder, '' to skip

$ErrorActionPreference = 'Stop'
$ServerDir = Split-Path -Parent $env:MCMODELS_SELF
$ModsDir   = Join-Path $ServerDir 'mods'
$failed = $false
try {
Write-Host "Server folder: $ServerDir"
if (-not (Test-Path -LiteralPath (Join-Path $ServerDir 'fabric-server-launch.jar')) -and -not (Test-Path -LiteralPath $ModsDir)) {
  throw "This does not look like the server folder (no fabric-server-launch.jar and no mods folder here). Put apply-models.cmd into D:\MinecraftServer."
}

# A running server keeps its jars open, so files in mods\ cannot be replaced while it runs.
$running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match '^javaw?\.exe$' -and ([string]$_.CommandLine) -match [regex]::Escape($ServerDir)
})
while ($running) {
  $reply = Read-Host "The Minecraft server is running from this folder. Stop it (type stop in its console), then press Enter. Type skip to continue anyway"
  if ($reply -match '^\s*skip') { break }
  $running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^javaw?\.exe$' -and ([string]$_.CommandLine) -match [regex]::Escape($ServerDir) })
}

# Where the models come from: the argument, or the newest models*.zip next to this file or in Downloads.
$source = $env:MCMODELS_ARG
if (-not $source) {
  $dirs = @($ServerDir)
  try { $dirs += (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path } catch { }
  if ($env:USERPROFILE) { $dirs += Join-Path $env:USERPROFILE 'Downloads' }
  $zip = Get-ChildItem -LiteralPath ($dirs | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique) -Filter 'models*.zip' -File -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $zip) { throw "No models zip found. Download it from the site (Models tab, 'Download all for the server') and put it next to this file, or drag it onto this file." }
  $source = $zip.FullName
  Write-Host "Using $source"
}
if (-not (Test-Path -LiteralPath $source)) { throw "Not found: $source" }

# Collect the jars from a zip or a folder.
$temp = $null
if ((Get-Item -LiteralPath $source).PSIsContainer) {
  $jars = @(Get-ChildItem -LiteralPath $source -Recurse -Filter '*.jar' -File)
} else {
  $temp = Join-Path $env:TEMP ("models-" + [IO.Path]::GetRandomFileName())
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($source, $temp)
  $jars = @(Get-ChildItem -LiteralPath $temp -Recurse -Filter '*.jar' -File)
}
if (-not $jars) { throw "No .jar files inside $source" }

function Install-Jars($jars, $dir) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $n = 0
  foreach ($jar in $jars) {
    # Model file names are <modid>-<version>.jar; older builds of the same model are replaced.
    $prefix = ($jar.Name -replace '-.*$', '') + '-'
    foreach ($old in Get-ChildItem -LiteralPath $dir -File -Filter "$prefix*.jar") {
      if ($old.Name -ne $jar.Name) { Write-Host "  removing old $($old.Name)"; Remove-Item -LiteralPath $old.FullName -Force }
    }
    Copy-Item -LiteralPath $jar.FullName -Destination (Join-Path $dir $jar.Name) -Force
    Write-Host "  installed $($jar.Name)"
    $n++
  }
  return $n
}

Write-Host "Models -> $ModsDir"
$count = Install-Jars $jars $ModsDir

# Player pack: bundle the jars and list them in pack.json so the installer delivers them.
if ($PackDir -and (Test-Path -LiteralPath (Join-Path $PackDir 'pack.json'))) {
  Write-Host "Models -> player pack $PackDir"
  Install-Jars $jars (Join-Path $PackDir 'mods') | Out-Null
  $packFile = Join-Path $PackDir 'pack.json'
  $pack = Get-Content -LiteralPath $packFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $mods = @($pack.mods)
  foreach ($jar in $jars) {
    $modId = $jar.Name -replace '-.*$', ''
    $match = "$modId-*.jar"
    $entry = $mods | Where-Object { $_.match -eq $match } | Select-Object -First 1
    if ($entry) { $entry.localFile = "mods/$($jar.Name)" }
    else { $mods += [pscustomobject]@{ name = "Model: $modId"; match = $match; localFile = "mods/$($jar.Name)" } }
  }
  $pack.mods = $mods
  $pack.packVersion = Get-Date -Format 'yyyy-MM-dd.HHmm'
  ($pack | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $packFile -Encoding UTF8
  Write-Host "  pack.json updated (pack version $($pack.packVersion)). Zip the pack folder and upload it as a new installer version."
}

if ($temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host ""
Write-Host "Done: $count model$(if ($count -ne 1) { 's' }) in the server mods folder. Start the Minecraft server again to load them." -ForegroundColor Green
} catch {
  $failed = $true
  Write-Host ""
  Write-Host "STOPPED: $($_.Exception.Message)" -ForegroundColor Red
}
if ($Host.Name -eq 'ConsoleHost') { Read-Host "Press Enter to close" | Out-Null }
if ($failed) { exit 1 }

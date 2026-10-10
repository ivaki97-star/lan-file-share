<# :
@echo off
setlocal
title Deploy the mod pack to this Minecraft server
set "MCDEPLOY_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([IO.File]::ReadAllText($env:MCDEPLOY_SELF))"
exit /b %errorlevel%
#>
# ==========================================================================================
#  deploy-server.cmd  -  run inside the Minecraft server folder (next to fabric-server-launch.jar).
#
#  Pulls the current installer version from the LAN File Share site (over the internet when hosted),
#  installs its mods and the uploaded models into this server's mods folder, and reports the
#  deployment back, so the site shows what the server runs. Stop the server first, start it after.
#
#  Fill in the two settings below (the admin token is ADMIN_TOKEN from the site's .env).
# ==========================================================================================
$SiteUrl    = 'http://FRIEND-PC-IP:8080'
$AdminToken = 'change-me-too'

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
$ServerDir = Split-Path -Parent $env:MCDEPLOY_SELF
$failed = $false
try {
if ($SiteUrl -match 'FRIEND-PC' -or $AdminToken -eq 'change-me-too') { throw "Open deploy-server.cmd in Notepad and fill in SiteUrl and AdminToken first." }
if (-not (Test-Path -LiteralPath (Join-Path $ServerDir 'fabric-server-launch.jar'))) { throw "This does not look like the server folder (no fabric-server-launch.jar here). Put deploy-server.cmd into D:\MinecraftServer." }
$SiteUrl = $SiteUrl.TrimEnd('/')
$headers = @{ 'X-Admin-Token' = $AdminToken }

Write-Host "Site: $SiteUrl"
$me = Invoke-RestMethod -Uri "$SiteUrl/api/me" -Headers $headers -UseBasicParsing -TimeoutSec 20
if (-not $me.admin) { throw "The site did not accept the admin token. Check ADMIN_TOKEN in the site's .env." }
if (-not $me.current) { throw "The site has no installer version yet. Upload one in the Mods installer panel." }
Write-Host "Current pack on the site: $($me.current)"

$temp = Join-Path $env:TEMP ("deploy-" + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $temp | Out-Null
$zip = Join-Path $temp 'pack.zip'
Write-Host "Downloading the pack..."
Invoke-WebRequest -Uri "$SiteUrl/api/releases/current/download" -OutFile $zip -Headers $headers -UseBasicParsing -TimeoutSec 300
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($zip, $temp)
$installer = Get-ChildItem -LiteralPath $temp -Recurse -Filter 'Install-MinecraftMods.cmd' -File | Select-Object -First 1
if (-not $installer) { throw "The pack has no Install-MinecraftMods.cmd inside." }
if (-not (Test-Path -LiteralPath (Join-Path $installer.DirectoryName 'pack.json'))) { throw "The pack has no pack.json next to the installer." }

# The installer does the work in server mode: mods + models into <server>\mods, then it reports target=server.
$env:MCMODS_SERVER_DIR   = $ServerDir
$env:MCMODS_ADMIN_TOKEN  = $AdminToken
$env:MCMODS_REPORT_URL   = "$SiteUrl/api/installs"
$env:MCMODS_NO_PAUSE     = '1'
Write-Host ""
& cmd.exe /c "`"$($installer.FullName)`""
if ($LASTEXITCODE -ne 0) { $failed = $true; Write-Host "The installer reported problems (see above and Install-MinecraftMods.log next to it)." -ForegroundColor Yellow }
Copy-Item -LiteralPath (Join-Path $installer.DirectoryName 'Install-MinecraftMods.log') -Destination (Join-Path $ServerDir 'deploy-server.log') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
if (-not $failed) { Write-Host ""; Write-Host "Deployed. Start the Minecraft server again." -ForegroundColor Green }
} catch {
  $failed = $true
  Write-Host ""
  Write-Host "STOPPED: $($_.Exception.Message)" -ForegroundColor Red
}
if ($Host.Name -eq 'ConsoleHost') { Read-Host "Press Enter to close" | Out-Null }
if ($failed) { exit 1 }

<# :
@echo off
setlocal
title Minecraft mod installer
set "MCMODS_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([IO.File]::ReadAllText($env:MCMODS_SELF))"
exit /b %errorlevel%
#>
# ==========================================================================================
#  Minecraft mod installer  -  double-click to run.  Needs pack.json in the same folder.
#
#  What it does on the player's PC:
#    1. finds the Minecraft folder (any drive / any location)
#    2. installs Fabric Loader for the pack's Minecraft version and adds a
#       "fabric-loader-<version>" launcher installation
#    3. installs every mod listed in pack.json into the mods folder, verifying checksums
#    4. removes mods that this script installed earlier but that are no longer in pack.json
#  A log is written next to this file (Install-MinecraftMods.log). Errors stay on screen.
#
#  FOR THE DEVELOPERS: edit pack.json, never this file. See README.md for the fields.
# ==========================================================================================


$InstallerUrl = 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.2/fabric-installer-1.1.2.jar'
$UserAgent    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Install-MinecraftMods/3.0'
$ManifestName = 'installed-by-mod-installer.json'   # kept in the mods folder: what this script put there

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$selfDir = if ($env:MCMODS_SELF) { Split-Path -Parent $env:MCMODS_SELF } elseif ($PSScriptRoot) { $PSScriptRoot } else { [Environment]::GetFolderPath('Desktop') }
$LogFile = Join-Path $selfDir 'Install-MinecraftMods.log'
try { Start-Transcript -Path $LogFile -Force | Out-Null } catch { }
$failed   = $false
$problems = @()
$launcherTypes = @{ 'launcher_profiles.json' = 'win32'; 'launcher_profiles_microsoft_store.json' = 'microsoft_store' }

try {
# ---------------- Load pack.json ----------------
$PackFile = Join-Path $selfDir 'pack.json'
if (-not (Test-Path -LiteralPath $PackFile)) { throw "pack.json was not found next to this script ($PackFile). Keep the whole folder together." }
try { $pack = Get-Content -LiteralPath $PackFile -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { throw "pack.json could not be read: $($_.Exception.Message)" }
$PackName     = [string]$pack.packName;         if (-not $PackName) { $PackName = 'Mod pack' }
$PackVersion  = [string]$pack.packVersion
$McVersion    = [string]$pack.minecraftVersion; if (-not $McVersion) { throw "pack.json has no minecraftVersion." }
$FabricLoader = [string]$pack.fabricLoader
$ModList      = @($pack.mods);                  if (-not $ModList) { throw "pack.json has no mods." }
$MinecraftDir = [string]$pack.minecraftDir
$Force        = [bool]$pack.force
foreach ($m in $ModList) {
  if (-not $m.name -or -not $m.match) { throw "Every mod in pack.json needs at least a name and a match pattern." }
  if (-not ($m.localFile -or $m.modrinth -or $m.url -or $m.page)) { throw "Mod '$($m.name)' in pack.json has no localFile, modrinth, url or page." }
}

# Talking to the LAN File Share site: the installer download for a signed-in player carries a report address and a
# personal token in pack.json ("report"), so the site can show who runs which version. The deploy command on the
# Minecraft server passes the same things through MCMODS_* environment variables plus the admin token.
$Report = $pack.report
$ReportUrl   = if ($env:MCMODS_REPORT_URL) { $env:MCMODS_REPORT_URL } elseif ($Report) { [string]$Report.url } else { '' }
$ReportToken = if ($Report) { [string]$Report.token } else { '' }
$AdminToken  = [string]$env:MCMODS_ADMIN_TOKEN
$SiteHost    = ''
try { if ($ReportUrl) { $SiteHost = ([uri]$ReportUrl).Host } } catch { }
function Get-SiteHeaders($url) {
  # Only the site gets our tokens, never Modrinth or CurseForge.
  $h = @{}
  try { if ($SiteHost -and (([uri]$url).Host -eq $SiteHost)) {
    if ($ReportToken) { $h['Authorization'] = "Bearer $ReportToken" }
    if ($AdminToken)  { $h['X-Admin-Token'] = $AdminToken }
  } } catch { }
  return $h
}
$ServerMode = [bool]$env:MCMODS_SERVER_DIR   # set by deploy-server.cmd: install into a Minecraft server folder
$installedNow = @()

# Extra mod lists fetched live, e.g. the models the server admin marked as uploaded on the LAN File Share site.
# An entry from a list replaces a pack.json entry with the same match pattern.
$feedFailed = $false
foreach ($feedUrl in @($pack.modListUrls)) {
  if (-not $feedUrl) { continue }
  if ($feedUrl -match 'FRIEND-PC') { Write-Host "[skip] modListUrls in pack.json still has the placeholder address, no models fetched." -ForegroundColor DarkYellow; continue }
  try {
    $feed = @(Invoke-RestMethod -Uri $feedUrl -UseBasicParsing -UserAgent 'Install-MinecraftMods/3.0' -TimeoutSec 20 -Headers (Get-SiteHeaders $feedUrl))
    $n = 0
    foreach ($e in $feed) {
      if (-not $e.name -or -not $e.match -or -not ($e.url -or $e.page)) { continue }
      $ModList = @($ModList | Where-Object { $_.match -ne $e.match }) + @([pscustomobject]@{ name = [string]$e.name; match = [string]$e.match; file = [string]$e.file; url = [string]$e.url; sha256 = [string]$e.sha256; page = [string]$e.page })
      $n++
    }
    Write-Host "Mod list from $feedUrl : $n entr$(if ($n -eq 1) { 'y' } else { 'ies' })"
  } catch {
    $feedFailed = $true
    $problems += "Could not read the mod list from $feedUrl ($($_.Exception.Message)). Those mods were skipped this time, run again when the site is reachable."
  }
}

Write-Host "$PackName $PackVersion for Minecraft $McVersion   ($(Get-Date -Format 'yyyy-MM-dd HH:mm'), Windows $([Environment]::OSVersion.Version), PowerShell $($PSVersionTable.PSVersion))"

function Test-Jar($path) {
  # A real .jar is a zip file, which always starts with the letters "PK"
  if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $false }
  try {
    $fs = [IO.File]::OpenRead($path)
    try { return ($fs.Length -gt 1000 -and $fs.ReadByte() -eq 0x50 -and $fs.ReadByte() -eq 0x4B) }
    finally { $fs.Dispose() }
  } catch { return $false }
}

function Get-Download($url, $outFile) {
  try {
    if (Test-Path -LiteralPath $outFile) { Remove-Item -LiteralPath $outFile -Force }
    Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing -UserAgent $UserAgent -TimeoutSec 120 -Headers (Get-SiteHeaders $url)
    return (Test-Jar $outFile)
  } catch {
    Write-Host "  download failed: $($_.Exception.Message)" -ForegroundColor DarkYellow
    return $false
  }
}

function Test-Hash($path, $algorithm, $expected) {
  if (-not $expected) { return $true }
  return ((Get-FileHash -LiteralPath $path -Algorithm $algorithm).Hash -ieq $expected)
}

# ---------------- 0. Find the Minecraft folder ----------------
function Find-MinecraftDir {
  param([string]$Hint)
  $isMc = { param($d) (Test-Path -LiteralPath (Join-Path $d 'launcher_profiles.json')) -or
                       (Test-Path -LiteralPath (Join-Path $d 'launcher_profiles_microsoft_store.json')) }
  if ($Hint) {
    if (& $isMc $Hint) { return (Get-Item -LiteralPath $Hint).FullName }
    throw "No Minecraft Launcher data found in $Hint"
  }
  $candidates = @()
  if ($env:APPDATA)      { $candidates += Join-Path $env:APPDATA '.minecraft' }
  if ($env:USERPROFILE)  { $candidates += (Join-Path $env:USERPROFILE '.minecraft'), (Join-Path $env:USERPROFILE 'AppData\Roaming\.minecraft') }
  if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.4297127D64EC6_8wekyb3d8bbwe\LocalCache\Roaming\.minecraft' }
  foreach ($c in $candidates) { if (& $isMc $c) { return (Get-Item -LiteralPath $c).FullName } }

  Write-Host "Minecraft is not in the usual place. Searching your drives (this can take a minute)..."
  $roots = @()
  if ($env:USERPROFILE) { $roots += $env:USERPROFILE }
  $roots += Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -ne $null -and $_.Root -match '^[A-Z]:\\$' } | ForEach-Object { $_.Root }
  $skip  = '\\(Windows|Program Files|Program Files \(x86\)|\$Recycle\.Bin|System Volume Information|node_modules|\.git)(\\|$)'
  $found = @()
  foreach ($root in ($roots | Select-Object -Unique)) {
    $queue = New-Object System.Collections.Generic.Queue[object]
    $queue.Enqueue(@{ Path = $root; Depth = 0 })
    while ($queue.Count -gt 0) {
      $item = $queue.Dequeue()
      if ($item.Depth -gt 6) { continue }
      if (& $isMc $item.Path) { $found += (Get-Item -LiteralPath $item.Path).FullName; continue }
      try {
        Get-ChildItem -LiteralPath $item.Path -Directory -Force -ErrorAction SilentlyContinue |
          Where-Object { $_.FullName -notmatch $skip -and -not $_.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) } |
          ForEach-Object { $queue.Enqueue(@{ Path = $_.FullName; Depth = $item.Depth + 1 }) }
      } catch { }
    }
    if ($found) { break }
  }
  $found = @($found | Select-Object -Unique)
  if ($found.Count -eq 1) { return $found[0] }
  if ($found.Count -gt 1) {
    Write-Host "More than one Minecraft folder was found:"
    for ($i = 0; $i -lt $found.Count; $i++) { Write-Host "  [$($i + 1)] $($found[$i])" }
    do { $pick = Read-Host "Type the number of the one you play from and press Enter" } until ($pick -match '^\d+$' -and [int]$pick -ge 1 -and [int]$pick -le $found.Count)
    return $found[[int]$pick - 1]
  }
  throw "No Minecraft Launcher data found. Install Minecraft (Java Edition), open the Minecraft Launcher once, close it, and run this again."
}

if ($ServerMode) {
  $mc = $env:MCMODS_SERVER_DIR
  if (-not (Test-Path -LiteralPath (Join-Path $mc 'fabric-server-launch.jar'))) { throw "No fabric-server-launch.jar in $mc. Install Fabric on the server first (fabric installer, server mode)." }
  Write-Host "Minecraft SERVER folder: $mc"
} else {
  $mc = Find-MinecraftDir -Hint $MinecraftDir
  Write-Host "Minecraft folder: $mc"
}
$modsDir = Join-Path $mc 'mods'
$profileFiles = if ($ServerMode) { @() } else { @($launcherTypes.Keys | ForEach-Object { Join-Path $mc $_ } | Where-Object { Test-Path -LiteralPath $_ }) }

$loaderPattern = if ($FabricLoader) { [regex]::Escape($FabricLoader) } else { '[^"]+' }
$loaderWild    = if ($FabricLoader) { $FabricLoader } else { '*' }
function Test-FabricProfile($file) {
  $pattern = '"lastVersionId"\s*:\s*"fabric-loader-' + $loaderPattern + '-' + [regex]::Escape($McVersion) + '"'
  return [bool]((Get-Content -LiteralPath $file -Raw) -match $pattern)
}
function Get-FabricVersionDir {
  $versions = Join-Path $mc 'versions'
  if (-not (Test-Path -LiteralPath $versions)) { return $null }
  return Get-ChildItem -LiteralPath $versions -Directory | Where-Object {
    $_.Name -like "fabric-loader-$loaderWild-$McVersion" -and (Test-Path -LiteralPath (Join-Path $_.FullName "$($_.Name).json"))
  } | Sort-Object Name -Descending | Select-Object -First 1
}

# ---------------- 1. Fabric loader + launcher installation ----------------
$missing = @($profileFiles | Where-Object { -not (Test-FabricProfile $_) })
if ($ServerMode) {
  Write-Host "[skip] Server mode: Fabric is the server's own installation."
} elseif (-not $Force -and (Get-FabricVersionDir) -and -not $missing) {
  Write-Host "[skip] Fabric for Minecraft $McVersion is already installed ($((Get-FabricVersionDir).Name))."
} else {
  if (-not $missing -or $Force) { $missing = $profileFiles }

  # The launcher rewrites its installation list when it closes, so it must be closed first
  while (Get-Process -Name MinecraftLauncher, Minecraft -ErrorAction SilentlyContinue) {
    $reply = Read-Host "The Minecraft Launcher is open. Close it (also from the tray near the clock), then press Enter. Type skip to continue anyway"
    if ($reply -match '^\s*skip') { break }
  }

  # Find Java: JAVA_HOME, PATH, or the copy bundled with the Minecraft Launcher
  $java = $null
  if ($env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\java.exe'))) { $java = Join-Path $env:JAVA_HOME 'bin\java.exe' }
  if (-not $java) { $java = (Get-Command java.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
  if (-not $java) {
    $roots = @()
    if ($env:LOCALAPPDATA) { $roots += Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.4297127D64EC6_8wekyb3d8bbwe\LocalCache\Local\runtime' }
    if (${env:ProgramFiles(x86)}) { $roots += Join-Path ${env:ProgramFiles(x86)} 'Minecraft Launcher\runtime' }
    if ($env:ProgramFiles) { $roots += (Join-Path $env:ProgramFiles 'Minecraft Launcher\runtime'), (Join-Path $env:ProgramFiles 'Java'), (Join-Path $env:ProgramFiles 'Eclipse Adoptium') }
    $roots += Join-Path $mc 'runtime'
    $roots = @($roots | Where-Object { Test-Path -LiteralPath $_ })
    if ($roots) {
      $java = Get-ChildItem -LiteralPath $roots -Recurse -Filter java.exe -ErrorAction SilentlyContinue |
              Where-Object { $_.FullName -match '\\bin\\java\.exe$' } |
              Sort-Object @{ Expression = { $_.FullName -match 'jre-legacy|jre-x86' } }, @{ Expression = { $_.LastWriteTime }; Descending = $true } |
              Select-Object -First 1 -ExpandProperty FullName
    }
  }
  if (-not $java) { throw "Java was not found. Start Minecraft $McVersion once from the launcher (Latest Release) so it downloads Java, quit the game, then run this again." }
  Write-Host "Using Java: $java"

  $installer = Join-Path $env:TEMP (Split-Path $InstallerUrl -Leaf)
  if ($Force -or -not (Test-Jar $installer)) {
    Write-Host "Downloading the Fabric installer..."
    if (-not (Get-Download $InstallerUrl $installer)) { throw "The Fabric installer could not be downloaded from $InstallerUrl" }
  }
  $loaderArgs = @(); if ($FabricLoader) { $loaderArgs = @('-loader', $FabricLoader) }

  if (-not $missing) {
    Write-Host "Installing Fabric for Minecraft $McVersion (no launcher profile file found)..."
    & $java -jar $installer client -dir $mc -mcversion $McVersion -noprofile @loaderArgs
    if ($LASTEXITCODE -ne 0) { $problems += "The Fabric installer reported an error (exit code $LASTEXITCODE)." }
  }
  foreach ($file in $missing) {
    $type = $launcherTypes[(Split-Path $file -Leaf)]
    Write-Host "Installing Fabric for Minecraft $McVersion ($type launcher)..."
    & $java -jar $installer client -dir $mc -mcversion $McVersion -launcher $type @loaderArgs
    if ($LASTEXITCODE -ne 0) { $problems += "The Fabric installer reported an error for the $type launcher (exit code $LASTEXITCODE)." }
  }

  $fabricDir = Get-FabricVersionDir
  if (-not $fabricDir) { throw "Fabric was not installed. Check the messages above." }
  Write-Host "[done] $($fabricDir.Name) installed."
  if ($profileFiles | Where-Object { -not (Test-FabricProfile $_) }) {
    $problems += "Fabric is installed but the launcher installation is missing. In the launcher: Installations > New installation > Version > $($fabricDir.Name)."
  }
}

# ---------------- 2. Mods ----------------
function Get-RunningGame {
  # The game client is a java/javaw process whose command line points into the Minecraft folder.
  # A dedicated server (fabric-server-launch.jar etc.) does not match and is left alone.
  try {
    if ($ServerMode) {
      return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^javaw?\.exe$' -and ([string]$_.CommandLine) -match [regex]::Escape($mc) })
    }
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $_.Name -match '^javaw?\.exe$' -and ([string]$_.CommandLine) -match '\.minecraft|net\.minecraft\.client|KnotClient|minecraft\.exe'
    })
  } catch { return @() }
}
while (Get-RunningGame) {
  $reply = Read-Host $(if ($ServerMode) { "The Minecraft server is running from $mc. Stop it (type stop in its window), then press Enter. Type skip to continue anyway" } else { "Minecraft is running. Mods only load when the game starts, so quit the game, then press Enter. Type skip to continue anyway" })
  if ($reply -match '^\s*skip') { break }
}

New-Item -ItemType Directory -Force -Path $modsDir | Out-Null
$manifest = Join-Path $modsDir $ManifestName
$managed  = @()
if (Test-Path -LiteralPath $manifest) { try { $managed = @((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json)) } catch { } }
$installedNow = @()

function Find-Download($pattern) {
  $dirs = @()
  try { $dirs += (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path } catch { }
  if ($env:USERPROFILE) { $dirs += (Join-Path $env:USERPROFILE 'Downloads'), (Join-Path $env:USERPROFILE 'Desktop') }
  $dirs = @($dirs | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique)
  if (-not $dirs) { return $null }
  return Get-ChildItem -LiteralPath $dirs -File -ErrorAction SilentlyContinue |
         Where-Object { $_.Name -like $pattern -and (Test-Jar $_.FullName) } |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

function Get-ModrinthLatest($slug) {
  # Newest Modrinth release of a project for this Minecraft version and Fabric
  try {
    $gv = [uri]::EscapeDataString("[`"$McVersion`"]"); $ld = [uri]::EscapeDataString('["fabric"]')
    $r = Invoke-RestMethod -Uri "https://api.modrinth.com/v2/project/$slug/version?game_versions=$gv&loaders=$ld" -UseBasicParsing -UserAgent $UserAgent -TimeoutSec 60
    $v = @($r | Where-Object { $_.version_type -eq 'release' } | Select-Object -First 1)
    if (-not $v) { $v = @($r | Select-Object -First 1) }
    if (-not $v) { return $null }
    $f = @($v[0].files | Where-Object { $_.primary } | Select-Object -First 1)
    if (-not $f) { $f = @($v[0].files | Select-Object -First 1) }
    return @{ File = $f[0].filename; Url = $f[0].url; Sha512 = $f[0].hashes.sha512 }
  } catch { Write-Host "  Modrinth lookup for '$slug' failed: $($_.Exception.Message)" -ForegroundColor DarkYellow; return $null }
}

foreach ($mod in $ModList) {
  # Work out which exact file this mod should be: localFile -> Modrinth -> url -> page
  $url = $mod.url; $fileName = $mod.file; $sha256 = $mod.sha256; $sha512 = $null; $local = $null
  if ($mod.localFile) {
    $local = Join-Path $selfDir $mod.localFile
    if (Test-Jar $local) { $fileName = Split-Path $local -Leaf; $url = $null }
    else { Write-Host "  bundled file $($mod.localFile) is missing or not a jar, trying online sources" -ForegroundColor DarkYellow; $local = $null }
  }
  if (-not $local -and $mod.modrinth) {
    $latest = Get-ModrinthLatest $mod.modrinth
    if ($latest) { $url = $latest.Url; $fileName = $latest.File; $sha512 = $latest.Sha512; $sha256 = $null }
  }
  if (-not $fileName) { $problems += "$($mod.name): pack.json has no file name for it and no Modrinth result."; continue }

  $existing = @(Get-ChildItem -LiteralPath $modsDir -File | Where-Object { $_.Name -like $mod.match })
  $good = $existing | Where-Object { $_.Name -eq $fileName -and (Test-Jar $_.FullName) } | Select-Object -First 1
  if ($good -and -not $Force) {
    Write-Host "[skip] $($mod.name) is up to date ($($good.Name))."
    $installedNow += $good.Name
    continue
  }
  $locked = $false
  foreach ($e in $existing) {
    Write-Host "Removing old $($mod.name) file $($e.Name)"
    try { Remove-Item -LiteralPath $e.FullName -Force } catch { $locked = $true; Write-Host "  could not remove it: $($_.Exception.Message)" -ForegroundColor DarkYellow }
  }
  if ($locked) { $problems += "$($mod.name): an old copy is in use and could not be replaced. Quit Minecraft and run this again."; continue }

  $target = Join-Path $modsDir $fileName
  $installed = $false

  if ($local) {
    Write-Host "Copying bundled $($mod.name)..."
    try { Copy-Item -LiteralPath $local -Destination $target -Force; $installed = $true }
    catch { Write-Host "  could not write $target : $($_.Exception.Message)" -ForegroundColor DarkYellow }
  }

  if (-not $installed -and $url) {
    Write-Host "Downloading $($mod.name)..."
    $tmp = Join-Path $env:TEMP ("mcmod-" + [IO.Path]::GetRandomFileName() + ".jar")
    if (Get-Download $url $tmp) {
      if ((Test-Hash $tmp SHA256 $sha256) -and (Test-Hash $tmp SHA512 $sha512)) {
        try { Move-Item -LiteralPath $tmp -Destination $target -Force; $installed = $true }
        catch { Write-Host "  could not write $target : $($_.Exception.Message)" -ForegroundColor DarkYellow }
      } else {
        Write-Host "  the downloaded file did not match the expected checksum" -ForegroundColor DarkYellow
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      }
    }
  }

  if (-not $installed -and $mod.page) {
    # Browser download: reuse a copy that is already in Downloads, otherwise open the page
    $file = Find-Download $mod.match
    if (-not $file) {
      Start-Process $mod.page
      Write-Host "$($mod.name) is downloading in your browser."
      Write-Host "If the browser warns that the file could be harmful, click Keep."
      do { $answer = Read-Host "Type y and press Enter when the download has finished" } until ($answer -match '^\s*y')
      $file = Find-Download $mod.match
    }
    if (-not $file) {
      Write-Host "Could not find the file automatically. Select the $($mod.name) jar in the window that opens."
      try {
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Title  = "Select the downloaded $($mod.name) jar"
        $dialog.Filter = 'Jar files (*.jar)|*.jar'
        if ($dialog.ShowDialog() -eq 'OK') { $file = Get-Item -LiteralPath $dialog.FileName }
      } catch { }
    }
    if ($file -and (Test-Jar $file.FullName)) {
      Move-Item -LiteralPath $file.FullName -Destination $target -Force
      $installed = $true
    }
  }

  if ($installed) { Write-Host "[done] $($mod.name) installed ($fileName)."; $installedNow += $fileName }
  else {
    $where = if ($mod.page) { $mod.page } else { $url }
    $problems += "$($mod.name) was not installed. Download it from $where and move it into $modsDir"
  }
}

# Mods that this script installed on an earlier run but that are no longer in the pack.
# Skipped when a mod list could not be read: its mods are not "dropped", just unknown right now.
if ($feedFailed) { $installedNow = @($installedNow + ($managed | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $modsDir $_)) })) | Select-Object -Unique }
foreach ($old in $managed) {
  if ($old -and ($installedNow -notcontains $old)) {
    $p = Join-Path $modsDir $old
    if (Test-Path -LiteralPath $p) {
      Write-Host "Removing $old (no longer part of the pack)."
      try { Remove-Item -LiteralPath $p -Force }
      catch { $installedNow += $old; $problems += "$old is in use and could not be removed. Quit Minecraft and run this again." }
    }
  }
}
try { ConvertTo-Json -InputObject @($installedNow) | Set-Content -LiteralPath $manifest -Encoding UTF8 } catch { }

# ---------------- 3. Result ----------------
$others = @(Get-ChildItem -LiteralPath $modsDir -File | Where-Object { $_.Extension -eq '.jar' -and ($installedNow -notcontains $_.Name) })
if ($others) {
  Write-Host ""
  Write-Host "Note: other mods are in the mods folder (not from this pack). If the game will not start, move these out:" -ForegroundColor Yellow
  $others | ForEach-Object { Write-Host "  $($_.Name)" -ForegroundColor Yellow }
}

Write-Host ""
if ($problems) {
  $failed = $true
  Write-Host "Finished with problems:" -ForegroundColor Yellow
  $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
  Write-Host "Send the file $LogFile to whoever gave you this script." -ForegroundColor Yellow
} else {
  if ($ServerMode) { Write-Host "All done. Start the Minecraft server again to load the mods." -ForegroundColor Green }
  else { Write-Host "All done. Quit Minecraft if it is running, open the Minecraft Launcher, pick 'fabric-loader-$McVersion' in the drop-down next to Play, and press Play." -ForegroundColor Green }
}

} catch {
  $failed = $true
  Write-Host ""
  Write-Host "STOPPED: $($_.Exception.Message)" -ForegroundColor Red
  if ($_.InvocationInfo.ScriptLineNumber) { Write-Host "  (script line $($_.InvocationInfo.ScriptLineNumber))" -ForegroundColor DarkGray }
  if ($problems) { $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow } }
  Write-Host "Nothing more was changed. Send the file $LogFile to whoever gave you this script." -ForegroundColor Yellow
} finally {
  if ($ReportUrl) {
    try {
      $body = @{ packVersion = [string]$PackVersion; ok = (-not $failed -and -not $problems); minecraft = [string]$McVersion; problems = @($problems)
                 mods = @($installedNow); machine = [string]$env:COMPUTERNAME; target = $(if ($ServerMode) { 'server' } else { 'client' }) } | ConvertTo-Json -Compress
      $headers = Get-SiteHeaders $ReportUrl; $headers['Content-Type'] = 'application/json'
      Invoke-RestMethod -Uri $ReportUrl -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($body)) -Headers $headers -UseBasicParsing -TimeoutSec 20 | Out-Null
      Write-Host "Reported to the site$(if ($Report -and $Report.user) { " as $($Report.user)" })." -ForegroundColor DarkGray
    } catch { Write-Host "Could not report to the site: $($_.Exception.Message)" -ForegroundColor DarkYellow }
  }
  try { Stop-Transcript | Out-Null } catch { }
}
if ($Host.Name -eq 'ConsoleHost' -and -not $env:MCMODS_NO_PAUSE) { Read-Host "Press Enter to close" | Out-Null }
if ($failed) { exit 1 }

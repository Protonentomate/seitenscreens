# Seitenscreens auf den neusten Stand bringen (aufgerufen von Aktualisieren.bat).
#
# - Ist der Projektordner ein Git-Klon: git pull
# - Sonst: aktuellen Stand als ZIP von GitHub laden und ueber den Ordner kopieren
# Danach installiert/baut ensure-build.mjs, was noetig ist. Einstellungen und
# Kalibrierung (%APPDATA%\seitenscreens) und die Vorlagen (Nextcloud) liegen
# ausserhalb des Projektordners und werden nie angefasst.

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
$zipUrl = 'https://github.com/Protonentomate/seitenscreens/archive/refs/heads/main.zip'

function Test-AppRunning {
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://localhost:8080/api/health' | Out-Null
    return $true
  } catch {
    return $false
  }
}

try {
  $hasGit = (Test-Path (Join-Path $root '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)
  if ($hasGit) {
    Write-Host 'Hole den neusten Stand (git pull) ...'
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw 'git pull fehlgeschlagen (lokale Aenderungen im Projektordner?)' }
  } else {
    Write-Host 'Lade den neusten Stand von GitHub (ZIP) ...'
    $tmp = Join-Path $env:TEMP 'seitenscreens-update'
    $zip = "$tmp.zip"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Invoke-WebRequest -UseBasicParsing $zipUrl -OutFile $zip
    Expand-Archive $zip $tmp -Force
    $src = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
    # Quellcode spiegeln (entfernte Dateien verschwinden), Rest nur ergaenzen.
    # node_modules, out, dev und .git bleiben, wie sie sind.
    robocopy (Join-Path $src 'src') (Join-Path $root 'src') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Kopieren von src fehlgeschlagen (robocopy $LASTEXITCODE)" }
    robocopy $src $root /E /XD node_modules out dev .git src /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Kopieren fehlgeschlagen (robocopy $LASTEXITCODE)" }
    Remove-Item $tmp -Recurse -Force
    Remove-Item $zip -Force
  }

  if (Test-AppRunning) {
    Write-Host ''
    Write-Host 'Neuer Stand ist geholt. Seitenscreens laeuft gerade - bitte beenden'
    Write-Host '(schwarzes Konsolenfenster schliessen) und ueber das Desktop-Icon neu starten.'
    Write-Host 'Beim Start baut sich die App automatisch neu (ein paar Sekunden bis Minuten).'
  } else {
    node (Join-Path $root 'scripts\ensure-build.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Installieren/Bauen fehlgeschlagen - Meldung oben lesen' }
    Write-Host ''
    Write-Host 'Fertig. Seitenscreens ueber das Desktop-Icon starten.'
  }
} catch {
  Write-Host ''
  Write-Host "Fehler: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

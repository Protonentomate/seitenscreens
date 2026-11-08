# Verknuepfung "Seitenscreens" auf Desktop, im Startmenue und im Projektordner
# anlegen (aufgerufen von "Desktop-Verknuepfung erstellen.bat").
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$target = Join-Path $PSScriptRoot 'Seitenscreens starten.bat'
$icon = Join-Path $root 'build\icon.ico'
$shell = New-Object -ComObject WScript.Shell

$places = @(
  @{ Name = 'Desktop'; Dir = [Environment]::GetFolderPath('Desktop') },
  @{ Name = 'Startmenue'; Dir = [Environment]::GetFolderPath('Programs') },
  @{ Name = 'Projektordner'; Dir = $root }
)

$ok = 0
foreach ($p in $places) {
  try {
    $lnk = $shell.CreateShortcut((Join-Path $p.Dir 'Seitenscreens.lnk'))
    $lnk.TargetPath = $target
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = $icon
    $lnk.Description = 'Seitenscreens Projektion starten'
    $lnk.Save()
    Write-Host "Verknuepfung angelegt: $($p.Name)"
    $ok++
  } catch {
    Write-Host "Konnte die Verknuepfung nicht anlegen ($($p.Name)): $($_.Exception.Message)" -ForegroundColor Red
  }
}
if ($ok -gt 0) {
  Write-Host ''
  Write-Host 'Fertig: Doppelklick auf "Seitenscreens" startet die Projektion.'
  Write-Host 'Die Verknuepfung im Projektordner kann man beliebig weiterkopieren.'
}

@echo off
setlocal
rem Legt eine Verknuepfung "Seitenscreens" (mit Icon) auf dem Desktop an.
set "ROOT=%~dp0..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "TARGET=%~dp0Seitenscreens starten.bat"
set "ICON=%ROOT%\build\icon.ico"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $lnk=$ws.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Seitenscreens.lnk'); $lnk.TargetPath='%TARGET%'; $lnk.WorkingDirectory='%ROOT%'; $lnk.IconLocation='%ICON%'; $lnk.Description='Seitenscreens Projektion starten'; $lnk.Save()"

if errorlevel 1 (
  echo Konnte die Verknuepfung nicht anlegen.
) else (
  echo Verknuepfung "Seitenscreens" liegt jetzt auf dem Desktop.
)
pause

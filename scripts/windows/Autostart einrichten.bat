@echo off
setlocal
rem Startet Seitenscreens kuenftig automatisch (unsichtbar) bei der Windows-Anmeldung.
rem Voraussetzung fuer den Kirchen-PC: automatische Anmeldung des Technik-Benutzers.
set "ROOT=%~dp0..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "VBS=%~dp0Seitenscreens starten unsichtbar.vbs"
set "ICON=%ROOT%\build\icon.ico"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $lnk=$ws.CreateShortcut([Environment]::GetFolderPath('Startup')+'\Seitenscreens.lnk'); $lnk.TargetPath='C:\Windows\System32\wscript.exe'; $lnk.Arguments='\"%VBS%\"'; $lnk.WorkingDirectory='%ROOT%'; $lnk.IconLocation='%ICON%'; $lnk.Save()"

if errorlevel 1 (
  echo Konnte den Autostart nicht einrichten.
) else (
  echo Seitenscreens startet ab jetzt automatisch bei der Windows-Anmeldung.
  echo Rueckgaengig: "Autostart entfernen.bat" ausfuehren.
)
pause

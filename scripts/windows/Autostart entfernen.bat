@echo off
rem Entfernt den Seitenscreens-Autostart wieder.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item ([Environment]::GetFolderPath('Startup')+'\Seitenscreens.lnk') -ErrorAction SilentlyContinue"
echo Autostart entfernt (falls er eingerichtet war).
pause

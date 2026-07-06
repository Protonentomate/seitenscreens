@echo off
title Seitenscreens
rem Dieses Skript liegt in scripts\windows - zwei Ebenen hoch ist das Projekt.
cd /d "%~dp0..\.."

rem Nach frischem Kopieren oder Update installiert und baut sich die App selbst.
if not exist "node_modules\" (
  echo Erster Start: installiere Abhaengigkeiten ^(dauert ein paar Minuten^) ...
  call npm install || goto :fehler
)

rem Electron-Programmdatei pruefen: der Binary-Download beim npm install
rem schlaegt manchmal fehl (Firewall, unterbrochen, ignore-scripts). Dann fehlt
rem electron.exe trotz node_modules und der Start bricht mit "Electron uninstall"
rem ab. In dem Fall die Binary gezielt nachladen (das reparierte den Fehler).
if not exist "node_modules\electron\dist\electron.exe" (
  if exist "node_modules\electron\install.js" (
    echo Electron-Programmdatei fehlt - lade sie nach ...
    call node "node_modules\electron\install.js" || goto :fehler
  ) else (
    echo Electron-Paket unvollstaendig - installiere neu ...
    call npm install || goto :fehler
    call node "node_modules\electron\install.js" || goto :fehler
  )
)

if not exist "out\main\index.js" (
  echo Baue die App ...
  call npm run build || goto :fehler
)

call npm start
exit /b

:fehler
echo.
echo Etwas ist schiefgelaufen - Meldung oben lesen. Ist Node.js installiert?
pause

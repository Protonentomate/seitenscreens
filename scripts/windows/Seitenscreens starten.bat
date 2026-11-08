@echo off
title Seitenscreens
rem Dieses Skript liegt in scripts\windows - zwei Ebenen hoch ist das Projekt.
cd /d "%~dp0..\.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js ist nicht installiert - bitte die LTS-Version von https://nodejs.org installieren.
  pause
  exit /b 1
)

rem Installiert und baut bei Bedarf neu: beim ersten Start und nach jedem
rem Update (Pruefsummen in node_modules\.seitenscreens-deps und out\.build-stamp).
rem Einstellungen und Kalibrierung liegen in %APPDATA%\seitenscreens und
rem werden dabei nie angefasst.
call node scripts\ensure-build.mjs || goto :fehler

call npm start
exit /b

:fehler
echo.
echo Etwas ist schiefgelaufen - Meldung oben lesen.
pause

@echo off
title Seitenscreens
rem Dieses Skript liegt in scripts\windows - zwei Ebenen hoch ist das Projekt.
cd /d "%~dp0..\.."

rem Nach frischem Kopieren oder Update installiert und baut sich die App selbst.
if not exist "node_modules\" (
  echo Erster Start: installiere Abhaengigkeiten ^(dauert ein paar Minuten^) ...
  call npm install || goto :fehler
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

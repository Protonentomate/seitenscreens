@echo off
title Seitenscreens aktualisieren
rem Holt den neusten Stand (git pull bzw. ZIP von GitHub). Einstellungen,
rem Kalibrierung und Vorlagen bleiben unveraendert. Alles in EINER Zeile,
rem weil das Update auch diese Datei ersetzen kann.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0aktualisieren.ps1" & pause & exit /b

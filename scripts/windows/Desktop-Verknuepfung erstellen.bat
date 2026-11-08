@echo off
rem Legt die Verknuepfung "Seitenscreens" (mit Icon) auf dem Desktop, im
rem Startmenue und im Projektordner an. Die Verknuepfung kann man danach
rem beliebig kopieren - sie zeigt immer auf diesen Projektordner.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verknuepfungen.ps1"
pause

' Startet Seitenscreens ohne sichtbares Konsolenfenster (fuer den Autostart).
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
bat = fso.GetParentFolderName(WScript.ScriptFullName) & "\Seitenscreens starten.bat"
shell.Run """" & bat & """", 0, False

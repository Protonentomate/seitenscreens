# Kurzanleitung: Windows-Installation, Desktop-Icon & Autostart

Die Schnellversion für den Beamer-PC — die ausführliche Anleitung mit
Einrichtung, Stream Deck und Fehlersuche steht in
[INSTALLATION-WINDOWS.md](INSTALLATION-WINDOWS.md).

## 1. Einmalig installieren

1. **Node.js LTS** von https://nodejs.org installieren (Standard-Optionen).
2. **ffmpeg**: „release essentials"-ZIP von https://www.gyan.dev/ffmpeg/builds/
   nach `C:\ffmpeg\` entpacken und `C:\ffmpeg\bin` zum PATH hinzufügen
   (Details in der ausführlichen Anleitung, Abschnitt 1).
3. Den Projektordner `seitenscreens` auf den PC kopieren, z.B. nach
   `C:\seitenscreens` (USB-Stick, Netzwerk oder `git clone`).

Mehr braucht es nicht — `npm install` und der Build passieren beim ersten
Start automatisch.

## 2. Desktop-Icon anlegen

Im Explorer `C:\seitenscreens\scripts\windows\` öffnen und doppelklicken:

> **`Desktop-Verknuepfung erstellen.bat`**

Danach liegt **„Seitenscreens"** (blaues 4-Leinwände-Icon) auf dem Desktop.

## 3. Starten

**Doppelklick auf das Desktop-Icon.** Beim allerersten Mal installiert und
baut sich die App selbst (ein paar Minuten, Fortschritt im schwarzen
Fenster); danach startet sie in wenigen Sekunden:

- Zwei Vollbild-Fenster erscheinen auf den Beamern, der letzte Inhalt wird
  wiederhergestellt.
- Steuerung im Browser: `http://localhost:8080` (Anwender) bzw.
  `http://localhost:8080/admin` (Verwaltung) — auch vom Handy/Laptop über
  `http://<IP-des-PCs>:8080`.
- Wenn Windows beim ersten Start wegen der **Firewall** fragt:
  „Zugriff zulassen" (private Netzwerke).

Ein zweiter Doppelklick startet keine zweite Instanz — die App läuft nur
einmal. **Beenden:** ein Beamer-Fenster in den Vordergrund holen und
`Alt+F4`, oder das schwarze Konsolenfenster schliessen.

## 4. Autostart (startet mit Windows)

Doppelklick auf:

> **`Autostart einrichten.bat`**

Ab dann startet Seitenscreens bei jeder Windows-Anmeldung automatisch und
**unsichtbar** (kein Konsolenfenster). Damit das nach einem Stromausfall
ohne Tastatur funktioniert, muss der Technik-Benutzer **automatisch
angemeldet** werden (Windows-Auto-Login: `Win+R` → `netplwiz` → Haken
„Benutzer müssen Benutzernamen … eingeben" entfernen).

Wieder ausschalten: **`Autostart entfernen.bat`**.

> Hinweis: Diese Variante ist die einfache. Die robustere mit automatischem
> Neustart bei Absturz (Aufgabenplanung) steht in der ausführlichen
> Anleitung, Abschnitt 6 — und M6 bringt später einen richtigen Installer.

## 5. Nach einem Update

Neuen Stand des Ordners auf den PC kopieren, dann einmal im Projektordner
`npm run build` ausführen (oder einfach `out\` löschen — dann baut der
nächste Doppelklick automatisch neu).

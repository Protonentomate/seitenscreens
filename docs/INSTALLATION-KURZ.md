# Kurzanleitung: Windows-Installation, Desktop-Icon, Autostart & Update

Die Schnellversion für den Beamer-PC — die ausführliche Anleitung mit
Einrichtung, Stream Deck und Fehlersuche steht in
[INSTALLATION-WINDOWS.md](INSTALLATION-WINDOWS.md).

## 1. Einmalig installieren

1. **Node.js LTS** von https://nodejs.org installieren (Standard-Optionen).
2. **ffmpeg**: „release essentials"-ZIP von https://www.gyan.dev/ffmpeg/builds/
   nach `C:\ffmpeg\` entpacken und `C:\ffmpeg\bin` zum PATH hinzufügen
   (Details in der ausführlichen Anleitung, Abschnitt 1).
3. Den Projektordner `seitenscreens` auf den PC holen, z.B. nach
   `C:\seitenscreens` — am besten per `git clone`, oder den Ordner
   kopieren **ohne** die Unterordner `node_modules` und `out`.

> **Wichtig:** `node_modules` NICHT von einem anderen Rechner (z.B. Mac)
> mitkopieren — darin stecken plattformspezifische Programmdateien (Electron,
> Bildverarbeitung), die nur auf dem Rechner laufen, auf dem sie installiert
> wurden. Sonst kommt beim Start `Error: Electron uninstall`.

Mehr braucht es nicht — `npm install`, das Nachladen der Electron-Programmdatei
und der Build passieren beim ersten Start automatisch.

## 2. Desktop-Icon anlegen

Im Explorer `C:\seitenscreens\scripts\windows\` öffnen und doppelklicken:

> **`Desktop-Verknuepfung erstellen.bat`**

Danach gibt es die Verknüpfung **„Seitenscreens"** (blaues 4-Leinwände-Icon)
dreimal: auf dem **Desktop**, im **Startmenü** (Windows-Taste, „Seitenscreens"
tippen) und direkt im **Projektordner**. Die Verknüpfung lässt sich beliebig
weiterkopieren — sie zeigt immer auf den Projektordner. Wird der Projektordner
verschoben, das Skript einfach nochmals ausführen.

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

## 5. Beamer später einschalten / anschliessen

Die App muss nicht warten, bis die Beamer laufen:

- **Fehlt beim Start ein Beamer**, wartet sein Fenster versteckt — es legt
  sich nicht mehr über den Hauptbildschirm. Die Steuerung zeigt oben
  „Beamer … nicht erkannt".
- **Sobald der Beamer da ist** (eingesteckt oder eingeschaltet), erscheint
  das Fenster nach etwa einer Sekunde von selbst im Vollbild auf ihm.
- Der **Hauptbildschirm** (Bediener-Monitor) wird nie automatisch für einen
  Beamer verwendet. Bei einem PC ohne eigenen Monitor lässt sich das unter
  `/admin` → „Anzeige" ausschalten.
- **Erster Start bzw. noch nicht bestätigt:** Die App verteilt die Fenster
  von links nach rechts und blendet auf den Leinwänden kurz „links"/„rechts"
  ein. Oben in der Steuerung fragt sie: „Stimmen links und rechts?" →
  **„Ja, stimmt"** merkt sich die Zuordnung, **„Links ↔ rechts tauschen"**
  korrigiert sie (und merkt sie sich ebenfalls). Danach fragt sie nicht mehr.
- Vergibt Windows einem Beamer nach dem Neu-Anschliessen eine neue
  Display-ID, erkennt die App ihn an Name, Auflösung und Position wieder.

## 6. Update (neuer Code)

Doppelklick auf:

> **`scripts\windows\Aktualisieren.bat`**

Das Skript holt den neusten Stand — per `git pull`, wenn der Ordner ein
Git-Klon ist, sonst als ZIP von GitHub — und installiert/baut, was nötig
ist. Läuft Seitenscreens gerade, sagt es Bescheid: dann die App beenden und
über das Desktop-Icon neu starten. Beim Start prüft die App selbst, ob der
Code neu ist, und baut sich dann automatisch neu (Prüfsummen, ein paar
Sekunden bis Minuten). Den Ordner `out\` muss man nicht mehr von Hand löschen.

**Was bei einem Update erhalten bleibt — immer:**

| Was | Wo | Vom Update betroffen? |
|---|---|---|
| Einstellungen, Kalibrierung, Bildschirm-Zuordnung, Wand-Layout | `%APPDATA%\seitenscreens\config.json` (+ `.bak`) | nein — liegt ausserhalb des Projektordners |
| Letzter Inhalt auf den Leinwänden | `%APPDATA%\seitenscreens\last-state.json` | nein |
| Vorlagen, Einzelbilder, Originale | Nextcloud-Medienordner | nein |
| Vorschaubilder, Zwischenspeicher | `%APPDATA%\seitenscreens\…` | werden bei Bedarf neu gerechnet |

Neue Einstellungen aus einer neueren Version bekommen beim ersten Start
ihren Standardwert; ältere Einträge werden übernommen und bei Bedarf ergänzt
(z.B. merkt sich die App zu einer alten Bildschirm-Zuordnung zusätzlich
Name und Auflösung des Displays). Fehlende Hover-Vorschauen für ältere
Videos rechnet die App nach dem Start im Hintergrund nach.

**Vorsicht:** Im Projektordner selbst nichts von Hand ändern — `git pull`
bricht sonst ab („lokale Änderungen"). Zur Sicherheit vor grösseren Updates:
`/admin` → „Einstellungen" → „Konfiguration herunterladen".

**Ohne Skript** (z.B. am Mac): `git pull`, danach `node scripts/ensure-build.mjs`.

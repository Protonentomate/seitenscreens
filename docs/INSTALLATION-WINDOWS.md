# Installation & Betrieb auf dem Beamer-PC (Windows)

Anleitung für die Einrichtung auf dem Kirchen-PC oder einem neuen Rechner.

> **Stand:** Bis Meilenstein M6 fertig ist (NSIS-Installer, Autostart,
> gebündeltes ffmpeg), läuft die App über Node.js aus dem Quellcode.
> Die Schritte hier funktionieren jetzt schon — der Installer macht sie
> später überflüssig. Abschnitte, die M6 betreffen, sind markiert.

## 1. Voraussetzungen

1. **Node.js LTS** (≥ 20): https://nodejs.org → „LTS" installieren
2. **ffmpeg + ffprobe**: https://www.gyan.dev/ffmpeg/builds/ →
   „release essentials" ZIP entpacken nach `C:\ffmpeg\` und
   `C:\ffmpeg\bin` zum PATH hinzufügen
   (Systemsteuerung → System → Erweiterte Systemeinstellungen →
   Umgebungsvariablen → Path → Bearbeiten → Neu).
   Test in einer neuen Eingabeaufforderung: `ffmpeg -version`
   *(entfällt mit M6 — wird dann mitgeliefert)*
3. **Nextcloud-Client** eingerichtet, Ordner
   `…\Nextcloud\Technische Dienste\Licht_Video\SeitenScreens\_Vorlagen`
   wird synchronisiert
4. Beide Beamer angeschlossen; Windows-Anzeige auf **Erweitern**,
   je 1920×1080, Skalierung 100 %

## 2. Installation

```bat
cd C:\
git clone <repo-url> seitenscreens   REM oder Ordner vom Mac kopieren
cd seitenscreens
npm install
npm run build
```

## 3. Erststart & Einrichtung

```bat
npm start
```

1. Es öffnen sich zwei Vollbild-Fenster auf den Beamern (bei nur einem
   Bildschirm: Simulator-Fenster).
2. Browser auf **http://localhost:8080** (oder von einem anderen Gerät:
   `http://<IP-des-PCs>:8080`).
3. **⚙︎ Einstellungen** → „Medienordner" auf den Nextcloud-`_Vorlagen`-Pfad
   setzen, z.B. `C:\Users\Techniker\Nextcloud\Technische Dienste\Licht_Video\SeitenScreens\_Vorlagen`
4. Beamer-IPs prüfen (Standard: links 192.168.100.95, rechts 192.168.100.96).
5. Kalibrierung: kommt aus dem OBS-Import bzw. wird mit M5 direkt in der
   Web-UI justierbar. Import vom alten OBS-Export:
   `npm run import-streamfx -- --obs <export.json> --config <pfad-zur-config>`
   (Config-Pfad steht in `/api/health` → `mediaRoot` daneben; Standard:
   `%APPDATA%\seitenscreens\config.json`)
6. **Testbild** in der UI einschalten und prüfen, ob die Quads auf den
   Leinwänden sitzen.

## 4. Windows-Firewall

Beim ersten Start fragt Windows nach — **Zugriff zulassen** (private Netzwerke),
sonst können Handy/Tablet/Stream-Deck-PC die Steuerung nicht erreichen.
Manuell: `netsh advfirewall firewall add rule name="Seitenscreens" dir=in
action=allow protocol=TCP localport=8080`

## 5. Stream Deck umstellen

Das vorhandene Plugin **„API Request"** (`com.github.mjbnz.sd-api-request`)
weiterverwenden — nur die URLs ändern (Methode GET, kein Body):

| Knopf | URL |
|---|---|
| Vorlage 1 | `http://<PC-IP>:8080/api/template/Scene%201/apply` |
| Weiss | `http://<PC-IP>:8080/api/template/Szene%208%2C%20White/apply` |
| Schwarz/Blackout | `http://<PC-IP>:8080/api/blackout/toggle` |
| Beamer ein | `http://<PC-IP>:8080/api/projector/on` |
| Beamer aus | `http://<PC-IP>:8080/api/projector/off` |
| Video Pause/Weiter | `http://<PC-IP>:8080/api/video/toggle` |

Tipp: Leerzeichen und Kommas in Vorlagen-Namen URL-kodieren (`%20`, `%2C`) —
oder den fertigen Link aus `/api/templates` kopieren.
Die alten Beamer-ein/aus-Knöpfe (direkt auf `…/form/control_cgi`)
funktionieren unverändert weiter.

## 6. Autostart *(bis M6: manuell einrichten)*

Aufgabenplanung (`taskschd.msc`) → Einfache Aufgabe:
- Trigger: **Bei Anmeldung** (des Technik-Benutzers, mit Auto-Login)
- Aktion: Programm `cmd`, Argumente `/c cd /d C:\seitenscreens && npm start`
- Nach Erstellen → Eigenschaften: „Aufgabe neu starten bei Fehler" alle
  1 Minute, 3 Versuche
- Windows-Energieoptionen: Bildschirm **nie** ausschalten, kein Standby;
  Windows-Update-Nutzungszeit über die Gottesdienstzeiten legen

M6 bringt: Ein-Klick-Installer, sauberen Autostart, Preflight-Ampel
(Sonntagmorgen-Check), Display-Zuordnung mit Identify/Tausch in der UI.

## 7. Zurück zu OBS (Notfall-Rollback)

Das alte Setup bleibt installiert. Falls nötig:
1. Seitenscreens-Aufgabe in der Aufgabenplanung deaktivieren, App beenden
2. OBS starten, Szenensammlung „Seitenbeamer_Grundeinstellung_Brian" laden
3. Rechtsklick auf Szene → Vollbild-Projektor auf die beiden Beamer
4. Alte GUI/Stream-Deck-Profile funktionieren wie bisher

## 8. Fehlersuche

| Symptom | Prüfen |
|---|---|
| Steuerung nicht erreichbar | Firewall-Regel? Richtige IP? `http://localhost:8080/api/health` direkt am PC |
| „Medienordner nicht gefunden" | Nextcloud fertig gesynct? Pfad in Einstellungen korrekt? |
| Video spielt nicht / Warnung ⚠ | Badge-Text lesen: kaputte Datei, 60 fps oder falscher Codec → über Verwaltung neu verarbeiten (M4) |
| Videos ruckeln | `/api/health` → `tools` ok? Hardware-Decode-Check kommt mit M6-Preflight |
| Beamer „!" | IP korrekt? Beamer im selben Netz? Webinterface `http://<beamer-ip>` erreichbar? |
| Bild auf falschem Beamer | Bis M6: Windows-Anzeigeeinstellungen → Monitore 1/2 tauschen; ab M6 Knopf in der UI |

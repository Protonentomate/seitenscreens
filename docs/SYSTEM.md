# System: Anforderungen, Architektur & Entscheidungen

Stand: Juli 2026. Dieses Dokument hält fest, **was** das System können muss,
**wie** es gebaut ist und **warum** — damit spätere Arbeiten (neue Features,
anderer Entwickler, KI-Assistent) ohne Archäologie weitermachen können.

## 1. Ausgangslage & Anforderungen

### Physisches Setup
- 2 Beamer (je 1920×1080 quer) an einem Windows-PC, projizieren links und
  rechts der Hauptleinwand
- Jeder Beamer bespielt **2 weisse Hochformat-Leinwände** → 4 logische Screens:
  `LinksLinks`, `LinksRechts`, `RechtsLinks`, `RechtsRechts`
- Content-Format pro Leinwand: Hochformat 9:16 (Bilder 1080×1920)
- Beamer sind netzwerksteuerbar: `POST http://192.168.100.95|.96/form/control_cgi`
  mit Body `btn_powon=btn_powon` (ein) bzw. `btn_powoff=btn_powoff` (aus)
- Zielrechner aktuell: i5-7500T, 8 GB RAM, Intel HD 630 iGPU (Upgrade geplant,
  Baseline bleibt aber diese Hardware)

### Was das System können muss
1. Bilder & **loopende Videos** (Motion Graphics, 5–30 s) corner-pinned auf die
   4 Leinwände projizieren — Videos über alle Screens **synchron** (< 40 ms)
2. Bedienung durch Freiwillige: Web-UI im LAN (Handy/Tablet/PC) + Stream Deck
3. Medien kommen aus dem **Nextcloud-Ordner `_Vorlagen`** (Konvention unten) —
   Mitarbeiter legen einfach Dateien ab, kein Spezialwissen nötig
4. Typische Nutzung: 1–4 Folienwechsel pro Gottesdienst, weiche Überblendung (~300 ms)
5. Blackout, Testbild, Beamer ein/aus, globale Video-Pause + Position
6. Kiosk-Betrieb: Autostart nach Boot, übersteht Abstürze, Sonntagmorgen-tauglich
7. Keine Authentifizierung — bewusste Entscheidung (Kirchen-LAN, Einfachheit)

### Explizit verschoben/abgelehnt
- PJLink-Beamer-Steuerung: nicht nötig (control_cgi funktioniert), Treiber-Schicht
  ist aber austauschbar gebaut
- „Serie"-Unterordner in Vorlagen-Ordnern: alte Artefakte, werden ignoriert
- PIN-Schutz für Admin-Funktionen: bewusst weggelassen

## 2. Architektur

Eine einzige **Electron-App** auf dem Beamer-PC, drei Rollen:

```
Browser (LAN) ──HTTP/WS──┐
Stream Deck ──HTTP───────┤
                         ▼
        ┌─ Main-Process ─────────────────────────┐
        │ Fastify :8080 (REST, WS, UI, Medien)   │
        │ State-Store (einzige Wahrheit)         │
        │ Medien-Index (chokidar + ffprobe-Gate) │
        │ Schattencache (userData/cache)         │
        │ Beamer-Treiber (control_cgi)           │
        └───────────┬────────────────────────────┘
                    │ IPC (Zustands-Schnappschüsse)
      ┌─────────────┴─────────────┐
      ▼                           ▼
Player-Fenster links        Player-Fenster rechts
(2 Quads, matrix3d)         (2 Quads, matrix3d)
      │                           │
   Beamer links              Beamer rechts
```

### Kernideen (und warum)

**Corner-Pin per CSS `matrix3d`** — Homographie aus 4 Eckpunkten
(Adjugaten-Methode, `src/shared/homography.ts`). Reine GPU-Compositor-Arbeit,
null JS pro Frame, Hardware-Video-Decode bleibt aktiv. Kein WebGL nötig.

**Video-Sync über die Wanduhr** — Der Store vergibt pro Umschaltung eine
gemeinsame **Epoche** (`epochMs`). Soll-Position jedes Videos =
`((jetzt − epochMs) / 1000) mod dauer`. Alle Prozesse teilen dieselbe
Maschinenuhr → kein Uhrenproblem. Ein Regler pro Video
(`src/renderer/sync.ts`, requestVideoFrameCallback) korrigiert Abweichungen:
Deadband 15 ms → playbackRate-Nudge ±4 % → harter Seek ab 200 ms.
Loop-Ruckler heilen sich dadurch selbst. **Pause** = Zeitpunkt merken,
**Resume** = alle Epochen um die Pausendauer verschieben, **Seek** = Epochen
neu setzen — Synchronität bleibt konstruktionsbedingt erhalten.

**Schattencache** — Abgespielt wird nie direkt aus dem Nextcloud-Ordner,
sondern aus einer lokalen Kopie (`userData/cache`), versioniert über
mtime+size. Nextcloud kann dadurch nie eine laufende Wiedergabe stören;
eine ersetzte Datei wird als neue Version erkannt und sauber neu geladen.

**ffprobe-Gate** — Jedes Video im Index wird geprüft. Hart abgelehnt
(spielt nicht): Codec ≠ h264/vp9/av1, > 32 fps, > 1080×1920. Weiche Warnung
(spielt mit Badge): Tonspur, grösser als nötig. Kaputte/halb gesyncte Dateien
→ nicht abspielbar. Nur ein fehlendes ffprobe winkt im Zweifel durch.
Grund: direkt in Nextcloud abgelegte Dateien umgehen die Ingest-Pipeline —
ohne Gate ruckelt so etwas erst live am Sonntag.

**Ein State-Store, komplette Schnappschüsse** — Alle Mutationen laufen
serialisiert durch `src/main/store.ts`; jede Änderung geht als vollständiger
Snapshot an Player (IPC) und Web-Clients (WS). UIs sind dumme Funktionen des
Zustands, kein Diffing, keine Drift. Letzter Zustand übersteht Neustarts
(`last-state.json`, Videos bekommen dann eine frische gemeinsame Epoche).

**media://-Protokoll mit Range-Support** — Chromiums Media-Stack verlangt
HTTP-206-Antworten; ohne eigenen Range-Handler bleiben Videos bei
`readyState=HAVE_METADATA` hängen (Electron-Falle: `net.fetch(file://)`
reicht NICHT).

## 3. Medien-Konventionen (`_Vorlagen`-Ordner)

```
_Vorlagen/
├── Scene 1/                  ← Unterordner = Vorlage
│   ├── LinksLinks.jpg        ← eine Datei pro Leinwand
│   ├── LinksRechts.mp4       ← Video schlägt Bild (mp4 > webm > png > jpg > webp)
│   ├── RechtsLinks.jpg
│   └── RechtsRechts.jpg
├── Worship.jpg               ← lose Datei = Einzelbild (auf beliebige Leinwand legbar)
└── _irgendwas/, Archiv/, Serie*/ ← ignoriert (auch ._*, *.part, *.tmp)
```

- Vorlagen dürfen unvollständig sein (Anwenden verlangt dann Bestätigung/`force=1`)
- Gross-/Kleinschreibung der Dateinamen ist egal, Umlaute funktionieren (NFC-Normalisierung)

**Encoding-Kontrakt für Videos** (Ziel der Ingest-Pipeline, Gate im Index):
H.264 High, yuv420p, ≤ 30 fps CFR, pro Leinwand ~720×1280 (max. 1080×1920),
ohne Tonspur, closed GOP (Keyframe-Intervall 2 s, kein Scene-Cut), `+faststart`.
Referenz-ffmpeg-Flags: `-c:v libx264 -preset veryfast -crf 18 -profile:v high
-level 4.0 -vf fps=30,scale=…,format=yuv420p -g 60 -keyint_min 60
-sc_threshold 0 -bf 2 -movflags +faststart -an`

## 4. Konfiguration

`config.json` (Pfad: `%APPDATA%/seitenscreens/` bzw. via Env
`SEITENSCREENS_CONFIG`), atomisch geschrieben, `.bak` der Vorversion:

- `mediaRoot` — Pfad zum Nextcloud-`_Vorlagen`-Ordner (per Web-UI änderbar)
- `screens` — Kalibrierung: 4 Eckpunkte pro Leinwand in Fenster-Pixeln (1920×1080)
- `transitionMs`, `server.port`, `simulator`, `projectors` (IPs + Treiber)

**StreamFX-Import**: `npm run import-streamfx` konvertiert die Corner-Pin-Werte
aus einem OBS-Export. Formel (am StreamFX-Quellcode verifiziert):
`pixel = (prozent/100 + 1) × quellgrösse/2 + szenen-position` — die Prozente
leben in einem −1…+1-Raum mit Ursprung in der Quellmitte, y nach unten.

Env-Overrides: `SEITENSCREENS_CONFIG`, `SEITENSCREENS_FFMPEG`, `SEITENSCREENS_FFPROBE`.

## 5. Meilensteine / Stand

| # | Inhalt | Stand |
|---|---|---|
| M1 | Player-Kern: Fenster, matrix3d, Bilder, Blackout, Crossfade, Testbild, StreamFX-Import | ✅ |
| M2 | Video-Engine: Wanduhr-Sync, Loop, Drift-Regler (< 10 ms gemessen) | ✅ |
| M3 | Medien-Index, Schattencache, REST/WS-API, Control-UI, Beamer ein/aus, Video-Pause/Seek | ✅ |
| M4 | Admin-Upload: Normalisieren, single/clone/**span mit Leinwand-Abständen**, Job-Queue | 🔨 |
| M5 | Kalibrier-UI: Ecken ziehen am Live-Output, Layout-Editor, Re-Render | ⬜ |
| M6 | Windows-Kiosk: Display-Mapping, Autostart, Preflight-Ampel, NSIS-Installer, ffmpeg-Vendoring | ⬜ |

Auf echte Hardware verschoben (M6): Degradations-Fallback bei Frame-Drops
während Überblendungen, Verifikation Hardware-Decode (D3D11), Worst-Case-Test
4 verschiedene Videos + Crossfade auf HD 630, Kaltstart-Budget ≤ 60 s.

## 6. Bekannte Punkte / Wartungshinweise

- **Rollback**: Das alte OBS-Setup bleibt auf dem Beamer-PC installiert
  (Autostart deaktiviert), bis 4–6 Gottesdienste fehlerfrei liefen.
- Beamer-Status ist optimistisch (HTTP 200 = geschaltet); die Webinterfaces
  liefern keinen sauberen Status. Bei Bedarf später Status-Polling ergänzen.
- Port 8080 belegt → App loggt Fehler, Player läuft weiter (Steuerung dann
  nicht erreichbar). Port ist in der Config änderbar.
- 17 Review-Findings aus dem M3-Review blieben unverifiziert (Session-Limit);
  die plausiblen wurden trotzdem gefixt, Details im Commit `2e94cd6`.

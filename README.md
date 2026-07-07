# Seitenscreens

Projektions-Software für Seitenbeamer in Kirchen, Sälen und auf Bühnen —
entstanden als Ersatz für ein OBS+StreamFX-Setup. Zwei Beamer projizieren
auf je zwei Hochformat-Leinwände (4 logische Screens: **LinksLinks,
LinksRechts, RechtsLinks, RechtsRechts**). Die App verzerrt Bilder und
loopende Videos per Corner-Pin exakt auf die Leinwände, hält Videos über
alle vier Screens synchron (< 10 ms) und wird über ein Web-Interface oder
ein Stream Deck bedient.

**Weitere Doku:**
- [docs/SYSTEM.md](docs/SYSTEM.md) — Anforderungen, Architektur, Entscheidungen, Medien-Konventionen
- [docs/INSTALLATION-KURZ.md](docs/INSTALLATION-KURZ.md) — Schnellversion: Desktop-Icon & Autostart per Doppelklick (`scripts/windows/`)
- [docs/INSTALLATION-WINDOWS.md](docs/INSTALLATION-WINDOWS.md) — Installation & Betrieb auf dem Beamer-PC (ausführlich)
- [docs/STREAMDECK.md](docs/STREAMDECK.md) — Stream Deck verbinden (URLs, Gruppen, Vorschau-Bilder auf den Knöpfen)

## Schnellstart (Entwicklung, macOS/Windows)

Voraussetzungen: Node.js ≥ 20, ffmpeg + ffprobe im PATH (macOS: `brew install ffmpeg`).

```bash
npm install

# Einmalig: lokale Dev-Config anlegen (dev/ ist nicht versioniert)
mkdir -p dev
echo '{ "mediaRoot": "/pfad/zum/medienordner" }' > dev/config.json

# Optional: Kalibrierung aus einem bestehenden OBS/StreamFX-Export übernehmen
npm run import-streamfx -- --obs <obs-export.json> --config ./dev/config.json --media-root <medienordner>

# Starten (Simulator-Modus: beide Beamer als skalierte Fenster)
SEITENSCREENS_CONFIG=./dev/config.json npm run dev
```

Steuerung über zwei getrennte Seiten:

- **Anwender-Seite** `http://localhost:8080/` — Vorlagen anwenden (mit
  Gruppen-Tabs), Blackout, Testbild, Beamer ein/aus, Video-Pause/-Slider,
  Einzelbilder. Mehr sieht der Sonntags-Bediener nicht.
- **Admin-Seite** `http://localhost:8080/admin` (Link „Verwaltung →" oben
  rechts) — Tabs **Hochladen**, **Inhalte**, **Kalibrierung**, **Anzeige**,
  **Einstellungen** (u.a. Medienordner-Pfad). Bewusst getrennt, ohne Auth
  (Kirchen-LAN).

Vorlagen und Einzelbilder liegen im Medienordner (z.B. Nextcloud-gesynct),
optional gruppiert in Unterordnern (z.B. `Jugend/Scene 1/…`,
`Jugend/Worship.jpg`) — beide Seiten zeigen dafür Gruppen-Tabs; welcher Tab
vorgewählt ist, bestimmt die Einstellung „Standard-Gruppe". Details zur
Ordner-Konvention: [docs/SYSTEM.md](docs/SYSTEM.md), Abschnitt 3.

```bash
npm test           # Unit-Tests (Homographie, StreamFX-Import)
npm run typecheck  # TypeScript beider Welten (Node + Browser)
npm run build      # Produktions-Build nach out/
```

## Repo-Struktur

| Pfad | Inhalt |
|---|---|
| `src/main/` | Electron-Hauptprozess: Config, State-Store, Medien-Index (Watcher + ffprobe), Schattencache, Fastify-API, Beamer-Treiber, Fenster |
| `src/renderer/` | Player (`index.html` + `player.ts` + `sync.ts`) und Control-UI (`control.html` + Svelte-App) |
| `src/shared/` | Gemeinsame Typen, Homographie-Mathematik, StreamFX-Konvertierung |
| `tools/` | `import-streamfx.ts`: OBS-Export → Kalibrierung |
| `tests/` | Vitest-Unit-Tests |
| `docs/` | System- und Installations-Dokumentation |

## HTTP-API (Stream Deck & Skripte)

Die Bedien-Endpunkte funktionieren als einfache GETs (fürs Stream-Deck-Plugin
„API Request", `com.github.mjbnz.sd-api-request`) und liefern JSON `{ok, state}`.
Die POST-Endpunkte am Tabellenende sind primär für die Admin-UI gedacht.

| Endpunkt | Wirkung |
|---|---|
| `GET /api/template/{Name}/apply` | Vorlage anwenden (`?force=1` bei unvollständigen); Name case-insensitiv, muss über alle Gruppen eindeutig sein, sonst 409 mit Kandidatenliste |
| `GET /api/template/{Gruppe}/{Name}/apply` | Vorlage einer bestimmten Gruppe anwenden |
| `GET /api/screen/{Screen}/set?file={rel}` | Einzelne Leinwand setzen |
| `GET /api/screens/set?file={rel}&screens=all` | Alle Leinwände, synchroner Videostart |
| `GET /api/screen/{Screen}/clear` | Leinwand leeren |
| `GET /api/blackout/on\|off\|toggle` | Alles schwarz / wieder an |
| `GET /api/video/play\|pause\|toggle` | Videos global pausieren/fortsetzen |
| `GET /api/video/seek?toS={s}` | Alle Videos an Loop-Position springen |
| `GET /api/testpattern/on\|off` | Testbild für Kalibrier-Kontrolle |
| `GET /api/projector/on\|off` | Beide Beamer schalten (`/api/projector/{links\|rechts}/on\|off` einzeln) |
| `GET /api/state`, `/api/health`, `/api/templates` | Zustand, Diagnose, Medienliste |
| `GET /api/button/{Name}` | Quadratisches Knopf-Icon der Vorlage (Standard 144×144 JPEG; `?size=`, `?format=png`), direkt als Stream-Deck-Knopfbild nutzbar |
| `GET /api/button/{Gruppe}/{Name}` | Knopf-Icon einer Vorlage aus einer bestimmten Gruppe |
| `POST /api/upload` | Multipart-Upload: `mode` = `single`\|`clone`\|`span`\|`span2`\|`quad`, `fit` = `contain`\|`cover`\|`stretch`, `gaps` = `exact`\|`none` (Übergang beim Spannen), `mirror` = `1`\|`0` (nur span2: rechte Seite spiegeln), `group` = Gruppen-Ordner (optional). Bei `mode=quad` je eine Datei pro Leinwand über die Feldnamen `fileLinksLinks`/`fileLinksRechts`/`fileRechtsLinks`/`fileRechtsRechts` mit eigener Einpassung `fitLinksLinks` usw. `loopSmooth` = `1`\|`0` (Video-Loop weich überblenden), `loopCrossfadeS` = Überblendungsdauer in s (Standard 0,5) |
| `POST /api/template/{Name}/rerender` | Vorlage aus gesichertem Original + `_meta.json` neu rechnen (z.B. nach geänderten Wand-Massen) |
| `POST /api/template/{Gruppe}/{Name}/rerender` | dasselbe für eine Vorlage in einer Gruppe |
| `POST /api/rerender-all?modes=span,span2` | Alle Vorlagen der genannten Span-Modi neu rechnen |
| `POST /api/trash` | In den Papierkorb (`_Papierkorb/` im Medienordner) verschieben, Body `{type:'template', ref}` oder `{type:'single', file}` |
| `POST /api/calibration/{Screen}` | Leinwand-Ecken setzen, Body `{corners:{tl:{x,y},tr,br,bl}}` |
| `POST /api/calibration/focus` | Ecke auf der Leinwand magenta markieren, Body `{screen,corner}` (`{}` löscht die Markierung) |
| `POST /api/display/assign` | Beamer-Fenster einem Display zuordnen, Body `{window:'links'\|'rechts', displayId}` |
| `POST /api/display/rotation` | Ausgabe um 180° drehen, Body `{window, deg:0\|180}` |
| `GET\|POST /api/display/identify` | Fenster-Kennung 4 s gross einblenden (links/rechts) |
| `POST /api/display/refullscreen` | Vollbild auf den Beamer-Fenstern erzwingen |
| `GET /api/config/export` | Komplette Konfiguration (inkl. Kalibrierung) als JSON-Datei herunterladen |
| `POST /api/config/import` | Konfigurations-Backup zurückspielen (JSON-Body = exportierte Datei) |

Live-Updates für UIs: WebSocket `ws://…:8080/ws` (komplette Zustands-Schnappschüsse).

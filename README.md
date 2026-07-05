# Seitenscreens

Projektions-Software für die Seitenbeamer der Kirche — ersetzt das bisherige
OBS-Setup. Zwei Beamer projizieren auf je zwei weisse Hochformat-Leinwände
(4 logische Screens: **LinksLinks, LinksRechts, RechtsLinks, RechtsRechts**).
Die App verzerrt Bilder und loopende Videos per Corner-Pin exakt auf die
Leinwände, hält Videos über alle vier Screens synchron (< 10 ms) und wird
über ein Web-Interface oder das Stream Deck bedient.

**Weitere Doku:**
- [docs/SYSTEM.md](docs/SYSTEM.md) — Anforderungen, Architektur, Entscheidungen, Medien-Konventionen
- [docs/INSTALLATION-WINDOWS.md](docs/INSTALLATION-WINDOWS.md) — Installation & Betrieb auf dem Beamer-PC

## Schnellstart (Entwicklung, macOS/Windows)

Voraussetzungen: Node.js ≥ 20, ffmpeg + ffprobe im PATH (macOS: `brew install ffmpeg`).

```bash
npm install

# Einmalig: Kalibrierung aus dem alten OBS-Export übernehmen + Medienordner setzen
npm run import-streamfx -- \
  --obs "../Seitenbeamer_Grundeinstellung_Brian_OBS.json" \
  --config ./dev/config.json \
  --media-root "../_Vorlagen"

# Starten (Simulator-Modus: beide Beamer als skalierte Fenster)
SEITENSCREENS_CONFIG=./dev/config.json npm run dev
```

Steuerung: **http://localhost:8080** — Vorlagen anwenden, Blackout, Testbild,
Video-Pause/-Slider, Beamer ein/aus, Einstellungen (u.a. Medienordner-Pfad).

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

Alle Endpunkte funktionieren als einfache GETs (fürs Stream-Deck-Plugin
„API Request", `com.github.mjbnz.sd-api-request`) und liefern JSON `{ok, state}`.

| Endpunkt | Wirkung |
|---|---|
| `GET /api/template/{Name}/apply` | Vorlage anwenden (`?force=1` bei unvollständigen) |
| `GET /api/screen/{Screen}/set?file={rel}` | Einzelne Leinwand setzen |
| `GET /api/screens/set?file={rel}&screens=all` | Alle Leinwände, synchroner Videostart |
| `GET /api/screen/{Screen}/clear` | Leinwand leeren |
| `GET /api/blackout/on\|off\|toggle` | Alles schwarz / wieder an |
| `GET /api/video/play\|pause\|toggle` | Videos global pausieren/fortsetzen |
| `GET /api/video/seek?toS={s}` | Alle Videos an Loop-Position springen |
| `GET /api/testpattern/on\|off` | Testbild für Kalibrier-Kontrolle |
| `GET /api/projector/on\|off` | Beide Beamer schalten (`/api/projector/{links\|rechts}/on\|off` einzeln) |
| `GET /api/state`, `/api/health`, `/api/templates` | Zustand, Diagnose, Medienliste |

Live-Updates für UIs: WebSocket `ws://…:8080/ws` (komplette Zustands-Schnappschüsse).

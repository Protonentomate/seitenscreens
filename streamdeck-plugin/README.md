# Seitenscreens — Stream-Deck-Plugin

Kleines Stream-Deck-Plugin, das eine Vorlage anwendet **und** die Vorschau
automatisch als Knopf-Bild aktuell hält. Damit muss man das Bild nicht mehr
von Hand setzen: ändert sich der Inhalt einer Vorlage (Upload / „Neu rechnen"),
aktualisiert sich der Knopf beim nächsten Poll von selbst.

## Was der Knopf macht

- **Drücken** → `GET /api/template/{Vorlage}/apply` (Vorlage anwenden)
- **Hintergrund** → `GET /api/button/{Vorlage}?format=png&size=144` laden und
  als Knopf-Bild setzen (periodisch + direkt nach dem Anwenden)

## Installieren

1. Ordner `com.seitenscreens.deck.sdPlugin` in den Plugin-Ordner kopieren:
   - Windows: `%APPDATA%\Elgato\StreamDeck\Plugins\`
   - macOS: `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`
2. Stream-Deck-Software beenden und neu starten.
3. Aktion **Seitenscreens → „Vorlage anwenden"** auf einen Knopf ziehen und im
   Property Inspector einstellen:
   - **Basis-URL**: `http://<PC-IP>:8080` (am Beamer-PC: `http://localhost:8080`)
   - **Vorlage**: `Name` oder `Gruppe/Name` (z.B. `Pfimi/Welcome`)
   - **Beim Drücken anwenden**: an/aus
   - **Aktualisieren alle … Sekunden**: Standard 15

## Voraussetzungen / Hinweise

- Der Beamer-PC muss vom Stream-Deck-Gerät aus über `http://<PC-IP>:8080`
  erreichbar sein (gleiches Netz, Firewall-Freigabe — siehe
  [../docs/STREAMDECK.md](../docs/STREAMDECK.md)). Die App erlaubt CORS für alle
  Ursprünge, ein Aufruf vom Plugin funktioniert also direkt.
- Reines JS (klassische Stream-Deck-SDK, `SDKVersion 2`), kein Build-Schritt.
- Nicht signiert/paketiert — Installation als Ordner (oben). Zum Verteilen als
  `.streamDeckPlugin` bräuchte es Elgatos DistributionTool.
- Auf echter Stream-Deck-Hardware noch nicht getestet. Bei Problemen: Basis-URL
  im Browser des Stream-Deck-PCs prüfen (`…/api/button/<Vorlage>` muss ein Bild
  liefern), und dass die Vorlage exakt so heisst wie in der Verwaltung.

## Dateien

- `manifest.json` — Plugin-Metadaten + Aktion `com.seitenscreens.deck.template`
- `plugin.html` / `plugin.js` — Logik (WebSocket-Handshake, apply, Bild-Poll)
- `pi.html` / `pi.js` — Property Inspector (Einstellungen pro Knopf)
- `icons/` — Plugin-/Aktions-/Knopf-Icons

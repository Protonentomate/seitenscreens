# Stream Deck einrichten

Kurzanleitung, um die Seitenscreens per Elgato Stream Deck zu bedienen — inkl.
der Vorschau-Bilder auf den Knöpfen.

## 1. Plugin

Das Plugin **„API Request"** (`com.github.mjbnz.sd-api-request`) verwenden — es
ruft beim Tastendruck eine URL auf. Pro Knopf:

- **Method:** `GET`
- **URL:** einer der Endpunkte unten
- **Body:** leer

## 2. Basis-Adresse (IP des Beamer-PCs)

Vom Beamer-PC selbst: `http://localhost:8080`. Von einem anderen Gerät im
selben Netz (Stream-Deck-PC, Laptop, Handy): `http://<IP-des-Beamer-PCs>:8080`.

Die IP findest du am Beamer-PC in der Eingabeaufforderung mit `ipconfig`
(„IPv4-Adresse", z.B. `192.168.100.50`). In den Beispielen unten steht `<PC>`
dafür.

> Beim ersten Start muss die Windows-Firewall den Zugriff erlauben (private
> Netzwerke), sonst erreicht das Stream Deck den PC nicht. Siehe
> [INSTALLATION-WINDOWS.md](INSTALLATION-WINDOWS.md), Abschnitt Firewall.

## 3. Die wichtigsten URLs

| Knopf | URL (Method GET) |
|---|---|
| Vorlage anwenden | `http://<PC>:8080/api/template/{Name}/apply` |
| Vorlage aus Gruppe | `http://<PC>:8080/api/template/{Gruppe}/{Name}/apply` |
| Einzelbild auf alle 4 | `http://<PC>:8080/api/screens/set?file={Pfad}&screens=all` |
| Blackout ein/aus | `http://<PC>:8080/api/blackout/toggle` |
| Testbild ein/aus | `http://<PC>:8080/api/testpattern/on` bzw. `/off` |
| Video Pause/Weiter | `http://<PC>:8080/api/video/toggle` |
| Beide Beamer ein | `http://<PC>:8080/api/projector/on` |
| Beide Beamer aus | `http://<PC>:8080/api/projector/off` |
| Nur ein Beamer | `http://<PC>:8080/api/projector/{links\|rechts}/on` bzw. `/off` |

**Namen mit Leerzeichen/Komma** URL-kodieren: Leerzeichen → `%20`, Komma →
`%2C`. Beispiel: aus der Vorlage „Scene 1" wird
`http://<PC>:8080/api/template/Scene%201/apply`. Am einfachsten den fertigen
Link aus der Liste `http://<PC>:8080/api/templates` kopieren.

**Gruppen:** `/api/template/{Name}/apply` funktioniert, solange der Name über
alle Gruppen eindeutig ist (Gross-/Kleinschreibung egal). Kommt derselbe Name
in mehreren Gruppen vor, antwortet der Server mit einer Kandidatenliste — dann
die Gruppe mit in die URL nehmen: `…/api/template/{Gruppe}/{Name}/apply`.

## 4. Vorschau-Bild auf dem Knopf

Jede Vorlage liefert ein fertiges quadratisches Knopf-Bild (Ausschnitt der
ersten Leinwand der Vorlage):

```
http://<PC>:8080/api/button/{Name}
http://<PC>:8080/api/button/{Gruppe}/{Name}      (bei Gruppen)
```

Optional: `?size=144` (Pixel, Standard 144) und `?format=png` (Standard JPEG).
Bei Video-Vorlagen wird automatisch ein Standbild verwendet.

**So kommt das Bild auf den Knopf** (Stream-Deck-Software):

1. Die Button-URL im Browser öffnen und das Bild speichern (Rechtsklick →
   „Bild speichern unter…").
2. In der Stream-Deck-Software den Knopf auswählen und das gespeicherte Bild
   als Symbol setzen (Bereich „Symbol" / per Drag&Drop auf den Knopf).

So sieht man auf dem Knopf direkt, welche Vorlage er schaltet. Ändert sich der
Inhalt einer Vorlage (z.B. nach einem neuen Upload oder „Neu rechnen"), einfach
die URL erneut öffnen und das aktualisierte Bild neu setzen.

> Hinweis: Das „API Request"-Plugin selbst setzt keine Knopf-Bilder — es löst
> nur die Aktion aus. Das Vorschau-Bild wird wie oben von Hand als Symbol
> hinterlegt (einmalig pro Knopf).

## 5. Beispiel-Profil

Ein sinnvoller Sonntags-Aufbau: eine Reihe „Vorlagen anwenden" (je ein Knopf
pro häufiger Vorlage, mit Vorschau-Bild), plus feste Knöpfe für Blackout,
Video Pause/Weiter und Beamer ein/aus. Die alten Beamer-ein/aus-Knöpfe (direkt
auf das Beamer-Webinterface `…/form/control_cgi`) funktionieren unverändert
weiter.

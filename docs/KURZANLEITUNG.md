# Seitenscreens – Kurzanleitung

Für alle, die die Seitenscreens nur ab und zu bedienen oder eigene Bilder und
Videos dafür bereitstellen.

## Die vier Leinwände

Zwei Beamer bespielen je zwei Hochformat-Leinwände, links und rechts der Bühne:

```
   Beamer links            Bühne            Beamer rechts
┌────────┐ ┌────────┐                  ┌────────┐ ┌────────┐
│   LL   │ │   LR   │                  │   RL   │ │   RR   │
│ Links- │ │ Links- │                  │ Rechts-│ │ Rechts-│
│ Links  │ │ Rechts │                  │ Links  │ │ Rechts │
└────────┘ └────────┘                  └────────┘ └────────┘
```

Eine **Vorlage** füllt alle vier Leinwände auf einmal, ein **Einzelbild**
kommt auf eine oder alle Leinwände.

## 1. Einschalten

1. Den Beamer-PC einschalten. Seitenscreens startet von selbst und öffnet die
   Steuerung als Fenster (darf man schliessen, die Leinwände laufen weiter).
2. Die **Steuerung** öffnen: Desktop-Symbol „Seitenscreens Steuerung", die
   Taste auf dem Stream Deck oder vom Handy/Tablet im selben WLAN
   `http://<Adresse des Beamer-PCs>:8080`.
3. Oben bei „Beamer links" und „Beamer rechts" je **Ein** drücken. Die Anzeige
   wechselt auf „startet …" und nach etwa einer Minute auf **„an"**.

## 2. Bedienen

- **Gruppe wählen:** Die Reiter unter „Vorlagen" sind die Gruppen
  (z.B. Gottesdienst, Jugend).
- **Vorlage zeigen:** Bei der gewünschten Vorlage **Anwenden** drücken. Die
  laufende Vorlage ist blau umrandet und zeigt „Aktiv". Oben unter „Live" sieht
  man, was gerade auf den vier Leinwänden ist.
- **Vorschau:** Mit der Maus über eine Video-Vorlage fahren (am Handy: auf die
  Bilder tippen), dann läuft eine kurze Vorschau.
- **Einzelbild:** Unten bei „Einzelbilder" mit **Alle** auf alle vier
  Leinwände, oder mit LL, LR, RL, RR nur auf eine.
- **Blackout:** Alles schwarz. Nochmals drücken, und das Bild ist wieder da.
- **Video:** Mit **Pause** anhalten, mit dem Regler springen.
- **Zum Schluss:** Beide Beamer mit **Aus** ausschalten („kühlt ab …" →
  „aus"). Den PC kann man laufen lassen.

> Die **Verwaltung** (Link „Verwaltung →" oben rechts) braucht es nur zum
> Hochladen. Die Reiter „Kalibrierung", „Anzeige" und „Einstellungen" bitte
> nur anfassen, wenn man weiss, was man tut: Sie verändern das Bild live.

## 3. Eigene Bilder und Videos

### Weg A: Hochladen (empfohlen, vor allem für Videos)

1. Verwaltung → Reiter **„Hochladen"**.
2. **Datei** wählen (Bild oder Video).
3. **Gruppe** wählen oder „+ Neue Gruppe…", dann einen **Vorlagen-Namen**
   eingeben. Gibt es den Namen schon, wird diese Vorlage ersetzt.
4. **Aufteilung** wählen:

   | Auswahl | Ergebnis |
   |---|---|
   | Über alle 4 spannen (Standard) | Ein breites Bild/Video läuft über alle vier Leinwände |
   | Je über 2 spannen | Links und rechts dasselbe, je über zwei Leinwände (eine Seite lässt sich spiegeln) |
   | Gleich auf allen 4 | Dasselbe Bild viermal |
   | 4 Dateien | Für jede Leinwand eine eigene Datei |
   | Eine Leinwand | Nur eine Leinwand |

   Die übrigen Einstellungen (Strecken, „Korrekt, Mitte direkt") passen
   meistens so. Die Vorschau unten zeigt, wie es auf den Leinwänden aussieht.
5. **„Hochladen & verarbeiten"** drücken. Bilder sind nach wenigen Sekunden
   da, ein Video braucht etwa ein bis zwei Minuten. Danach steht die Vorlage in der
   Steuerung.

### Weg B: Direkt in den Medienordner (Nextcloud)

Gut für Bilder, die schon im richtigen Format sind. Der Aufbau:

```
Medienordner/
├── Jugend/                     ← Gruppe = ein Reiter in der Steuerung
│   ├── Sommerlager/            ← Vorlage (Ordnername = Name der Vorlage)
│   │   ├── LinksLinks.jpg
│   │   ├── LinksRechts.jpg
│   │   ├── RechtsLinks.jpg
│   │   └── RechtsRechts.jpg
│   ├── Plakat.jpg              ← Einzelbild (lose Datei in der Gruppe)
│   └── _Alt/                   ← wird nicht angezeigt
└── Gottesdienst/
    └── …
```

- **Vorlage:** ein Ordner mit genau diesen vier Dateinamen: `LinksLinks`,
  `LinksRechts`, `RechtsLinks`, `RechtsRechts` (Gross-/Kleinschreibung egal).
  Erlaubt sind `.jpg`, `.png`, `.webp` und `.mp4`. Fehlt eine Datei, zeigt die
  App eine Warnung.
- **Einzelbild:** eine lose Bilddatei direkt im Gruppenordner. Der Dateiname
  ist egal, nur **nie** `LinksLinks` usw.: Sonst hält die App den ganzen
  Gruppenordner für eine Vorlage, und seine Vorlagen verschwinden.
- **Format:** Hochformat **1080 × 1920** Pixel pro Leinwand. Videos lieber über
  Weg A hochladen, die App macht sie dann passend (Grösse, 30 fps, ohne Ton).
- **Ausblenden statt löschen:** Ordner, die mit `_` beginnen oder „Archiv"
  heissen, zeigt die App nicht an. Was man in der Verwaltung löscht, landet in
  `_Papierkorb`.
- Neue Dateien erscheinen nach ein paar Sekunden in der Steuerung, sobald die
  Nextcloud sie auf den Beamer-PC synchronisiert hat.

## 4. Wenn etwas nicht stimmt

| Problem | Was tun |
|---|---|
| Alles schwarz | Ist **Blackout** aktiv? Nochmals drücken. |
| Eine Leinwand bleibt immer schwarz | Steht oben „Weihnachtsbaum-Modus"? Dann ist sie absichtlich aus (Verwaltung → „Einstellungen"). |
| Beamer zeigt „?" | Kurz warten, der Status kommt nach ein paar Sekunden. |
| Beamer zeigt „offline" | Beamer ohne Strom oder Netzwerkkabel? |
| Links und rechts vertauscht | Verwaltung → „Anzeige" → „Links ↔ rechts tauschen". |
| Neue Vorlage fehlt | Dateinamen prüfen (siehe oben); ist die Nextcloud fertig synchronisiert? |
| Steuerung lädt nicht | Am Beamer-PC das Desktop-Symbol „Seitenscreens" starten. |

Weitere Hilfe: die verantwortliche Person aus dem Technikteam.

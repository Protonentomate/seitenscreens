# Offene Punkte

Stand: November 2026. Erledigtes wandert in die Doku bzw. ins Git-Log.

## 1. Bedienungsanleitung: erledigt (21.11.2026)

Öffentlich und neutral im Repo:

- `docs/KURZANLEITUNG.md` für Gelegenheitsnutzer (bedienen, Probleme, Inhalte
  ablegen oder hochladen)
- `docs/HANDBUCH.md` für die Technik (Hochladen im Detail, Kalibrierung,
  Anzeige, Einstellungen, Sicherung, Weihnachtsbaum-Modus, Stream Deck,
  Update), Bilder in `docs/img/`

Die Fassung für die eigene Kirche (mit Namen, Ordnerpfaden, IP-Adressen,
Stream-Deck-Belegung) liegt nur lokal in `dev/anleitung/` und kommt nicht ins
Repo. Offen dort: drei Screenshots (`websteuerung.png`, `hochladen.png`,
`anzeige.png`) zeigen noch die Oberfläche vor dem 21.11.2026.

## 2. Beamer-Status: nach dem Update vor Ort prüfen

**Befund (15.11.2026):** Beide Beamer sind Optoma 1080P und sprechen
**PJLink ohne Passwort** (`PJLINK 0`, Klasse 2, keine Fehler gemeldet). Die
alte Anzeige war falsch, weil die App den Status nie abfragte, sondern nur den
zuletzt geschickten Befehl zeigte.

**Eingebaut:** Status per PJLink alle 30 s, nach einem Befehl 2 Minuten lang
alle 3 s; Anzeige „an", „aus", „startet …", „kühlt ab …", „offline"
(Details in SYSTEM.md, Abschnitt 6). Vom Mac aus gegen die echten Beamer
getestet (beide „an", 10 schnelle Abfragen in Folge problemlos).

**Stand 15.11.2026:** Update auf dem Beamer-PC installiert, beide Beamer
zeigen „an" (per PJLink); Ausschalten über die Steuerung funktioniert laut
Brian. **Noch offen:** einmal wieder einschalten (nicht während eines Gottesdienstes) und schauen, ob „kühlt ab …"
→ „aus" → „startet …" → „an" sauber durchläuft.

## 3. Bildschirm-Zuordnung auf dem Beamer-PC durchspielen

Stand 15.11.2026: Das Update lief; die alte Zuordnung wurde übernommen und um
Name und Auflösung der Displays ergänzt, der Hauptbildschirm ist gesperrt.
Die Schritte unten sind noch nicht durchgespielt.

Die neue Logik (Fenster warten auf fehlende Beamer, nie auf dem
Hauptbildschirm, Bestätigen/Tauschen) ist mit Unit-Tests abgedeckt, aber
noch nicht auf dem Windows-PC mit echten Beamern erprobt. Durchspielen:

1. App starten, Beamer noch aus → Steuerung meldet „Keine Beamer erkannt",
   Hauptbildschirm bleibt frei
2. Beamer einschalten → Fenster erscheinen von selbst, „links"/„rechts"
   wird eingeblendet, Steuerung fragt nach → „Ja, stimmt" bzw. tauschen
3. Einen Beamer während des Betriebs aus- und wieder einschalten
4. App neu starten → Zuordnung bleibt, keine Rückfrage mehr

## 4. Autostart

Das Skript gibt es (`scripts/windows/Autostart einrichten.bat`), es ist
bewusst noch nicht eingerichtet. Wenn gewünscht: einrichten und den
Technik-Benutzer automatisch anmelden lassen (INSTALLATION-KURZ.md, Abschnitt 4).

## 5. Medienordner aufräumen

Der Nextcloud-Ordner mit den Vorlagen heisst auf dem Beamer-PC noch
provisorisch (Test-Ordner). Umbenennen und aufräumen, danach unter `/admin` →
„Einstellungen" den Medienordner-Pfad anpassen.

## 6. Für andere einfach installierbar machen

Für weitere Standorte ist „Node.js + Quellcode" eine Hürde. Optionen: den
vorhandenen Installer (electron-builder, INSTALLATION-WINDOWS.md, Abschnitt 7)
fertig machen und in GitHub-Releases ablegen, oder ein Ein-Klick-Skript, das
Node.js und ffmpeg mitinstalliert.

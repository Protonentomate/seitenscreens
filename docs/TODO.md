# Offene Punkte

Stand: November 2026. Erledigtes wandert in die Doku bzw. ins Git-Log.

## 1. Bedienungsanleitung (Deutsch, mit Screenshots vom Live-System)

Damit auch andere die Seitenscreens bedienen und einrichten können. Erst
schreiben, wenn die App auf dem Beamer-PC installiert ist und mehr Inhalte
drin sind: dann vor Ort im Netzwerk des Beamer-PCs die Screenshots direkt
vom Live-System machen (Steuerung, Verwaltung, Bild auf den Leinwänden).

Inhalt:

- **Einschalten**: Desktop-Icon, Beamer ein, Steuerung öffnen (auch vom
  Handy/Tablet über `http://<IP>:8080`), Firewall-Frage beim ersten Start
- **Bedienen**: Vorlagen anwenden, Gruppen-Tabs, Hover-Vorschau, Einzelbilder,
  Blackout, Video-Pause/-Regler, Beamer ein/aus
- **Bildschirme**: links/rechts prüfen und bestätigen, tauschen, „Fenster
  identifizieren", „Vollbild erzwingen", was passiert, wenn ein Beamer später
  kommt
- **Kalibrieren**: Testbild, Ecken verziehen (ziehen, Pfeiltasten, Zoom),
  Kalibrierung sichern und wiederherstellen
- **Hochladen**: die Modi (über alle 4, je über 2 mit Spiegeln, gleich auf
  allen 4, 4 Dateien, eine Leinwand), Einpassen, Übergang zwischen den
  Leinwänden, Loop glätten, Überschreiben einer bestehenden Vorlage
- **Einstellungen**: Medienordner, Wand-Layout ausmessen, Beamer-IPs,
  Standard-Gruppe
- **Update und Sicherung** (Kurzfassung von INSTALLATION-KURZ.md, Abschnitt 6)
- **Stream Deck** (Verweis auf STREAMDECK.md)

Ablage: `docs/ANLEITUNG.md` mit Bildern in `docs/img/`.

Erste Screenshots vom Live-System (15.11.2026, Steuerung am PC und am Handy,
alle Reiter der Verwaltung) liegen lokal in `dev/screenshots/2026-11-15/`,
bewusst nicht im Repo: Sie zeigen Gruppen- und Vorlagennamen der Kirche. Vor
einer Veröffentlichung neutrale Inhalte verwenden oder die Anleitung ausserhalb
des öffentlichen Repos ablegen.

## 2. Beamer-Status: nach dem Update vor Ort prüfen

**Befund (15.11.2026):** Beide Beamer sind Optoma 1080P und sprechen
**PJLink ohne Passwort** (`PJLINK 0`, Klasse 2, keine Fehler gemeldet). Die
alte Anzeige war falsch, weil die App den Status nie abfragte, sondern nur den
zuletzt geschickten Befehl zeigte.

**Eingebaut:** Status per PJLink alle 30 s, nach einem Befehl 2 Minuten lang
alle 3 s; Anzeige „an", „aus", „startet …", „kühlt ab …", „offline"
(Details in SYSTEM.md, Abschnitt 6). Vom Mac aus gegen die echten Beamer
getestet (beide „an", 10 schnelle Abfragen in Folge problemlos).

**Noch offen:** Auf dem Beamer-PC nach dem Update einmal aus- und wieder
einschalten (nicht während eines Gottesdienstes) und schauen, ob „kühlt ab …"
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

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

## 2. Beamer-Status (vor Ort)

Ein- und Ausschalten funktioniert, aber der Status in der Steuerung stimmt
nicht. Ohne Zugang zum Netz der Beamer lässt sich nicht sagen, was die Geräte
liefern. Vorbereitet ist:

- `/admin` → „Einstellungen" → **„Verbindung testen"** (bzw.
  `GET /api/projector/{links|rechts}/diagnose`): zeigt die Startseite des
  Webinterfaces und, ob der Beamer **PJLink** spricht (Port 4352, liefert
  an/aus/kühlt ab/wärmt auf).
- Jeder Ein-/Aus-Befehl schreibt die Antwort des Beamers ins Konsolen-Log
  (`[projector] …`).

**Befund vor Ort (15.11.2026):** Beide Beamer sind Optoma 1080P
(Webserver „GoAhead-Webs") und sprechen **PJLink ohne Passwort**
(Begrüssung `PJLINK 0`, Klasse 2). Antworten im Betrieb: `%1POWR=1` (an),
`%1NAME=Beamer links` bzw. `Beamer rechts`, `%1ERST=000000` (keine Fehler),
`%1INPT=31`, `%1AVMT=30`. Die Antwort auf `%1LAMP ?` kam mit einem
führenden Leerzeichen, also Zeilen vor dem Auswerten trimmen.

Ursache der falschen Anzeige: Die App fragt den Status nie ab, sie zeigt nur
an, welchen Befehl sie zuletzt geschickt hat (beim Start „?").

Nächster Schritt: Status per PJLink (`%1POWR ?`) regelmässig abfragen (z.B.
alle 30 s, nach einem Befehl öfter, weil Ab- und Aufwärmen dauert) und
„kühlt ab"/„wärmt auf" in der Steuerung anzeigen. Ein/Aus kann über
`control_cgi` bleiben oder ebenfalls auf PJLink (`%1POWR 1`/`0`) wechseln.

## 3. Bildschirm-Zuordnung auf dem Beamer-PC durchspielen

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

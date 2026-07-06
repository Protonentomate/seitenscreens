import type { ScreenName, WindowRole } from './screens'

export interface Point {
  x: number
  y: number
}

/** Vier Eckpunkte eines projizierten Quads in Fenster-Pixeln (1920×1080). */
export interface Quad {
  tl: Point
  tr: Point
  br: Point
  bl: Point
}

export interface ScreenCalibration {
  /** In welchem Beamer-Fenster dieses Quad liegt. */
  window: WindowRole
  corners: Quad
}

export interface ProjectorConfig {
  id: WindowRole
  name: string
  /** IP oder Hostname, z.B. 192.168.100.95 */
  host: string
  driver: 'control-cgi' | 'none'
}

/**
 * Physisches Wand-Layout: Grösse der Leinwände und die realen Abstände
 * dazwischen. Treibt den Span-Modus (ein Motiv über alle 4 Leinwände):
 * die Zuschnitte "überspringen" die Lücken, damit durchlaufende Motive
 * physisch fluchten.
 */
export interface WallLayout {
  /** Breite einer Leinwand in mm. */
  canvasWmm: number
  /** Höhe einer Leinwand in mm. */
  canvasHmm: number
  /** Abstände zwischen den Leinwänden in mm: [LL→LR, LR→RL (Bühne), RL→RR]. */
  gapsMm: [number, number, number]
  /**
   * Höhenversatz je Leinwand in mm (LL, LR, RL, RR; positiv = hängt tiefer).
   * In der Kirche hängen die äusseren Leinwände tiefer als die inneren —
   * beim geometrisch korrekten Spannen zeigt jede Leinwand den entsprechend
   * versetzten Ausschnitt, damit der Übergang fluchtet.
   */
  yOffsetsMm: [number, number, number, number]
}

/**
 * Umgang mit den physischen Lücken/Versätzen beim Spannen:
 * 'exact' = geometrisch korrekt (Lücken & Höhenversatz maskieren Bildteile),
 * 'none'  = nichts abschneiden (nahtlos geteilt, Lücken/Versatz ignoriert).
 */
export type SpanGaps = 'exact' | 'none'

/** Zuordnung der Beamer-Fenster zu physischen Displays + Ausgabe-Drehung. */
export interface WindowSettings {
  /** Electron-Display-ID pro Fenster; fehlt sie, gilt die Reihenfolge nach x. */
  assignments: Partial<Record<WindowRole, number>>
  /** 180° für kopfüber montierte Beamer (90/270 würde das Seitenformat brechen). */
  rotation: Partial<Record<WindowRole, 0 | 180>>
}

/** Physisches Display, wie Electron es sieht (für die Zuordnung in der Admin-UI). */
export interface DisplayInfo {
  id: number
  label: string
  bounds: { x: number; y: number; width: number; height: number }
  primary: boolean
  internal: boolean
}

export interface AppConfig {
  version: 1
  /** Absoluter Pfad zum Nextcloud-Ordner _Vorlagen (pro Maschine verschieden). */
  mediaRoot: string
  server: { port: number }
  simulator: { enabled: boolean | 'auto'; scale: number }
  transitionMs: number
  screens: Record<ScreenName, ScreenCalibration>
  projectors: ProjectorConfig[]
  layout: WallLayout
  windows: WindowSettings
}

/**
 * single = eine Leinwand; clone = gleiches Motiv auf allen 4;
 * span = EIN Motiv über alle 4 (inkl. Lücken);
 * span2 = Motiv über die beiden LINKEN gespannt und identisch über die
 * beiden RECHTEN (passt für Querformat-Motive deutlich besser als span)
 */
export type IngestMode = 'single' | 'clone' | 'span' | 'span2'
export type IngestFit = 'contain' | 'cover' | 'stretch'

export type IngestStatus = 'queued' | 'running' | 'done' | 'error'

export interface IngestJob {
  id: string
  /** Anzeige, z.B. "Herbstserie ← intro.mov (span)" */
  label: string
  status: IngestStatus
  /** 0..1 */
  progress: number
  error?: string
  createdAt: number
}

export type MediaKind = 'image' | 'video'

export interface ScreenContent {
  /** Pfad relativ zu mediaRoot, z.B. "Scene 1/LinksLinks.jpg" */
  file: string
  kind: MediaKind
  /**
   * Gemeinsamer Startzeitpunkt (Wanduhr, ms) für synchronisierte Videos.
   * Alle in einem Zug gesetzten Videos teilen dieselbe Epoche; die Soll-Position
   * ist ((jetzt − epochMs) / 1000) mod dauer.
   */
  epochMs?: number
  /**
   * Datei-Version (mtime+size). Ersetzt jemand die Datei in Nextcloud, ändert
   * sich die Version — der Player erkennt den Wechsel und die media://-URL
   * zeigt auf die richtige Cache-Kopie, ohne laufende Layer umzubiegen.
   */
  version?: string
  /** Loop-Länge in Sekunden (aus ffprobe), für den Video-Slider in der UI. */
  durationS?: number
}

/** Ergebnis der ffprobe-Prüfung eines Videos gegen den Encoding-Kontrakt. */
export interface ProbeInfo {
  codec: string
  width: number
  height: number
  fps: number
  durationS: number
  hasAudio: boolean
  /** Hart abgelehnt (zu hohe Last für den Beamer-PC) — Player startet es nicht. */
  playable: boolean
  /** Weiche Warnungen, z.B. "nicht optimiert" — spielt, aber mit Badge. */
  warnings: string[]
}

export interface MediaFileInfo {
  /** Pfad relativ zu mediaRoot */
  file: string
  kind: MediaKind
  probe?: ProbeInfo
}

export interface TemplateInfo {
  name: string
  /**
   * Gruppe = Unterordner im Medienordner (z.B. "Pimi", "Upgrade", "NTL").
   * Vorlagen direkt im Wurzelordner (bisherige Struktur) haben group ''.
   */
  group: string
  /** Eindeutige Referenz: "Gruppe/Name" bzw. nur "Name" ohne Gruppe. */
  ref: string
  files: Partial<Record<ScreenName, MediaFileInfo>>
  complete: boolean
  /** Aggregierte Warnungen (fehlende Screens, nicht abspielbare Videos …) */
  warnings: string[]
}

export interface MediaIndexSnapshot {
  templates: TemplateInfo[]
  singles: MediaFileInfo[]
  updatedAt: number
  mediaRootExists: boolean
}

export type ProjectorPower = 'on' | 'off' | 'unknown' | 'error'

export interface ProjectorStatus {
  id: WindowRole
  name: string
  host: string
  power: ProjectorPower
  /** Letzte erfolgreiche/fehlgeschlagene Aktion, für die UI. */
  lastMessage: string
}

/** Der eine Zustands-Schnappschuss, den Player-Fenster und Web-Clients erhalten. */
export interface AppState {
  screens: Record<ScreenName, ScreenContent | null>
  activeTemplate: string | null
  blackout: boolean
  testPattern: boolean
  transitionMs: number
  calibration: Record<ScreenName, ScreenCalibration>
  simulator: boolean
  mediaIndex: MediaIndexSnapshot
  projectors: ProjectorStatus[]
  mediaRoot: string
  /** Globale Video-Wiedergabe: pausiert alle laufenden Videos gemeinsam. */
  videoPaused: boolean
  /** Wanduhr-Zeitpunkt der Pause (definiert die eingefrorene Position). */
  videoPausedAtMs: number | null
  /** Laufende/erledigte Verarbeitungs-Jobs (Upload → Normalisieren). */
  jobs: IngestJob[]
  layout: WallLayout
  /** Angeschlossene Displays (für die Zuordnung in der Admin-UI). */
  displays: DisplayInfo[]
  windowSettings: WindowSettings
  /**
   * Gerade bearbeitete Ecke in der Kalibrier-UI — der Player markiert sie
   * im Testbild, damit man auf der echten Leinwand sieht, woran man zieht.
   */
  calibrationFocus: { screen: ScreenName; corner: 'tl' | 'tr' | 'br' | 'bl' } | null
}

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

export interface AppConfig {
  version: 1
  /** Absoluter Pfad zum Nextcloud-Ordner _Vorlagen (pro Maschine verschieden). */
  mediaRoot: string
  server: { port: number }
  simulator: { enabled: boolean | 'auto'; scale: number }
  transitionMs: number
  screens: Record<ScreenName, ScreenCalibration>
  projectors: ProjectorConfig[]
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
}

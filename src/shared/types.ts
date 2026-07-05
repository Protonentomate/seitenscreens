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
}

export interface TemplateInfo {
  name: string
  files: Partial<Record<ScreenName, string>>
  complete: boolean
}

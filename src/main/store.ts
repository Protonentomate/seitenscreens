import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig, AppState, Quad, ScreenContent } from '../shared/types'
import { SCREEN_NAMES, type ScreenName } from '../shared/screens'
import { saveConfig, configPath } from './config'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm'])

export function kindForFile(file: string): ScreenContent['kind'] | null {
  const ext = path.extname(file).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return null
}

interface PersistedLastState {
  screens: Record<ScreenName, ScreenContent | null>
  activeTemplate: string | null
  blackout: boolean
}

/**
 * Einzige Quelle der Wahrheit: alle Mutationen laufen durch diese Klasse,
 * jede Änderung wird als kompletter Schnappschuss an alle Abonnenten verteilt
 * (Player-Fenster über IPC, Web-Clients später über WebSocket).
 */
export class Store extends EventEmitter {
  private config: AppConfig
  private screens: Record<ScreenName, ScreenContent | null>
  private activeTemplate: string | null = null
  private blackout = false
  private testPattern = false
  private simulatorActive = false
  private persistTimer: NodeJS.Timeout | null = null

  constructor(config: AppConfig) {
    super()
    this.config = config
    this.screens = {
      LinksLinks: null,
      LinksRechts: null,
      RechtsLinks: null,
      RechtsRechts: null,
    }
  }

  getConfig(): AppConfig {
    return this.config
  }

  setSimulatorActive(active: boolean): void {
    this.simulatorActive = active
  }

  snapshot(): AppState {
    return {
      screens: { ...this.screens },
      activeTemplate: this.activeTemplate,
      blackout: this.blackout,
      testPattern: this.testPattern,
      transitionMs: this.config.transitionMs,
      calibration: { ...this.config.screens },
      simulator: this.simulatorActive,
    }
  }

  private broadcast(): void {
    this.emit('state', this.snapshot())
    this.schedulePersistLastState()
  }

  /** Vorlauf, bis Videos einer neuen Epoche starten — Zeit zum Laden/Prerollen. */
  private static readonly VIDEO_PREROLL_MS = 700

  setScreen(screen: ScreenName, content: ScreenContent | null, template: string | null = null): void {
    if (content?.kind === 'video' && content.epochMs === undefined) {
      content = { ...content, epochMs: Date.now() + Store.VIDEO_PREROLL_MS }
    }
    this.screens[screen] = content
    this.activeTemplate = template
    this.broadcast()
  }

  applyTemplate(name: string, files: Partial<Record<ScreenName, string>>): void {
    // Eine gemeinsame Epoche für alle Videos dieser Vorlage → synchroner Start
    const epochMs = Date.now() + Store.VIDEO_PREROLL_MS
    for (const screen of SCREEN_NAMES) {
      const file = files[screen]
      if (!file) continue
      const kind = kindForFile(file)
      if (!kind) continue
      const previous = this.screens[screen]
      // Läuft schon mit gültiger Epoche → nicht neu starten (Videos ohne Epoche
      // stammen aus altem Zustand und brauchen einen synchronisierten Neustart)
      if (previous && previous.file === file && (previous.kind !== 'video' || previous.epochMs !== undefined)) continue
      this.screens[screen] = kind === 'video' ? { file, kind, epochMs } : { file, kind }
    }
    this.activeTemplate = name
    this.broadcast()
  }

  setBlackout(on: boolean): void {
    if (this.blackout === on) return
    this.blackout = on
    this.broadcast()
  }

  toggleBlackout(): void {
    this.setBlackout(!this.blackout)
  }

  setTestPattern(on: boolean): void {
    if (this.testPattern === on) return
    this.testPattern = on
    this.broadcast()
  }

  setCalibration(screen: ScreenName, corners: Quad): void {
    this.config.screens[screen] = { ...this.config.screens[screen], corners }
    saveConfig(this.config)
    this.broadcast()
  }

  setTransitionMs(ms: number): void {
    this.config.transitionMs = ms
    saveConfig(this.config)
    this.broadcast()
  }

  // --- Letzten Zustand über Neustarts hinweg wiederherstellen ---

  private lastStatePath(): string {
    return path.join(path.dirname(configPath()), 'last-state.json')
  }

  private schedulePersistLastState(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      const data: PersistedLastState = {
        screens: this.screens,
        activeTemplate: this.activeTemplate,
        blackout: this.blackout,
      }
      try {
        const file = this.lastStatePath()
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file + '.tmp', JSON.stringify(data))
        fs.renameSync(file + '.tmp', file)
      } catch (err) {
        console.warn('[store] last-state konnte nicht gespeichert werden:', err)
      }
    }, 1000)
  }

  restoreLastState(): void {
    try {
      const raw = fs.readFileSync(this.lastStatePath(), 'utf-8')
      const data = JSON.parse(raw) as PersistedLastState
      // Videos bekommen nach einem Neustart eine frische gemeinsame Epoche
      const epochMs = Date.now() + Store.VIDEO_PREROLL_MS
      for (const screen of SCREEN_NAMES) {
        const content = data.screens?.[screen]
        if (content && typeof content.file === 'string' && kindForFile(content.file)) {
          this.screens[screen] =
            content.kind === 'video'
              ? { file: content.file, kind: content.kind, epochMs }
              : { file: content.file, kind: content.kind }
        }
      }
      this.activeTemplate = data.activeTemplate ?? null
      this.blackout = Boolean(data.blackout)
      this.emit('state', this.snapshot())
    } catch {
      // Kein letzter Zustand — normal beim ersten Start
    }
  }
}

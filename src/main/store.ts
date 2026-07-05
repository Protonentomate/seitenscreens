import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type {
  AppConfig,
  AppState,
  MediaIndexSnapshot,
  ProjectorStatus,
  Quad,
  ScreenContent,
  TemplateInfo,
} from '../shared/types'
import { SCREEN_NAMES, type ScreenName } from '../shared/screens'
import { saveConfig, configPath } from './config'
import { ensureCached } from './cache'
import { resolveMediaFile } from './media'

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

export interface ApplyResult {
  ok: boolean
  error?: string
}

/**
 * Einzige Quelle der Wahrheit: alle Mutationen laufen durch diese Klasse,
 * jede Änderung wird als kompletter Schnappschuss an alle Abonnenten verteilt
 * (Player-Fenster über IPC, Web-Clients über WebSocket).
 */
export class Store extends EventEmitter {
  private config: AppConfig
  private screens: Record<ScreenName, ScreenContent | null>
  private activeTemplate: string | null = null
  private blackout = false
  private testPattern = false
  private simulatorActive = false
  private persistTimer: NodeJS.Timeout | null = null
  private mediaIndex: MediaIndexSnapshot = { templates: [], singles: [], updatedAt: 0, mediaRootExists: false }
  private projectors: ProjectorStatus[] = []

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

  setMediaIndex(snapshot: MediaIndexSnapshot): void {
    this.mediaIndex = snapshot
    this.broadcast()
  }

  setProjectors(projectors: ProjectorStatus[]): void {
    this.projectors = projectors
    this.broadcast()
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
      mediaIndex: this.mediaIndex,
      projectors: this.projectors,
      mediaRoot: this.config.mediaRoot,
    }
  }

  private broadcast(): void {
    this.emit('state', this.snapshot())
    this.schedulePersistLastState()
  }

  /** Vorlauf, bis Videos einer neuen Epoche starten — Zeit zum Laden/Prerollen. */
  private static readonly VIDEO_PREROLL_MS = 700

  private async cacheFile(rel: string): Promise<void> {
    const abs = resolveMediaFile(this.config.mediaRoot, rel)
    if (abs) await ensureCached(this.config.mediaRoot, rel, abs)
  }

  async setScreen(screen: ScreenName, content: ScreenContent | null, template: string | null = null): Promise<void> {
    if (content) {
      await this.cacheFile(content.file)
      if (content.kind === 'video' && content.epochMs === undefined) {
        content = { ...content, epochMs: Date.now() + Store.VIDEO_PREROLL_MS }
      }
    }
    this.screens[screen] = content
    this.activeTemplate = template
    this.broadcast()
  }

  /**
   * Vorlage anwenden. Lehnt ab, wenn ein Video den Encoding-Kontrakt hart
   * verletzt (würde auf dem Beamer-PC ruckeln) — ausser mit force.
   */
  async applyTemplate(template: TemplateInfo, force = false): Promise<ApplyResult> {
    if (!force) {
      const blocked = (Object.keys(template.files) as ScreenName[])
        .map((s) => ({ screen: s, info: template.files[s] }))
        .filter((e) => e.info?.probe && !e.info.probe.playable)
      if (blocked.length > 0) {
        const first = blocked[0]
        return {
          ok: false,
          error: `Nicht abspielbar: ${first?.screen} — ${first?.info?.probe?.warnings[0] ?? 'Kontrakt verletzt'}`,
        }
      }
    }

    // Erst alle Dateien in den Schattencache, dann in einem Zug umschalten
    const files = (Object.keys(template.files) as ScreenName[])
      .map((screen) => ({ screen, info: template.files[screen] }))
      .filter((e): e is { screen: ScreenName; info: NonNullable<typeof e.info> } => Boolean(e.info))
    await Promise.all(files.map((e) => this.cacheFile(e.info.file)))

    // Eine gemeinsame Epoche für alle Videos dieser Vorlage → synchroner Start
    const epochMs = Date.now() + Store.VIDEO_PREROLL_MS
    for (const { screen, info } of files) {
      const previous = this.screens[screen]
      // Läuft schon mit gültiger Epoche → nicht neu starten (Videos ohne Epoche
      // stammen aus altem Zustand und brauchen einen synchronisierten Neustart)
      if (previous && previous.file === info.file && (previous.kind !== 'video' || previous.epochMs !== undefined)) {
        continue
      }
      this.screens[screen] = info.kind === 'video' ? { file: info.file, kind: info.kind, epochMs } : { file: info.file, kind: info.kind }
    }
    this.activeTemplate = template.name
    this.broadcast()
    return { ok: true }
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

  /** Medienordner umstellen — meldet 'mediaroot-changed', damit der Index neu startet. */
  setMediaRoot(root: string): void {
    this.config.mediaRoot = root
    saveConfig(this.config)
    this.emit('mediaroot-changed', root)
    this.broadcast()
  }

  setProjectorHost(id: string, host: string): boolean {
    const projector = this.config.projectors.find((p) => p.id === id)
    if (!projector) return false
    projector.host = host
    saveConfig(this.config)
    this.emit('projectors-changed', this.config.projectors)
    this.broadcast()
    return true
  }

  // --- Letzten Zustand über Neustarts hinweg wiederherstellen ---

  private lastStatePath(): string {
    return path.join(path.dirname(configPath()), 'last-state.json')
  }

  private writeLastState(): void {
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
  }

  private schedulePersistLastState(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.writeLastState()
    }, 1000)
  }

  /** Ausstehende last-state-Schreibung sofort ausführen (beim Beenden). */
  flushLastState(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
      this.writeLastState()
    }
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
          // Cache im Hintergrund auffüllen; bis dahin spielt das Original
          void this.cacheFile(content.file)
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

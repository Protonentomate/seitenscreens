import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type {
  AppConfig,
  AppState,
  DisplayInfo,
  IngestJob,
  MediaIndexSnapshot,
  ProjectorStatus,
  Quad,
  ScreenContent,
  TemplateInfo,
  WallLayout,
} from '../shared/types'
import { SCREEN_NAMES, type ScreenName, type WindowRole } from '../shared/screens'
import { saveConfig, configPath } from './config'
import { ensureCached, clearCacheRegistry } from './cache'
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
 *
 * Inhalts-Mutationen mit await (Schattencache-Kopien) sind über eine
 * Promise-Kette serialisiert — zwei schnelle API-Aufrufe können sich nie
 * zu einem Misch-Zustand verschränken.
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
  private videoPaused = false
  private videoPausedAtMs: number | null = null
  private jobs: IngestJob[] = []
  private displays: DisplayInfo[] = []
  private calibrationFocus: AppState['calibrationFocus'] = null
  private mutationChain: Promise<unknown> = Promise.resolve()
  private configSaveTimer: NodeJS.Timeout | null = null

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
      videoPaused: this.videoPaused,
      videoPausedAtMs: this.videoPausedAtMs,
      jobs: this.jobs,
      layout: this.config.layout,
      displays: this.displays,
      windowSettings: this.config.windows,
      calibrationFocus: this.calibrationFocus,
      defaultGroup: this.config.defaultGroup,
    }
  }

  setDefaultGroup(group: string): void {
    if (group === this.config.defaultGroup) return
    this.config.defaultGroup = group
    saveConfig(this.config)
    this.broadcast()
  }

  /**
   * Komplette Konfiguration ersetzen (Import aus Datei, v.a. als Backup der
   * Kalibrierung). Der Server-Port bleibt der laufende (Rebind zur Laufzeit
   * nicht möglich); ein Medienordner, den es auf diesem Rechner nicht gibt,
   * wird nicht übernommen (Import von einem anderen Rechner).
   */
  importConfig(next: AppConfig): { mediaRootKept: boolean } {
    const current = this.config
    let mediaRoot = next.mediaRoot
    let mediaRootKept = false
    if (mediaRoot !== current.mediaRoot) {
      let exists = false
      try {
        exists = Boolean(mediaRoot) && fs.statSync(mediaRoot).isDirectory()
      } catch {
        exists = false
      }
      if (!exists) {
        mediaRoot = current.mediaRoot
        mediaRootKept = true
      }
    }
    const mediaRootChanged = mediaRoot !== current.mediaRoot
    this.config = { ...next, mediaRoot, server: current.server }
    if (this.configSaveTimer) {
      clearTimeout(this.configSaveTimer)
      this.configSaveTimer = null
    }
    saveConfig(this.config)
    if (mediaRootChanged) {
      clearCacheRegistry()
      this.emit('mediaroot-changed', mediaRoot)
    }
    this.emit('projectors-changed', this.config.projectors)
    this.broadcast()
    return { mediaRootKept }
  }

  setDisplays(displays: DisplayInfo[]): void {
    this.displays = displays
    this.broadcast()
  }

  setWindowRotation(role: WindowRole, deg: 0 | 180): void {
    this.config.windows.rotation[role] = deg
    saveConfig(this.config)
    this.broadcast()
  }

  /** Display-Zuordnung merken — das eigentliche Verschieben macht main/index. */
  setWindowAssignment(role: WindowRole, displayId: number): void {
    this.config.windows.assignments[role] = displayId
    saveConfig(this.config)
    this.emit('window-assignment', role, displayId)
    this.broadcast()
  }

  setCalibrationFocus(focus: AppState['calibrationFocus']): void {
    this.calibrationFocus = focus
    this.broadcast()
  }

  setJobs(jobs: IngestJob[]): void {
    this.jobs = jobs
    this.broadcast()
  }

  setLayout(layout: WallLayout): void {
    this.config.layout = layout
    saveConfig(this.config)
    this.broadcast()
  }

  private broadcast(): void {
    this.emit('state', this.snapshot())
    this.schedulePersistLastState()
  }

  /** Vorlauf, bis Videos einer neuen Epoche starten — Zeit zum Laden/Prerollen. */
  private static readonly VIDEO_PREROLL_MS = 700

  /** Inhalts-Mutationen nacheinander ausführen (keine Race zwischen Applies). */
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(op, op)
    this.mutationChain = next.catch(() => {})
    return next
  }

  /** Datei in den Schattencache legen; liefert die Version (oder undefined). */
  private async cacheFile(rel: string): Promise<string | undefined> {
    const abs = resolveMediaFile(this.config.mediaRoot, rel)
    if (!abs) return undefined
    return (await ensureCached(rel, abs)) ?? undefined
  }

  setScreen(screen: ScreenName, content: ScreenContent | null, template: string | null = null): Promise<void> {
    return this.setScreens(content ? [screen] : [], content, template, content ? undefined : [screen])
  }

  /**
   * Mehrere Leinwände in einem Zug auf dieselbe Datei setzen (oder leeren) —
   * eine gemeinsame Epoche, damit Videos synchron laufen.
   */
  setScreens(
    targets: ScreenName[],
    content: ScreenContent | null,
    template: string | null = null,
    clearTargets: ScreenName[] = [],
  ): Promise<void> {
    return this.serialize(async () => {
      if (content) {
        const version = await this.cacheFile(content.file)
        const epochMs =
          content.kind === 'video' && content.epochMs === undefined
            ? Date.now() + Store.VIDEO_PREROLL_MS
            : content.epochMs
        for (const screen of targets) {
          this.screens[screen] = { ...content, version, epochMs }
        }
      }
      for (const screen of clearTargets) {
        this.screens[screen] = null
      }
      this.activeTemplate = template
      // Neuer Inhalt hebt eine globale Video-Pause auf
      this.videoPaused = false
      this.videoPausedAtMs = null
      this.broadcast()
    })
  }

  /**
   * Vorlage anwenden. Nicht abspielbare Videos (Encoding-Kontrakt hart
   * verletzt) werden IMMER abgelehnt — force überstimmt nur Unvollständigkeit.
   */
  applyTemplate(template: TemplateInfo): Promise<ApplyResult> {
    return this.serialize(async () => {
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

      // Erst alle Dateien in den Schattencache, dann in einem Zug umschalten
      const files = (Object.keys(template.files) as ScreenName[])
        .map((screen) => ({ screen, info: template.files[screen] }))
        .filter((e): e is { screen: ScreenName; info: NonNullable<typeof e.info> } => Boolean(e.info))
      const versions = new Map<ScreenName, string | undefined>()
      for (const { screen, info } of files) {
        versions.set(screen, await this.cacheFile(info.file))
      }

      // Eine gemeinsame Epoche für alle Videos dieser Vorlage → synchroner Start
      const epochMs = Date.now() + Store.VIDEO_PREROLL_MS
      for (const { screen, info } of files) {
        const version = versions.get(screen)
        const previous = this.screens[screen]
        // Identische Datei UND identische Version läuft schon → nicht neu starten
        // (neue Version = in Nextcloud ersetzte Datei = bewusst neu laden)
        if (
          previous &&
          previous.file === info.file &&
          previous.version === version &&
          (previous.kind !== 'video' || previous.epochMs !== undefined)
        ) {
          continue
        }
        this.screens[screen] =
          info.kind === 'video'
            ? { file: info.file, kind: info.kind, epochMs, version, durationS: info.probe?.durationS }
            : { file: info.file, kind: info.kind, version }
      }
      this.activeTemplate = template.ref
      // Neuer Inhalt hebt eine globale Video-Pause auf
      this.videoPaused = false
      this.videoPausedAtMs = null
      this.broadcast()
      return { ok: true }
    })
  }

  // --- Globale Video-Wiedergabe (Pause/Play/Seek über alle Leinwände) ---

  pauseVideo(): void {
    if (this.videoPaused) return
    this.videoPaused = true
    this.videoPausedAtMs = Date.now()
    this.broadcast()
  }

  resumeVideo(): void {
    if (!this.videoPaused) return
    const pausedForMs = Date.now() - (this.videoPausedAtMs ?? Date.now())
    // Alle Epochen um die Pausendauer verschieben → jedes Video läuft exakt
    // dort weiter, wo es stand, und die Synchronität bleibt erhalten
    for (const screen of SCREEN_NAMES) {
      const content = this.screens[screen]
      if (content?.kind === 'video' && content.epochMs !== undefined) {
        this.screens[screen] = { ...content, epochMs: content.epochMs + pausedForMs }
      }
    }
    this.videoPaused = false
    this.videoPausedAtMs = null
    this.broadcast()
  }

  toggleVideo(): void {
    if (this.videoPaused) this.resumeVideo()
    else this.pauseVideo()
  }

  /** Alle Videos an Position toS (Sekunden in der Loop) springen lassen. */
  seekVideo(toS: number): void {
    const base = this.videoPaused ? (this.videoPausedAtMs ?? Date.now()) : Date.now()
    for (const screen of SCREEN_NAMES) {
      const content = this.screens[screen]
      if (content?.kind === 'video') {
        this.screens[screen] = { ...content, epochMs: base - toS * 1000 }
      }
    }
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

  /**
   * Kalibrierung setzen. Beim interaktiven Ziehen kommen ~25 Updates/s —
   * der Broadcast an die Player muss sofort raus (Live-Vorschau), das
   * Schreiben der Config-Datei wird entprellt.
   */
  setCalibration(screen: ScreenName, corners: Quad): void {
    this.config.screens[screen] = { ...this.config.screens[screen], corners }
    if (this.configSaveTimer) clearTimeout(this.configSaveTimer)
    this.configSaveTimer = setTimeout(() => {
      this.configSaveTimer = null
      saveConfig(this.config)
    }, 800)
    this.broadcast()
  }

  /** Ausstehendes Config-Speichern sofort ausführen (beim Beenden). */
  flushConfig(): void {
    if (this.configSaveTimer) {
      clearTimeout(this.configSaveTimer)
      this.configSaveTimer = null
      saveConfig(this.config)
    }
  }

  setTransitionMs(ms: number): void {
    this.config.transitionMs = ms
    saveConfig(this.config)
    this.broadcast()
  }

  /** Medienordner umstellen — meldet 'mediaroot-changed', damit der Index neu startet. */
  setMediaRoot(root: string): void {
    if (root === this.config.mediaRoot) return
    this.config.mediaRoot = root
    saveConfig(this.config)
    // Cache-Register leeren: rel-Pfade beziehen sich jetzt auf den neuen Ordner
    clearCacheRegistry()
    this.emit('mediaroot-changed', root)
    this.broadcast()
  }

  setProjectorHost(id: string, host: string): boolean {
    const projector = this.config.projectors.find((p) => p.id === id)
    if (!projector) return false
    if (projector.host === host) return true
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
              ? { ...content, epochMs }
              : { file: content.file, kind: content.kind, version: content.version }
          // Cache im Hintergrund auffüllen; falls sich die Datei zwischenzeitlich
          // geändert hat, Version nachziehen und neu verteilen
          void this.cacheFile(content.file).then((version) => {
            const current = this.screens[screen]
            if (version && current && current.file === content.file && current.version !== version) {
              this.screens[screen] = { ...current, version }
              this.broadcast()
            }
          })
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

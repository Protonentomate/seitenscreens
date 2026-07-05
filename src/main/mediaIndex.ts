import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { MediaFileInfo, MediaIndexSnapshot, ProbeInfo, TemplateInfo } from '../shared/types'
import { SCREEN_NAMES, type ScreenName } from '../shared/screens'
import { kindForFile } from './store'

/** Reihenfolge = Priorität: Video schlägt Bild. */
const EXTENSION_PRIORITY = ['.mp4', '.webm', '.png', '.jpg', '.jpeg', '.webp']

/** Ordner, die nie als Vorlage gelten (Altlasten + interne Ordner). */
const IGNORED_DIR_PATTERN = /^(_|\.|archiv$|serie)/i

/**
 * Encoding-Kontrakt für Videos. Direkt in Nextcloud abgelegte Dateien umgehen
 * die Ingest-Pipeline — deshalb prüft der Index JEDES Video per ffprobe und
 * lehnt ab, was den Beamer-PC (i5-7500T, HD 630) überfordern würde.
 */
function classify(raw: {
  codec: string
  width: number
  height: number
  fps: number
  durationS: number
  hasAudio: boolean
}): ProbeInfo {
  const warnings: string[] = []
  let playable = true

  const allowedCodecs = ['h264', 'vp9', 'av1']
  if (!allowedCodecs.includes(raw.codec)) {
    playable = false
    warnings.push(`Codec ${raw.codec} wird nicht hardware-dekodiert — bitte über die Verwaltung neu verarbeiten`)
  }
  if (raw.fps > 32) {
    playable = false
    warnings.push(`${Math.round(raw.fps)} fps überlastet den Beamer-PC — Ziel sind 30 fps`)
  }
  if (raw.width * raw.height > 1080 * 1920) {
    playable = false
    warnings.push(`Auflösung ${raw.width}×${raw.height} ist zu gross (max. 1080×1920 pro Leinwand)`)
  }
  if (playable) {
    if (raw.hasAudio) warnings.push('Enthält eine Tonspur (wird stumm abgespielt, kostet aber Leistung)')
    if (raw.width * raw.height > 720 * 1280) {
      warnings.push('Grösser als nötig — 720×1280 reicht für die Leinwände und halbiert die Last')
    }
  }
  return { ...raw, playable, warnings }
}

function ffprobeBinary(): string {
  return process.env.SEITENSCREENS_FFPROBE || 'ffprobe'
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
}

function parseFps(rate: string | undefined): number {
  if (!rate) return 0
  const [num, den] = rate.split('/').map(Number)
  if (!num || !den) return num || 0
  return num / den
}

type ProbeResult = { kind: 'ok'; probe: ProbeInfo } | { kind: 'no-tool' } | { kind: 'broken' }

async function probeVideo(abs: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(
      ffprobeBinary(),
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', abs],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) {
          // ffprobe fehlt (ENOENT) ≠ Datei kaputt (Exit-Code/Timeout) —
          // nur Ersteres darf im Zweifel durchwinken
          const code = (err as NodeJS.ErrnoException).code
          resolve(code === 'ENOENT' ? { kind: 'no-tool' } : { kind: 'broken' })
          return
        }
        try {
          const data = JSON.parse(stdout) as { streams?: FfprobeStream[]; format?: { duration?: string } }
          const video = data.streams?.find((s) => s.codec_type === 'video')
          if (!video) {
            resolve({ kind: 'broken' })
            return
          }
          resolve({
            kind: 'ok',
            probe: classify({
              codec: video.codec_name ?? 'unbekannt',
              width: video.width ?? 0,
              height: video.height ?? 0,
              fps: parseFps(video.avg_frame_rate),
              durationS: Number(data.format?.duration ?? 0),
              hasAudio: Boolean(data.streams?.some((s) => s.codec_type === 'audio')),
            }),
          })
        } catch {
          resolve({ kind: 'broken' })
        }
      },
    )
  })
}

/**
 * Beobachtet den Vorlagen-Ordner (Nextcloud-Sync) und baut bei jeder Änderung
 * den kompletten Index neu — kein inkrementelles Patchen, keine Drift.
 */
export class MediaIndex extends EventEmitter {
  private watcher: FSWatcher | null = null
  private root = ''
  private snapshot: MediaIndexSnapshot = { templates: [], singles: [], updatedAt: 0, mediaRootExists: false }
  private probeCache = new Map<string, ProbeInfo>()
  private rescanTimer: NodeJS.Timeout | null = null
  private waitForRootTimer: NodeJS.Timeout | null = null
  private probeCacheDirty = false
  private scanning = false
  private scanQueued = false
  /** Schutz gegen überlappende start()-Aufrufe (Ordner-Umkonfiguration). */
  private startGeneration = 0
  /** Erster ungescannter Watcher-Event — erzwingt Rescan trotz Dauerfeuer. */
  private oldestPendingEventAt: number | null = null

  constructor() {
    super()
    this.loadProbeCache()
  }

  getSnapshot(): MediaIndexSnapshot {
    return this.snapshot
  }

  getTemplate(name: string): TemplateInfo | null {
    const wanted = name.normalize('NFC')
    return this.snapshot.templates.find((t) => t.name.normalize('NFC') === wanted) ?? null
  }

  /** Watcher (neu) starten — z.B. wenn der Medienordner umkonfiguriert wurde. */
  async start(root: string): Promise<void> {
    const generation = ++this.startGeneration
    await this.stop()
    if (generation !== this.startGeneration) return // ein neuerer start() hat übernommen
    this.root = root
    if (!root) {
      this.snapshot = { templates: [], singles: [], updatedAt: Date.now(), mediaRootExists: false }
      this.emit('index', this.snapshot)
      return
    }
    if (!fs.existsSync(root)) {
      // Kaltstart bevor Nextcloud gesynct hat: alle 10s prüfen, bis der Ordner da ist
      this.snapshot = { templates: [], singles: [], updatedAt: Date.now(), mediaRootExists: false }
      this.emit('index', this.snapshot)
      this.waitForRootTimer = setTimeout(() => {
        if (generation === this.startGeneration) void this.start(root)
      }, 10_000)
      return
    }
    this.watcher = chokidar.watch(root, {
      depth: 1,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
      ignored: (p) => {
        const base = path.basename(p)
        return (
          base.startsWith('.') ||
          base.endsWith('.part') ||
          base.endsWith('.tmp') ||
          base.startsWith('~$') ||
          base === 'desktop.ini' ||
          base === 'Thumbs.db'
        )
      },
    })
    this.watcher.on('all', () => this.scheduleRescan())
    this.watcher.on('error', (err) => console.warn('[index] Watcher-Fehler:', err))
    await this.rescan()
  }

  async stop(): Promise<void> {
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    if (this.waitForRootTimer) clearTimeout(this.waitForRootTimer)
    this.rescanTimer = null
    this.waitForRootTimer = null
    await this.watcher?.close()
    this.watcher = null
  }

  private scheduleRescan(): void {
    const now = Date.now()
    if (this.oldestPendingEventAt === null) this.oldestPendingEventAt = now
    // Max-Wait: ein grosser Nextcloud-Sync feuert minutenlang Events —
    // das Debounce darf den Index trotzdem nicht komplett aushungern
    if (now - this.oldestPendingEventAt > 10_000) {
      if (this.rescanTimer) clearTimeout(this.rescanTimer)
      this.rescanTimer = null
      this.oldestPendingEventAt = null
      void this.rescan()
      return
    }
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.rescanTimer = setTimeout(() => {
      this.oldestPendingEventAt = null
      void this.rescan()
    }, 1500)
  }

  private async rescan(): Promise<void> {
    if (this.scanning) {
      this.scanQueued = true
      return
    }
    this.scanning = true
    try {
      const snapshot = await this.buildSnapshot()
      this.snapshot = snapshot
      this.emit('index', snapshot)
      this.saveProbeCacheIfDirty()
    } catch (err) {
      console.error('[index] Scan fehlgeschlagen:', err)
    } finally {
      this.scanning = false
      if (this.scanQueued) {
        this.scanQueued = false
        this.scheduleRescan()
      }
    }
  }

  private async fileInfo(rel: string): Promise<MediaFileInfo | null> {
    const kind = kindForFile(rel)
    if (!kind) return null
    const info: MediaFileInfo = { file: rel, kind }
    if (kind === 'video') {
      const abs = path.join(this.root, rel)
      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(abs)
      } catch {
        return null
      }
      const cacheKey = `${rel}|${Math.round(stat.mtimeMs)}|${stat.size}`
      let probe = this.probeCache.get(cacheKey)
      if (!probe) {
        const result = await probeVideo(abs)
        if (result.kind === 'ok') {
          probe = result.probe
          this.probeCache.set(cacheKey, probe)
          this.probeCacheDirty = true
        } else if (result.kind === 'broken') {
          // Kaputte/halb-gesyncte Datei: NICHT abspielbar (auch negativ cachen —
          // eine fertig gesyncte Datei hat neue mtime/size und wird neu geprüft)
          probe = {
            codec: 'unbekannt',
            width: 0,
            height: 0,
            fps: 0,
            durationS: 0,
            hasAudio: false,
            playable: false,
            warnings: ['Datei beschädigt oder unvollständig (Sync noch nicht fertig?)'],
          }
          this.probeCache.set(cacheKey, probe)
          this.probeCacheDirty = true
        } else {
          // ffprobe nicht installiert: im Zweifel abspielbar, aber markieren
          probe = classify({ codec: 'h264', width: 0, height: 0, fps: 0, durationS: 0, hasAudio: false })
          probe.warnings = ['Video konnte nicht geprüft werden — ffprobe fehlt auf diesem Rechner']
        }
      }
      info.probe = probe
    }
    return info
  }

  private async buildSnapshot(): Promise<MediaIndexSnapshot> {
    const templates: TemplateInfo[] = []
    const singles: MediaFileInfo[] = []
    const rootExists = Boolean(this.root) && fs.existsSync(this.root)

    if (rootExists) {
      const entries = await fs.promises.readdir(this.root, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (IGNORED_DIR_PATTERN.test(entry.name)) continue
          const template = await this.scanTemplate(entry.name)
          if (template) templates.push(template)
        } else if (entry.isFile()) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
          if (!EXTENSION_PRIORITY.includes(path.extname(entry.name).toLowerCase())) continue
          const info = await this.fileInfo(entry.name)
          if (info) singles.push(info)
        }
      }
    }

    templates.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }))
    singles.sort((a, b) => a.file.localeCompare(b.file, 'de', { numeric: true }))
    return { templates, singles, updatedAt: Date.now(), mediaRootExists: rootExists }
  }

  private async scanTemplate(dirName: string): Promise<TemplateInfo | null> {
    const dir = path.join(this.root, dirName)
    let entries: string[]
    try {
      entries = await fs.promises.readdir(dir)
    } catch {
      return null
    }
    const lower = new Map(entries.map((e) => [e.toLowerCase(), e]))
    const files: Partial<Record<ScreenName, MediaFileInfo>> = {}
    for (const screen of SCREEN_NAMES) {
      for (const ext of EXTENSION_PRIORITY) {
        const actual = lower.get((screen + ext).toLowerCase())
        if (actual) {
          const info = await this.fileInfo(`${dirName}/${actual}`)
          if (info) files[screen] = info
          break
        }
      }
    }
    const found = Object.keys(files) as ScreenName[]
    if (found.length === 0) return null

    const warnings: string[] = []
    const missing = SCREEN_NAMES.filter((s) => !files[s])
    if (missing.length > 0) warnings.push(`Unvollständig — fehlt: ${missing.join(', ')}`)
    for (const screen of found) {
      const probe = files[screen]?.probe
      if (probe && !probe.playable) warnings.push(`${screen}: ${probe.warnings[0] ?? 'nicht abspielbar'}`)
      else if (probe && probe.warnings.length > 0) warnings.push(`${screen}: ${probe.warnings[0]}`)
    }

    return { name: dirName, files, complete: missing.length === 0, warnings }
  }

  // --- Probe-Cache-Persistenz (ffprobe nur einmal pro Datei-Version) ---

  private probeCachePath(): string {
    return path.join(app.getPath('userData'), 'probe-cache.json')
  }

  private loadProbeCache(): void {
    try {
      const raw = fs.readFileSync(this.probeCachePath(), 'utf-8')
      const data = JSON.parse(raw) as Record<string, ProbeInfo>
      for (const [key, value] of Object.entries(data)) this.probeCache.set(key, value)
    } catch {
      // kein Cache — normal beim ersten Start
    }
  }

  private saveProbeCacheIfDirty(): void {
    if (!this.probeCacheDirty) return
    this.probeCacheDirty = false
    try {
      const data = Object.fromEntries(this.probeCache)
      fs.writeFileSync(this.probeCachePath(), JSON.stringify(data))
    } catch (err) {
      console.warn('[index] Probe-Cache konnte nicht gespeichert werden:', err)
    }
  }
}

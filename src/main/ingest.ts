import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import type { Store } from './store'
import { IGNORED_DIR_PATTERN, type MediaIndex } from './mediaIndex'
import type { IngestFit, IngestJob, IngestMode, SpanGaps, TemplateInfo } from '../shared/types'
import { spanCrops, span2Pairs } from '../shared/span'
import { SCREEN_NAMES, type ScreenName } from '../shared/screens'
import { ffmpegBinary, ffprobeBinary } from './ffmpeg'

/**
 * Ingest-Pipeline: Upload → Normalisieren → atomar in den Nextcloud-Ordner.
 *
 * - Bilder: sharp → 1080×1920 JPEG (EXIF-Rotation, Alpha auf Schwarz)
 * - Videos: ffmpeg → 720×1280@30 H.264 nach Encoding-Kontrakt (Loop-tauglich,
 *   stumm, faststart) — 720p reicht: die Quads rendern mit ~465×845 px,
 *   und die halbe Auflösung halbiert die Decode-Last des Beamer-PCs
 * - span: EIN Motiv über alle 4 Leinwände; die Zuschnitte berücksichtigen
 *   die realen Abstände aus dem Wand-Layout, ein einziger ffmpeg-Lauf
 *   erzeugt alle 4 Ausgaben (eine Decodierung, vier Encoder)
 * - Verarbeitet wird im Work-Dir ausserhalb des Sync-Ordners; erst fertige
 *   Dateien werden per Rename eingesetzt (_meta.json zuletzt als Commit-Marker)
 * - Jobs laufen SOFORT, auch während Videos live sind — dafür läuft ffmpeg
 *   mit niedrigster OS-Priorität und (bei Live-Videos) gedrosselten Threads,
 *   damit die Wiedergabe auf dem Beamer-PC Vorrang behält
 * - Überschreibt der Upload die gerade aktive Vorlage, wird sie nach dem
 *   Ingest automatisch neu angewendet ("schnell live etwas ändern")
 */

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv'])
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

const VIDEO_TARGET_W = 720
const VIDEO_TARGET_H = 1280
const IMAGE_TARGET_W = 1080
const IMAGE_TARGET_H = 1920

function encoderArgs(threads: number): string[] {
  return [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-profile:v', 'high',
    '-level', '4.0',
    '-g', '60',
    '-keyint_min', '60',
    '-sc_threshold', '0',
    '-bf', '2',
    '-movflags', '+faststart',
    '-an',
    '-threads', String(threads),
  ]
}

/** Eine Quelle im Modus 'quad' (je eine Datei pro Leinwand). */
export interface IngestSource {
  uploadPath: string
  originalName: string
  fit: IngestFit
}

export interface IngestParams {
  uploadPath: string
  originalName: string
  /** Gruppen-Ordner ('' = Wurzel, bisherige Struktur). */
  group: string
  templateName: string
  mode: IngestMode
  /** Nur bei mode 'single'. */
  target?: ScreenName
  fit: IngestFit
  /** Nur bei span/span2: Lücken maskieren ('exact') oder nahtlos teilen ('none'). */
  gaps: SpanGaps
  /** Nur bei span2: die rechte Seite horizontal spiegeln (symmetrische Bewegung). */
  mirror: boolean
  /** Nur bei Videos: Ende weich in den Anfang überblenden (nahtloser Loop). */
  loopSmooth: boolean
  /** Crossfade-Länge der Loop-Glättung in Sekunden. */
  loopCrossfadeS: number
  /** Nur bei mode 'quad': je Leinwand eine eigene Quelle. */
  sources?: Partial<Record<ScreenName, IngestSource>>
}

/** _meta.json einer verarbeiteten Vorlage (Commit-Marker + Grundlage fürs Re-Render). */
export interface TemplateMeta {
  version: number
  mode: IngestMode
  fit?: IngestFit
  gaps?: SpanGaps
  mirror?: boolean
  loopSmooth?: boolean
  loopCrossfadeS?: number
  targets: ScreenName[]
  /** Nicht-quad: Original liegt unter _original/<source>. */
  source?: string
  /** quad: je Leinwand Original-Datei (in _original) + Einpassung + Typ. */
  sources?: Partial<Record<ScreenName, { file: string; fit: IngestFit; kind: 'image' | 'video' }>>
  layout?: unknown
  createdAt: string
  tool: string
}

/** Skalierungs-Filter für ffmpeg je Einpass-Modus. */
function scaleFilter(fit: IngestFit, w: number, h: number): string {
  if (fit === 'cover') {
    return `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`
  }
  if (fit === 'stretch') {
    return `scale=${w}:${h}:flags=lanczos`
  }
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`
}

/** sharp-fit je Einpass-Modus ('stretch' = fill: Seitenverhältnis ignorieren). */
function sharpFit(fit: IngestFit): 'contain' | 'cover' | 'fill' {
  return fit === 'stretch' ? 'fill' : fit
}

async function probeDuration(abs: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      ffprobeBinary(),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', abs],
      { timeout: 15000 },
      (err, stdout) => resolve(err ? 0 : Number(stdout.trim()) || 0),
    )
  })
}

/**
 * ffmpeg mit Fortschritts-Parsing (-progress pipe:1). Läuft immer mit
 * niedrigster OS-Priorität: die Video-Wiedergabe (Electron, normale
 * Priorität) gewinnt jeden CPU-Konflikt, das Encoding nimmt nur den Rest.
 */
function runFfmpeg(args: string[], durationS: number, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBinary(), ['-y', '-nostats', '-progress', 'pipe:1', ...args])
    try {
      if (proc.pid) os.setPriority(proc.pid, 19)
    } catch {
      // Priorität senken ist Best-Effort (kann je nach OS/Rechten fehlschlagen)
    }
    let stderrTail = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })
    proc.stdout.on('data', (chunk: Buffer) => {
      const match = /out_time_us=(\d+)/.exec(chunk.toString())
      if (match && durationS > 0) {
        onProgress(Math.min(1, Number(match[1]) / 1e6 / durationS))
      }
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg Exit ${code}: …${stderrTail.slice(-400)}`))
    })
  })
}

export class IngestQueue {
  private readonly store: Store
  private readonly index: MediaIndex | null
  private readonly jobs: IngestJob[] = []
  private readonly params = new Map<string, IngestParams>()
  private working = false

  constructor(store: Store, index: MediaIndex | null = null) {
    this.store = store
    this.index = index
  }

  list(): IngestJob[] {
    return this.jobs.slice(-20)
  }

  workDir(): string {
    const dir = path.join(app.getPath('userData'), 'work')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  enqueue(params: IngestParams): { ok: boolean; jobId?: string; error?: string } {
    let name = params.templateName.trim()
    let group = params.group.trim()
    const invalidName = (v: string) => /[/\\]|^\.|^_/.test(v) || v.includes('..')
    if (!name || invalidName(name)) {
      return { ok: false, error: 'Ungültiger Vorlagen-Name (keine Slashes, nicht mit . oder _ beginnen)' }
    }
    if (group && invalidName(group)) {
      return { ok: false, error: 'Ungültiger Gruppen-Name (keine Slashes, nicht mit . oder _ beginnen)' }
    }
    // Der Index ignoriert Ordner mit diesen Präfixen — so benannte Uploads
    // wären nach der Verarbeitung unsichtbar
    if (IGNORED_DIR_PATTERN.test(name) || (group && IGNORED_DIR_PATTERN.test(group))) {
      return { ok: false, error: 'Name würde ignoriert (beginnt mit „serie", „archiv", . oder _)' }
    }

    if (this.index) {
      // Identität kanonisieren: existiert die Vorlage schon (case-/Unicode-
      // insensitiv, wie NTFS Pfade auflöst), übernehmen wir die Schreibweise
      // des vorhandenen Ordners — sonst überschreibt "sommerfest" auf Windows
      // still "Sommerfest", ohne dass Warnung und Auto-Neuanwenden greifen
      const norm = (s: string) => s.normalize('NFC').toLowerCase()
      const snap = this.index.getSnapshot()
      const existing = snap.templates.find((t) => norm(t.group) === norm(group) && norm(t.name) === norm(name))
      if (existing) {
        name = existing.name
        group = existing.group
      } else {
        // Struktur-Kollisionen abfangen: eine Wurzel-Vorlage, die wie eine
        // Gruppe heisst, würde deren Vorlagen unsichtbar machen (und umgekehrt)
        const groupNames = new Set(
          [...snap.templates.map((t) => t.group), ...snap.singles.map((s) => (s.file.includes('/') ? s.file.split('/')[0]! : ''))]
            .filter(Boolean)
            .map(norm),
        )
        const rootTemplates = new Set(snap.templates.filter((t) => !t.group).map((t) => norm(t.name)))
        if (!group && groupNames.has(norm(name))) {
          return { ok: false, error: `„${name}" ist bereits eine Gruppe — bitte Gruppe auswählen oder anders benennen` }
        }
        if (group && rootTemplates.has(norm(group))) {
          return { ok: false, error: `„${group}" ist bereits eine Vorlage im Wurzelordner — anderer Gruppen-Name nötig` }
        }
      }
    }
    const supported = (fileName: string) => {
      const e = path.extname(fileName).toLowerCase()
      return VIDEO_EXTENSIONS.has(e) || IMAGE_EXTENSIONS.has(e)
    }

    if (params.mode === 'quad') {
      const entries = Object.values(params.sources ?? {}) as IngestSource[]
      if (entries.length === 0) {
        return { ok: false, error: 'Modus "4 Dateien" braucht mindestens eine Datei' }
      }
      for (const src of entries) {
        if (!supported(src.originalName)) {
          return { ok: false, error: `Nicht unterstütztes Format: ${path.extname(src.originalName)}` }
        }
      }
    } else {
      if (!supported(params.originalName)) {
        return { ok: false, error: `Nicht unterstütztes Format: ${path.extname(params.originalName)}` }
      }
      if (params.mode === 'single' && !params.target) {
        return { ok: false, error: 'Modus "single" braucht eine Ziel-Leinwand' }
      }
    }

    const id = crypto.randomBytes(6).toString('hex')
    const quadCount = params.mode === 'quad' ? Object.keys(params.sources ?? {}).length : 0
    const modeLabel =
      params.mode === 'single'
        ? `→ ${params.target}`
        : params.mode === 'clone'
          ? 'alle gleich'
          : params.mode === 'span2'
            ? 'je über 2'
            : params.mode === 'quad'
              ? `${quadCount} Dateien`
              : 'über alle 4'
    const sourceLabel = params.mode === 'quad' ? `${quadCount} Datei(en)` : params.originalName
    const ref = group ? `${group}/${name}` : name
    this.jobs.push({
      id,
      label: `${ref} ← ${sourceLabel} (${modeLabel})`,
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    })
    this.params.set(id, { ...params, templateName: name, group })
    this.publish()
    void this.pump()
    return { ok: true, jobId: id }
  }

  private publish(): void {
    this.store.setJobs(this.list())
  }

  private update(id: string, patch: Partial<IngestJob>): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return
    Object.assign(job, patch)
    this.publish()
  }

  /** Läuft gerade ein Video auf einer Leinwand? Dann Encoding-Threads drosseln. */
  private videoIsLive(): boolean {
    const snapshot = this.store.snapshot()
    return Object.values(snapshot.screens).some((c) => c?.kind === 'video')
  }

  private async pump(): Promise<void> {
    if (this.working) return
    const next = this.jobs.find((j) => j.status === 'queued')
    if (!next) return
    this.working = true
    this.update(next.id, { status: 'running', progress: 0 })
    try {
      const params = this.params.get(next.id)
      if (!params) throw new Error('Job-Parameter verloren')
      await this.process(next.id, params)
      this.update(next.id, { status: 'done', progress: 1 })
      await this.reapplyIfActive(params)
    } catch (err) {
      console.error('[ingest] Job fehlgeschlagen:', err)
      this.update(next.id, { status: 'error', error: err instanceof Error ? err.message : String(err) })
    } finally {
      const params = this.params.get(next.id)
      if (params) {
        if (params.uploadPath) fs.rmSync(params.uploadPath, { force: true })
        // quad: jede Leinwand-Quelle aufräumen
        for (const src of Object.values(params.sources ?? {})) {
          if (src?.uploadPath) fs.rmSync(src.uploadPath, { force: true })
        }
      }
      this.params.delete(next.id)
      this.working = false
      void this.pump()
    }
  }

  /**
   * Wurde die gerade LIVE geschaltete Vorlage überschrieben, sofort neu
   * anwenden — die Versionierung (mtime+size) sorgt dafür, dass nur die
   * tatsächlich geänderten Leinwände neu laden.
   */
  private async reapplyIfActive(params: IngestParams): Promise<void> {
    if (!this.index) return
    const ref = params.group ? `${params.group}/${params.templateName}` : params.templateName
    if (this.store.snapshot().activeTemplate !== ref) return
    try {
      await this.index.rescanNow()
      // Erneut prüfen: der Bediener könnte während der Verarbeitung
      // gewechselt haben — dann nicht ungefragt zurückschalten
      if (this.store.snapshot().activeTemplate !== ref) return
      const template = this.index.getTemplate(ref)
      if (template) {
        const result = await this.store.applyTemplate(template)
        if (!result.ok) console.warn('[ingest] Auto-Neuanwenden abgelehnt:', result.error)
      }
    } catch (err) {
      console.warn('[ingest] Auto-Neuanwenden fehlgeschlagen:', err)
    }
  }

  private async process(jobId: string, params: IngestParams): Promise<void> {
    const mediaRoot = this.store.getConfig().mediaRoot
    if (!mediaRoot || !fs.existsSync(mediaRoot)) {
      throw new Error('Medienordner nicht konfiguriert oder nicht vorhanden')
    }
    const jobDir = path.join(this.workDir(), jobId)
    fs.mkdirSync(jobDir, { recursive: true })
    const outputs = new Map<ScreenName, string>()

    try {
      if (params.mode === 'quad') {
        await this.processQuad(jobId, params, jobDir, outputs)
      } else {
        const targets: ScreenName[] = params.mode === 'single' ? [params.target!] : [...SCREEN_NAMES]
        const ext = path.extname(params.originalName).toLowerCase()
        if (VIDEO_EXTENSIONS.has(ext)) {
          await this.processVideo(jobId, params, jobDir, targets, outputs)
        } else {
          await this.processImage(params, jobDir, targets, outputs)
          this.update(jobId, { progress: 0.9 })
        }
      }
      await this.finalize(params, mediaRoot, outputs)
    } finally {
      fs.rmSync(jobDir, { recursive: true, force: true })
    }
  }

  /**
   * Modus 'quad': je Leinwand eine eigene Datei — jede wird wie ein
   * single-Upload auf IHRE Leinwand normalisiert (Bild 1080×1920, Video
   * 720×1280, eigene Einpassung). Encodes laufen seriell (HD630).
   */
  private async processQuad(
    jobId: string,
    params: IngestParams,
    jobDir: string,
    outputs: Map<ScreenName, string>,
  ): Promise<void> {
    const sources = params.sources ?? {}
    const screens = (Object.keys(sources) as ScreenName[]).filter((s) => sources[s])
    const live = this.videoIsLive()
    let done = 0
    for (const screen of screens) {
      const src = sources[screen]!
      const ext = path.extname(src.originalName).toLowerCase()
      const base = done / screens.length
      const span = 1 / screens.length
      if (VIDEO_EXTENSIONS.has(ext)) {
        let input = src.uploadPath
        const durationS = await probeDuration(input)
        if (params.loopSmooth) {
          input = await this.smoothLoop(input, path.join(jobDir, `_loop_${screen}.mp4`), durationS, params.loopCrossfadeS, live)
        }
        const scale = scaleFilter(src.fit, VIDEO_TARGET_W, VIDEO_TARGET_H)
        const out = path.join(jobDir, `${screen}.mp4`)
        const encDur = params.loopSmooth ? Math.max(0.1, durationS - params.loopCrossfadeS) : durationS
        await runFfmpeg(
          ['-i', input, '-vf', `fps=30,${scale},setsar=1,format=yuv420p`, ...encoderArgs(live ? 1 : 0), out],
          encDur,
          (f) => this.update(jobId, { progress: Math.min(0.95, (base + f * span) * 0.95) }),
        )
        outputs.set(screen, out)
      } else {
        const out = path.join(jobDir, `${screen}.jpg`)
        await sharp(src.uploadPath, { failOn: 'error' })
          .rotate()
          .resize(IMAGE_TARGET_W, IMAGE_TARGET_H, { fit: sharpFit(src.fit), background: { r: 0, g: 0, b: 0 } })
          .flatten({ background: { r: 0, g: 0, b: 0 } })
          .jpeg({ quality: 90, mozjpeg: true })
          .toFile(out)
        outputs.set(screen, out)
      }
      done++
      this.update(jobId, { progress: Math.min(0.95, (done / screens.length) * 0.95) })
    }
  }

  /**
   * Loop-Glättung: aus einem Video der Dauer D wird D−C, wobei die letzten C
   * Sekunden weich in den Anfang überblenden (blend genau auf der Loop-Naht).
   * Sehr kurze Clips (kein Mittelstück übrig) werden unverändert gelassen.
   */
  private async smoothLoop(
    inputPath: string,
    outPath: string,
    durationS: number,
    crossfadeS: number,
    live: boolean,
  ): Promise<string> {
    const C = crossfadeS
    if (!(durationS > 0) || C <= 0 || durationS - 2 * C < 0.1) return inputPath
    const target = durationS - C
    const f = (n: number) => n.toFixed(3)
    const fc = [
      `[0:v]trim=0:${f(C)},setpts=PTS-STARTPTS[head]`,
      `[0:v]trim=${f(target)}:${f(durationS)},setpts=PTS-STARTPTS[tail]`,
      `[0:v]trim=${f(C)}:${f(target)},setpts=PTS-STARTPTS[mid]`,
      // Naht: front = head*(T/C) + tail*(1−T/C) — startet als Ende, endet als Anfang
      `[head][tail]blend=all_expr=A*(T/${f(C)})+B*(1-T/${f(C)})[front]`,
      `[front][mid]concat=n=2:v=1:a=0,format=yuv420p[v]`,
    ].join(';')
    await runFfmpeg(['-i', inputPath, '-filter_complex', fc, '-map', '[v]', ...encoderArgs(live ? 2 : 0), outPath], durationS, () => {})
    return outPath
  }

  private async processImage(
    params: IngestParams,
    jobDir: string,
    targets: ScreenName[],
    outputs: Map<ScreenName, string>,
  ): Promise<void> {
    const base = sharp(params.uploadPath, { failOn: 'error' }).rotate()

    if (params.mode === 'span') {
      const layout = this.store.getConfig().layout
      const { wallW, wallH, crops } = spanCrops(layout, IMAGE_TARGET_W, IMAGE_TARGET_H, params.gaps)
      const wall = await base
        .resize(wallW, wallH, {
          fit: sharpFit(params.fit),
          background: { r: 0, g: 0, b: 0 },
        })
        .flatten({ background: { r: 0, g: 0, b: 0 } })
        .toBuffer()
      for (const crop of crops) {
        if (!targets.includes(crop.screen)) continue
        const out = path.join(jobDir, `${crop.screen}.jpg`)
        await sharp(wall)
          .extract({ left: crop.x, top: crop.y, width: IMAGE_TARGET_W, height: IMAGE_TARGET_H })
          .jpeg({ quality: 90, mozjpeg: true })
          .toFile(out)
        outputs.set(crop.screen, out)
      }
      return
    }

    if (params.mode === 'span2') {
      // Je über 2 Leinwände gespannt: linkes Paar und rechtes Paar identisch;
      // bei mirror wird das rechte Paar (Index 1) horizontal gespiegelt
      const layout = this.store.getConfig().layout
      const pairs = span2Pairs(layout, IMAGE_TARGET_W, IMAGE_TARGET_H, params.gaps)
      for (let pi = 0; pi < pairs.length; pi++) {
        const pair = pairs[pi]!
        let img = base
          .clone()
          .resize(pair.wallW, pair.wallH, {
            fit: sharpFit(params.fit),
            background: { r: 0, g: 0, b: 0 },
          })
          .flatten({ background: { r: 0, g: 0, b: 0 } })
        if (params.mirror && pi === 1) img = img.flop()
        const wall = await img.toBuffer()
        for (const crop of pair.crops) {
          if (!targets.includes(crop.screen)) continue
          const out = path.join(jobDir, `${crop.screen}.jpg`)
          await sharp(wall)
            .extract({ left: crop.x, top: crop.y, width: IMAGE_TARGET_W, height: IMAGE_TARGET_H })
            .jpeg({ quality: 90, mozjpeg: true })
            .toFile(out)
          outputs.set(crop.screen, out)
        }
      }
      return
    }

    // single/clone: einmal rechnen, dann kopieren
    const single = path.join(jobDir, 'out.jpg')
    await base
      .resize(IMAGE_TARGET_W, IMAGE_TARGET_H, { fit: sharpFit(params.fit), background: { r: 0, g: 0, b: 0 } })
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .jpeg({ quality: 90, mozjpeg: true })
      .toFile(single)
    for (const screen of targets) {
      const out = path.join(jobDir, `${screen}.jpg`)
      await fs.promises.copyFile(single, out)
      outputs.set(screen, out)
    }
  }

  private async processVideo(
    jobId: string,
    params: IngestParams,
    jobDir: string,
    targets: ScreenName[],
    outputs: Map<ScreenName, string>,
  ): Promise<void> {
    const durationS = await probeDuration(params.uploadPath)
    // Laufen gerade Videos live, pro Encoder nur 1–2 Threads: zusammen mit
    // der niedrigen Prozess-Priorität bleibt die Wiedergabe flüssig, das
    // Encoding dauert einfach länger
    const live = this.videoIsLive()

    // Optionaler Loop-Glättungs-Vorlauf: erzeugt eine nahtlos loopende Quelle,
    // auf die dann die unveränderte Skalier-/Zuschnitt-Pipeline angewendet wird.
    let inputPath = params.uploadPath
    let encDur = durationS
    const preShare = params.loopSmooth ? 0.3 : 0
    if (params.loopSmooth) {
      inputPath = await this.smoothLoop(inputPath, path.join(jobDir, '_loop.mp4'), durationS, params.loopCrossfadeS, live)
      if (inputPath !== params.uploadPath) encDur = Math.max(0.1, durationS - params.loopCrossfadeS)
      this.update(jobId, { progress: preShare * 0.95 })
    }
    const onProgress = (fr: number) =>
      this.update(jobId, { progress: Math.min(0.95, (preShare + fr * (1 - preShare)) * 0.95) })

    if (params.mode === 'span') {
      const layout = this.store.getConfig().layout
      const { wallW, wallH, crops } = spanCrops(layout, VIDEO_TARGET_W, VIDEO_TARGET_H, params.gaps)
      const scale = scaleFilter(params.fit, wallW, wallH)
      const parts = [`[0:v]fps=30,${scale},setsar=1[wall]`, `[wall]split=${crops.length}${crops.map((_, i) => `[c${i}]`).join('')}`]
      crops.forEach((crop, i) => {
        parts.push(`[c${i}]crop=${VIDEO_TARGET_W}:${VIDEO_TARGET_H}:${crop.x}:${crop.y},format=yuv420p[o${i}]`)
      })
      const args = ['-i', inputPath, '-filter_complex', parts.join(';')]
      crops.forEach((crop, i) => {
        const out = path.join(jobDir, `${crop.screen}.mp4`)
        args.push('-map', `[o${i}]`, ...encoderArgs(live ? 1 : 0), out)
        outputs.set(crop.screen, out)
      })
      await runFfmpeg(args, encDur, onProgress)
      return
    }

    if (params.mode === 'span2') {
      // Ein ffmpeg-Lauf: Quelle einmal decodieren, pro Paar skalieren
      // (Lücken links/rechts können verschieden sein), je 2 Zuschnitte
      const layout = this.store.getConfig().layout
      const pairs = span2Pairs(layout, VIDEO_TARGET_W, VIDEO_TARGET_H, params.gaps)
      const parts = [`[0:v]fps=30,split=2[srcA][srcB]`]
      const mapLabels: Array<{ label: string; screen: (typeof pairs)[0]['crops'][0]['screen'] }> = []
      pairs.forEach((pair, p) => {
        const src = p === 0 ? 'srcA' : 'srcB'
        const scale = scaleFilter(params.fit, pair.wallW, pair.wallH)
        // Rechtes Paar (p===1) bei mirror horizontal spiegeln — die ganze
        // Doppel-Leinwand wird gespiegelt, dann wie gehabt zugeschnitten
        const flip = params.mirror && p === 1 ? ',hflip' : ''
        parts.push(`[${src}]${scale}${flip},setsar=1[w${p}]`, `[w${p}]split=2[p${p}a][p${p}b]`)
        pair.crops.forEach((crop, c) => {
          const label = `o${p}${c}`
          parts.push(
            `[p${p}${c === 0 ? 'a' : 'b'}]crop=${VIDEO_TARGET_W}:${VIDEO_TARGET_H}:${crop.x}:${crop.y},format=yuv420p[${label}]`,
          )
          mapLabels.push({ label, screen: crop.screen })
        })
      })
      const args = ['-i', inputPath, '-filter_complex', parts.join(';')]
      for (const { label, screen } of mapLabels) {
        const out = path.join(jobDir, `${screen}.mp4`)
        args.push('-map', `[${label}]`, ...encoderArgs(live ? 1 : 0), out)
        outputs.set(screen, out)
      }
      await runFfmpeg(args, encDur, onProgress)
      return
    }

    // single/clone: einmal encodieren, dann kopieren
    const scale = scaleFilter(params.fit, VIDEO_TARGET_W, VIDEO_TARGET_H)
    const single = path.join(jobDir, 'out.mp4')
    await runFfmpeg(
      ['-i', inputPath, '-vf', `fps=30,${scale},setsar=1,format=yuv420p`, ...encoderArgs(live ? 2 : 0), single],
      encDur,
      onProgress,
    )
    for (const screen of targets) {
      const out = path.join(jobDir, `${screen}.mp4`)
      await fs.promises.copyFile(single, out)
      outputs.set(screen, out)
    }
  }

  /** Fertige Dateien atomar in den Sync-Ordner einsetzen, _meta.json als Commit-Marker. */
  private async finalize(params: IngestParams, mediaRoot: string, outputs: Map<ScreenName, string>): Promise<void> {
    const destDir = params.group
      ? path.join(mediaRoot, params.group, params.templateName)
      : path.join(mediaRoot, params.templateName)
    await fs.promises.mkdir(destDir, { recursive: true })

    const ALL_EXT = ['.mp4', '.webm', '.png', '.jpg', '.jpeg', '.webp']
    // Endung je Leinwand aus der Ausgabedatei ableiten — im quad-Modus kann
    // sie pro Leinwand verschieden sein (Bild vs. Video)
    for (const [screen, src] of outputs) {
      const newExt = path.extname(src).toLowerCase()
      const dest = path.join(destDir, `${screen}${newExt}`)
      const tmp = path.join(destDir, `.${screen}${newExt}.tmp-${process.pid}`)
      // copy+rename statt rename: Work-Dir und Sync-Ordner können auf
      // verschiedenen Laufwerken liegen
      await fs.promises.copyFile(src, tmp)
      await fs.promises.rename(tmp, dest)
      // Alte Dateien anderer Endungen für diese Leinwand entfernen — sonst
      // gewinnt z.B. ein altes mp4 per Priorität gegen das neue jpg
      for (const oldExt of ALL_EXT) {
        if (oldExt === newExt) continue
        await fs.promises.rm(path.join(destDir, `${screen}${oldExt}`), { force: true }).catch(() => {})
      }
    }

    // Original(e) aufheben (Backup + Grundlage für spätere Re-Renders)
    const originalDir = path.join(destDir, '_original')
    await fs.promises.mkdir(originalDir, { recursive: true })

    const meta: TemplateMeta = {
      version: 1,
      mode: params.mode,
      targets: [...outputs.keys()],
      createdAt: new Date().toISOString(),
      tool: 'seitenscreens-ingest',
    }

    if (params.mode === 'quad') {
      const sources = params.sources ?? {}
      const metaSources: NonNullable<TemplateMeta['sources']> = {}
      for (const screen of Object.keys(sources) as ScreenName[]) {
        const src = sources[screen]
        if (!src) continue
        // Screen-Präfix entkoppelt gleichnamige Dateien mehrerer Leinwände
        const stored = `${screen}__${src.originalName}`
        await fs.promises.copyFile(src.uploadPath, path.join(originalDir, stored)).catch(() => {})
        const kind = VIDEO_EXTENSIONS.has(path.extname(src.originalName).toLowerCase()) ? 'video' : 'image'
        metaSources[screen] = { file: stored, fit: src.fit, kind }
      }
      meta.sources = metaSources
    } else {
      await fs.promises.copyFile(params.uploadPath, path.join(originalDir, params.originalName)).catch(() => {})
      meta.source = params.originalName
      meta.fit = params.fit
      if (params.mode === 'span' || params.mode === 'span2') {
        meta.gaps = params.gaps
        meta.layout = this.store.getConfig().layout
      }
      if (params.mode === 'span2') meta.mirror = params.mirror
      if (params.loopSmooth) {
        meta.loopSmooth = true
        meta.loopCrossfadeS = params.loopCrossfadeS
      }
    }

    const metaTmp = path.join(destDir, '._meta.json.tmp')
    await fs.promises.writeFile(metaTmp, JSON.stringify(meta, null, 2))
    await fs.promises.rename(metaTmp, path.join(destDir, '_meta.json'))
  }

  // --- Re-Render aus _original (nach geänderten Wandmassen etc.) ---

  private destDirFor(group: string, name: string): string {
    return group
      ? path.join(this.store.getConfig().mediaRoot, group, name)
      : path.join(this.store.getConfig().mediaRoot, name)
  }

  private readMeta(destDir: string): TemplateMeta | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(destDir, '_meta.json'), 'utf-8')) as TemplateMeta
    } catch {
      return null
    }
  }

  /** Eine Vorlage aus ihrem _original + _meta.json neu rechnen (frisches Layout). */
  async rerenderTemplate(template: TemplateInfo): Promise<{ ok: boolean; jobId?: string; error?: string }> {
    const mediaRoot = this.store.getConfig().mediaRoot
    if (!mediaRoot) return { ok: false, error: 'Medienordner nicht konfiguriert' }
    const destDir = this.destDirFor(template.group, template.name)
    const meta = this.readMeta(destDir)
    if (!meta) {
      return { ok: false, error: `Keine _meta.json — vor der Re-Render-Funktion erstellt, bitte neu hochladen: ${template.ref}` }
    }
    const originalDir = path.join(destDir, '_original')

    // KRITISCH: das Original NICHT direkt enqueuen — pump() löscht die
    // Upload-Datei am Ende. Deshalb in eine Wegwerf-Kopie im Work-Dir kopieren.
    const workCopy = (rel: string): string => {
      const abs = path.join(originalDir, rel)
      if (!fs.existsSync(abs)) throw new Error(`Original fehlt: _original/${rel}`)
      const dest = path.join(this.workDir(), `rerender-${crypto.randomBytes(6).toString('hex')}-${path.basename(rel)}`)
      fs.copyFileSync(abs, dest)
      return dest
    }

    try {
      if (meta.mode === 'quad') {
        const sources: Partial<Record<ScreenName, IngestSource>> = {}
        for (const screen of Object.keys(meta.sources ?? {}) as ScreenName[]) {
          const s = meta.sources![screen]!
          sources[screen] = { uploadPath: workCopy(s.file), originalName: s.file.replace(/^[^_]*__/, ''), fit: s.fit }
        }
        if (Object.keys(sources).length === 0) return { ok: false, error: 'Keine Quellen im _meta' }
        return this.enqueue({
          uploadPath: '',
          originalName: '',
          group: template.group,
          templateName: template.name,
          mode: 'quad',
          fit: 'contain',
          gaps: 'exact',
          mirror: false,
          loopSmooth: false,
          loopCrossfadeS: 0.5,
          sources,
        })
      }
      if (!meta.source) return { ok: false, error: `Kein Original im _meta: ${template.ref}` }
      return this.enqueue({
        uploadPath: workCopy(meta.source),
        originalName: meta.source,
        group: template.group,
        templateName: template.name,
        mode: meta.mode,
        target: meta.mode === 'single' ? meta.targets[0] : undefined,
        fit: meta.fit ?? 'contain',
        gaps: meta.gaps ?? 'exact',
        mirror: meta.mirror ?? false,
        loopSmooth: meta.loopSmooth ?? false,
        loopCrossfadeS: meta.loopCrossfadeS ?? 0.5,
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Alle Vorlagen der gewünschten Modi neu rechnen (z.B. span,span2). */
  async rerenderByModes(modes: IngestMode[]): Promise<{ queued: string[]; skipped: { ref: string; reason: string }[] }> {
    const queued: string[] = []
    const skipped: { ref: string; reason: string }[] = []
    const templates = this.index?.getSnapshot().templates ?? []
    for (const t of templates) {
      const meta = this.readMeta(this.destDirFor(t.group, t.name))
      if (!meta) {
        skipped.push({ ref: t.ref, reason: 'keine _meta.json' })
        continue
      }
      if (!modes.includes(meta.mode)) continue
      const r = await this.rerenderTemplate(t)
      if (r.ok) queued.push(t.ref)
      else skipped.push({ ref: t.ref, reason: r.error ?? 'Fehler' })
    }
    return { queued, skipped }
  }
}

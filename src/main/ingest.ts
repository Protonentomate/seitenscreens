import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { Store } from './store'
import type { IngestFit, IngestJob, IngestMode, WallLayout } from '../shared/types'
import { SCREEN_NAMES, type ScreenName } from '../shared/screens'

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
 * - Die Queue pausiert, solange ein Video live auf den Leinwänden läuft:
 *   x264 frisst Speicherbandbreite, die sich die iGPU mit dem Decode teilt
 */

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv'])
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

const VIDEO_TARGET_W = 720
const VIDEO_TARGET_H = 1280
const IMAGE_TARGET_W = 1080
const IMAGE_TARGET_H = 1920

const ENCODER_ARGS = [
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
]

function ffmpegBinary(): string {
  return process.env.SEITENSCREENS_FFMPEG || 'ffmpeg'
}
function ffprobeBinary(): string {
  return process.env.SEITENSCREENS_FFPROBE || 'ffprobe'
}

export interface IngestParams {
  uploadPath: string
  originalName: string
  templateName: string
  mode: IngestMode
  /** Nur bei mode 'single'. */
  target?: ScreenName
  fit: IngestFit
}

interface SpanCrop {
  screen: ScreenName
  x: number
}

/** Zuschnitt-Offsets für den Span-Modus aus dem Wand-Layout (in Ziel-Pixeln). */
export function spanCrops(layout: WallLayout, targetW: number): { wallW: number; crops: SpanCrop[] } {
  const ppmm = targetW / layout.canvasWmm
  const totalMm = 4 * layout.canvasWmm + layout.gapsMm[0] + layout.gapsMm[1] + layout.gapsMm[2]
  const wallW = Math.round(totalMm * ppmm)
  const crops: SpanCrop[] = SCREEN_NAMES.map((screen, i) => {
    const gapSumMm = layout.gapsMm.slice(0, i).reduce((a, b) => a + b, 0)
    return { screen, x: Math.round((i * layout.canvasWmm + gapSumMm) * ppmm) }
  })
  return { wallW, crops }
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

/** ffmpeg mit Fortschritts-Parsing (-progress pipe:1). */
function runFfmpeg(args: string[], durationS: number, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBinary(), ['-y', '-nostats', '-progress', 'pipe:1', ...args])
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
  private readonly jobs: IngestJob[] = []
  private readonly params = new Map<string, IngestParams>()
  private working = false

  constructor(store: Store) {
    this.store = store
    // Wenn ein Video-Template endet, ggf. wartende Jobs anstossen
    store.on('state', () => {
      if (!this.working) void this.pump()
    })
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
    const name = params.templateName.trim()
    if (!name || /[/\\]|^\.|^_/.test(name) || name.includes('..')) {
      return { ok: false, error: 'Ungültiger Vorlagen-Name (keine Slashes, nicht mit . oder _ beginnen)' }
    }
    const ext = path.extname(params.originalName).toLowerCase()
    if (!VIDEO_EXTENSIONS.has(ext) && !IMAGE_EXTENSIONS.has(ext)) {
      return { ok: false, error: `Nicht unterstütztes Format: ${ext}` }
    }
    if (params.mode === 'single' && !params.target) {
      return { ok: false, error: 'Modus "single" braucht eine Ziel-Leinwand' }
    }
    const id = crypto.randomBytes(6).toString('hex')
    const modeLabel = params.mode === 'single' ? `→ ${params.target}` : params.mode === 'clone' ? 'alle gleich' : 'über alle 4'
    this.jobs.push({
      id,
      label: `${name} ← ${params.originalName} (${modeLabel})`,
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    })
    this.params.set(id, { ...params, templateName: name })
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

  /** Läuft gerade ein Video auf einer Leinwand? Dann nicht transkodieren. */
  private videoIsLive(): boolean {
    const snapshot = this.store.snapshot()
    return Object.values(snapshot.screens).some((c) => c?.kind === 'video')
  }

  private async pump(): Promise<void> {
    if (this.working) return
    // Nur Video-Encoding (x264 = Speicherbandbreite) muss auf ein Ende der
    // Live-Videos warten — Bild-Jobs (sharp, <2s) laufen sofort und dürfen
    // an wartenden Video-Jobs vorbeiziehen
    const videoLive = this.videoIsLive()
    let next: IngestJob | undefined
    for (const job of this.jobs) {
      if (job.status !== 'queued' && job.status !== 'waiting-live') continue
      const params = this.params.get(job.id)
      const isVideoJob = params ? VIDEO_EXTENSIONS.has(path.extname(params.originalName).toLowerCase()) : false
      if (isVideoJob && videoLive) {
        if (job.status !== 'waiting-live') this.update(job.id, { status: 'waiting-live' })
        continue
      }
      next = job
      break
    }
    if (!next) return
    this.working = true
    this.update(next.id, { status: 'running', progress: 0 })
    try {
      const params = this.params.get(next.id)
      if (!params) throw new Error('Job-Parameter verloren')
      await this.process(next.id, params)
      this.update(next.id, { status: 'done', progress: 1 })
    } catch (err) {
      console.error('[ingest] Job fehlgeschlagen:', err)
      this.update(next.id, { status: 'error', error: err instanceof Error ? err.message : String(err) })
    } finally {
      const params = this.params.get(next.id)
      if (params) fs.rmSync(params.uploadPath, { force: true })
      this.params.delete(next.id)
      this.working = false
      void this.pump()
    }
  }

  private async process(jobId: string, params: IngestParams): Promise<void> {
    const mediaRoot = this.store.getConfig().mediaRoot
    if (!mediaRoot || !fs.existsSync(mediaRoot)) {
      throw new Error('Medienordner nicht konfiguriert oder nicht vorhanden')
    }
    const ext = path.extname(params.originalName).toLowerCase()
    const isVideo = VIDEO_EXTENSIONS.has(ext)
    const jobDir = path.join(this.workDir(), jobId)
    fs.mkdirSync(jobDir, { recursive: true })

    const targets: ScreenName[] = params.mode === 'single' ? [params.target!] : [...SCREEN_NAMES]
    const outputs = new Map<ScreenName, string>()

    try {
      if (isVideo) {
        await this.processVideo(jobId, params, jobDir, targets, outputs)
      } else {
        await this.processImage(params, jobDir, targets, outputs)
        this.update(jobId, { progress: 0.9 })
      }
      await this.finalize(params, mediaRoot, targets, outputs, isVideo)
    } finally {
      fs.rmSync(jobDir, { recursive: true, force: true })
    }
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
      const { wallW, crops } = spanCrops(layout, IMAGE_TARGET_W)
      const wallH = IMAGE_TARGET_H
      const wall = await base
        .resize(wallW, wallH, {
          fit: params.fit,
          background: { r: 0, g: 0, b: 0 },
        })
        .flatten({ background: { r: 0, g: 0, b: 0 } })
        .toBuffer()
      for (const crop of crops) {
        if (!targets.includes(crop.screen)) continue
        const out = path.join(jobDir, `${crop.screen}.jpg`)
        await sharp(wall)
          .extract({ left: crop.x, top: 0, width: IMAGE_TARGET_W, height: wallH })
          .jpeg({ quality: 90, mozjpeg: true })
          .toFile(out)
        outputs.set(crop.screen, out)
      }
      return
    }

    // single/clone: einmal rechnen, dann kopieren
    const single = path.join(jobDir, 'out.jpg')
    await base
      .resize(IMAGE_TARGET_W, IMAGE_TARGET_H, { fit: params.fit, background: { r: 0, g: 0, b: 0 } })
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
    const onProgress = (f: number) => this.update(jobId, { progress: Math.min(0.95, f * 0.95) })

    if (params.mode === 'span') {
      const layout = this.store.getConfig().layout
      const { wallW, crops } = spanCrops(layout, VIDEO_TARGET_W)
      const wallH = VIDEO_TARGET_H
      const scale =
        params.fit === 'cover'
          ? `scale=${wallW}:${wallH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${wallW}:${wallH}`
          : `scale=${wallW}:${wallH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${wallW}:${wallH}:(ow-iw)/2:(oh-ih)/2:black`
      const parts = [`[0:v]fps=30,${scale},setsar=1[wall]`, `[wall]split=${crops.length}${crops.map((_, i) => `[c${i}]`).join('')}`]
      crops.forEach((crop, i) => {
        parts.push(`[c${i}]crop=${VIDEO_TARGET_W}:${wallH}:${crop.x}:0,format=yuv420p[o${i}]`)
      })
      const args = ['-i', params.uploadPath, '-filter_complex', parts.join(';')]
      crops.forEach((crop, i) => {
        const out = path.join(jobDir, `${crop.screen}.mp4`)
        args.push('-map', `[o${i}]`, ...ENCODER_ARGS, out)
        outputs.set(crop.screen, out)
      })
      await runFfmpeg(args, durationS, onProgress)
      return
    }

    // single/clone: einmal encodieren, dann kopieren
    const scale =
      params.fit === 'cover'
        ? `scale=${VIDEO_TARGET_W}:${VIDEO_TARGET_H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${VIDEO_TARGET_W}:${VIDEO_TARGET_H}`
        : `scale=${VIDEO_TARGET_W}:${VIDEO_TARGET_H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${VIDEO_TARGET_W}:${VIDEO_TARGET_H}:(ow-iw)/2:(oh-ih)/2:black`
    const single = path.join(jobDir, 'out.mp4')
    await runFfmpeg(
      ['-i', params.uploadPath, '-vf', `fps=30,${scale},setsar=1,format=yuv420p`, ...ENCODER_ARGS, single],
      durationS,
      onProgress,
    )
    for (const screen of targets) {
      const out = path.join(jobDir, `${screen}.mp4`)
      await fs.promises.copyFile(single, out)
      outputs.set(screen, out)
    }
  }

  /** Fertige Dateien atomar in den Sync-Ordner einsetzen, _meta.json als Commit-Marker. */
  private async finalize(
    params: IngestParams,
    mediaRoot: string,
    targets: ScreenName[],
    outputs: Map<ScreenName, string>,
    isVideo: boolean,
  ): Promise<void> {
    const destDir = path.join(mediaRoot, params.templateName)
    await fs.promises.mkdir(destDir, { recursive: true })

    const newExt = isVideo ? '.mp4' : '.jpg'
    for (const screen of targets) {
      const src = outputs.get(screen)
      if (!src) continue
      const dest = path.join(destDir, `${screen}${newExt}`)
      const tmp = path.join(destDir, `.${screen}${newExt}.tmp-${process.pid}`)
      // copy+rename statt rename: Work-Dir und Sync-Ordner können auf
      // verschiedenen Laufwerken liegen
      await fs.promises.copyFile(src, tmp)
      await fs.promises.rename(tmp, dest)
      // Alte Dateien anderer Endungen für diese Leinwand entfernen — sonst
      // gewinnt z.B. ein altes mp4 per Priorität gegen das neue jpg
      for (const oldExt of ['.mp4', '.webm', '.png', '.jpg', '.jpeg', '.webp']) {
        if (oldExt === newExt) continue
        await fs.promises.rm(path.join(destDir, `${screen}${oldExt}`), { force: true }).catch(() => {})
      }
    }

    // Original aufheben (Backup + Grundlage für spätere Re-Renders)
    const originalDir = path.join(destDir, '_original')
    await fs.promises.mkdir(originalDir, { recursive: true })
    await fs.promises.copyFile(params.uploadPath, path.join(originalDir, params.originalName)).catch(() => {})

    const meta = {
      version: 1,
      mode: params.mode,
      fit: params.fit,
      targets,
      source: params.originalName,
      layout: params.mode === 'span' ? this.store.getConfig().layout : undefined,
      createdAt: new Date().toISOString(),
      tool: 'seitenscreens-ingest',
    }
    const metaTmp = path.join(destDir, '._meta.json.tmp')
    await fs.promises.writeFile(metaTmp, JSON.stringify(meta, null, 2))
    await fs.promises.rename(metaTmp, path.join(destDir, '_meta.json'))
  }
}

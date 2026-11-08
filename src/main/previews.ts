import { app } from 'electron'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MediaFileInfo, MediaIndexSnapshot } from '../shared/types'
import { PREVIEW_FRAMES, PREVIEW_FRAME_H, PREVIEW_FRAME_W } from '../shared/preview'
import { ffmpegBinary } from './ffmpeg'
import { resolveMediaFile } from './media'

/** Bei Änderungen am Format erhöhen → alle Vorschauen werden neu gerechnet. */
const FORMAT_VERSION = 1
/** Höchstens so viele ffmpeg-Läufe gleichzeitig (Wiedergabe hat Vorrang). */
const MAX_PARALLEL = 2

/**
 * Hover-Vorschauen (Filmstreifen) für Videos, gecacht in userData/previews.
 * Entstehen bei Bedarf (erster Hover) und im Hintergrund für alle Videos im
 * Medienordner — so haben auch Vorlagen aus älteren Versionen nach einem
 * Update ihre Vorschau, ohne dass jemand etwas tun muss. ffmpeg läuft dafür
 * mit niedrigster Priorität und einem Thread.
 */
export class PreviewSprites {
  private readonly dir = path.join(app.getPath('userData'), 'previews')
  private readonly inFlight = new Map<string, Promise<string | null>>()
  private running = 0
  private readonly waiting: Array<() => void> = []
  private warmupTimer: NodeJS.Timeout | null = null
  private warmupGeneration = 0

  constructor(private readonly getMediaRoot: () => string) {}

  private keyFor(rel: string, stat: fs.Stats): string {
    return crypto
      .createHash('sha1')
      .update(`${rel}|${Math.round(stat.mtimeMs)}|${stat.size}|v${FORMAT_VERSION}`)
      .digest('hex')
      .slice(0, 20)
  }

  /** Vorschau einer Datei sicherstellen; liefert Pfad + Cache-Schlüssel (oder null). */
  async ensure(info: Pick<MediaFileInfo, 'file' | 'probe'>): Promise<{ path: string; key: string } | null> {
    const abs = resolveMediaFile(this.getMediaRoot(), info.file)
    if (!abs) return null
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      return null
    }
    const key = this.keyFor(info.file, stat)
    const out = path.join(this.dir, `${key}.jpg`)
    if (fs.existsSync(out)) return { path: out, key }
    let job = this.inFlight.get(key)
    if (!job) {
      job = this.withSlot(() => this.render(abs, out, info.probe?.durationS ?? 0)).finally(() => this.inFlight.delete(key))
      this.inFlight.set(key, job)
    }
    const result = await job
    return result ? { path: result, key } : null
  }

  private async withSlot<T>(op: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_PARALLEL) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.running++
    try {
      return await op()
    } finally {
      this.running--
      this.waiting.shift()?.()
    }
  }

  /**
   * Ein ffmpeg-Lauf: PREVIEW_FRAMES Bilder gleichmässig über die Dauer,
   * verkleinert und nebeneinander gekachelt. Die Abtastrate liegt knapp über
   * N/Dauer, damit sicher genug Bilder für eine volle Kachel entstehen.
   */
  private render(abs: string, out: string, durationS: number): Promise<string | null> {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${out}.${process.pid}.tmp.jpg`
    const d = durationS > 0.5 ? durationS : 10
    const vf = [
      `fps=${PREVIEW_FRAMES}/${(d * 0.97).toFixed(3)}`,
      `scale=${PREVIEW_FRAME_W}:${PREVIEW_FRAME_H}:flags=bilinear`,
      `tile=${PREVIEW_FRAMES}x1`,
    ].join(',')
    return new Promise((resolve) => {
      const proc = spawn(ffmpegBinary(), ['-v', 'error', '-y', '-threads', '1', '-i', abs, '-an', '-vf', vf, '-frames:v', '1', '-q:v', '6', tmp])
      try {
        if (proc.pid) os.setPriority(proc.pid, 19)
      } catch {
        // Best-Effort
      }
      const timer = setTimeout(() => proc.kill(), 60_000)
      proc.on('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0 || !fs.existsSync(tmp)) {
          fs.rmSync(tmp, { force: true })
          resolve(null)
          return
        }
        try {
          fs.renameSync(tmp, out)
          resolve(out)
        } catch {
          fs.rmSync(tmp, { force: true })
          resolve(fs.existsSync(out) ? out : null)
        }
      })
    })
  }

  /**
   * Nach jedem Index-Update (entprellt) fehlende Vorschauen nacheinander
   * rechnen und veraltete löschen (ersetzte oder gelöschte Videos).
   */
  scheduleWarmup(snapshot: MediaIndexSnapshot, delayMs = 15_000): void {
    if (this.warmupTimer) clearTimeout(this.warmupTimer)
    this.warmupTimer = setTimeout(() => {
      this.warmupTimer = null
      void this.warmup(snapshot)
    }, delayMs)
  }

  private async warmup(snapshot: MediaIndexSnapshot): Promise<void> {
    const generation = ++this.warmupGeneration
    const videos = new Map<string, MediaFileInfo>()
    for (const t of snapshot.templates) {
      for (const f of Object.values(t.files)) if (f?.kind === 'video') videos.set(f.file, f)
    }
    for (const s of snapshot.singles) if (s.kind === 'video') videos.set(s.file, s)

    const valid = new Set<string>()
    let created = 0
    for (const info of videos.values()) {
      if (generation !== this.warmupGeneration) return // neuer Index → neuer Durchlauf
      const abs = resolveMediaFile(this.getMediaRoot(), info.file)
      if (!abs) continue
      let stat: fs.Stats
      try {
        stat = fs.statSync(abs)
      } catch {
        continue
      }
      const key = this.keyFor(info.file, stat)
      valid.add(key)
      if (fs.existsSync(path.join(this.dir, `${key}.jpg`))) continue
      await this.ensure(info)
      created++
      // Kurze Pause zwischen den Läufen — die Wiedergabe bleibt ungestört
      await new Promise((r) => setTimeout(r, 500))
    }
    if (generation !== this.warmupGeneration) return
    if (created > 0) console.log(`[previews] ${created} Video-Vorschau(en) erstellt`)
    // Veraltete Vorschauen entfernen (nur nach vollständigem Durchlauf)
    try {
      for (const name of fs.readdirSync(this.dir)) {
        const key = name.replace(/\.jpg$/, '')
        if (name.endsWith('.jpg') && !name.includes('.tmp') && !valid.has(key)) {
          fs.rmSync(path.join(this.dir, name), { force: true })
        }
      }
    } catch {
      // Aufräumen darf nie stören
    }
  }
}

/**
 * Drift-Regler für synchronisierte Loop-Videos.
 *
 * Grundidee: Die Soll-Position eines Videos hängt NUR von der Wanduhr ab:
 *   erwartet = ((jetzt − epochMs) / 1000) mod dauer
 * Alle Prozesse laufen auf derselben Maschine, also gibt es kein Uhren-Problem —
 * jede Störung (Loop-Ruckler, Decoder-Stall) erscheint als Fehler gegen die
 * Wanduhr und wird automatisch wieder ausgeregelt.
 *
 * Regelung pro Frame (requestVideoFrameCallback):
 *   |Fehler| < 15 ms   → Deadband, Rate 1.0
 *   15–200 ms          → playbackRate-Nudge (max ±4 %, unsichtbar bei stummen Loops)
 *   ≥ 200 ms           → harter Seek auf die Soll-Position (+ gelernte Seek-Latenz)
 * Nahe am Loop-Übergang (±120 ms) wird nicht korrigiert.
 */

const DEADBAND_S = 0.015
const SEEK_THRESHOLD_S = 0.2
const MAX_RATE_NUDGE = 0.04
const ACTION_INTERVAL_MS = 250
const WRAP_GUARD_S = 0.12
const EMA_ALPHA = 0.3

export interface SyncStats {
  screen: string
  errMs: number
  rate: number
  nudges: number
  seeks: number
  droppedFrames: number
  totalFrames: number
  currentTime: number
  paused: boolean
  readyState: number
}

function signedModDistance(delta: number, modulus: number): number {
  let r = delta % modulus
  if (r > modulus / 2) r -= modulus
  if (r < -modulus / 2) r += modulus
  return r
}

function wrap(value: number, modulus: number): number {
  const r = value % modulus
  return r < 0 ? r + modulus : r
}

export class SyncController {
  private readonly video: HTMLVideoElement
  private readonly epochMs: number
  private readonly screen: string
  private emaErr = 0
  private nextActionAt = 0
  private seekLatencyS = 0.08
  private seekStartedAt: { wallMs: number; target: number } | null = null
  private nudges = 0
  private seeks = 0
  private stopped = false

  constructor(screen: string, video: HTMLVideoElement, epochMs: number) {
    this.screen = screen
    this.video = video
    this.epochMs = epochMs
    this.scheduleFrame()
  }

  stop(): void {
    this.stopped = true
  }

  stats(): SyncStats {
    const q = this.video.getVideoPlaybackQuality?.()
    return {
      screen: this.screen,
      errMs: Math.round(this.emaErr * 1000),
      rate: this.video.playbackRate,
      nudges: this.nudges,
      seeks: this.seeks,
      droppedFrames: q?.droppedVideoFrames ?? 0,
      totalFrames: q?.totalVideoFrames ?? 0,
      currentTime: Math.round(this.video.currentTime * 100) / 100,
      paused: this.video.paused,
      readyState: this.video.readyState,
    }
  }

  private scheduleFrame(): void {
    this.video.requestVideoFrameCallback((now, meta) => this.onFrame(now, meta))
  }

  private onFrame(_now: DOMHighResTimeStamp, meta: VideoFrameCallbackMetadata): void {
    if (this.stopped) return
    const duration = this.video.duration
    if (Number.isFinite(duration) && duration > 0 && !this.video.paused) {
      this.control(meta, duration)
    }
    this.scheduleFrame()
  }

  private control(meta: VideoFrameCallbackMetadata, duration: number): void {
    // Während eines laufenden Seeks liefern rVFC-Frames noch alte mediaTime-Werte —
    // Messungen wären Müll und würden sofort den nächsten Seek auslösen
    if (this.video.seeking || this.seekStartedAt) return

    const wallMs = performance.timeOrigin + meta.expectedDisplayTime
    const expected = wrap((wallMs - this.epochMs) / 1000, duration)
    const err = signedModDistance(meta.mediaTime - expected, duration)
    this.emaErr = this.emaErr * (1 - EMA_ALPHA) + err * EMA_ALPHA

    // Nahe am Loop-Übergang keine Korrekturen — sowohl wenn die Soll- als auch
    // wenn die Ist-Position gleich umspringt (mediaTime → 0)
    const nearWrap = (t: number) => t < WRAP_GUARD_S || t > duration - WRAP_GUARD_S
    if (nearWrap(expected) || nearWrap(meta.mediaTime)) return

    const nowMs = performance.now()
    if (nowMs < this.nextActionAt) return

    const absErr = Math.abs(this.emaErr)
    if (absErr < DEADBAND_S) {
      if (this.video.playbackRate !== 1) this.video.playbackRate = 1
      return
    }

    if (absErr < SEEK_THRESHOLD_S) {
      // Video zu weit vorn (err > 0) → bremsen; zu weit hinten → beschleunigen
      const nudge = Math.max(-MAX_RATE_NUDGE, Math.min(MAX_RATE_NUDGE, this.emaErr))
      this.video.playbackRate = 1 - nudge
      this.nudges++
      this.nextActionAt = nowMs + ACTION_INTERVAL_MS
      return
    }

    // Grober Fehler: harter Seek (Seek-Latenz einrechnen und aus 'seeked' neu lernen)
    const target = wrap(expected + this.seekLatencyS, duration)
    this.video.playbackRate = 1
    this.seekStartedAt = { wallMs: performance.timeOrigin + performance.now(), target }
    this.video.addEventListener(
      'seeked',
      () => {
        if (this.seekStartedAt) {
          const measured = (performance.timeOrigin + performance.now() - this.seekStartedAt.wallMs) / 1000
          if (measured > 0 && measured < 0.3) {
            this.seekLatencyS = this.seekLatencyS * 0.7 + measured * 0.3
          }
          this.seekStartedAt = null
        }
      },
      { once: true },
    )
    this.video.currentTime = target
    this.emaErr = 0
    this.seeks++
    this.nextActionAt = nowMs + 400
    // Falls 'seeked' nie kommt (z.B. Decoder-Fehler): Regler nicht ewig blockieren
    window.setTimeout(() => {
      this.seekStartedAt = null
    }, 1000)
  }
}

/** Startposition beim Einstieg in eine laufende Epoche berechnen. */
export function initialPosition(epochMs: number, duration: number): number {
  return wrap((Date.now() - epochMs) / 1000, duration)
}

import Fastify, { type FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import fastifyCors from '@fastify/cors'
import fastifyMultipart from '@fastify/multipart'
import { app as electronApp } from 'electron'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Store } from './store'
import { kindForFile } from './store'
import type { MediaIndex } from './mediaIndex'
import type { ProjectorManager } from './projectors'
import type { IngestQueue } from './ingest'
import { resolveMediaFile, openFileStream, isServableMedia } from './media'
import { isScreenName, SCREEN_NAMES, WINDOW_ROLES, type ScreenName, type WindowRole } from '../shared/screens'
import type { MediaFileInfo, IngestFit, IngestMode, Quad, SpanGaps } from '../shared/types'

/** Fenster-Aktionen, die main/index bereitstellt (Identify, Vollbild erzwingen). */
export interface WindowControl {
  identify(): void
  refullscreen(): void
}

function ffmpegBinary(): string {
  return process.env.SEITENSCREENS_FFMPEG || 'ffmpeg'
}

function toolAvailable(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(binary, ['-version'], { timeout: 5000 }, (err) => resolve(!err))
  })
}

/**
 * Schlanke HTTP-API — bewusst simple GETs, damit das Stream-Deck-Plugin
 * (API Request) und jeder Browser sie direkt aufrufen können. Ohne Auth,
 * bewusst: Kirchen-LAN, Einfachheit ist Teil der Anforderung.
 */
export async function startApi(
  store: Store,
  index: MediaIndex,
  projectors: ProjectorManager,
  ingest: IngestQueue,
  windowControl: WindowControl,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  // Im Dev-Modus läuft die UI auf dem Vite-Port (5173), die API auf 8080 —
  // ohne CORS blockt der Browser die Antworten ("Failed to fetch"), obwohl
  // die Aktion ausgeführt wurde.
  await app.register(fastifyCors, { origin: true })
  await app.register(fastifyWebsocket)
  await app.register(fastifyMultipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 } })

  const ok = (extra: Record<string, unknown> = {}) => ({ ok: true, ...extra, state: store.snapshot() })

  // Werkzeug-Verfügbarkeit einmal beim Start prüfen (Preflight/Health)
  const tools = {
    ffmpeg: await toolAvailable(ffmpegBinary()),
    ffprobe: await toolAvailable(process.env.SEITENSCREENS_FFPROBE || 'ffprobe'),
  }

  // --- Zustand & Gesundheit ---

  app.get('/api/state', async () => ok())

  app.get('/api/health', async () => {
    const mediaRoot = store.getConfig().mediaRoot
    let mediaRootExists = false
    try {
      mediaRootExists = Boolean(mediaRoot) && fs.statSync(mediaRoot).isDirectory()
    } catch {
      mediaRootExists = false
    }
    return {
      ok: true,
      mediaRoot,
      mediaRootConfigured: Boolean(mediaRoot),
      mediaRootExists,
      templates: index.getSnapshot().templates.length,
      tools,
    }
  })

  // --- Live-Updates: ein WebSocket, komplette Schnappschüsse ---

  app.get('/ws', { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ type: 'state', state: store.snapshot() }))
    const onState = (state: unknown) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'state', state }))
      }
    }
    store.on('state', onState)
    socket.on('close', () => store.off('state', onState))
  })

  // --- Vorlagen & Inhalte ---

  app.get('/api/templates', async () => {
    const snap = index.getSnapshot()
    return { ok: true, templates: snap.templates, singles: snap.singles, updatedAt: snap.updatedAt }
  })

  /**
   * Vorlage anwenden — per "Name" (eindeutig über alle Gruppen, für kurze
   * Stream-Deck-URLs) oder "Gruppe/Name".
   */
  const applyTemplateRef = async (
    ref: string,
    force: boolean,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const resolved = index.resolveTemplate(ref)
    if (resolved.ambiguous) {
      return {
        status: 409,
        body: { ok: false, error: `Mehrdeutig — Gruppe angeben: ${resolved.ambiguous.join(', ')}` },
      }
    }
    const template = resolved.template
    if (!template) {
      return { status: 404, body: { ok: false, error: `Vorlage nicht gefunden: ${ref}` } }
    }
    if (!template.complete && !force) {
      return {
        status: 409,
        body: {
          ok: false,
          error: `Vorlage unvollständig (${template.warnings[0] ?? ''}) — mit ?force=1 werden nur die vorhandenen Leinwände gewechselt`,
        },
      }
    }
    const result = await store.applyTemplate(template)
    if (!result.ok) {
      return { status: 409, body: { ok: false, error: result.error } }
    }
    return { status: 200, body: ok({ applied: template.ref }) }
  }

  app.route({
    method: ['GET', 'POST'],
    url: '/api/template/:name/apply',
    handler: async (req, reply) => {
      const { name } = req.params as { name: string }
      const force = (req.query as Record<string, string>).force === '1'
      const result = await applyTemplateRef(name, force)
      return reply.status(result.status).send(result.body)
    },
  })

  app.route({
    method: ['GET', 'POST'],
    url: '/api/template/:group/:name/apply',
    handler: async (req, reply) => {
      const { group, name } = req.params as { group: string; name: string }
      const force = (req.query as Record<string, string>).force === '1'
      const result = await applyTemplateRef(`${group}/${name}`, force)
      return reply.status(result.status).send(result.body)
    },
  })

  /** Datei im Index suchen (für den Playable-Gate auch bei Einzelbildern). */
  const findInIndex = (rel: string): MediaFileInfo | null => {
    const snap = index.getSnapshot()
    const single = snap.singles.find((s) => s.file === rel)
    if (single) return single
    for (const t of snap.templates) {
      for (const screen of SCREEN_NAMES) {
        const f = t.files[screen]
        if (f && f.file === rel) return f
      }
    }
    return null
  }

  const validateFileParam = (rawFile: string | undefined): { file?: string; error?: string; status?: number } => {
    if (!rawFile) return { error: 'Parameter file fehlt', status: 400 }
    const file = rawFile.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '')
    const kind = kindForFile(file)
    if (!kind) return { error: `Nicht unterstütztes Format: ${file}`, status: 400 }
    if (!resolveMediaFile(store.getConfig().mediaRoot, file)) {
      return { error: `Datei nicht gefunden: ${file}`, status: 404 }
    }
    // Encoding-Kontrakt gilt auch für Einzel-Zuweisungen, nicht nur Vorlagen
    const info = findInIndex(file)
    if (info?.probe && !info.probe.playable) {
      return { error: `Nicht abspielbar: ${info.probe.warnings[0] ?? 'Kontrakt verletzt'}`, status: 409 }
    }
    return { file }
  }

  const contentFor = (file: string) => {
    const info = findInIndex(file)
    return {
      file,
      kind: kindForFile(file)!,
      durationS: info?.probe?.durationS,
    }
  }

  app.route({
    method: ['GET', 'POST'],
    url: '/api/screen/:screen/set',
    handler: async (req, reply) => {
      const { screen } = req.params as { screen: string }
      if (!isScreenName(screen)) {
        return reply.status(404).send({ ok: false, error: `Unbekannte Leinwand: ${screen}` })
      }
      const check = validateFileParam((req.query as Record<string, string>).file)
      if (check.error) return reply.status(check.status ?? 400).send({ ok: false, error: check.error })
      await store.setScreen(screen, contentFor(check.file!))
      return ok()
    },
  })

  /**
   * Mehrere Leinwände in einem Zug — EINE gemeinsame Epoche, damit Videos
   * synchron starten. screens=all oder Komma-Liste (LinksLinks,RechtsRechts).
   */
  app.route({
    method: ['GET', 'POST'],
    url: '/api/screens/set',
    handler: async (req, reply) => {
      const query = req.query as Record<string, string>
      const screensParam = query.screens ?? 'all'
      const targets: ScreenName[] =
        screensParam === 'all'
          ? [...SCREEN_NAMES]
          : screensParam.split(',').filter(isScreenName)
      if (targets.length === 0) {
        return reply.status(400).send({ ok: false, error: 'Keine gültigen Leinwände in screens=' })
      }
      const check = validateFileParam(query.file)
      if (check.error) return reply.status(check.status ?? 400).send({ ok: false, error: check.error })
      await store.setScreens(targets, contentFor(check.file!))
      return ok()
    },
  })

  app.route({
    method: ['GET', 'POST'],
    url: '/api/screen/:screen/clear',
    handler: async (req, reply) => {
      const { screen } = req.params as { screen: string }
      if (!isScreenName(screen)) {
        return reply.status(404).send({ ok: false, error: `Unbekannte Leinwand: ${screen}` })
      }
      await store.setScreen(screen, null)
      return ok()
    },
  })

  // --- Blackout, Testbild & Video-Wiedergabe ---

  app.route({
    method: ['GET', 'POST'],
    url: '/api/blackout/:action',
    handler: async (req, reply) => {
      const { action } = req.params as { action: string }
      if (action === 'on') store.setBlackout(true)
      else if (action === 'off') store.setBlackout(false)
      else if (action === 'toggle') store.toggleBlackout()
      else return reply.status(404).send({ ok: false, error: 'on|off|toggle erwartet' })
      return ok()
    },
  })

  app.route({
    method: ['GET', 'POST'],
    url: '/api/testpattern/:action',
    handler: async (req, reply) => {
      const { action } = req.params as { action: string }
      if (action === 'on') store.setTestPattern(true)
      else if (action === 'off') store.setTestPattern(false)
      else return reply.status(404).send({ ok: false, error: 'on|off erwartet' })
      return ok()
    },
  })

  app.route({
    method: ['GET', 'POST'],
    url: '/api/video/:action',
    handler: async (req, reply) => {
      const { action } = req.params as { action: string }
      if (action === 'pause') store.pauseVideo()
      else if (action === 'play') store.resumeVideo()
      else if (action === 'toggle') store.toggleVideo()
      else if (action === 'seek') {
        const toS = Number((req.query as Record<string, string>).toS)
        if (!Number.isFinite(toS) || toS < 0) {
          return reply.status(400).send({ ok: false, error: 'Parameter toS (Sekunden) fehlt oder ungültig' })
        }
        store.seekVideo(toS)
      } else return reply.status(404).send({ ok: false, error: 'play|pause|toggle|seek erwartet' })
      return ok()
    },
  })

  // --- Beamer ein/aus (control_cgi, wie die bisherigen Stream-Deck-Buttons) ---

  const projectorAction = async (id: string | 'all', action: string) => {
    if (action !== 'on' && action !== 'off') return { status: 404, error: 'on|off erwartet' }
    const result = await projectors.setPower(id, action === 'on')
    store.setProjectors(projectors.list())
    if (!result.ok) return { status: 502, error: result.errors.join(' / ') }
    return { status: 200 }
  }

  app.route({
    method: ['GET', 'POST'],
    url: '/api/projector/:action',
    handler: async (req, reply) => {
      const { action } = req.params as { action: string }
      const result = await projectorAction('all', action)
      if (result.error) return reply.status(result.status).send({ ok: false, error: result.error })
      return ok()
    },
  })

  app.route({
    method: ['GET', 'POST'],
    url: '/api/projector/:id/:action',
    handler: async (req, reply) => {
      const { id, action } = req.params as { id: string; action: string }
      const result = await projectorAction(id, action)
      if (result.error) return reply.status(result.status).send({ ok: false, error: result.error })
      return ok()
    },
  })

  // --- Kalibrierung (Admin: Ecken ziehen mit Live-Vorschau) ---

  const parseQuad = (raw: unknown): Quad | null => {
    const q = raw as Record<string, { x?: unknown; y?: unknown }> | null
    if (!q || typeof q !== 'object') return null
    const corners = {} as Record<'tl' | 'tr' | 'br' | 'bl', { x: number; y: number }>
    for (const key of ['tl', 'tr', 'br', 'bl'] as const) {
      const x = Number(q[key]?.x)
      const y = Number(q[key]?.y)
      // Grosszügige Grenzen: Ecken dürfen auch etwas ausserhalb der Bühne liegen
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 8000 || Math.abs(y) > 8000) return null
      corners[key] = { x, y }
    }
    return corners
  }

  app.post('/api/calibration/:screen', async (req, reply) => {
    const { screen } = req.params as { screen: string }
    if (!isScreenName(screen)) {
      return reply.status(404).send({ ok: false, error: `Unbekannte Leinwand: ${screen}` })
    }
    const body = req.body as { corners?: unknown } | null
    const corners = parseQuad(body?.corners)
    if (!corners) {
      return reply.status(400).send({ ok: false, error: 'corners mit tl/tr/br/bl {x,y} erwartet' })
    }
    store.setCalibration(screen, corners)
    return ok()
  })

  /** Gerade bearbeitete Ecke — der Player markiert sie auf der Leinwand. */
  app.post('/api/calibration/focus', async (req, reply) => {
    const body = req.body as { screen?: string; corner?: string } | null
    if (!body?.screen) {
      store.setCalibrationFocus(null)
      return ok()
    }
    if (!isScreenName(body.screen) || !['tl', 'tr', 'br', 'bl'].includes(body.corner ?? '')) {
      return reply.status(400).send({ ok: false, error: 'screen + corner (tl|tr|br|bl) erwartet' })
    }
    store.setCalibrationFocus({ screen: body.screen, corner: body.corner as 'tl' | 'tr' | 'br' | 'bl' })
    return ok()
  })

  // --- Displays & Fenster (Admin: welcher Ausgang ist welcher Beamer) ---

  const isWindowRole = (v: string): v is WindowRole => (WINDOW_ROLES as readonly string[]).includes(v)

  app.post('/api/display/assign', async (req, reply) => {
    const body = req.body as { window?: string; displayId?: unknown } | null
    const displayId = Number(body?.displayId)
    if (!body?.window || !isWindowRole(body.window) || !Number.isFinite(displayId)) {
      return reply.status(400).send({ ok: false, error: 'window (links|rechts) + displayId erwartet' })
    }
    const exists = store.snapshot().displays.some((d) => d.id === displayId)
    if (!exists) {
      return reply.status(404).send({ ok: false, error: `Display ${displayId} nicht gefunden` })
    }
    store.setWindowAssignment(body.window, displayId)
    return ok()
  })

  app.post('/api/display/rotation', async (req, reply) => {
    const body = req.body as { window?: string; deg?: unknown } | null
    const deg = Number(body?.deg)
    if (!body?.window || !isWindowRole(body.window) || (deg !== 0 && deg !== 180)) {
      return reply.status(400).send({ ok: false, error: 'window (links|rechts) + deg (0|180) erwartet' })
    }
    store.setWindowRotation(body.window, deg as 0 | 180)
    return ok()
  })

  app.route({
    method: ['GET', 'POST'],
    url: '/api/display/identify',
    handler: async () => {
      windowControl.identify()
      return ok()
    },
  })

  app.post('/api/display/refullscreen', async () => {
    windowControl.refullscreen()
    return ok()
  })

  // --- Papierkorb (Admin): nichts wird gelöscht, nur verschoben ---

  /** Eindeutigen Zielpfad im Papierkorb finden (Zeitstempel + Zähler). */
  const trashDestination = (mediaRoot: string, name: string): string => {
    const trashDir = path.join(mediaRoot, '_Papierkorb')
    fs.mkdirSync(trashDir, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')
    let dest = path.join(trashDir, `${stamp} ${name}`)
    let counter = 2
    while (fs.existsSync(dest)) {
      dest = path.join(trashDir, `${stamp} ${name} (${counter})`)
      counter++
    }
    return dest
  }

  app.post('/api/trash', async (req, reply) => {
    const body = req.body as { type?: string; ref?: string; file?: string } | null
    const mediaRoot = store.getConfig().mediaRoot
    if (!mediaRoot || !fs.existsSync(mediaRoot)) {
      return reply.status(409).send({ ok: false, error: 'Medienordner nicht konfiguriert' })
    }

    if (body?.type === 'template' && body.ref) {
      const resolved = index.resolveTemplate(body.ref)
      if (resolved.ambiguous) {
        return reply.status(409).send({ ok: false, error: `Mehrdeutig: ${resolved.ambiguous.join(', ')}` })
      }
      const template = resolved.template
      if (!template) return reply.status(404).send({ ok: false, error: `Vorlage nicht gefunden: ${body.ref}` })
      // Live-Schutz: aktive Vorlage ODER einzelne Dateien daraus auf Leinwänden
      const snapshot = store.snapshot()
      const filePrefix = `${template.ref}/`
      const inUse =
        snapshot.activeTemplate === template.ref ||
        Object.values(snapshot.screens).some((c) => c?.file.startsWith(filePrefix))
      if (inUse) {
        return reply.status(409).send({ ok: false, error: 'Vorlage ist gerade live — zuerst etwas anderes anwenden' })
      }
      const srcDir = template.group
        ? path.join(mediaRoot, template.group, template.name)
        : path.join(mediaRoot, template.name)
      const dest = trashDestination(mediaRoot, template.group ? `${template.group}__${template.name}` : template.name)
      try {
        await fs.promises.rename(srcDir, dest)
      } catch (err) {
        return reply.status(500).send({ ok: false, error: `Verschieben fehlgeschlagen: ${String(err)}` })
      }
      await index.rescanNow()
      return ok({ trashed: template.ref })
    }

    if (body?.type === 'single' && body.file) {
      const rel = body.file
      const isSingle = index.getSnapshot().singles.some((s) => s.file === rel)
      const abs = resolveMediaFile(mediaRoot, rel)
      if (!isSingle || !abs) {
        return reply.status(404).send({ ok: false, error: `Einzelbild nicht gefunden: ${rel}` })
      }
      const inUse = Object.values(store.snapshot().screens).some((c) => c?.file === rel)
      if (inUse) {
        return reply.status(409).send({ ok: false, error: 'Datei liegt gerade auf einer Leinwand — zuerst wechseln' })
      }
      const dest = trashDestination(mediaRoot, path.basename(rel))
      try {
        await fs.promises.rename(abs, dest)
      } catch (err) {
        return reply.status(500).send({ ok: false, error: `Verschieben fehlgeschlagen: ${String(err)}` })
      }
      await index.rescanNow()
      return ok({ trashed: rel })
    }

    return reply.status(400).send({ ok: false, error: 'type template+ref oder single+file erwartet' })
  })

  // --- Upload & Verarbeitung (Admin) ---

  app.post('/api/upload', async (req, reply) => {
    const data = await req.file()
    if (!data) {
      return reply.status(400).send({ ok: false, error: 'Keine Datei im Upload' })
    }
    const fields = data.fields as Record<string, { value?: unknown } | undefined>
    const fieldValue = (name: string): string => String(fields[name]?.value ?? '').trim()

    const templateName = fieldValue('templateName')
    const group = fieldValue('group')
    const mode = fieldValue('mode') as IngestMode
    const fit = (fieldValue('fit') || 'contain') as IngestFit
    const gaps = (fieldValue('gaps') || 'exact') as SpanGaps
    const target = fieldValue('target')

    if (!['single', 'clone', 'span', 'span2'].includes(mode)) {
      return reply.status(400).send({ ok: false, error: 'mode muss single|clone|span|span2 sein' })
    }
    if (!['contain', 'cover', 'stretch'].includes(fit)) {
      return reply.status(400).send({ ok: false, error: 'fit muss contain|cover|stretch sein' })
    }
    if (!['exact', 'none'].includes(gaps)) {
      return reply.status(400).send({ ok: false, error: 'gaps muss exact|none sein' })
    }
    if (mode === 'single' && !isScreenName(target)) {
      return reply.status(400).send({ ok: false, error: 'target muss eine Leinwand sein' })
    }

    // Upload zuerst vollständig ins Work-Dir streamen
    const safeName = path.basename(data.filename || 'upload').replace(/[^\w.\-äöüÄÖÜéèà ]/g, '_')
    const uploadPath = path.join(ingest.workDir(), `upload-${Date.now()}-${safeName}`)
    await pipeline(data.file, fs.createWriteStream(uploadPath))
    if (data.file.truncated) {
      fs.rmSync(uploadPath, { force: true })
      return reply.status(413).send({ ok: false, error: 'Datei zu gross (max. 2 GB)' })
    }

    const result = ingest.enqueue({
      uploadPath,
      originalName: safeName,
      group,
      templateName,
      mode,
      target: mode === 'single' ? (target as ScreenName) : undefined,
      fit,
      gaps,
    })
    if (!result.ok) {
      fs.rmSync(uploadPath, { force: true })
      return reply.status(400).send({ ok: false, error: result.error })
    }
    return ok({ jobId: result.jobId })
  })

  // --- Einstellungen (Medienordner, Übergang, Beamer-IPs) ---

  app.get('/api/config', async () => {
    const cfg = store.getConfig()
    return {
      ok: true,
      config: {
        mediaRoot: cfg.mediaRoot,
        transitionMs: cfg.transitionMs,
        projectors: cfg.projectors,
        layout: cfg.layout,
      },
    }
  })

  app.post('/api/config', async (req, reply) => {
    const body = req.body as
      | { mediaRoot?: string; transitionMs?: number; projectors?: Array<{ id: string; host: string }> }
      | null
      | undefined
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ ok: false, error: 'JSON-Body erwartet' })
    }

    // Phase 1: ALLES validieren, bevor irgendetwas gespeichert wird —
    // sonst meldet die UI einen Fehler, obwohl die Hälfte übernommen wurde
    let newMediaRoot: string | undefined
    if (body.mediaRoot !== undefined) {
      newMediaRoot = body.mediaRoot.trim()
      if (newMediaRoot && newMediaRoot !== store.getConfig().mediaRoot) {
        try {
          if (!fs.statSync(newMediaRoot).isDirectory()) {
            return reply.status(400).send({ ok: false, error: `Kein Ordner: ${newMediaRoot}` })
          }
        } catch {
          return reply.status(400).send({ ok: false, error: `Ordner existiert nicht: ${newMediaRoot}` })
        }
      }
    }
    let newTransitionMs: number | undefined
    if (body.transitionMs !== undefined && body.transitionMs !== null) {
      newTransitionMs = Number(body.transitionMs)
      if (!Number.isFinite(newTransitionMs) || newTransitionMs < 0 || newTransitionMs > 5000) {
        return reply.status(400).send({ ok: false, error: 'Überblendung muss zwischen 0 und 5000 ms liegen' })
      }
    }
    const newProjectors: Array<{ id: string; host: string }> = []
    if (body.projectors) {
      if (!Array.isArray(body.projectors)) {
        return reply.status(400).send({ ok: false, error: 'projectors muss eine Liste sein' })
      }
      for (const p of body.projectors) {
        if (typeof p?.id !== 'string' || typeof p?.host !== 'string') {
          return reply.status(400).send({ ok: false, error: 'Beamer-Eintrag braucht id und host' })
        }
        newProjectors.push({ id: p.id, host: p.host.trim() })
      }
    }
    let newLayout:
      | {
          canvasWmm: number
          canvasHmm: number
          gapsMm: [number, number, number]
          yOffsetsMm: [number, number, number, number]
        }
      | undefined
    const bodyLayout = (
      body as { layout?: { canvasWmm?: unknown; canvasHmm?: unknown; gapsMm?: unknown[]; yOffsetsMm?: unknown[] } }
    ).layout
    if (bodyLayout) {
      const w = Number(bodyLayout.canvasWmm)
      const h = Number(bodyLayout.canvasHmm)
      const gaps = Array.isArray(bodyLayout.gapsMm) ? bodyLayout.gapsMm.map(Number) : []
      const yOffs = Array.isArray(bodyLayout.yOffsetsMm) ? bodyLayout.yOffsetsMm.map(Number) : [0, 0, 0, 0]
      if (!(w > 100 && h > 100) || gaps.length !== 3 || gaps.some((g) => !Number.isFinite(g) || g < 0)) {
        return reply.status(400).send({ ok: false, error: 'Layout: Masse in mm (Breite/Höhe > 100, 3 Abstände ≥ 0)' })
      }
      if (yOffs.length !== 4 || yOffs.some((o) => !Number.isFinite(o) || Math.abs(o) > 2000)) {
        return reply.status(400).send({ ok: false, error: 'Layout: 4 Höhenversätze in mm (±2000) erwartet' })
      }
      newLayout = {
        canvasWmm: w,
        canvasHmm: h,
        gapsMm: [gaps[0]!, gaps[1]!, gaps[2]!],
        yOffsetsMm: [yOffs[0]!, yOffs[1]!, yOffs[2]!, yOffs[3]!],
      }
    }

    // Phase 2: anwenden
    if (newMediaRoot !== undefined) store.setMediaRoot(newMediaRoot)
    if (newTransitionMs !== undefined) store.setTransitionMs(newTransitionMs)
    for (const p of newProjectors) store.setProjectorHost(p.id, p.host)
    if (newLayout) store.setLayout(newLayout)
    return ok()
  })

  // --- Medien & Thumbnails für die Control-UI ---
  // Hinweis: fastify dekodiert den Wildcard-Parameter bereits einmal —
  // ein weiteres decodeURIComponent würde %-Dateinamen kaputtmachen.

  app.get('/media/*', async (req, reply) => {
    const rel = (req.params as Record<string, string>)['*'] ?? ''
    if (!isServableMedia(rel)) return reply.status(404).send({ ok: false, error: 'Kein Medientyp' })
    const abs = resolveMediaFile(store.getConfig().mediaRoot, rel)
    if (!abs) return reply.status(404).send({ ok: false, error: 'Nicht gefunden' })
    // Streamen, nie puffern — ein 200-MB-Video darf den RAM nicht fluten
    const { status, headers, stream } = openFileStream(abs, req.headers.range ?? null)
    reply.status(status)
    for (const [key, value] of Object.entries(headers)) reply.header(key, value)
    return reply.send(stream ?? undefined)
  })

  /** Poster-Frame für Videos, gecacht in userData/thumbs (Bilder skaliert der Browser selbst). */
  const thumbsInFlight = new Map<string, Promise<boolean>>()
  const thumbsDir = path.join(electronApp.getPath('userData'), 'thumbs')

  app.get('/thumbs/*', async (req, reply) => {
    const rel = (req.params as Record<string, string>)['*'] ?? ''
    const abs = resolveMediaFile(store.getConfig().mediaRoot, rel)
    if (!abs) return reply.status(404).send({ ok: false, error: 'Nicht gefunden' })

    const stat = fs.statSync(abs)
    const key = crypto.createHash('sha1').update(`${rel}|${Math.round(stat.mtimeMs)}|${stat.size}`).digest('hex').slice(0, 20)
    const thumbPath = path.join(thumbsDir, `${key}.jpg`)

    if (!fs.existsSync(thumbPath)) {
      // Parallele Anfragen fürs gleiche Video teilen sich EINEN ffmpeg-Lauf
      let job = thumbsInFlight.get(key)
      if (!job) {
        job = new Promise<boolean>((resolve) => {
          fs.mkdirSync(thumbsDir, { recursive: true })
          const tmp = path.join(thumbsDir, `.${key}-${process.pid}.tmp.jpg`)
          execFile(
            ffmpegBinary(),
            ['-y', '-ss', '1', '-i', abs, '-frames:v', '1', '-vf', 'scale=270:-2', '-q:v', '5', tmp],
            { timeout: 20000 },
            (err) => {
              if (err || !fs.existsSync(tmp)) {
                fs.rmSync(tmp, { force: true })
                resolve(false)
                return
              }
              try {
                fs.renameSync(tmp, thumbPath)
                resolve(true)
              } catch {
                fs.rmSync(tmp, { force: true })
                resolve(fs.existsSync(thumbPath))
              }
            },
          )
        }).finally(() => {
          thumbsInFlight.delete(key)
          void pruneThumbs()
        })
        thumbsInFlight.set(key, job)
      }
      const okThumb = await job
      if (!okThumb) return reply.status(404).send({ ok: false, error: 'Kein Thumbnail möglich' })
    }
    reply.header('Content-Type', 'image/jpeg')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Cache-Control', 'max-age=86400')
    return reply.send(fs.createReadStream(thumbPath))
  })

  async function pruneThumbs(): Promise<void> {
    try {
      const entries = await fs.promises.readdir(thumbsDir)
      if (entries.length <= 300) return
      const stats = await Promise.all(
        entries.map(async (name) => {
          const p = path.join(thumbsDir, name)
          const st = await fs.promises.stat(p).catch(() => null)
          return st ? { p, mtimeMs: st.mtimeMs } : null
        }),
      )
      const sorted = stats.filter((s): s is NonNullable<typeof s> => s !== null).sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const s of sorted.slice(0, sorted.length - 300)) {
        await fs.promises.unlink(s.p).catch(() => {})
      }
    } catch {
      // Aufräumen darf nie stören
    }
  }

  // --- Control-UI ausliefern ---

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    // Entwicklung: Vite-Dev-Server rendert die UI (nur auf dieser Maschine erreichbar)
    app.get('/', async (_req, reply) => reply.redirect(`${devUrl}/control.html`))
    app.get('/admin', async (_req, reply) => reply.redirect(`${devUrl}/admin.html`))
  } else {
    await app.register(fastifyStatic, {
      root: path.join(__dirname, '../renderer'),
      prefix: '/ui/',
    })
    app.get('/', async (_req, reply) => reply.redirect('/ui/control.html'))
    app.get('/admin', async (_req, reply) => reply.redirect('/ui/admin.html'))
  }

  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store')
  })

  const port = store.getConfig().server.port
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`[api] Steuerung: http://localhost:${port}/`)
  return app
}

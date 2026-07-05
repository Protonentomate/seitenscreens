import Fastify, { type FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { app as electronApp } from 'electron'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Store } from './store'
import { kindForFile } from './store'
import type { MediaIndex } from './mediaIndex'
import type { ProjectorManager } from './projectors'
import { resolveMediaFile, fileResponse } from './media'
import { isScreenName } from '../shared/screens'

function ffmpegBinary(): string {
  return process.env.SEITENSCREENS_FFMPEG || 'ffmpeg'
}

/**
 * Schlanke HTTP-API — bewusst simple GETs, damit das Stream-Deck-Plugin
 * (API Request) und jeder Browser sie direkt aufrufen können. Ohne Auth,
 * bewusst: Kirchen-LAN, Einfachheit ist Teil der Anforderung.
 */
export async function startApi(store: Store, index: MediaIndex, projectors: ProjectorManager): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(fastifyWebsocket)

  const ok = (extra: Record<string, unknown> = {}) => ({ ok: true, ...extra, state: store.snapshot() })

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

  app.route({
    method: ['GET', 'POST'],
    url: '/api/template/:name/apply',
    handler: async (req, reply) => {
      const { name } = req.params as { name: string }
      const force = (req.query as Record<string, string>).force === '1'
      const template = index.getTemplate(name)
      if (!template) {
        return reply.status(404).send({ ok: false, error: `Vorlage nicht gefunden: ${name}` })
      }
      if (!template.complete && !force) {
        return reply.status(409).send({
          ok: false,
          error: `Vorlage unvollständig (${template.warnings[0] ?? ''}) — mit ?force=1 werden nur die vorhandenen Leinwände gewechselt`,
        })
      }
      const result = await store.applyTemplate(template, force)
      if (!result.ok) {
        return reply.status(409).send({ ok: false, error: result.error })
      }
      return ok({ applied: template.name })
    },
  })

  app.route({
    method: ['GET', 'POST'],
    url: '/api/screen/:screen/set',
    handler: async (req, reply) => {
      const { screen } = req.params as { screen: string }
      const rawFile = (req.query as Record<string, string>).file
      if (!isScreenName(screen)) {
        return reply.status(404).send({ ok: false, error: `Unbekannte Leinwand: ${screen}` })
      }
      if (!rawFile) {
        return reply.status(400).send({ ok: false, error: 'Parameter file fehlt' })
      }
      // Pfad normalisieren (Backslashes, Doppel-Slashes) und prüfen, dass die
      // Datei wirklich unter mediaRoot existiert — sonst würde ein Tippfehler
      // im Stream-Deck-Button die Leinwand kommentarlos schwarz schalten
      const file = rawFile.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '')
      const kind = kindForFile(file)
      if (!kind) {
        return reply.status(400).send({ ok: false, error: `Nicht unterstütztes Format: ${file}` })
      }
      if (!resolveMediaFile(store.getConfig().mediaRoot, file)) {
        return reply.status(404).send({ ok: false, error: `Datei nicht gefunden: ${file}` })
      }
      await store.setScreen(screen, { file, kind })
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

  // --- Blackout & Testbild ---

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

  // --- Beamer ein/aus (control_cgi, wie die bisherigen Stream-Deck-Buttons) ---

  app.route({
    method: ['GET', 'POST'],
    url: '/api/projector/:action',
    handler: async (req, reply) => {
      const { action } = req.params as { action: string }
      if (action !== 'on' && action !== 'off') {
        return reply.status(404).send({ ok: false, error: 'on|off erwartet' })
      }
      const result = await projectors.setPower('all', action === 'on')
      store.setProjectors(projectors.list())
      if (!result.ok) return reply.status(502).send({ ok: false, error: result.errors.join(' / ') })
      return ok()
    },
  })

  app.route({
    method: ['GET', 'POST'],
    url: '/api/projector/:id/:action',
    handler: async (req, reply) => {
      const { id, action } = req.params as { id: string; action: string }
      if (action !== 'on' && action !== 'off') {
        return reply.status(404).send({ ok: false, error: 'on|off erwartet' })
      }
      const result = await projectors.setPower(id, action === 'on')
      store.setProjectors(projectors.list())
      if (!result.ok) return reply.status(502).send({ ok: false, error: result.errors.join(' / ') })
      return ok()
    },
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
      },
    }
  })

  app.post('/api/config', async (req, reply) => {
    const body = req.body as { mediaRoot?: string; transitionMs?: number; projectors?: Array<{ id: string; host: string }> }
    if (body.mediaRoot !== undefined) {
      const root = body.mediaRoot.trim()
      if (root && !fs.existsSync(root)) {
        return reply.status(400).send({ ok: false, error: `Ordner existiert nicht: ${root}` })
      }
      if (root && !fs.statSync(root).isDirectory()) {
        return reply.status(400).send({ ok: false, error: `Kein Ordner: ${root}` })
      }
      store.setMediaRoot(root)
    }
    if (body.transitionMs !== undefined) {
      const ms = Number(body.transitionMs)
      if (!Number.isFinite(ms) || ms < 0 || ms > 5000) {
        return reply.status(400).send({ ok: false, error: 'transitionMs muss zwischen 0 und 5000 liegen' })
      }
      store.setTransitionMs(ms)
    }
    if (body.projectors) {
      for (const p of body.projectors) {
        if (typeof p.id === 'string' && typeof p.host === 'string') {
          store.setProjectorHost(p.id, p.host.trim())
        }
      }
    }
    return ok()
  })

  // --- Medien & Thumbnails für die Control-UI ---

  app.get('/media/*', async (req, reply) => {
    const rel = decodeURIComponent((req.params as Record<string, string>)['*'] ?? '')
    const abs = resolveMediaFile(store.getConfig().mediaRoot, rel)
    if (!abs) return reply.status(404).send({ ok: false, error: 'Nicht gefunden' })
    const res = fileResponse(abs, req.headers.range ?? null)
    reply.status(res.status)
    res.headers.forEach((value, key) => reply.header(key, value))
    return reply.send(res.body ? Buffer.from(await res.arrayBuffer()) : undefined)
  })

  /** Poster-Frame für Videos, gecacht in userData/thumbs (Bilder skaliert der Browser selbst). */
  app.get('/thumbs/*', async (req, reply) => {
    const rel = decodeURIComponent((req.params as Record<string, string>)['*'] ?? '')
    const abs = resolveMediaFile(store.getConfig().mediaRoot, rel)
    if (!abs) return reply.status(404).send({ ok: false, error: 'Nicht gefunden' })

    const stat = fs.statSync(abs)
    const key = crypto.createHash('sha1').update(`${rel}|${Math.round(stat.mtimeMs)}|${stat.size}`).digest('hex').slice(0, 20)
    const thumbsDir = path.join(electronApp.getPath('userData'), 'thumbs')
    const thumbPath = path.join(thumbsDir, `${key}.jpg`)

    if (!fs.existsSync(thumbPath)) {
      fs.mkdirSync(thumbsDir, { recursive: true })
      const okThumb = await new Promise<boolean>((resolve) => {
        execFile(
          ffmpegBinary(),
          ['-y', '-ss', '1', '-i', abs, '-frames:v', '1', '-vf', 'scale=270:-2', '-q:v', '5', thumbPath],
          { timeout: 20000 },
          (err) => resolve(!err),
        )
      })
      if (!okThumb) return reply.status(404).send({ ok: false, error: 'Kein Thumbnail möglich' })
    }
    reply.header('Content-Type', 'image/jpeg')
    reply.header('Cache-Control', 'max-age=86400')
    return reply.send(fs.createReadStream(thumbPath))
  })

  // --- Control-UI ausliefern ---

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    // Entwicklung: Vite-Dev-Server rendert die UI (nur auf dieser Maschine erreichbar)
    app.get('/', async (_req, reply) => reply.redirect(`${devUrl}/control.html`))
  } else {
    await app.register(fastifyStatic, {
      root: path.join(__dirname, '../renderer'),
      prefix: '/ui/',
    })
    app.get('/', async (_req, reply) => reply.redirect('/ui/control.html'))
  }

  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store')
  })

  const port = store.getConfig().server.port
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`[api] Steuerung: http://localhost:${port}/`)
  return app
}

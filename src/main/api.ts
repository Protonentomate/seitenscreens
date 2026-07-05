import Fastify, { type FastifyInstance } from 'fastify'
import fs from 'node:fs'
import type { Store } from './store'
import { kindForFile } from './store'
import { getTemplate, listTemplates, listSingles, resolveMediaFile } from './media'
import { isScreenName, SCREEN_NAMES } from '../shared/screens'

/**
 * Schlanke HTTP-API — bewusst simple GETs, damit das Stream-Deck-Plugin
 * (API Request) und jeder Browser sie direkt aufrufen können.
 */
export async function startApi(store: Store): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  const ok = (extra: Record<string, unknown> = {}) => ({ ok: true, ...extra, state: store.snapshot() })

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
    }
  })

  app.get('/api/templates', async () => ({
    ok: true,
    templates: listTemplates(store.getConfig().mediaRoot),
    singles: listSingles(store.getConfig().mediaRoot),
  }))

  const applyTemplate = async (name: string, force: boolean) => {
    const template = getTemplate(store.getConfig().mediaRoot, name)
    if (!template) {
      return { status: 404, body: { ok: false, error: `Vorlage nicht gefunden: ${name}` } }
    }
    if (!template.complete && !force) {
      const missing = SCREEN_NAMES.filter((s) => !template.files[s])
      return {
        status: 409,
        body: {
          ok: false,
          error: `Vorlage unvollständig (fehlend: ${missing.join(', ')}) — mit ?force=1 trotzdem anwenden`,
          missing,
        },
      }
    }
    store.applyTemplate(template.name, template.files)
    return { status: 200, body: ok({ applied: template.name }) }
  }

  app.route({
    method: ['GET', 'POST'],
    url: '/api/template/:name/apply',
    handler: async (req, reply) => {
      const { name } = req.params as { name: string }
      const force = (req.query as Record<string, string>).force === '1'
      const result = await applyTemplate(name, force)
      return reply.status(result.status).send(result.body)
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
      store.setScreen(screen, { file, kind })
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
      store.setScreen(screen, null)
      return ok()
    },
  })

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

  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store')
  })

  const port = store.getConfig().server.port
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`[api] http://localhost:${port}/api/state`)
  return app
}

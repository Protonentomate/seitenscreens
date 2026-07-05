import { protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { cachedPathFor } from './cache'

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

export function registerMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'media',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ])
}

/**
 * Datei mit HTTP-Range-Unterstützung ausliefern. Chromiums Media-Stack
 * verlangt 206-Antworten fürs Buffern/Seeken — ohne Range bleiben Videos
 * bei readyState=HAVE_METADATA hängen.
 */
export function fileResponse(abs: string, rangeHeader: string | null): Response {
  const size = fs.statSync(abs).size
  const mime = MIME_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'

  let start = 0
  let end = size - 1
  let status = 200
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
    if (!match) {
      return new Response('Ungültiger Range-Header', { status: 416 })
    }
    const [, fromStr, toStr] = match
    if (fromStr) {
      start = Number(fromStr)
      if (toStr) end = Math.min(Number(toStr), size - 1)
    } else if (toStr) {
      // Suffix-Range: die letzten N Bytes
      start = Math.max(0, size - Number(toStr))
    }
    if (start > end || start >= size) {
      return new Response('Range nicht erfüllbar', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      })
    }
    status = 206
  }

  const nodeStream = fs.createReadStream(abs, { start, end })
  const body = Readable.toWeb(nodeStream) as unknown as ReadableStream
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
  }
  if (status === 206) {
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  }
  return new Response(body, { status, headers })
}

/**
 * Relativen Medienpfad normalisieren und sicher unter mediaRoot auflösen.
 * Liefert den absoluten Pfad oder null (Traversal, absolut, nicht vorhanden).
 */
export function resolveMediaFile(mediaRoot: string, rel: string): string | null {
  if (!mediaRoot || !rel) return null
  const normalized = rel.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '')
  if (normalized.length === 0) return null
  if (path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) return null
  if (normalized.split('/').some((seg) => seg === '..')) return null
  const abs = path.resolve(mediaRoot, normalized)
  const rootResolved = path.resolve(mediaRoot) + path.sep
  if (!abs.startsWith(rootResolved)) return null
  try {
    if (!fs.statSync(abs).isFile()) return null
  } catch {
    return null
  }
  return abs
}

/**
 * media://local/<pfad relativ zu mediaRoot> — so kann der Renderer lokale
 * Medien laden, ohne dass wir file://-Zugriff freischalten müssen.
 * Bevorzugt wird aus dem Schattencache gespielt (Nextcloud kann syncen,
 * ohne laufende Wiedergabe zu stören); Fallback ist das Original.
 */
export function registerMediaProtocol(getMediaRoot: () => string): void {
  protocol.handle('media', (request) => {
    const mediaRoot = getMediaRoot()
    if (!mediaRoot) return new Response('mediaRoot nicht konfiguriert', { status: 404 })
    const url = new URL(request.url)
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')

    const cached = cachedPathFor(rel)
    const abs = cached ?? resolveMediaFile(mediaRoot, rel)
    if (!abs) {
      return new Response('Datei nicht gefunden', { status: 404 })
    }
    try {
      return fileResponse(abs, request.headers.get('Range'))
    } catch (err) {
      console.error('[media] Fehler beim Ausliefern:', abs, err)
      return new Response('Interner Fehler', { status: 500 })
    }
  })
}

import { protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { TemplateInfo } from '../shared/types'
import { SCREEN_NAMES, type ScreenName } from '../shared/screens'

/** Reihenfolge = Priorität: Video schlägt Bild. */
const EXTENSION_PRIORITY = ['.mp4', '.webm', '.png', '.jpg', '.jpeg', '.webp']

/** Ordner, die nie als Vorlage gelten (Altlasten + interne Ordner). */
const IGNORED_DIR_PATTERN = /^(_|\.|archiv$|serie)/i

export function registerMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'media',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ])
}

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/**
 * Datei mit HTTP-Range-Unterstützung ausliefern. Chromiums Media-Stack
 * verlangt 206-Antworten fürs Buffern/Seeken — ohne Range bleiben Videos
 * bei readyState=HAVE_METADATA hängen.
 */
function fileResponse(abs: string, rangeHeader: string | null): Response {
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
 * media://local/<pfad relativ zu mediaRoot> — so kann der Renderer lokale
 * Medien laden, ohne dass wir file://-Zugriff freischalten müssen.
 * Später zeigt das hierhin auf den Schattencache statt direkt auf Nextcloud.
 */
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

export function registerMediaProtocol(getMediaRoot: () => string): void {
  protocol.handle('media', (request) => {
    const mediaRoot = getMediaRoot()
    if (!mediaRoot) return new Response('mediaRoot nicht konfiguriert', { status: 404 })
    const url = new URL(request.url)
    const rel = decodeURIComponent(url.pathname)
    const abs = resolveMediaFile(mediaRoot, rel)
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

function findScreenFiles(dir: string): Partial<Record<ScreenName, string>> {
  const files: Partial<Record<ScreenName, string>> = {}
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return files
  }
  const lower = new Map(entries.map((e) => [e.toLowerCase(), e]))
  for (const screen of SCREEN_NAMES) {
    for (const ext of EXTENSION_PRIORITY) {
      const actual = lower.get((screen + ext).toLowerCase())
      if (actual) {
        files[screen] = actual
        break
      }
    }
  }
  return files
}

/** Vorlage = Unterordner der ersten Ebene mit mindestens einer ScreenName-Datei. */
export function listTemplates(mediaRoot: string): TemplateInfo[] {
  if (!mediaRoot || !fs.existsSync(mediaRoot)) return []
  const templates: TemplateInfo[] = []
  for (const entry of fs.readdirSync(mediaRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (IGNORED_DIR_PATTERN.test(entry.name)) continue
    const dir = path.join(mediaRoot, entry.name)
    const found = findScreenFiles(dir)
    const names = Object.keys(found) as ScreenName[]
    if (names.length === 0) continue
    const files: Partial<Record<ScreenName, string>> = {}
    for (const screen of names) {
      files[screen] = `${entry.name}/${found[screen]}`
    }
    templates.push({
      name: entry.name,
      files,
      complete: names.length === SCREEN_NAMES.length,
    })
  }
  templates.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }))
  return templates
}

export function getTemplate(mediaRoot: string, name: string): TemplateInfo | null {
  // Kein Pfad-Traversal über den Namen
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null
  // NFC-normalisiert vergleichen: macOS liefert Ordnernamen in NFD,
  // URLs/Clients schicken meist NFC — Umlaute würden sonst nie matchen
  const wanted = name.normalize('NFC')
  return listTemplates(mediaRoot).find((t) => t.name.normalize('NFC') === wanted) ?? null
}

/** Lose Bilder direkt in _Vorlagen (Einzelbilder). */
export function listSingles(mediaRoot: string): string[] {
  if (!mediaRoot || !fs.existsSync(mediaRoot)) return []
  const singles: string[] = []
  for (const entry of fs.readdirSync(mediaRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (EXTENSION_PRIORITY.includes(ext)) singles.push(entry.name)
  }
  singles.sort((a, b) => a.localeCompare(b, 'de', { numeric: true }))
  return singles
}

import { protocol, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
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

/**
 * media://local/<pfad relativ zu mediaRoot> — so kann der Renderer lokale
 * Medien laden, ohne dass wir file://-Zugriff freischalten müssen.
 * Später zeigt das hierhin auf den Schattencache statt direkt auf Nextcloud.
 */
export function registerMediaProtocol(getMediaRoot: () => string): void {
  protocol.handle('media', (request) => {
    const mediaRoot = getMediaRoot()
    if (!mediaRoot) return new Response('mediaRoot nicht konfiguriert', { status: 404 })
    const url = new URL(request.url)
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const abs = path.resolve(mediaRoot, rel)
    const rootResolved = path.resolve(mediaRoot) + path.sep
    if (!abs.startsWith(rootResolved)) {
      return new Response('Pfad ausserhalb von mediaRoot', { status: 403 })
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return new Response('Datei nicht gefunden', { status: 404 })
    }
    return net.fetch(pathToFileURL(abs).toString())
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
  return listTemplates(mediaRoot).find((t) => t.name === name) ?? null
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

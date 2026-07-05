import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * Schattencache: Abgespielt wird nie direkt aus dem Nextcloud-Sync-Ordner,
 * sondern aus einer lokalen Kopie. So kann der Sync-Client Dateien jederzeit
 * ersetzen, ohne auf gesperrte, gerade abgespielte Dateien zu treffen —
 * und ein Sync mitten im Gottesdienst kann laufende Inhalte nicht zerstören.
 *
 * Versionierung: Schlüssel ist rel+version (version = mtime+size). Eine in
 * Nextcloud ersetzte Datei ergibt eine NEUE Version mit eigener Cache-Kopie;
 * ein noch laufender Layer spielt seine alte Kopie ungestört zu Ende, weil
 * seine media://-URL die alte Version trägt.
 */

const MAX_CACHE_FILES = 60
/** Pro Datei die letzten N Versionen im Register behalten (alte Layer). */
const KEEP_VERSIONS_PER_FILE = 2

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'cache')
}

/** `${rel}|${version}` → Cache-Pfad, für synchronen Lookup im media://-Handler. */
const activeCache = new Map<string, string>()

export function versionOf(stat: { mtimeMs: number; size: number }): string {
  return `${Math.round(stat.mtimeMs)}-${stat.size}`
}

export function cachedPathFor(rel: string, version: string | null): string | null {
  if (!version) return null
  const cached = activeCache.get(`${rel}|${version}`)
  if (cached && fs.existsSync(cached)) return cached
  return null
}

export function clearCacheRegistry(): void {
  activeCache.clear()
}

/**
 * Datei in den Cache kopieren (falls nötig) und registrieren.
 * Liefert die Version oder null (Fehler → es wird vom Original gespielt).
 */
export async function ensureCached(rel: string, absSource: string): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(absSource)
    const version = versionOf(stat)
    const hash = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16)
    const ext = path.extname(rel).toLowerCase()
    const dest = path.join(cacheDir(), `${hash}-${version}${ext}`)

    if (!fs.existsSync(dest)) {
      await fs.promises.mkdir(cacheDir(), { recursive: true })
      const tmp = dest + '.tmp'
      await fs.promises.copyFile(absSource, tmp)
      await fs.promises.rename(tmp, dest)
    } else {
      // Nutzungszeit auffrischen für die LRU-Aufräumung
      const now = new Date()
      await fs.promises.utimes(dest, now, now).catch(() => {})
    }
    activeCache.set(`${rel}|${version}`, dest)
    trimVersions(rel)
    void pruneCache()
    return version
  } catch (err) {
    console.warn('[cache] Kopie fehlgeschlagen, spiele vom Original:', rel, err)
    return null
  }
}

/** Nur die neuesten Versionen pro Datei im Register behalten. */
function trimVersions(rel: string): void {
  const prefix = `${rel}|`
  const keys = [...activeCache.keys()].filter((k) => k.startsWith(prefix))
  if (keys.length <= KEEP_VERSIONS_PER_FILE) return
  // Version beginnt mit mtimeMs → lexikalisch sortierbar bei gleicher Länge;
  // zur Sicherheit numerisch nach mtime sortieren
  const byMtime = (k: string) => Number(k.slice(prefix.length).split('-')[0]) || 0
  keys.sort((a, b) => byMtime(a) - byMtime(b))
  for (const key of keys.slice(0, keys.length - KEEP_VERSIONS_PER_FILE)) {
    activeCache.delete(key)
  }
}

async function pruneCache(): Promise<void> {
  try {
    const dir = cacheDir()
    const entries = await fs.promises.readdir(dir)
    if (entries.length <= MAX_CACHE_FILES) return
    const inUse = new Set(activeCache.values())
    const stats = await Promise.all(
      entries.map(async (name) => {
        const p = path.join(dir, name)
        const st = await fs.promises.stat(p).catch(() => null)
        return st ? { p, mtimeMs: st.mtimeMs } : null
      }),
    )
    const candidates = stats
      .filter((s): s is { p: string; mtimeMs: number } => s !== null && !inUse.has(s.p))
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    const toDelete = candidates.slice(0, Math.max(0, entries.length - MAX_CACHE_FILES))
    for (const c of toDelete) {
      await fs.promises.unlink(c.p).catch(() => {})
    }
  } catch {
    // Aufräumen darf nie etwas kaputt machen
  }
}

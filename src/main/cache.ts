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
 * Schlüssel: relPath + mtime + size — eine geänderte Datei ergibt einen neuen
 * Cache-Eintrag, der beim nächsten Anwenden gezogen wird.
 */

const MAX_CACHE_FILES = 60

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'cache')
}

/** rel → aktueller Cache-Pfad, damit der media://-Handler synchron nachschlagen kann. */
const activeCache = new Map<string, string>()

export function cachedPathFor(rel: string): string | null {
  const cached = activeCache.get(rel)
  if (cached && fs.existsSync(cached)) return cached
  return null
}

/** Datei in den Cache kopieren (falls nötig) und für media:// registrieren. */
export async function ensureCached(mediaRoot: string, rel: string, absSource: string): Promise<void> {
  try {
    const stat = await fs.promises.stat(absSource)
    const hash = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16)
    const ext = path.extname(rel).toLowerCase()
    const name = `${hash}-${Math.round(stat.mtimeMs)}-${stat.size}${ext}`
    const dest = path.join(cacheDir(), name)

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
    activeCache.set(rel, dest)
    void pruneCache()
  } catch (err) {
    // Cache ist eine Optimierung — bei Fehlern wird direkt vom Original gespielt
    console.warn('[cache] Kopie fehlgeschlagen, spiele vom Original:', rel, err)
    activeCache.delete(rel)
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

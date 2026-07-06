import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Zentrale Auflösung der ffmpeg/ffprobe-Programme. Reihenfolge:
 * 1. Umgebungsvariable (Dev/Override): SEITENSCREENS_FFMPEG / _FFPROBE
 * 2. Gebündelt im Installer (app.isPackaged): resources/ffmpeg/ffmpeg(.exe)
 *    — via electron-builder extraResources, siehe electron-builder.yml
 * 3. Fallback: aus dem PATH ('ffmpeg' / 'ffprobe')
 */
function vendored(name: 'ffmpeg' | 'ffprobe'): string | null {
  if (!app.isPackaged) return null
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const p = path.join(process.resourcesPath, 'ffmpeg', exe)
  return fs.existsSync(p) ? p : null
}

export function ffmpegBinary(): string {
  return process.env.SEITENSCREENS_FFMPEG || vendored('ffmpeg') || 'ffmpeg'
}

export function ffprobeBinary(): string {
  return process.env.SEITENSCREENS_FFPROBE || vendored('ffprobe') || 'ffprobe'
}

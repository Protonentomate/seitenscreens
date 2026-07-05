import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig, Quad, ScreenCalibration } from '../shared/types'
import { SCREEN_NAMES, WINDOW_SCREENS, OUTPUT_WIDTH, OUTPUT_HEIGHT, type ScreenName } from '../shared/screens'

/**
 * Config-Datei: standardmässig userData/config.json, für die Entwicklung
 * per Umgebungsvariable SEITENSCREENS_CONFIG umbiegbar (z.B. ./dev/config.json).
 */
export function configPath(): string {
  const fromEnv = process.env.SEITENSCREENS_CONFIG
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(app.getPath('userData'), 'config.json')
}

function defaultQuad(role: 'links' | 'rechts', indexInWindow: number): Quad {
  // Sichtbarer Startwert: zwei Hochformat-Rechtecke (9:16) nebeneinander im Fenster.
  const w = 480
  const h = (w * 16) / 9
  const y = (OUTPUT_HEIGHT - h) / 2
  const centerX = indexInWindow === 0 ? OUTPUT_WIDTH * 0.25 : OUTPUT_WIDTH * 0.75
  const x = centerX - w / 2
  return {
    tl: { x, y },
    tr: { x: x + w, y },
    br: { x: x + w, y: y + h },
    bl: { x, y: y + h },
  }
}

export function defaultConfig(): AppConfig {
  const screens = {} as Record<ScreenName, ScreenCalibration>
  for (const role of ['links', 'rechts'] as const) {
    WINDOW_SCREENS[role].forEach((screen, i) => {
      screens[screen] = { window: role, corners: defaultQuad(role, i) }
    })
  }
  return {
    version: 1,
    mediaRoot: '',
    server: { port: 8080 },
    simulator: { enabled: 'auto', scale: 0.5 },
    transitionMs: 300,
    screens,
    projectors: [
      { id: 'links', name: 'Beamer links', host: '192.168.100.95', driver: 'control-cgi' },
      { id: 'rechts', name: 'Beamer rechts', host: '192.168.100.96', driver: 'control-cgi' },
    ],
    // Platzhalter-Masse — echte Werte werden bei der Einrichtung in der
    // Kirche ausgemessen und in den Einstellungen eingetragen
    layout: {
      canvasWmm: 1000,
      canvasHmm: 1780,
      gapsMm: [300, 4000, 300],
    },
  }
}

function mergeWithDefaults(loaded: Partial<AppConfig>): AppConfig {
  const def = defaultConfig()
  const merged: AppConfig = {
    ...def,
    ...loaded,
    server: { ...def.server, ...loaded.server },
    simulator: { ...def.simulator, ...loaded.simulator },
    screens: { ...def.screens, ...(loaded.screens ?? {}) },
    projectors: loaded.projectors ?? def.projectors,
    layout: { ...def.layout, ...(loaded.layout ?? {}) },
  }
  // Nur bekannte Screens behalten
  for (const key of Object.keys(merged.screens)) {
    if (!(SCREEN_NAMES as readonly string[]).includes(key)) {
      delete (merged.screens as Record<string, unknown>)[key]
    }
  }
  return merged
}

function tryRead(file: string): Partial<AppConfig> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<AppConfig>
  } catch {
    return null
  }
}

export function loadConfig(): AppConfig {
  const file = configPath()
  const primary = tryRead(file)
  if (primary) return mergeWithDefaults(primary)
  const backup = tryRead(file + '.bak')
  if (backup) {
    console.warn(`[config] ${file} unlesbar — Fallback auf .bak`)
    return mergeWithDefaults(backup)
  }
  console.warn(`[config] keine Config gefunden — Standardwerte (${file})`)
  return defaultConfig()
}

/** Atomar schreiben: tmp + rename, vorherige Version als .bak behalten. */
export function saveConfig(config: AppConfig): void {
  const file = configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const json = JSON.stringify(config, null, 2)
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, file + '.bak')
  }
  const tmp = file + '.tmp'
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, json)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

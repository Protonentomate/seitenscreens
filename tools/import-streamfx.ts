/**
 * Importiert die Corner-Pin-Kalibrierung aus einem OBS-Szenen-Export
 * (StreamFX "3D-Transformation"-Filter) in unsere config.json.
 *
 * Aufruf:
 *   npm run import-streamfx -- --obs <pfad/zum/obs-export.json> --config <pfad/zur/config.json> [--media-root <pfad>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { streamFxToQuad, cornersFromFilterSettings } from '../src/shared/streamfx'
import { isScreenName, type ScreenName } from '../src/shared/screens'
import type { AppConfig, Quad } from '../src/shared/types'

interface ObsSceneItem {
  name: string
  pos: { x: number; y: number }
  scale: { x: number; y: number }
}

interface ObsSource {
  name: string
  id: string
  settings?: { items?: ObsSceneItem[]; file?: string }
  filters?: Array<{ id: string; settings: Record<string, unknown> }>
}

interface ObsExport {
  sources: ObsSource[]
}

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key?.startsWith('--')) {
      const value = argv[i + 1]
      if (value && !value.startsWith('--')) {
        args.set(key.slice(2), value)
        i++
      }
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const obsPath = args.get('obs')
const configPath = args.get('config')
if (!obsPath || !configPath) {
  console.error('Nutzung: import-streamfx --obs <obs-export.json> --config <config.json> [--media-root <pfad>]')
  process.exit(1)
}

const obs = JSON.parse(fs.readFileSync(obsPath, 'utf-8')) as ObsExport

// Szenen-Item-Platzierung pro Quellname einsammeln (aus den scene-Quellen)
const placements = new Map<string, ObsSceneItem>()
for (const source of obs.sources) {
  if (source.id !== 'scene') continue
  for (const item of source.settings?.items ?? []) {
    placements.set(item.name, item)
  }
}

// Bild-Quellen mit StreamFX-Filter → Quad
const imported: Partial<Record<ScreenName, Quad>> = {}
for (const source of obs.sources) {
  if (source.id !== 'image_source') continue
  if (!isScreenName(source.name)) {
    console.warn(`Überspringe Quelle mit unbekanntem Namen: ${source.name}`)
    continue
  }
  const filter = source.filters?.find((f) => f.id === 'streamfx-filter-transform')
  if (!filter) {
    console.warn(`Quelle ${source.name} hat keinen StreamFX-Transform-Filter`)
    continue
  }
  const placement = placements.get(source.name)
  if (!placement) {
    console.warn(`Quelle ${source.name} in keiner Szene platziert`)
    continue
  }

  // Quellgrösse: die Vorlagen sind 1080×1920; falls die Bilddatei existiert, könnte man
  // sie auslesen — für unseren Bestand ist 1080×1920 korrekt.
  const srcW = 1080
  const srcH = 1920

  const corners = cornersFromFilterSettings(filter.settings)
  const quad = streamFxToQuad(corners, srcW, srcH, { pos: placement.pos, scale: placement.scale })
  imported[source.name] = quad

  const fmt = (p: { x: number; y: number }) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`
  console.log(`${source.name}: TL${fmt(quad.tl)} TR${fmt(quad.tr)} BR${fmt(quad.br)} BL${fmt(quad.bl)}`)
}

if (Object.keys(imported).length === 0) {
  console.error('Keine Kalibrierung gefunden — Abbruch.')
  process.exit(1)
}

// Config laden oder minimal anlegen, Quads eintragen, zurückschreiben
let config: Partial<AppConfig> = {}
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<AppConfig>
}

config.version = 1
config.screens = config.screens ?? ({} as AppConfig['screens'])
for (const [screen, quad] of Object.entries(imported) as Array<[ScreenName, Quad]>) {
  const windowRole = screen.startsWith('Links') ? 'links' : 'rechts'
  config.screens[screen] = { window: windowRole, corners: quad }
}

const mediaRoot = args.get('media-root')
if (mediaRoot) {
  config.mediaRoot = path.resolve(mediaRoot)
}

fs.mkdirSync(path.dirname(path.resolve(configPath)), { recursive: true })
fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
console.log(`\nKalibrierung für ${Object.keys(imported).length} Leinwände nach ${configPath} geschrieben.`)

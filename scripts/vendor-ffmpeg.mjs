#!/usr/bin/env node
// Lädt ffmpeg.exe + ffprobe.exe (Windows x64) nach vendor/win/, damit
// electron-builder sie in den Installer packen kann (extraResources).
// Idempotent: sind beide Binaries schon da, passiert nichts.
//
// Quelle: gyan.dev "release essentials" (GPL-Build). Für eine LGPL-Variante
// die URL auf einen BtbN win64-lgpl-Build umstellen. Version über die
// Umgebungsvariable SEITENSCREENS_FFMPEG_URL überschreibbar.
//
// Ausführung: node scripts/vendor-ffmpeg.mjs  (auf dem Build-Rechner / CI)

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'vendor', 'win')
const DL_URL =
  process.env.SEITENSCREENS_FFMPEG_URL || 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
const WANTED = ['ffmpeg.exe', 'ffprobe.exe']

function have() {
  return WANTED.every((w) => fs.existsSync(path.join(OUT_DIR, w)))
}

/** ZIP entpacken mit dem, was die Plattform mitbringt (Windows: tar/PowerShell; sonst: unzip/tar). */
function extract(zipPath, destDir) {
  const attempts =
    process.platform === 'win32'
      ? [
          ['tar', ['-xf', zipPath, '-C', destDir]],
          ['powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${destDir}'`]],
        ]
      : [
          ['unzip', ['-o', zipPath, '-d', destDir]],
          ['tar', ['-xf', zipPath, '-C', destDir]],
        ]
  let lastErr
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore' })
      return
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`Entpacken fehlgeschlagen (weder unzip/tar/PowerShell verfügbar): ${lastErr}`)
}

/** ffmpeg.exe/ffprobe.exe irgendwo im entpackten Baum finden. */
function findBinaries(dir) {
  const found = {}
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (WANTED.includes(entry.name.toLowerCase())) found[entry.name.toLowerCase()] = p
    }
  }
  walk(dir)
  return found
}

async function main() {
  if (have()) {
    console.log('[vendor-ffmpeg] ffmpeg.exe + ffprobe.exe bereits vorhanden — übersprungen')
    return
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-vendor-'))
  const zip = path.join(tmp, 'ffmpeg.zip')

  console.log(`[vendor-ffmpeg] Lade ${DL_URL} …`)
  const res = await fetch(DL_URL)
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(zip))

  console.log('[vendor-ffmpeg] Entpacke …')
  const unpacked = path.join(tmp, 'unpacked')
  fs.mkdirSync(unpacked, { recursive: true })
  extract(zip, unpacked)

  const bins = findBinaries(unpacked)
  for (const w of WANTED) {
    const src = bins[w]
    if (!src) throw new Error(`${w} nicht im Archiv gefunden`)
    fs.copyFileSync(src, path.join(OUT_DIR, w))
    console.log(`[vendor-ffmpeg] ${w} → vendor/win/${w}`)
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('[vendor-ffmpeg] fertig.')
}

main().catch((err) => {
  console.error('[vendor-ffmpeg]', err.message)
  process.exit(1)
})

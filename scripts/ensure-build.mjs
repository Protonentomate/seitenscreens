#!/usr/bin/env node
/**
 * Vor jedem Start: sorgt dafür, dass die App zum aktuellen Code passt.
 *
 *  - Abhängigkeiten fehlen oder package-lock.json hat sich geändert → npm install
 *  - Electron-Programmdatei fehlt (Download beim Install fehlgeschlagen) → nachladen
 *  - Quellcode hat sich seit dem letzten Build geändert (z.B. nach einem Update)
 *    → npm run build
 *
 * Ob sich etwas geändert hat, steht in zwei Stempel-Dateien (Prüfsummen):
 * node_modules/.seitenscreens-deps und out/.build-stamp. Ist alles aktuell,
 * dauert der Check nur einen Augenblick. Einstellungen, Kalibrierung und
 * Medien liegen ausserhalb des Projektordners und werden nie angefasst.
 *
 * Aufruf: node scripts/ensure-build.mjs   (macht das Windows-Startskript)
 */
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

const isWin = process.platform === 'win32'

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin })
  if (result.status !== 0) {
    console.error(`\nFehlgeschlagen: ${cmd} ${args.join(' ')}`)
    process.exit(result.status ?? 1)
  }
}

function hashFiles(files) {
  const hash = crypto.createHash('sha1')
  for (const file of files) {
    hash.update(file.replaceAll('\\', '/'))
    hash.update('\0')
    if (fs.existsSync(file)) hash.update(fs.readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out.sort()
}

const readStamp = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '')

// --- 1. Abhängigkeiten ---
const depsStamp = path.join('node_modules', '.seitenscreens-deps')
const depsHash = hashFiles(['package.json', 'package-lock.json'])
if (!fs.existsSync('node_modules') || readStamp(depsStamp) !== depsHash) {
  console.log(
    fs.existsSync('node_modules')
      ? 'Abhängigkeiten haben sich geändert — installiere neu (dauert etwas) ...'
      : 'Erster Start: installiere Abhängigkeiten (dauert ein paar Minuten) ...',
  )
  run('npm', ['install'])
  fs.writeFileSync(depsStamp, depsHash)
}

// --- 2. Electron-Programmdatei ---
// Der Binary-Download beim npm install schlägt manchmal fehl (Firewall,
// Abbruch) — dann fehlt electron.exe trotz node_modules ("Electron uninstall").
const electronDir = path.join('node_modules', 'electron')
const pathTxt = path.join(electronDir, 'path.txt')
const electronOk =
  fs.existsSync(pathTxt) && fs.existsSync(path.join(electronDir, 'dist', fs.readFileSync(pathTxt, 'utf8').trim()))
if (!electronOk) {
  console.log('Electron-Programmdatei fehlt — lade sie nach ...')
  if (!fs.existsSync(path.join(electronDir, 'install.js'))) run('npm', ['install'])
  run(process.execPath, [path.join(electronDir, 'install.js')])
}

// --- 3. Build ---
const buildStamp = path.join('out', '.build-stamp')
const buildInputs = [
  ...walk('src'),
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
]
const buildHash = hashFiles(buildInputs)
if (!fs.existsSync(path.join('out', 'main', 'index.js')) || readStamp(buildStamp) !== buildHash) {
  console.log(fs.existsSync('out') ? 'Neuer Code — baue die App neu ...' : 'Baue die App ...')
  run('npm', ['run', 'build'])
  fs.writeFileSync(buildStamp, buildHash)
}

console.log('App ist aktuell.')

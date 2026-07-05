import type { AppState, Quad, ScreenContent } from '../shared/types'
import type { PlayerBridge } from '../preload/index'
import { matrix3dForQuad } from '../shared/homography'
import { SyncController, initialPosition } from './sync'
import {
  WINDOW_SCREENS,
  CONTENT_WIDTH,
  CONTENT_HEIGHT,
  OUTPUT_WIDTH,
  OUTPUT_HEIGHT,
  type ScreenName,
  type WindowRole,
} from '../shared/screens'

declare global {
  interface Window {
    player: PlayerBridge
  }
}

const params = new URLSearchParams(location.search)
const role = (params.get('role') === 'rechts' ? 'rechts' : 'links') as WindowRole
document.title = `Beamer ${role}`

const stage = document.getElementById('stage') as HTMLDivElement
const blackoutEl = document.getElementById('blackout') as HTMLDivElement
const windowLabel = document.getElementById('window-label') as HTMLDivElement
windowLabel.textContent = `BEAMER ${role.toUpperCase()}`

/** Bühne (logisch 1920×1080) auf die tatsächliche Fenstergrösse skalieren. */
function fitStage(): void {
  const scale = Math.min(window.innerWidth / OUTPUT_WIDTH, window.innerHeight / OUTPUT_HEIGHT)
  const offsetX = (window.innerWidth - OUTPUT_WIDTH * scale) / 2
  const offsetY = (window.innerHeight - OUTPUT_HEIGHT * scale) / 2
  stage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
}
window.addEventListener('resize', fitStage)
fitStage()

function mediaUrl(file: string): string {
  const encoded = file.split('/').map(encodeURIComponent).join('/')
  return `media://local/${encoded}`
}

function testPatternSvg(screen: ScreenName): string {
  const w = CONTENT_WIDTH
  const h = CONTENT_HEIGHT
  const lines: string[] = []
  for (let x = 0; x <= w; x += 108) {
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#0f0" stroke-width="2"/>`)
  }
  for (let y = 0; y <= h; y += 120) {
    lines.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#0f0" stroke-width="2"/>`)
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="4" width="${w - 8}" height="${h - 8}" fill="none" stroke="#fff" stroke-width="8"/>
    ${lines.join('')}
    <line x1="0" y1="0" x2="${w}" y2="${h}" stroke="#ff0" stroke-width="3"/>
    <line x1="${w}" y1="0" x2="0" y2="${h}" stroke="#ff0" stroke-width="3"/>
    <circle cx="${w / 2}" cy="${h / 2}" r="180" fill="none" stroke="#fff" stroke-width="6"/>
    <text x="${w / 2}" y="${h / 2 - 220}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="110" font-weight="bold" fill="#fff">${screen}</text>
    <text x="60" y="140" font-family="system-ui,sans-serif" font-size="80" fill="#f0f">TL</text>
    <text x="${w - 60}" y="140" text-anchor="end" font-family="system-ui,sans-serif" font-size="80" fill="#f0f">TR</text>
    <text x="60" y="${h - 70}" font-family="system-ui,sans-serif" font-size="80" fill="#f0f">BL</text>
    <text x="${w - 60}" y="${h - 70}" text-anchor="end" font-family="system-ui,sans-serif" font-size="80" fill="#f0f">BR</text>
  </svg>`
}

interface QuadView {
  root: HTMLDivElement
  layerHost: HTMLDivElement
  currentLayer: HTMLDivElement | null
  currentFile: string | null
  syncController: SyncController | null
}

/** Controller pro Layer, damit beim Teardown der richtige gestoppt wird. */
const layerControllers = new WeakMap<HTMLDivElement, SyncController>()

const quads = new Map<ScreenName, QuadView>()

for (const screen of WINDOW_SCREENS[role]) {
  const root = document.createElement('div')
  root.className = 'quad'
  root.dataset.screen = screen

  const layerHost = document.createElement('div')
  layerHost.style.position = 'absolute'
  layerHost.style.inset = '0'
  root.appendChild(layerHost)

  const pattern = document.createElement('div')
  pattern.className = 'testpattern'
  pattern.innerHTML = testPatternSvg(screen)
  root.appendChild(pattern)

  stage.appendChild(root)
  quads.set(screen, { root, layerHost, currentLayer: null, currentFile: null, syncController: null })
}

function createMediaElement(content: ScreenContent): HTMLElement {
  if (content.kind === 'video') {
    const video = document.createElement('video')
    video.muted = true
    video.loop = true
    video.playsInline = true
    video.preload = 'auto'
    video.src = mediaUrl(content.file)
    return video
  }
  const img = document.createElement('img')
  img.src = mediaUrl(content.file)
  img.alt = ''
  return img
}

/**
 * Video gegen die gemeinsame Epoche starten: Liegt die Epoche in der Zukunft,
 * warten wir bis dahin (synchroner Start über beide Fenster); liegt sie in der
 * Vergangenheit, steigen wir an der richtigen Position in die Timeline ein.
 * Danach hält der SyncController die Position gegen die Wanduhr.
 */
function startVideo(
  screen: ScreenName,
  layer: HTMLDivElement,
  video: HTMLVideoElement,
  epochMs: number,
  onPlaying: () => void,
  onError: () => void,
): void {
  video.addEventListener('playing', onPlaying, { once: true })
  video.addEventListener('error', onError, { once: true })

  video.addEventListener(
    'loadedmetadata',
    () => {
      const duration = video.duration
      const now = Date.now()
      const begin = () => {
        // Layer wurde inzwischen ersetzt/entfernt → gar nicht erst starten
        if (!layer.isConnected) return
        if (Number.isFinite(duration) && duration > 0) {
          video.currentTime = initialPosition(epochMs, duration)
        }
        void video.play()
        const controller = new SyncController(screen, video, epochMs)
        layerControllers.set(layer, controller)
        const view = quads.get(screen)
        if (view && view.currentLayer === layer) view.syncController = controller
      }
      if (now < epochMs) {
        video.currentTime = 0
        window.setTimeout(begin, epochMs - now)
      } else {
        begin()
      }
    },
    { once: true },
  )
}

function teardownLayer(layer: HTMLDivElement): void {
  layerControllers.get(layer)?.stop()
  layerControllers.delete(layer)
  const video = layer.querySelector('video')
  if (video) {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
  layer.remove()
}

function fadeOutAndRemove(layer: HTMLDivElement, transitionMs: number): void {
  if (!layer.isConnected) return
  layer.style.transition = `opacity ${transitionMs}ms ease`
  layer.classList.remove('visible')
  window.setTimeout(() => teardownLayer(layer), transitionMs + 100)
}

/** Inhalt eines Quads mit Crossfade wechseln. */
function setQuadContent(view: QuadView, content: ScreenContent | null, transitionMs: number): void {
  const newFile = content?.file ?? null
  if (newFile === view.currentFile) return
  view.currentFile = newFile

  if (!content) {
    view.currentLayer = null
    view.syncController = null
    // Alles ausblenden, was noch da ist — auch noch ladende Ebenen
    for (const child of Array.from(view.layerHost.children)) {
      fadeOutAndRemove(child as HTMLDivElement, transitionMs)
    }
    return
  }

  const layer = document.createElement('div')
  layer.className = 'layer'
  const media = createMediaElement(content)
  layer.appendChild(media)
  view.layerHost.appendChild(layer)
  view.currentLayer = layer
  view.syncController = null

  const fadeIn = () => {
    // Verspätetes load-Event einer inzwischen überholten Ebene: entsorgen
    // statt einblenden — sonst erscheint alter Inhalt über dem neuen
    if (view.currentLayer !== layer || !layer.isConnected) {
      teardownLayer(layer)
      return
    }
    layer.style.transition = `opacity ${transitionMs}ms ease`
    // Reflow erzwingen, damit die Transition ab opacity:0 greift
    void layer.offsetWidth
    layer.classList.add('visible')
    // ALLE anderen Ebenen ausblenden (nicht nur die zuletzt sichtbare) —
    // deckt schnelle A→B→C-Wechsel ab, bei denen B nie sichtbar wurde
    for (const child of Array.from(view.layerHost.children)) {
      if (child !== layer) fadeOutAndRemove(child as HTMLDivElement, transitionMs)
    }
  }

  const onError = () => {
    // Kaputte/fehlende Datei: bisherigen Inhalt stehen lassen statt
    // eine leere Ebene einzublenden (Leinwand würde schwarz)
    console.error(`[player] Medienfehler auf ${view.root.dataset.screen}: ${content.file}`)
    teardownLayer(layer)
  }

  if (media instanceof HTMLImageElement) {
    if (media.complete) fadeIn()
    else {
      media.addEventListener('load', fadeIn, { once: true })
      media.addEventListener('error', onError, { once: true })
    }
  } else if (media instanceof HTMLVideoElement) {
    const screen = view.root.dataset.screen as ScreenName
    // Erst einblenden, wenn das Video wirklich läuft — synchron zur Epoche
    startVideo(screen, layer, media, content.epochMs ?? Date.now(), fadeIn, onError)
  }
}

// Sync-Statistiken alle 2 s an den Main-Process (Log + später Preflight-Panel)
window.setInterval(() => {
  const stats = []
  for (const view of quads.values()) {
    if (view.syncController) stats.push(view.syncController.stats())
  }
  if (stats.length > 0) window.player.syncStats({ role, stats })
}, 2000)

function render(state: AppState): void {
  for (const screen of WINDOW_SCREENS[role]) {
    const view = quads.get(screen)
    if (!view) continue

    const calibration = state.calibration[screen]
    if (calibration) {
      const quad: Quad = calibration.corners
      view.root.style.transform = matrix3dForQuad(CONTENT_WIDTH, CONTENT_HEIGHT, quad)
    }

    view.root.classList.toggle('show-testpattern', state.testPattern)
    setQuadContent(view, state.screens[screen], state.transitionMs)
  }

  blackoutEl.classList.toggle('active', state.blackout)
  blackoutEl.style.transition = `opacity ${state.transitionMs}ms ease`
  windowLabel.classList.toggle('active', state.testPattern)
  document.body.classList.toggle('no-cursor', !state.simulator)
}

window.player.onState(render)
window.player.ready()

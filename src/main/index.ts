import { app, ipcMain, powerSaveBlocker, screen, type WebContents } from 'electron'
import { loadConfig } from './config'
import { Store } from './store'
import { registerMediaSchemePrivileges, registerMediaProtocol } from './media'
import { createPlayerWindows, listDisplays, assignWindowToDisplay } from './windows'
import { startApi, type WindowControl } from './api'
import { MediaIndex } from './mediaIndex'
import { ProjectorManager } from './projectors'
import { IngestQueue } from './ingest'
import type { WindowRole } from '../shared/screens'

// Muss vor app.whenReady() passieren
registerMediaSchemePrivileges()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  void main()
}

async function main(): Promise<void> {
  await app.whenReady()

  const config = loadConfig()
  const store = new Store(config)

  registerMediaProtocol(() => store.getConfig().mediaRoot)

  const { windows, simulator } = createPlayerWindows(config)
  store.setSimulatorActive(simulator)

  // Zustand an alle Player-Fenster verteilen
  const subscribers = new Set<WebContents>()
  store.on('state', (snapshot) => {
    for (const wc of subscribers) {
      if (!wc.isDestroyed()) wc.send('state', snapshot)
    }
  })

  ipcMain.on('player:ready', (event) => {
    subscribers.add(event.sender)
    event.sender.send('state', store.snapshot())
  })

  interface SyncStatsPayload {
    role: string
    stats: Array<{
      screen: string
      errMs: number
      rate: number
      seeks: number
      droppedFrames: number
      totalFrames: number
      currentTime: number
      paused: boolean
      readyState: number
    }>
  }
  ipcMain.on('player:syncstats', (_event, payload: SyncStatsPayload) => {
    const parts = payload.stats.map(
      (s) =>
        `${s.screen}: t=${s.currentTime}s${s.paused ? ' PAUSED' : ''} rs=${s.readyState} err=${s.errMs}ms rate=${s.rate.toFixed(3)} seeks=${s.seeks} drop=${s.droppedFrames}/${s.totalFrames}`,
    )
    console.log(`[sync:${payload.role}] ${parts.join(' | ')}`)
  })

  for (const [role, win] of windows) {
    // Referenz VOR dem Close festhalten — der webContents-Getter wirft
    // nach der Zerstörung des Fensters ("Object has been destroyed")
    const wc = win.webContents
    let crashCount = 0
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit' || details.reason === 'killed') return
      crashCount++
      const delayMs = Math.min(2 ** crashCount * 1000, 30_000)
      console.error(`[player:${role}] Renderer weg (${details.reason}) — Neuladen in ${delayMs}ms`)
      setTimeout(() => {
        if (!wc.isDestroyed()) wc.reload()
      }, delayMs)
      // Nach 5 Minuten Stabilität wieder bei kurzen Delays anfangen
      setTimeout(() => {
        crashCount = Math.max(0, crashCount - 1)
      }, 300_000)
    })
    win.on('closed', () => {
      subscribers.delete(wc)
    })
  }

  powerSaveBlocker.start('prevent-display-sleep')

  // Displays für die Admin-UI (Zuordnung Fenster ↔ physischer Ausgang)
  store.setDisplays(listDisplays())
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed'] as const) {
    screen.on(event as 'display-added', () => store.setDisplays(listDisplays()))
  }
  store.on('window-assignment', (role: WindowRole, displayId: number) => {
    const win = windows.get(role)
    if (win && !win.isDestroyed()) {
      const result = assignWindowToDisplay(win, displayId, simulator)
      if (!result.ok) console.warn('[windows]', result.error)
    }
  })

  const windowControl: WindowControl = {
    identify() {
      for (const [role, win] of windows) {
        if (!win.isDestroyed()) win.webContents.send('identify', { role })
      }
    },
    refullscreen() {
      // Vollbild erneut erzwingen (falls z.B. Windows das Fenster verschoben hat)
      for (const [role] of windows) {
        const win = windows.get(role)
        if (!win || win.isDestroyed() || simulator) continue
        win.setFullScreen(true)
        win.setAlwaysOnTop(true, 'screen-saver')
      }
    },
  }

  // Medien-Index: beobachtet den Nextcloud-Ordner, prüft Videos per ffprobe
  const index = new MediaIndex()
  index.on('index', (snapshot) => store.setMediaIndex(snapshot))
  store.on('mediaroot-changed', (root: string) => void index.start(root))
  void index.start(config.mediaRoot)

  // Beamer-Steuerung (control_cgi über die Webinterfaces)
  const projectors = new ProjectorManager(config.projectors, () => store.setProjectors(projectors.list()))
  store.setProjectors(projectors.list())
  store.on('projectors-changed', (configs) => {
    projectors.updateConfigs(configs)
    store.setProjectors(projectors.list())
  })

  // Upload-Verarbeitung (läuft sofort, gedrosselt solange Videos live sind)
  const ingest = new IngestQueue(store, index)

  store.restoreLastState()

  try {
    await startApi(store, index, projectors, ingest, windowControl)
  } catch (err) {
    console.error('[api] Start fehlgeschlagen:', err)
  }

  app.on('before-quit', () => {
    store.flushLastState()
    store.flushConfig()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}

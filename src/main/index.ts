import { app, ipcMain, powerSaveBlocker, type WebContents } from 'electron'
import { loadConfig } from './config'
import { Store } from './store'
import { registerMediaSchemePrivileges, registerMediaProtocol } from './media'
import { createPlayerWindows } from './windows'
import { startApi } from './api'

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
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error(`[player:${role}] Renderer weg (${details.reason}) — lade neu`)
      win.webContents.reload()
    })
    win.on('closed', () => {
      subscribers.delete(win.webContents)
    })
  }

  powerSaveBlocker.start('prevent-display-sleep')

  store.restoreLastState()

  try {
    await startApi(store)
  } catch (err) {
    console.error('[api] Start fehlgeschlagen:', err)
  }

  app.on('window-all-closed', () => {
    app.quit()
  })
}

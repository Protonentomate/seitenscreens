import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import type { AppConfig } from '../shared/types'
import { WINDOW_ROLES, type WindowRole } from '../shared/screens'

export interface PlayerWindows {
  windows: Map<WindowRole, BrowserWindow>
  simulator: boolean
}

function shouldSimulate(config: AppConfig): boolean {
  const setting = config.simulator.enabled
  if (setting === true || setting === false) return setting
  // 'auto': auf macOS oder mit weniger als 2 Displays immer simulieren
  if (process.platform === 'darwin') return true
  return screen.getAllDisplays().length < 2
}

function loadPlayer(win: BrowserWindow, role: WindowRole): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(`${devUrl}/index.html?role=${role}`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { role } })
  }
}

export function createPlayerWindows(config: AppConfig): PlayerWindows {
  const simulator = shouldSimulate(config)
  const windows = new Map<WindowRole, BrowserWindow>()

  if (simulator) {
    const scale = config.simulator.scale || 0.5
    const w = Math.round(1920 * scale)
    const h = Math.round(1080 * scale)
    WINDOW_ROLES.forEach((role, i) => {
      const win = new BrowserWindow({
        width: w,
        height: h,
        x: 40 + i * (w + 24),
        y: 80,
        title: `Beamer ${role} (Simulator)`,
        backgroundColor: '#000000',
        useContentSize: true,
        webPreferences: {
          preload: path.join(__dirname, '../preload/index.js'),
          backgroundThrottling: false,
        },
      })
      loadPlayer(win, role)
      windows.set(role, win)
    })
  } else {
    // Echtbetrieb: ein randloses Vollbildfenster pro Display.
    // M1: einfachste Zuordnung — Displays nach x sortiert, linkestes = "links".
    // M6 bringt Fingerprint-Matching, Identify-Overlay und Swap.
    const displays = screen.getAllDisplays().slice().sort((a, b) => a.bounds.x - b.bounds.x)
    WINDOW_ROLES.forEach((role, i) => {
      const display = displays[Math.min(i, displays.length - 1)]
      if (!display) return
      const win = new BrowserWindow({
        frame: false,
        show: false,
        backgroundColor: '#000000',
        skipTaskbar: true,
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, '../preload/index.js'),
          backgroundThrottling: false,
        },
      })
      win.setBounds(display.bounds)
      win.setFullScreen(true)
      win.setAlwaysOnTop(true, 'screen-saver')
      loadPlayer(win, role)
      win.once('ready-to-show', () => win.show())
      windows.set(role, win)
    })
  }

  return { windows, simulator }
}

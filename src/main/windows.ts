import { BrowserWindow, screen, type Display } from 'electron'
import path from 'node:path'
import type { AppConfig, DisplayInfo } from '../shared/types'
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

/** Displays für State/Admin-UI aufbereiten. */
export function listDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen
    .getAllDisplays()
    .slice()
    .sort((a, b) => a.bounds.x - b.bounds.x)
    .map((d) => ({
      id: d.id,
      label: d.label || `Display ${d.id}`,
      bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
      primary: d.id === primaryId,
      internal: d.internal ?? false,
    }))
}

/**
 * Display für eine Rolle wählen: gespeicherte Zuordnung, wenn das Display
 * noch existiert — sonst Fallback auf die Reihenfolge nach x (linkestes
 * Display = Fenster "links").
 */
function displayForRole(config: AppConfig, role: WindowRole): Display | undefined {
  const displays = screen.getAllDisplays().slice().sort((a, b) => a.bounds.x - b.bounds.x)
  const assignedId = config.windows.assignments[role]
  if (assignedId !== undefined) {
    const assigned = displays.find((d) => d.id === assignedId)
    if (assigned) return assigned
  }
  const index = WINDOW_ROLES.indexOf(role)
  return displays[Math.min(index, displays.length - 1)]
}

/**
 * Vollbild robust erzwingen. Auf Windows „verpufft" ein `setFullScreen(true)`,
 * das vor `show()` oder ohne Fokus kommt — deshalb erst auf das Display setzen,
 * dann Vollbild + AlwaysOnTop + Fokus, und bei Bedarf ein paar Mal nachfassen,
 * bis das Fenster wirklich im Vollbild ist.
 */
function enforceFullscreen(win: BrowserWindow, display: Display): void {
  if (win.isDestroyed()) return
  // Reihenfolge ist auf Windows wichtig: erst Position/Größe, dann Vollbild
  win.setBounds(display.bounds)
  win.setFullScreen(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.moveTop()
  win.focus()
}

function applyFullscreenWithRetries(win: BrowserWindow, display: Display, attempt = 0): void {
  if (win.isDestroyed()) return
  enforceFullscreen(win, display)
  // Windows meldet den Vollbild-Status manchmal erst nach kurzer Zeit —
  // bis zu 5× im 250-ms-Takt nachfassen, falls es noch nicht sitzt.
  if (!win.isFullScreen() && attempt < 5) {
    setTimeout(() => applyFullscreenWithRetries(win, display, attempt + 1), 250)
  }
}

/** Fenster auf ein Display verschieben und dort in den Vollbildmodus bringen. */
export function moveToDisplay(win: BrowserWindow, display: Display, simulator: boolean): void {
  if (simulator) {
    // Simulator: gerahmtes Fenster nur auf das Display schieben, kein Vollbild
    const current = win.getBounds()
    win.setBounds({ ...current, x: display.workArea.x + 40, y: display.workArea.y + 80 })
    return
  }
  if (win.isFullScreen()) win.setFullScreen(false)
  applyFullscreenWithRetries(win, display)
}

/**
 * Vollbild auf dem Display, auf dem das Fenster gerade steht, erneut erzwingen
 * (z.B. wenn Windows das Fenster verschoben oder den Vollbild verlassen hat).
 */
export function refullscreenWindow(win: BrowserWindow, simulator: boolean): void {
  if (simulator || win.isDestroyed()) return
  const display = screen.getDisplayMatching(win.getBounds())
  applyFullscreenWithRetries(win, display)
}

/** Zuordnung zur Laufzeit ändern (aus der Admin-UI). */
export function assignWindowToDisplay(
  win: BrowserWindow,
  displayId: number,
  simulator: boolean,
): { ok: boolean; error?: string } {
  const display = screen.getAllDisplays().find((d) => d.id === displayId)
  if (!display) return { ok: false, error: `Display ${displayId} nicht gefunden` }
  moveToDisplay(win, display, simulator)
  return { ok: true }
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
    // Echtbetrieb: ein randloses Vollbildfenster pro Display — gespeicherte
    // Zuordnung aus der Admin-UI, sonst Displays nach x sortiert
    WINDOW_ROLES.forEach((role) => {
      const display = displayForRole(config, role)
      if (!display) return
      const win = new BrowserWindow({
        frame: false,
        show: false,
        backgroundColor: '#000000',
        skipTaskbar: true,
        autoHideMenuBar: true,
        fullscreenable: true,
        webPreferences: {
          preload: path.join(__dirname, '../preload/index.js'),
          backgroundThrottling: false,
        },
      })
      // Schon vor dem Anzeigen aufs Ziel-Display setzen, damit es dort erscheint
      win.setBounds(display.bounds)
      loadPlayer(win, role)
      // Vollbild erst NACH dem Anzeigen erzwingen — auf Windows wird ein
      // setFullScreen() vor show() sonst ignoriert.
      win.once('ready-to-show', () => {
        win.show()
        applyFullscreenWithRetries(win, display)
      })
      windows.set(role, win)
    })
  }

  return { windows, simulator }
}

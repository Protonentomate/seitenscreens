import { BrowserWindow, screen, type Display, type Rectangle } from 'electron'
import path from 'node:path'
import type { AppConfig, DisplayInfo, WindowPlacement, WindowSettings } from '../shared/types'
import { WINDOW_ROLES, type WindowRole } from '../shared/screens'
import { planPlacement } from '../shared/placement'

/**
 * 'auto' simuliert nur auf macOS (Entwicklung). Auf Windows nie — auch nicht,
 * wenn beim Start erst ein Bildschirm da ist: dann warten die Beamer-Fenster
 * versteckt und erscheinen von selbst, sobald die Beamer angeschlossen sind.
 */
function shouldSimulate(config: AppConfig): boolean {
  const setting = config.simulator.enabled
  if (setting === true || setting === false) return setting
  return process.platform === 'darwin'
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
function moveToDisplay(win: BrowserWindow, display: Display): void {
  if (win.isFullScreen()) win.setFullScreen(false)
  applyFullscreenWithRetries(win, display)
}

const nearlySame = (a: Rectangle, b: Rectangle) =>
  Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2

/**
 * Die beiden Beamer-Fenster samt ihrer Platzierung. Die Entscheidung, welches
 * Fenster auf welches Display gehört, trifft `planPlacement` (shared, getestet);
 * hier wird sie umgesetzt — beim Start und jedes Mal, wenn Windows ein Display
 * hinzufügt, entfernt oder umstellt (Beamer eingesteckt oder eingeschaltet).
 */
export class PlayerWindows {
  readonly windows = new Map<WindowRole, BrowserWindow>()
  readonly simulator: boolean
  private readonly ready = new Set<WindowRole>()
  /** Display, auf dem das Fenster zuletzt gezeigt wurde (bleibt beim Verstecken). */
  private readonly lastDisplay = new Map<WindowRole, number>()
  private placement: Record<WindowRole, WindowPlacement>
  private relayoutTimer: NodeJS.Timeout | null = null

  constructor(
    config: AppConfig,
    private readonly getSettings: () => WindowSettings,
    private readonly onPlacement: (placement: Record<WindowRole, WindowPlacement>) => void,
  ) {
    this.simulator = shouldSimulate(config)
    this.placement = {
      links: { displayId: null, reason: this.simulator ? 'simulator' : 'missing' },
      rechts: { displayId: null, reason: this.simulator ? 'simulator' : 'missing' },
    }
    if (this.simulator) this.createSimulatorWindows(config)
    else this.createBeamerWindows()
  }

  getPlacement(): Record<WindowRole, WindowPlacement> {
    return this.placement
  }

  private createSimulatorWindows(config: AppConfig): void {
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
      this.windows.set(role, win)
    })
  }

  /**
   * Echtbetrieb: ein randloses Vollbildfenster pro Beamer. Die Fenster
   * entstehen immer (auch ohne Beamer) und bleiben versteckt, bis ein
   * passendes Display da ist.
   */
  private createBeamerWindows(): void {
    for (const role of WINDOW_ROLES) {
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
      loadPlayer(win, role)
      // Erst anzeigen, wenn der Player geladen ist (kein weisser Blitz)
      win.once('ready-to-show', () => {
        this.ready.add(role)
        this.relayout()
      })
      this.windows.set(role, win)
    }
  }

  /**
   * Nach einer Display-Änderung neu platzieren. Windows feuert beim Einstecken
   * mehrere Events, bis das Display stabil ist → entprellt. Beim Entfernen
   * sofort reagieren: sonst schiebt Windows das Vollbild-Fenster auf den
   * Hauptbildschirm, wo es den Bediener-Monitor verdeckt.
   */
  scheduleRelayout(delayMs = 1000): void {
    if (this.simulator) return
    if (this.relayoutTimer) clearTimeout(this.relayoutTimer)
    this.relayoutTimer = setTimeout(() => {
      this.relayoutTimer = null
      this.relayout()
    }, delayMs)
  }

  relayout(): Record<WindowRole, WindowPlacement> {
    if (this.simulator) return this.placement
    const previous = this.placement
    const next = planPlacement(listDisplays(), this.getSettings())
    const displays = screen.getAllDisplays()
    for (const role of WINDOW_ROLES) {
      const target = next[role]
      const display = target.displayId === null ? undefined : displays.find((d) => d.id === target.displayId)
      const placed = this.apply(role, display)
      // Kurz „links"/„rechts" einblenden, damit man auf den Leinwänden sofort
      // sieht, ob die Seiten stimmen: wenn ein Fenster auf ein anderes Display
      // wechselt (z.B. nach dem Tauschen) oder beim Start unbestätigt verteilt
      // wurde — nicht, wenn ein Beamer nach einem Aussetzer zurückkommt
      if (placed === 'moved' || (placed === 'first' && target.reason !== 'assigned')) {
        const win = this.windows.get(role)
        setTimeout(() => {
          if (win && !win.isDestroyed()) win.webContents.send('identify', { role })
        }, 800)
      }
    }
    const changed = WINDOW_ROLES.some(
      (r) => previous[r].displayId !== next[r].displayId || previous[r].reason !== next[r].reason,
    )
    this.placement = next
    if (changed) {
      const desc = WINDOW_ROLES.map((r) => `${r}=${next[r].displayId ?? '–'} (${next[r].reason})`).join(', ')
      console.log(`[windows] Platzierung: ${desc}`)
      this.onPlacement(next)
    }
    return next
  }

  /**
   * Platzierung umsetzen. Ergebnis: 'first' = erstmals gezeigt seit dem Start,
   * 'moved' = jetzt auf einem anderen Display als zuletzt, sonst 'same'.
   */
  private apply(role: WindowRole, display: Display | undefined): 'first' | 'moved' | 'same' {
    const win = this.windows.get(role)
    if (!win || win.isDestroyed() || !this.ready.has(role)) return 'same'
    if (!display) {
      // Kein Beamer für dieses Fenster → verstecken statt den Hauptbildschirm zu belegen
      if (win.isVisible()) {
        if (win.isFullScreen()) win.setFullScreen(false)
        win.hide()
      }
      return 'same'
    }
    const last = this.lastDisplay.get(role)
    this.lastDisplay.set(role, display.id)
    if (!win.isVisible()) {
      win.setBounds(display.bounds)
      win.show()
      applyFullscreenWithRetries(win, display)
    } else {
      const current = screen.getDisplayMatching(win.getBounds())
      if (current.id !== display.id || !nearlySame(win.getBounds(), display.bounds)) {
        moveToDisplay(win, display)
      } else if (!win.isFullScreen()) {
        applyFullscreenWithRetries(win, display)
      }
    }
    return last === undefined ? 'first' : last !== display.id ? 'moved' : 'same'
  }

  /** Vollbild auf den geplanten Displays erneut erzwingen (Button in der Verwaltung). */
  refullscreen(): void {
    if (this.simulator) return
    const displays = screen.getAllDisplays()
    for (const role of WINDOW_ROLES) {
      const win = this.windows.get(role)
      const id = this.placement[role].displayId
      const display = displays.find((d) => d.id === id)
      if (win && !win.isDestroyed() && display) {
        if (!win.isVisible()) win.show()
        moveToDisplay(win, display)
      }
    }
  }
}

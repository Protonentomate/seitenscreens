import { BrowserWindow, screen, shell } from 'electron'

/** Kennung im User-Agent, an der die Steuerung erkennt, dass sie im App-Fenster läuft. */
export const STATUS_WINDOW_UA_TAG = 'SeitenscreensFenster'

/**
 * Statusfenster: die Steuerung als normales Fenster auf dem Hauptbildschirm.
 * Seitenscreens startet sonst unsichtbar — so sieht man beim Start, dass es
 * läuft, unter welcher Adresse, ob die Beamer an sind und was live ist.
 * Schliessen beendet das Programm nicht (die Beamer-Fenster laufen weiter);
 * ein erneuter Start über das Desktop-Symbol holt das Fenster zurück.
 */
export class StatusWindow {
  private win: BrowserWindow | null = null

  constructor(private readonly url: string) {}

  show(): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore()
      this.win.show()
      this.win.focus()
      return
    }
    const area = screen.getPrimaryDisplay().workArea
    const width = Math.min(1280, area.width)
    const height = Math.min(900, area.height)
    const win = new BrowserWindow({
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height,
      title: 'Seitenscreens',
      autoHideMenuBar: true,
      backgroundColor: '#14161a',
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true },
    })
    this.win = win
    win.webContents.setUserAgent(`${win.webContents.getUserAgent()} ${STATUS_WINDOW_UA_TAG}`)
    // Links mit target=_blank (z.B. Hilfe) im normalen Browser öffnen
    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    win.loadURL(this.url).catch((err: unknown) => console.error('[status] Laden fehlgeschlagen:', err))
  }
}

import net from 'node:net'
import type { ProjectorConfig, ProjectorPower, ProjectorStatus } from '../shared/types'

/**
 * Beamer-Steuerung. Die Beamer der Kirche (192.168.100.95/.96) werden über
 * ihr Web-Interface geschaltet — exakt die Requests, die heute schon die
 * Stream-Deck-Buttons machen:
 *   POST /form/control_cgi  Body: btn_powon=btn_powon   (ein)
 *   POST /form/control_cgi  Body: btn_powoff=btn_powoff (aus)
 * Den Status liefern die Webinterfaces nicht sauber; er kommt per PJLink
 * (Port 4352, Industriestandard), siehe ProjectorManager.pollNow().
 */

export interface ProjectorDriver {
  powerOn(): Promise<void>
  powerOff(): Promise<void>
}

class ControlCgiDriver implements ProjectorDriver {
  constructor(private readonly host: string) {}

  private async post(body: string): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4000)
    try {
      const res = await fetch(`http://${this.host}/form/control_cgi`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body,
        signal: controller.signal,
      })
      const text = await res.text().catch(() => '')
      console.log(`[projector] ${this.host} ${body} → HTTP ${res.status} ${text.slice(0, 200).replace(/\s+/g, ' ')}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  powerOn(): Promise<void> {
    return this.post('btn_powon=btn_powon')
  }

  powerOff(): Promise<void> {
    return this.post('btn_powoff=btn_powoff')
  }
}

class NullDriver implements ProjectorDriver {
  async powerOn(): Promise<void> {}
  async powerOff(): Promise<void> {}
}

/** Normaler Abfrage-Takt für den Status. */
const POLL_MS = 30_000
/** Nach einem Ein-/Aus-Befehl öfter fragen, damit „startet"/„kühlt ab" sichtbar wird. */
const FAST_POLL_MS = 3_000
const FAST_WINDOW_MS = 120_000
/** Erst nach so vielen Fehlversuchen in Folge „offline" anzeigen (kein Flackern). */
const OFFLINE_AFTER = 2
/** So lange nach einem Befehl gilt ein „noch alter Stand" als verspätet, nicht als echt. */
const PENDING_MS = 15_000

const POWER_TEXT: Record<ProjectorPower, string> = {
  on: 'an',
  off: 'aus (Standby)',
  warming: 'startet',
  cooling: 'kühlt ab',
  offline: 'antwortet nicht',
  unknown: 'unbekannt',
  error: 'Fehler',
}

const clock = (): string => new Date().toLocaleTimeString('de-CH')

export class ProjectorManager {
  private readonly statuses = new Map<string, ProjectorStatus>()
  private readonly drivers = new Map<string, ProjectorDriver>()
  /** Beamer, deren Status per PJLink abgefragt wird (Treiber control-cgi, Host gesetzt). */
  private readonly pollable = new Set<string>()
  /** Beamer mit PJLink-Passwort: Status nicht abfragbar, nicht weiter versuchen. */
  private readonly pjlinkLocked = new Set<string>()
  private readonly failures = new Map<string, number>()
  /** Zuletzt geschickter Befehl je Beamer, solange der alte Stand noch erwartet wird. */
  private readonly pending = new Map<string, { on: boolean; until: number }>()
  private readonly onChange: () => void
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private polling: Promise<void> | null = null
  private fastUntil = 0

  constructor(configs: ProjectorConfig[], onChange: () => void) {
    this.onChange = onChange
    this.updateConfigs(configs)
  }

  /** Nach Config-Änderung (z.B. neue Beamer-IP) neu aufbauen — Statusanzeige bleibt. */
  updateConfigs(configs: ProjectorConfig[]): void {
    this.drivers.clear()
    this.pollable.clear()
    for (const cfg of configs) {
      this.drivers.set(cfg.id, cfg.driver === 'control-cgi' ? new ControlCgiDriver(cfg.host) : new NullDriver())
      if (cfg.driver === 'control-cgi' && cfg.host.trim()) this.pollable.add(cfg.id)
      const existing = this.statuses.get(cfg.id)
      const sameHost = existing?.host === cfg.host
      if (!sameHost) {
        this.pjlinkLocked.delete(cfg.id)
        this.failures.delete(cfg.id)
        this.pending.delete(cfg.id)
      }
      this.statuses.set(cfg.id, {
        id: cfg.id,
        name: cfg.name,
        host: cfg.host,
        power: sameHost ? existing.power : 'unknown',
        lastMessage: sameHost ? existing.lastMessage : '',
      })
    }
    for (const id of [...this.statuses.keys()]) {
      if (!this.drivers.has(id)) this.statuses.delete(id)
    }
    if (this.running) this.schedule(0)
  }

  list(): ProjectorStatus[] {
    return [...this.statuses.values()]
  }

  /** Regelmässige Status-Abfrage starten (sofort, dann alle 30 s). */
  start(): void {
    this.running = true
    this.schedule(0)
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delayMs: number): void {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.pollNow().finally(() => this.schedule(Date.now() < this.fastUntil ? FAST_POLL_MS : POLL_MS))
    }, delayMs)
  }

  /** Alle Beamer einmal per PJLink abfragen; meldet nur echte Änderungen weiter. */
  pollNow(): Promise<void> {
    if (this.polling) return this.polling
    this.polling = (async () => {
      const results = await Promise.all([...this.pollable].map((id) => this.pollOne(id)))
      if (results.some(Boolean)) this.onChange()
    })().finally(() => {
      this.polling = null
    })
    return this.polling
  }

  /** @returns true, wenn sich Status oder Meldung geändert haben */
  private async pollOne(id: string): Promise<boolean> {
    const status = this.statuses.get(id)
    if (!status || this.pjlinkLocked.has(id)) return false
    const host = status.host
    let reading: PjlinkPowerReading
    try {
      reading = await pjlinkPowerState(host)
    } catch (err) {
      if (this.statuses.get(id)?.host !== host) return false
      const n = (this.failures.get(id) ?? 0) + 1
      this.failures.set(id, n)
      if (n < OFFLINE_AFTER || status.power === 'offline') return false
      status.power = 'offline'
      status.lastMessage = `Antwortet nicht (seit ${clock()}): Beamer ohne Strom oder nicht im Netz? ${err instanceof Error ? err.message : ''}`.trim()
      return true
    }
    if (this.statuses.get(id)?.host !== host) return false
    this.failures.set(id, 0)
    if (reading === 'locked') {
      this.pjlinkLocked.add(id)
      status.lastMessage = 'PJLink ist mit Passwort geschützt: Status nicht abfragbar (im Beamer-Menü abschalten)'
      return true
    }
    // Beamer gerade beschäftigt (ERR3): letzten Stand stehen lassen
    if (reading === 'busy') return false
    // Kurz nach einem Befehl meldet der Beamer evtl. noch den alten Stand:
    // dann „startet"/„kühlt ab" stehen lassen statt hin- und herzuspringen
    const pending = this.pending.get(id)
    if (pending) {
      const stale = reading === (pending.on ? 'off' : 'on')
      if (stale && Date.now() < pending.until) return false
      this.pending.delete(id)
    }
    if (status.power === reading) return false
    status.power = reading
    status.lastMessage = `Laut Beamer ${POWER_TEXT[reading]} (seit ${clock()})`
    return true
  }

  async setPower(id: string | 'all', on: boolean): Promise<{ ok: boolean; errors: string[] }> {
    const targets = id === 'all' ? [...this.drivers.keys()] : [id]
    const errors: string[] = []
    await Promise.all(
      targets.map(async (t) => {
        const driver = this.drivers.get(t)
        const status = this.statuses.get(t)
        if (!driver || !status) {
          errors.push(`Unbekannter Beamer: ${t}`)
          return
        }
        try {
          await (on ? driver.powerOn() : driver.powerOff())
          // Bis die Abfrage den echten Stand liefert: das, was gerade passiert.
          // Ohne Abfrage (kein PJLink) bleibt es bei der Annahme an/aus.
          const polled = this.pollable.has(t) && !this.pjlinkLocked.has(t)
          status.power = polled ? (on ? 'warming' : 'cooling') : on ? 'on' : 'off'
          if (polled) this.pending.set(t, { on, until: Date.now() + PENDING_MS })
          status.lastMessage = `${on ? 'Einschalten' : 'Ausschalten'} geschickt um ${clock()}`
        } catch (err) {
          // Zeitüberschreitung heisst nicht „aus": manche Beamer antworten erst
          // nach dem Hochfahren — der Befehl kann trotzdem angekommen sein
          const timedOut = err instanceof Error && err.name === 'AbortError'
          status.power = timedOut ? 'unknown' : 'error'
          status.lastMessage = timedOut
            ? `Keine Antwort innert 4 s — Befehl ist evtl. trotzdem angekommen (${clock()})`
            : `Nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`
          errors.push(`${status.name}: ${status.lastMessage}`)
        }
      }),
    )
    this.onChange()
    // Danach eine Weile öfter nachfragen, bis „an"/„aus" stimmt
    this.fastUntil = Date.now() + FAST_WINDOW_MS
    this.schedule(1500)
    return { ok: errors.length === 0, errors }
  }
}

/**
 * Diagnose für die Fehlersuche vor Ort (GET /api/projector/{id}/diagnose):
 * was liefert das Webinterface, und spricht der Beamer PJLink (Port 4352,
 * Industriestandard mit Status-Abfrage)? Ändert nichts am Beamer.
 */
export async function diagnoseProjector(host: string): Promise<Record<string, unknown>> {
  const http = await (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4000)
    try {
      const res = await fetch(`http://${host}/`, { signal: controller.signal })
      const text = await res.text().catch(() => '')
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        server: res.headers.get('server'),
        title: /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() ?? null,
        snippet: text.slice(0, 1500),
      }
    } catch (err) {
      return { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
    } finally {
      clearTimeout(timeout)
    }
  })()
  const pjlink = await pjlinkPower(host).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
  return { host, http, pjlink }
}

const PJLINK_POWER: Record<string, string> = { '0': 'aus (Standby)', '1': 'an', '2': 'kühlt ab', '3': 'wärmt auf' }
const PJLINK_STATE: Record<string, ProjectorPower> = { '0': 'off', '1': 'on', '2': 'cooling', '3': 'warming' }

type PjlinkAnswer = { greeting: string; raw?: string; value?: string | null }

/**
 * PJLink-Klasse-1-Abfrage „%1POWR ?" (ohne Passwort). Eine Verbindung pro
 * Abfrage; Zeilen werden getrimmt (die Optoma schicken teils ein Leerzeichen vorneweg).
 */
function pjlinkQueryPower(host: string, timeoutMs = 3000): Promise<PjlinkAnswer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: 4352 })
    let buffer = ''
    let greeting: string | null = null
    let settled = false
    const done = (result: PjlinkAnswer | Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    socket.setTimeout(timeoutMs, () => done(new Error('PJLink: keine Antwort (Port 4352)')))
    socket.on('error', (err) => done(new Error(`PJLink: ${err.message}`)))
    socket.on('close', () => done(new Error('PJLink: Verbindung geschlossen')))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      let nl: number
      while ((nl = buffer.indexOf('\r')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        if (greeting === null) {
          greeting = line
          if (line === 'PJLINK 0') socket.write('%1POWR ?\r')
          else return done({ greeting: line })
        } else {
          return done({ greeting, raw: line, value: /^%1POWR=(\w+)/.exec(line)?.[1] ?? null })
        }
      }
    })
  })
}

/** Für die Diagnose: lesbare Antwort. */
export async function pjlinkPower(host: string): Promise<Record<string, unknown>> {
  const answer = await pjlinkQueryPower(host)
  if (answer.raw === undefined) {
    return { greeting: answer.greeting, note: answer.greeting.startsWith('PJLINK 1') ? 'PJLink mit Passwort aktiv' : 'Unerwartete Begrüssung' }
  }
  const value = answer.value
  return { greeting: answer.greeting, raw: answer.raw, power: value ? (PJLINK_POWER[value] ?? value) : null }
}

/** locked = PJLink mit Passwort, busy = Beamer kann gerade nicht antworten (ERR3). */
export type PjlinkPowerReading = ProjectorPower | 'locked' | 'busy'

/** Für die Statusanzeige: Zustand als ProjectorPower. Wirft, wenn der Beamer nicht antwortet. */
export async function pjlinkPowerState(host: string): Promise<PjlinkPowerReading> {
  const answer = await pjlinkQueryPower(host)
  if (answer.raw === undefined) {
    if (answer.greeting.startsWith('PJLINK 1')) return 'locked'
    throw new Error(`PJLink: unerwartete Begrüssung „${answer.greeting}"`)
  }
  const value = answer.value ?? ''
  const state = PJLINK_STATE[value]
  if (state) return state
  if (value === 'ERR3') return 'busy'
  if (value === 'ERR4') return 'error'
  throw new Error(`PJLink: unerwartete Antwort „${answer.raw}"`)
}

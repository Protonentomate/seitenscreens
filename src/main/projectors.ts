import net from 'node:net'
import type { ProjectorConfig, ProjectorStatus } from '../shared/types'

/**
 * Beamer-Steuerung. Die Beamer der Kirche (192.168.100.95/.96) werden über
 * ihr Web-Interface geschaltet — exakt die Requests, die heute schon die
 * Stream-Deck-Buttons machen:
 *   POST /form/control_cgi  Body: btn_powon=btn_powon   (ein)
 *   POST /form/control_cgi  Body: btn_powoff=btn_powoff (aus)
 * Die Treiber-Schnittstelle bleibt austauschbar (z.B. PJLink für künftige Geräte).
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
      // Antwort protokollieren — Grundlage, um vor Ort die Status-Abfrage
      // des Beamer-Modells einzubauen (siehe docs/TODO.md)
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

export class ProjectorManager {
  private readonly statuses = new Map<string, ProjectorStatus>()
  private readonly drivers = new Map<string, ProjectorDriver>()
  private readonly onChange: () => void

  constructor(configs: ProjectorConfig[], onChange: () => void) {
    this.onChange = onChange
    this.updateConfigs(configs)
  }

  /** Nach Config-Änderung (z.B. neue Beamer-IP) neu aufbauen — Statusanzeige bleibt. */
  updateConfigs(configs: ProjectorConfig[]): void {
    this.drivers.clear()
    for (const cfg of configs) {
      this.drivers.set(cfg.id, cfg.driver === 'control-cgi' ? new ControlCgiDriver(cfg.host) : new NullDriver())
      const existing = this.statuses.get(cfg.id)
      this.statuses.set(cfg.id, {
        id: cfg.id,
        name: cfg.name,
        host: cfg.host,
        power: existing?.power ?? 'unknown',
        lastMessage: existing?.lastMessage ?? '',
      })
    }
    for (const id of [...this.statuses.keys()]) {
      if (!this.drivers.has(id)) this.statuses.delete(id)
    }
  }

  list(): ProjectorStatus[] {
    return [...this.statuses.values()]
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
          status.power = on ? 'on' : 'off'
          status.lastMessage = `${on ? 'Eingeschaltet' : 'Ausgeschaltet'} um ${new Date().toLocaleTimeString('de-CH')}`
        } catch (err) {
          // Zeitüberschreitung heisst nicht „aus": manche Beamer antworten erst
          // nach dem Hochfahren — der Befehl kann trotzdem angekommen sein
          const timedOut = err instanceof Error && err.name === 'AbortError'
          status.power = timedOut ? 'unknown' : 'error'
          status.lastMessage = timedOut
            ? `Keine Antwort innert 4 s — Befehl ist evtl. trotzdem angekommen (${new Date().toLocaleTimeString('de-CH')})`
            : `Nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`
          errors.push(`${status.name}: ${status.lastMessage}`)
        }
      }),
    )
    this.onChange()
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

/** PJLink-Klasse-1-Abfrage „%1POWR ?" (ohne Passwort). */
export function pjlinkPower(host: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: 4352 })
    let buffer = ''
    let greeting: string | null = null
    const done = (result: Record<string, unknown> | Error) => {
      socket.destroy()
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    socket.setTimeout(3000, () => done(new Error('PJLink: keine Antwort (Port 4352)')))
    socket.on('error', (err) => done(new Error(`PJLink: ${err.message}`)))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      let nl: number
      while ((nl = buffer.indexOf('\r')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (greeting === null) {
          greeting = line
          if (line === 'PJLINK 0') socket.write('%1POWR ?\r')
          else return done({ greeting: line, note: line.startsWith('PJLINK 1') ? 'PJLink mit Passwort aktiv' : 'Unerwartete Begrüssung' })
        } else {
          const value = /^%1POWR=(\w+)/.exec(line)?.[1]
          return done({ greeting, raw: line, power: value ? (PJLINK_POWER[value] ?? value) : null })
        }
      }
    })
  })
}

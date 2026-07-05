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
          status.power = 'error'
          status.lastMessage = `Nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`
          errors.push(`${status.name}: ${status.lastMessage}`)
        }
      }),
    )
    this.onChange()
    return { ok: errors.length === 0, errors }
  }
}

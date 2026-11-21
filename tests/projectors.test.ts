import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { pjlinkPower, pjlinkPowerState, ProjectorManager } from '../src/main/projectors'

let server: net.Server | null = null
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

/** Minimaler PJLink-Beamer auf Port 4352 (nur für den Test); power() wird bei jeder Abfrage gelesen. */
function fakeProjector(greeting: string, power: () => string): Promise<void> {
  return new Promise((resolve) => {
    server = net.createServer((socket) => {
      socket.write(`${greeting}\r`)
      socket.on('data', (d) => {
        if (d.toString() === '%1POWR ?\r') socket.write(`%1POWR=${power()}\r`)
      })
    })
    server.listen(4352, '127.0.0.1', () => resolve())
  })
}

/** Der eine Test-Beamer (wirft, falls er fehlt). */
function first(manager: ProjectorManager) {
  const status = manager.list()[0]
  if (!status) throw new Error('kein Beamer')
  return status
}

const LOCAL = [{ id: 'links' as const, name: 'Beamer links', host: '127.0.0.1', driver: 'control-cgi' as const }]

describe('pjlinkPower (Diagnose)', () => {
  it('liest den Einschalt-Status ohne Passwort', async () => {
    await fakeProjector('PJLINK 0', () => '1')
    const result = await pjlinkPower('127.0.0.1')
    expect(result).toMatchObject({ greeting: 'PJLINK 0', power: 'an' })
  })

  it('meldet aktives Passwort statt zu hängen', async () => {
    await fakeProjector('PJLINK 1 498e4a67', () => '0')
    const result = await pjlinkPower('127.0.0.1')
    expect(result.note).toBe('PJLink mit Passwort aktiv')
  })
})

describe('pjlinkPowerState (Statusanzeige)', () => {
  it('bildet die PJLink-Werte auf den Status ab', async () => {
    let value = '0'
    await fakeProjector('PJLINK 0', () => value)
    const seen: string[] = []
    for (const v of ['0', '1', '2', '3', 'ERR3', 'ERR4']) {
      value = v
      seen.push(await pjlinkPowerState('127.0.0.1'))
    }
    expect(seen).toEqual(['off', 'on', 'cooling', 'warming', 'busy', 'error'])
  })

  it('erkennt ein PJLink-Passwort', async () => {
    await fakeProjector('PJLINK 1 498e4a67', () => '1')
    expect(await pjlinkPowerState('127.0.0.1')).toBe('locked')
  })
})

describe('ProjectorManager: Status-Abfrage', () => {
  it('übernimmt den Stand des Beamers und meldet nur Änderungen', async () => {
    let value = '1'
    await fakeProjector('PJLINK 0', () => value)
    let changes = 0
    const manager = new ProjectorManager(LOCAL, () => changes++)
    await manager.pollNow()
    expect(first(manager).power).toBe('on')
    expect(changes).toBe(1)
    await manager.pollNow()
    expect(changes).toBe(1)
    value = '2'
    await manager.pollNow()
    expect(first(manager).power).toBe('cooling')
    expect(changes).toBe(2)
  })

  it('zeigt „offline" erst nach zwei Fehlversuchen in Folge', async () => {
    // kein Server auf 4352 → Verbindung abgelehnt
    let changes = 0
    const manager = new ProjectorManager(LOCAL, () => changes++)
    await manager.pollNow()
    expect(first(manager).power).toBe('unknown')
    await manager.pollNow()
    expect(first(manager).power).toBe('offline')
    expect(changes).toBe(1)
  })

  it('schaltet beim Start nur ausgeschaltete Beamer ein, und nur tagsüber', async () => {
    let value = '0'
    await fakeProjector('PJLINK 0', () => value)
    const tagsueber = new Date(2026, 10, 22, 9, 30)
    const nachts = new Date(2026, 10, 22, 3, 0)

    // nachts: nichts tun
    expect(await new ProjectorManager(LOCAL, () => {}).powerOnIfOff(nachts, 10)).toEqual([])

    // läuft schon: nichts tun
    value = '1'
    expect(await new ProjectorManager(LOCAL, () => {}).powerOnIfOff(tagsueber, 10)).toEqual([])

    // aus: einschalten (der Befehl geht hier an 127.0.0.1:80 und scheitert — es zählt der Versuch)
    value = '0'
    const manager = new ProjectorManager(LOCAL, () => {})
    expect(await manager.powerOnIfOff(tagsueber, 10)).toEqual(['links'])
    expect(first(manager).lastMessage).not.toBe('Laut Beamer aus (Standby)')
  })

  it('fragt bei PJLink-Passwort nicht weiter und sagt warum', async () => {
    await fakeProjector('PJLINK 1 498e4a67', () => '1')
    const manager = new ProjectorManager(LOCAL, () => {})
    await manager.pollNow()
    const status = first(manager)
    expect(status.power).toBe('unknown')
    expect(status.lastMessage).toContain('Passwort')
  })
})

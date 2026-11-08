import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { pjlinkPower } from '../src/main/projectors'

let server: net.Server | null = null
afterEach(() => {
  server?.close()
  server = null
})

/** Minimaler PJLink-Beamer auf Port 4352 (nur für den Test). */
function fakeProjector(greeting: string, power: string): Promise<void> {
  return new Promise((resolve) => {
    server = net.createServer((socket) => {
      socket.write(`${greeting}\r`)
      socket.on('data', (d) => {
        if (d.toString() === '%1POWR ?\r') socket.write(`%1POWR=${power}\r`)
      })
    })
    server.listen(4352, '127.0.0.1', () => resolve())
  })
}

describe('pjlinkPower', () => {
  it('liest den Einschalt-Status ohne Passwort', async () => {
    await fakeProjector('PJLINK 0', '1')
    const result = await pjlinkPower('127.0.0.1')
    expect(result).toMatchObject({ greeting: 'PJLINK 0', power: 'an' })
  })

  it('meldet aktives Passwort statt zu hängen', async () => {
    await fakeProjector('PJLINK 1 498e4a67', '0')
    const result = await pjlinkPower('127.0.0.1')
    expect(result.note).toBe('PJLink mit Passwort aktiv')
  })
})

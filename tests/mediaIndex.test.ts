import { describe, it, expect, vi } from 'vitest'

// mediaIndex importiert Electron (userData-Pfad); für das Muster reicht eine Attrappe
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const { IGNORED_DIR_PATTERN } = await import('../src/main/mediaIndex')

describe('IGNORED_DIR_PATTERN', () => {
  it('blendet interne und archivierte Ordner aus', () => {
    for (const name of ['_Papierkorb', '_Sicherung', '.git', 'Archiv', 'archiv']) {
      expect(IGNORED_DIR_PATTERN.test(name), name).toBe(true)
    }
  })

  it('zeigt Predigtserien und alles andere an', () => {
    for (const name of ['Serie Advent', 'Serie', 'Predigtserie', 'Archivbilder', 'Gottesdienst', 'Jugend']) {
      expect(IGNORED_DIR_PATTERN.test(name), name).toBe(false)
    }
  })
})

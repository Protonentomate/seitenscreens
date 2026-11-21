import { describe, it, expect, vi } from 'vitest'

// config.ts importiert Electron (userData-Pfad); für die Logik reicht eine Attrappe
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const { mergeWithDefaults } = await import('../src/main/config')

describe('mergeWithDefaults: neue Felder', () => {
  it('gibt einer älteren Config die Standardwerte (alles an, Fenster an, kein Auto-Ein)', () => {
    const merged = mergeWithDefaults({ mediaRoot: 'C:/x', defaultGroup: 'Gottesdienst' })
    expect(merged.disabledScreens).toEqual([])
    expect(merged.statusWindow).toBe(true)
    expect(merged.projectorAutoOn).toBe(false)
    expect(merged.mediaRoot).toBe('C:/x')
    expect(merged.defaultGroup).toBe('Gottesdienst')
  })

  it('übernimmt gespeicherte Werte und verwirft unbekannte Leinwände', () => {
    const merged = mergeWithDefaults({
      disabledScreens: ['RechtsRechts', 'Quatsch', 'LinksLinks'] as never,
      statusWindow: false,
      projectorAutoOn: true,
    })
    // feste Reihenfolge LL, LR, RL, RR
    expect(merged.disabledScreens).toEqual(['LinksLinks', 'RechtsRechts'])
    expect(merged.statusWindow).toBe(false)
    expect(merged.projectorAutoOn).toBe(true)
  })
})

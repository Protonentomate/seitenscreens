import { describe, it, expect } from 'vitest'
import { spanCrops } from '../src/main/ingest'
import type { WallLayout } from '../src/shared/types'

describe('spanCrops', () => {
  const layout: WallLayout = {
    canvasWmm: 1000,
    canvasHmm: 1780,
    gapsMm: [300, 4000, 300],
  }

  it('rechnet die Zuschnitt-Offsets inkl. Lücken korrekt', () => {
    const targetW = 720 // px pro Leinwand → ppmm = 0.72
    const { wallW, crops } = spanCrops(layout, targetW)
    // Gesamtbreite: 4×1000 + 300 + 4000 + 300 = 8600 mm → 6192 px
    expect(wallW).toBe(Math.round(8600 * 0.72))
    expect(crops.map((c) => c.screen)).toEqual(['LinksLinks', 'LinksRechts', 'RechtsLinks', 'RechtsRechts'])
    // LL bei 0; LR bei (1000+300)·0.72=936; RL bei (2000+4300)·0.72=4536; RR bei (3000+4600)·0.72=5472
    expect(crops[0]?.x).toBe(0)
    expect(crops[1]?.x).toBe(936)
    expect(crops[2]?.x).toBe(4536)
    expect(crops[3]?.x).toBe(5472)
    // Jeder Zuschnitt (Breite 720) muss innerhalb der Wand liegen
    for (const c of crops) {
      expect(c.x + targetW).toBeLessThanOrEqual(wallW)
    }
  })

  it('ohne Lücken sind die Zuschnitte nahtlos', () => {
    const noGaps: WallLayout = { canvasWmm: 1000, canvasHmm: 1780, gapsMm: [0, 0, 0] }
    const { wallW, crops } = spanCrops(noGaps, 720)
    expect(wallW).toBe(720 * 4)
    expect(crops.map((c) => c.x)).toEqual([0, 720, 1440, 2160])
  })
})

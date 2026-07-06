import { describe, it, expect } from 'vitest'
import { spanCrops, span2Pairs } from '../src/shared/span'
import type { WallLayout } from '../src/shared/types'

describe('spanCrops', () => {
  const layout: WallLayout = {
    canvasWmm: 1000,
    canvasHmm: 1780,
    gapsMm: [300, 4000, 300],
    yOffsetsMm: [0, 0, 0, 0],
  }

  it('rechnet die Zuschnitt-Offsets inkl. Lücken korrekt', () => {
    const targetW = 720 // px pro Leinwand → ppmm = 0.72
    const { wallW, wallH, crops } = spanCrops(layout, targetW, 1280, 'exact')
    // Gesamtbreite: 4×1000 + 300 + 4000 + 300 = 8600 mm → 6192 px
    expect(wallW).toBe(Math.round(8600 * 0.72))
    expect(wallH).toBe(1280)
    expect(crops.map((c) => c.screen)).toEqual(['LinksLinks', 'LinksRechts', 'RechtsLinks', 'RechtsRechts'])
    // LL bei 0; LR bei (1000+300)·0.72=936; RL bei (2000+4300)·0.72=4536; RR bei (3000+4600)·0.72=5472
    expect(crops.map((c) => c.x)).toEqual([0, 936, 4536, 5472])
    expect(crops.map((c) => c.y)).toEqual([0, 0, 0, 0])
    // Jeder Zuschnitt (Breite 720) muss innerhalb der Wand liegen
    for (const c of crops) {
      expect(c.x + targetW).toBeLessThanOrEqual(wallW)
    }
  })

  it('Modus "none": Zuschnitte nahtlos, Lücken ignoriert', () => {
    const { wallW, crops } = spanCrops(layout, 720, 1280, 'none')
    expect(wallW).toBe(720 * 4)
    expect(crops.map((c) => c.x)).toEqual([0, 720, 1440, 2160])
  })

  it('Höhenversatz: tiefere Leinwände zeigen den unteren Ausschnitt', () => {
    // Äussere (LL, RR) hängen 178 mm tiefer als die inneren → 128 px bei targetH 1280
    const offs: WallLayout = { ...layout, yOffsetsMm: [178, 0, 0, 178] }
    const { wallH, crops } = spanCrops(offs, 720, 1280, 'exact')
    expect(wallH).toBe(1280 + 128)
    expect(crops.map((c) => c.y)).toEqual([128, 0, 0, 128])
    // Im Modus "none" wird der Versatz ignoriert
    const none = spanCrops(offs, 720, 1280, 'none')
    expect(none.wallH).toBe(1280)
    expect(none.crops.map((c) => c.y)).toEqual([0, 0, 0, 0])
  })
})

describe('span2Pairs', () => {
  it('rechnet linkes und rechtes Paar mit den jeweiligen Lücken', () => {
    const layout: WallLayout = { canvasWmm: 1000, canvasHmm: 1780, gapsMm: [300, 4000, 500], yOffsetsMm: [0, 0, 0, 0] }
    const targetW = 720 // ppmm = 0.72
    const [left, right] = span2Pairs(layout, targetW, 1280, 'exact')
    // Links: 2×1000 + 300 = 2300 mm → 1656 px; LR bei (1000+300)·0.72 = 936
    expect(left.wallW).toBe(Math.round(2300 * 0.72))
    expect(left.crops.map((c) => [c.screen, c.x])).toEqual([
      ['LinksLinks', 0],
      ['LinksRechts', 936],
    ])
    // Rechts: 2×1000 + 500 = 2500 mm → 1800 px; RR bei (1000+500)·0.72 = 1080
    expect(right.wallW).toBe(Math.round(2500 * 0.72))
    expect(right.crops.map((c) => [c.screen, c.x])).toEqual([
      ['RechtsLinks', 0],
      ['RechtsRechts', 1080],
    ])
    // Jeder Zuschnitt liegt innerhalb seiner Doppel-Leinwand
    for (const pair of [left, right]) {
      for (const c of pair.crops) expect(c.x + targetW).toBeLessThanOrEqual(pair.wallW)
    }
  })

  it('Modus "none": Paar ohne Lücke, halbe/halbe Teilung', () => {
    const layout: WallLayout = { canvasWmm: 1000, canvasHmm: 1780, gapsMm: [300, 4000, 500], yOffsetsMm: [100, 0, 0, 100] }
    const [left, right] = span2Pairs(layout, 720, 1280, 'none')
    for (const pair of [left, right]) {
      expect(pair.wallW).toBe(1440)
      expect(pair.wallH).toBe(1280)
      expect(pair.crops.map((c) => c.x)).toEqual([0, 720])
      expect(pair.crops.map((c) => c.y)).toEqual([0, 0])
    }
  })

  it('Höhenversatz wirkt pro Paar relativ', () => {
    // LL 178 mm tiefer als LR; rechts beide gleich hoch
    const layout: WallLayout = { canvasWmm: 1000, canvasHmm: 1780, gapsMm: [300, 4000, 300], yOffsetsMm: [178, 0, 50, 50] }
    const [left, right] = span2Pairs(layout, 720, 1280, 'exact')
    expect(left.wallH).toBe(1280 + 128)
    expect(left.crops.map((c) => c.y)).toEqual([128, 0])
    // Rechts: beide 50 → relativ 0/0
    expect(right.wallH).toBe(1280)
    expect(right.crops.map((c) => c.y)).toEqual([0, 0])
  })
})

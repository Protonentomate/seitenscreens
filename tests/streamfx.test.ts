import { describe, it, expect } from 'vitest'
import { streamFxToQuad, cornersFromFilterSettings } from '../src/shared/streamfx'

/** Echte Werte aus einem produktiven OBS/StreamFX-Export. */
const LINKS_LINKS = {
  'Corners.TopLeft.X': -56.25,
  'Corners.TopLeft.Y': -79.17,
  'Corners.TopRight.X': 31.25,
  'Corners.TopRight.Y': -79.29,
  'Corners.BottomLeft.X': -57.29,
  'Corners.BottomLeft.Y': 8.33,
  'Corners.BottomRight.X': 29.07,
  'Corners.BottomRight.Y': 9.38,
}

const LINKS_RECHTS = {
  'Corners.TopLeft.X': -8.24,
  'Corners.TopLeft.Y': -95.68,
  'Corners.TopRight.X': 77.73,
  'Corners.TopRight.Y': -95.58,
  'Corners.BottomLeft.X': -9.58,
  'Corners.BottomLeft.Y': -8.4,
  'Corners.BottomRight.X': 76.04,
  'Corners.BottomRight.Y': -8.14,
}

describe('streamFxToQuad', () => {
  it('konvertiert LinksLinks (pos 0,0) in plausible Fenster-Pixel', () => {
    const corners = cornersFromFilterSettings(LINKS_LINKS)
    const quad = streamFxToQuad(corners, 1080, 1920, { pos: { x: 0, y: 0 }, scale: { x: 1, y: 1 } })
    // (−56.25/100 + 1) × 540 = 236.25 ; (−79.17/100 + 1) × 960 = 199.968
    expect(quad.tl.x).toBeCloseTo(236.25, 2)
    expect(quad.tl.y).toBeCloseTo(199.97, 2)
    expect(quad.tr.x).toBeCloseTo(708.75, 2)
    expect(quad.br.y).toBeCloseTo(1050.05, 2)
    // Alle Ecken innerhalb des 1920×1080-Fensters
    for (const p of [quad.tl, quad.tr, quad.br, quad.bl]) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(1920)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(1080)
    }
  })

  it('berücksichtigt die Szenen-Position (LinksRechts bei x=840)', () => {
    const corners = cornersFromFilterSettings(LINKS_RECHTS)
    const quad = streamFxToQuad(corners, 1080, 1920, { pos: { x: 840, y: 0 }, scale: { x: 1, y: 1 } })
    // (−8.24/100 + 1) × 540 + 840 = 1335.5
    expect(quad.tl.x).toBeCloseTo(1335.5, 1)
    expect(quad.tr.x).toBeCloseTo(1799.74, 1)
    // Quad liegt komplett in der rechten Fensterhälfte
    for (const p of [quad.tl, quad.tr, quad.br, quad.bl]) {
      expect(p.x).toBeGreaterThan(960)
      expect(p.x).toBeLessThanOrEqual(1920)
    }
  })

  it('wirft bei fehlenden Settings einen verständlichen Fehler', () => {
    expect(() => cornersFromFilterSettings({})).toThrow(/Corners\.TopLeft\.X/)
  })
})

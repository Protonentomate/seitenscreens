import { describe, it, expect } from 'vitest'
import { homography, applyHomography, matrix3dForQuad } from '../src/shared/homography'
import type { Point, Quad } from '../src/shared/types'

const srcRect: [Point, Point, Point, Point] = [
  { x: 0, y: 0 },
  { x: 1080, y: 0 },
  { x: 0, y: 1920 },
  { x: 1080, y: 1920 },
]

describe('homography', () => {
  it('bildet die vier Quellecken exakt auf die Zielecken ab', () => {
    const quad: Quad = {
      tl: { x: 236.3, y: 200.0 },
      tr: { x: 708.8, y: 198.8 },
      br: { x: 697.0, y: 1050.0 },
      bl: { x: 230.6, y: 1040.0 },
    }
    const m = homography(srcRect, [quad.tl, quad.tr, quad.bl, quad.br])
    const check = (src: Point, expected: Point) => {
      const out = applyHomography(m, src)
      expect(out.x).toBeCloseTo(expected.x, 6)
      expect(out.y).toBeCloseTo(expected.y, 6)
    }
    check({ x: 0, y: 0 }, quad.tl)
    check({ x: 1080, y: 0 }, quad.tr)
    check({ x: 0, y: 1920 }, quad.bl)
    check({ x: 1080, y: 1920 }, quad.br)
  })

  it('ist für ein achsenparalleles Rechteck eine reine Skalierung+Verschiebung', () => {
    const m = homography(srcRect, [
      { x: 100, y: 50 },
      { x: 640, y: 50 },
      { x: 100, y: 1010 },
      { x: 640, y: 1010 },
    ])
    const mid = applyHomography(m, { x: 540, y: 960 })
    expect(mid.x).toBeCloseTo(370, 6)
    expect(mid.y).toBeCloseTo(530, 6)
    // Perspektiv-Anteile müssen ~0 sein
    const normalized = m.map((v) => v / m[8])
    expect(normalized[6]).toBeCloseTo(0, 10)
    expect(normalized[7]).toBeCloseTo(0, 10)
  })

  it('erzeugt einen gültigen matrix3d-String', () => {
    const quad: Quad = {
      tl: { x: 10, y: 20 },
      tr: { x: 500, y: 30 },
      br: { x: 490, y: 900 },
      bl: { x: 15, y: 880 },
    }
    const css = matrix3dForQuad(1080, 1920, quad)
    expect(css).toMatch(/^matrix3d\((-?[\d.e+-]+,){15}-?[\d.e+-]+\)$/)
    const values = css.slice('matrix3d('.length, -1).split(',').map(Number)
    expect(values).toHaveLength(16)
    for (const v of values) expect(Number.isFinite(v)).toBe(true)
  })
})

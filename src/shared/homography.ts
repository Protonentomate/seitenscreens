import type { Point, Quad } from './types'

/**
 * Projektive 2D-Transformation (Homographie) aus 4 Punktkorrespondenzen,
 * berechnet über die Adjugaten-/Basis-Methode — keine Gauss-Elimination nötig.
 * Referenz: "Computing CSS matrix3d transforms" (franklinta).
 */

/** 3×3-Matrix, zeilenweise abgelegt: [a b c, d e f, g h i] */
export type Mat3 = [number, number, number, number, number, number, number, number, number]

export function adjugate(m: Mat3): Mat3 {
  return [
    m[4] * m[8] - m[5] * m[7],
    m[2] * m[7] - m[1] * m[8],
    m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8],
    m[0] * m[8] - m[2] * m[6],
    m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6],
    m[1] * m[6] - m[0] * m[7],
    m[0] * m[4] - m[1] * m[3],
  ]
}

export function multiplyMat(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = 0
      for (let k = 0; k < 3; k++) {
        sum += (a[row * 3 + k] as number) * (b[k * 3 + col] as number)
      }
      r[row * 3 + col] = sum
    }
  }
  return r as unknown as Mat3
}

function multiplyVec(m: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

function basisToPoints(p1: Point, p2: Point, p3: Point, p4: Point): Mat3 {
  const m: Mat3 = [p1.x, p2.x, p3.x, p1.y, p2.y, p3.y, 1, 1, 1]
  const v = multiplyVec(adjugate(m), [p4.x, p4.y, 1])
  return multiplyMat(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]])
}

/** Homographie, die src[i] → dst[i] abbildet (Reihenfolge beliebig, aber konsistent). */
export function homography(src: [Point, Point, Point, Point], dst: [Point, Point, Point, Point]): Mat3 {
  const s = basisToPoints(src[0], src[1], src[2], src[3])
  const d = basisToPoints(dst[0], dst[1], dst[2], dst[3])
  return multiplyMat(d, adjugate(s))
}

/** Punkt durch Homographie schicken (mit perspektivischer Division). */
export function applyHomography(m: Mat3, p: Point): Point {
  const [x, y, w] = multiplyVec(m, [p.x, p.y, 1])
  return { x: x / w, y: y / w }
}

/**
 * CSS-matrix3d()-String, der ein Element der Grösse w×h (transform-origin 0 0)
 * exakt auf das Ziel-Quad verzerrt.
 */
export function matrix3dForQuad(w: number, h: number, quad: Quad): string {
  const m = homography(
    [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: 0, y: h }, { x: w, y: h }],
    [quad.tl, quad.tr, quad.bl, quad.br],
  )
  // Normalisieren, damit die Werte numerisch handlich bleiben
  const n = m.map((v) => v / (m[8] || 1))
  const [a, b, c, d, e, f, g, h2, i] = n as Mat3
  // CSS matrix3d ist spaltenweise; die 3×3-Homographie sitzt in x/y/w-Spalten
  return `matrix3d(${a},${d},0,${g},${b},${e},0,${h2},0,0,1,0,${c},${f},0,${i})`
}

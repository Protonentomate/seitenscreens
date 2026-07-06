import type { SpanGaps, WallLayout } from './types'
import { SCREEN_NAMES, type ScreenName } from './screens'

export interface SpanCrop {
  screen: ScreenName
  x: number
  y: number
}

export interface SpanWall {
  /** Gesamtbreite des Wand-Bildes in Ziel-Pixeln. */
  wallW: number
  /** Gesamthöhe des Wand-Bildes in Ziel-Pixeln (inkl. Höhenversatz). */
  wallH: number
  crops: SpanCrop[]
}

/**
 * Geteilt zwischen Ingest (ffmpeg/sharp) und der Upload-Vorschau im Browser —
 * beide müssen exakt gleich rechnen, sonst lügt die Vorschau.
 *
 * gaps 'exact': Lücken zwischen den Leinwänden und Höhenversatz (äussere
 * hängen tiefer) maskieren Bildteile — durchlaufende Motive fluchten physisch.
 * gaps 'none': nichts geht verloren — die Leinwände teilen das Motiv nahtlos.
 */

/** Höhenversätze normalisieren: kleinster Versatz = 0 (Bezugsleinwand). */
function normalizedOffsets(layout: WallLayout, gaps: SpanGaps): [number, number, number, number] {
  const raw = layout.yOffsetsMm ?? [0, 0, 0, 0]
  if (gaps === 'none') return [0, 0, 0, 0]
  const min = Math.min(...raw)
  return [raw[0] - min, raw[1] - min, raw[2] - min, raw[3] - min]
}

/** Ein Motiv über alle 4 Leinwände. */
export function spanCrops(layout: WallLayout, targetW: number, targetH: number, gaps: SpanGaps): SpanWall {
  const ppmmX = targetW / layout.canvasWmm
  const ppmmY = targetH / layout.canvasHmm
  const gapsMm = gaps === 'exact' ? layout.gapsMm : ([0, 0, 0] as const)
  const offs = normalizedOffsets(layout, gaps)
  const maxOffPx = Math.round(Math.max(...offs) * ppmmY)
  const totalMm = 4 * layout.canvasWmm + gapsMm[0] + gapsMm[1] + gapsMm[2]
  const crops: SpanCrop[] = SCREEN_NAMES.map((screen, i) => {
    const gapSumMm = gapsMm.slice(0, i).reduce((a, b) => a + b, 0)
    return {
      screen,
      x: Math.round((i * layout.canvasWmm + gapSumMm) * ppmmX),
      y: Math.round(offs[i]! * ppmmY),
    }
  })
  return { wallW: Math.round(totalMm * ppmmX), wallH: targetH + maxOffPx, crops }
}

/**
 * 2×2-Modus: das Motiv wird über die beiden LINKEN Leinwände gespannt
 * (inkl. deren Lücke) und identisch über die beiden RECHTEN. Die Lücken
 * links (gapsMm[0]) und rechts (gapsMm[2]) können verschieden sein —
 * deshalb pro Paar eine eigene Geometrie.
 */
export function span2Pairs(
  layout: WallLayout,
  targetW: number,
  targetH: number,
  gaps: SpanGaps,
): [SpanWall, SpanWall] {
  const ppmmX = targetW / layout.canvasWmm
  const ppmmY = targetH / layout.canvasHmm
  const offs = normalizedOffsets(layout, gaps)

  const pairFor = (screens: [ScreenName, ScreenName], gapMm: number, offMm: [number, number]): SpanWall => {
    // Innerhalb des Paars zählt nur der RELATIVE Versatz der beiden Leinwände
    const base = Math.min(offMm[0], offMm[1])
    const rel: [number, number] = [offMm[0] - base, offMm[1] - base]
    const gap = gaps === 'exact' ? gapMm : 0
    const maxOffPx = Math.round(Math.max(...rel) * ppmmY)
    return {
      wallW: Math.round((2 * layout.canvasWmm + gap) * ppmmX),
      wallH: targetH + maxOffPx,
      crops: [
        { screen: screens[0], x: 0, y: Math.round(rel[0] * ppmmY) },
        { screen: screens[1], x: Math.round((layout.canvasWmm + gap) * ppmmX), y: Math.round(rel[1] * ppmmY) },
      ],
    }
  }
  return [
    pairFor(['LinksLinks', 'LinksRechts'], layout.gapsMm[0], [offs[0], offs[1]]),
    pairFor(['RechtsLinks', 'RechtsRechts'], layout.gapsMm[2], [offs[2], offs[3]]),
  ]
}

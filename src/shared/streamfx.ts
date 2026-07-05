import type { Point, Quad } from './types'

/**
 * Konvertierung der StreamFX-"3D-Transformation"-Eckwerte (Corner-Pin-Modus)
 * aus einem OBS-Szenen-Export in Pixel-Quads.
 *
 * Semantik (verifiziert am StreamFX-Quellcode, filter-transform.cpp + transform.effect):
 * Die Prozentwerte leben in einem −1…+1-Raum über den Quellgrenzen, Ursprung in der
 * Quellmitte, x nach rechts, y nach UNTEN. −100 % = linke/obere Kante, +100 % = rechte/untere.
 * Der Filter-Output bleibt quellgross; danach wendet OBS die Szenen-Item-Transformation an
 * (bei Alignment 5 = top-left ist pos der Anker der linken oberen Ecke).
 *
 *   lokal = (prozent/100 + 1) × quellgrösse/2
 *   canvas = pos + scale × lokal
 */

export interface StreamFxCorners {
  tl: Point
  tr: Point
  bl: Point
  br: Point
}

export interface SceneItemPlacement {
  pos: Point
  scale: Point
}

export function cornerToPixel(
  pct: Point,
  srcW: number,
  srcH: number,
  placement: SceneItemPlacement,
): Point {
  const localX = (pct.x / 100 + 1) * (srcW / 2)
  const localY = (pct.y / 100 + 1) * (srcH / 2)
  return {
    x: placement.pos.x + placement.scale.x * localX,
    y: placement.pos.y + placement.scale.y * localY,
  }
}

export function streamFxToQuad(
  corners: StreamFxCorners,
  srcW: number,
  srcH: number,
  placement: SceneItemPlacement,
): Quad {
  return {
    tl: cornerToPixel(corners.tl, srcW, srcH, placement),
    tr: cornerToPixel(corners.tr, srcW, srcH, placement),
    br: cornerToPixel(corners.br, srcW, srcH, placement),
    bl: cornerToPixel(corners.bl, srcW, srcH, placement),
  }
}

/** Liest die Corner-Pin-Werte aus den Settings eines streamfx-filter-transform-Filters. */
export function cornersFromFilterSettings(settings: Record<string, unknown>): StreamFxCorners {
  const num = (key: string): number => {
    const v = settings[key]
    if (typeof v !== 'number') throw new Error(`StreamFX-Setting fehlt oder ist keine Zahl: ${key}`)
    return v
  }
  return {
    tl: { x: num('Corners.TopLeft.X'), y: num('Corners.TopLeft.Y') },
    tr: { x: num('Corners.TopRight.X'), y: num('Corners.TopRight.Y') },
    bl: { x: num('Corners.BottomLeft.X'), y: num('Corners.BottomLeft.Y') },
    br: { x: num('Corners.BottomRight.X'), y: num('Corners.BottomRight.Y') },
  }
}

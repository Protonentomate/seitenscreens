export const SCREEN_NAMES = ['LinksLinks', 'LinksRechts', 'RechtsLinks', 'RechtsRechts'] as const
export type ScreenName = (typeof SCREEN_NAMES)[number]

export type WindowRole = 'links' | 'rechts'
export const WINDOW_ROLES: WindowRole[] = ['links', 'rechts']

/** Welche logischen Leinwände in welchem Beamer-Fenster gerendert werden. */
export const WINDOW_SCREENS: Record<WindowRole, ScreenName[]> = {
  links: ['LinksLinks', 'LinksRechts'],
  rechts: ['RechtsLinks', 'RechtsRechts'],
}

export function isScreenName(v: string): v is ScreenName {
  return (SCREEN_NAMES as readonly string[]).includes(v)
}

/** Ausgabeauflösung eines Beamer-Fensters (logische Koordinaten der Kalibrierung). */
export const OUTPUT_WIDTH = 1920
export const OUTPUT_HEIGHT = 1080

/** Quellauflösung der Inhalte pro Leinwand (Hochformat). */
export const CONTENT_WIDTH = 1080
export const CONTENT_HEIGHT = 1920

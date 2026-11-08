import { WINDOW_ROLES, type WindowRole } from './screens'
import type { DisplayHint, DisplayInfo, WindowPlacement, WindowSettings } from './types'

/**
 * Welche Beamer-Fenster auf welches Display gehören — reine Funktion, damit
 * sie ohne Electron testbar ist. Läuft bei jedem Start und jedes Mal, wenn
 * Windows ein Display hinzufügt/entfernt (Beamer eingesteckt/eingeschaltet).
 *
 * Reihenfolge je Fenster:
 *  1. fest zugeordnetes Display, wenn diese ID gerade angeschlossen ist
 *  2. fest zugeordnetes Display an Name + Auflösung wiedererkannt (Windows
 *     vergibt nach dem Neu-Anschliessen manchmal eine neue ID); bei
 *     baugleichen Beamern entscheidet die Position
 *  3. automatisch: die übrigen Displays von links nach rechts — der
 *     Hauptbildschirm (Bediener-Monitor) wird dabei übersprungen
 *  4. sonst: kein Display → das Fenster wartet versteckt, statt sich über
 *     den Hauptbildschirm zu legen
 */
export function planPlacement(
  displays: DisplayInfo[],
  settings: Pick<WindowSettings, 'assignments' | 'assignmentHints' | 'avoidPrimary'>,
): Record<WindowRole, WindowPlacement> {
  const sorted = [...displays].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
  const taken = new Set<number>()
  const result: Partial<Record<WindowRole, WindowPlacement>> = {}
  const usable = (d: DisplayInfo) => !taken.has(d.id) && !(settings.avoidPrimary && d.primary)

  // 1. Feste Zuordnung per ID (bewusst gewählt — gilt auch für den Hauptbildschirm)
  for (const role of WINDOW_ROLES) {
    const id = settings.assignments[role]
    if (id === undefined) continue
    const display = sorted.find((d) => d.id === id)
    if (display && !taken.has(display.id)) {
      result[role] = { displayId: display.id, reason: 'assigned' }
      taken.add(display.id)
    }
  }

  // 2. Wiedererkennen an Name + Auflösung (neue ID nach dem Neu-Anschliessen)
  for (const role of WINDOW_ROLES) {
    if (result[role]) continue
    const hint = settings.assignmentHints?.[role]
    if (!hint) continue
    const match = closestMatch(sorted.filter((d) => usable(d) && matchesHint(d, hint)), hint)
    if (match) {
      result[role] = { displayId: match.id, reason: 'recognized' }
      taken.add(match.id)
    }
  }

  // 3. Automatisch: übrige Displays von links nach rechts
  for (const role of WINDOW_ROLES) {
    if (result[role]) continue
    const next = sorted.find(usable)
    if (next) {
      result[role] = { displayId: next.id, reason: 'auto' }
      taken.add(next.id)
    } else {
      result[role] = { displayId: null, reason: 'missing' }
    }
  }

  return result as Record<WindowRole, WindowPlacement>
}

function matchesHint(d: DisplayInfo, hint: DisplayHint): boolean {
  return d.label === hint.label && d.bounds.width === hint.width && d.bounds.height === hint.height
}

function closestMatch(candidates: DisplayInfo[], hint: DisplayHint): DisplayInfo | undefined {
  let best: DisplayInfo | undefined
  for (const d of candidates) {
    if (!best || Math.abs(d.bounds.x - hint.x) < Math.abs(best.bounds.x - hint.x)) best = d
  }
  return best
}

/** Merkmale eines Displays für die spätere Wiedererkennung. */
export function hintFor(d: DisplayInfo): DisplayHint {
  return { label: d.label, width: d.bounds.width, height: d.bounds.height, x: d.bounds.x }
}

/** Sind die Fenster auf eine Weise verteilt, die der Bediener noch bestätigen sollte? */
export function placementNeedsConfirmation(placement: Record<WindowRole, WindowPlacement>): boolean {
  return WINDOW_ROLES.some((r) => placement[r].reason === 'auto')
}

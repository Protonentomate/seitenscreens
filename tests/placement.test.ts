import { describe, it, expect } from 'vitest'
import { planPlacement, hintFor, placementNeedsConfirmation } from '../src/shared/placement'
import type { DisplayInfo, WindowSettings } from '../src/shared/types'

const display = (id: number, x: number, opts: Partial<DisplayInfo> = {}): DisplayInfo => ({
  id,
  label: opts.label ?? `Display ${id}`,
  bounds: { x, y: 0, width: 1920, height: 1080, ...(opts.bounds ?? {}) },
  primary: opts.primary ?? false,
  internal: false,
})

const settings = (s: Partial<WindowSettings> = {}) => ({
  assignments: {},
  assignmentHints: {},
  avoidPrimary: true,
  ...s,
})

// Typischer Kirchen-PC: Bediener-Monitor (primär) + zwei Beamer rechts davon
const monitor = display(1, 0, { primary: true, label: 'Monitor' })
const beamerA = display(2, 1920, { label: 'Beamer' })
const beamerB = display(3, 3840, { label: 'Beamer' })

describe('planPlacement', () => {
  it('nur der Hauptbildschirm: beide Fenster warten, statt ihn zu überdecken', () => {
    const plan = planPlacement([monitor], settings())
    expect(plan.links).toEqual({ displayId: null, reason: 'missing' })
    expect(plan.rechts).toEqual({ displayId: null, reason: 'missing' })
  })

  it('ein Beamer dazu: links kommt drauf, rechts wartet', () => {
    const plan = planPlacement([monitor, beamerA], settings())
    expect(plan.links).toEqual({ displayId: 2, reason: 'auto' })
    expect(plan.rechts).toEqual({ displayId: null, reason: 'missing' })
  })

  it('beide Beamer: automatisch von links nach rechts, Hauptbildschirm übersprungen', () => {
    const plan = planPlacement([beamerB, monitor, beamerA], settings())
    expect(plan.links).toEqual({ displayId: 2, reason: 'auto' })
    expect(plan.rechts).toEqual({ displayId: 3, reason: 'auto' })
    expect(placementNeedsConfirmation(plan)).toBe(true)
  })

  it('feste Zuordnung gewinnt (auch vertauscht)', () => {
    const plan = planPlacement([monitor, beamerA, beamerB], settings({ assignments: { links: 3, rechts: 2 } }))
    expect(plan.links).toEqual({ displayId: 3, reason: 'assigned' })
    expect(plan.rechts).toEqual({ displayId: 2, reason: 'assigned' })
    expect(placementNeedsConfirmation(plan)).toBe(false)
  })

  it('fest zugeordneter Beamer fehlt: Fenster wartet, der andere bleibt auf seinem', () => {
    const plan = planPlacement([monitor, beamerB], settings({ assignments: { links: 2, rechts: 3 } }))
    expect(plan.links).toEqual({ displayId: null, reason: 'missing' })
    expect(plan.rechts).toEqual({ displayId: 3, reason: 'assigned' })
  })

  it('neue IDs nach dem Neu-Anschliessen: an Name + Auflösung + Position wiedererkannt', () => {
    const hints = { links: hintFor(beamerB), rechts: hintFor(beamerA) }
    const newA = display(12, 1920, { label: 'Beamer' })
    const newB = display(13, 3840, { label: 'Beamer' })
    const plan = planPlacement([monitor, newA, newB], settings({ assignments: { links: 3, rechts: 2 }, assignmentHints: hints }))
    // links war auf dem Beamer bei x=3840 → bleibt dort
    expect(plan.links).toEqual({ displayId: 13, reason: 'recognized' })
    expect(plan.rechts).toEqual({ displayId: 12, reason: 'recognized' })
  })

  it('ohne avoidPrimary darf auch der Hauptbildschirm automatisch genutzt werden', () => {
    const plan = planPlacement([monitor, beamerA], settings({ avoidPrimary: false }))
    expect(plan.links).toEqual({ displayId: 1, reason: 'auto' })
    expect(plan.rechts).toEqual({ displayId: 2, reason: 'auto' })
  })

  it('zwei Fenster nie auf demselben Display', () => {
    const plan = planPlacement([monitor, beamerA, beamerB], settings({ assignments: { links: 2, rechts: 2 } }))
    expect(plan.links).toEqual({ displayId: 2, reason: 'assigned' })
    expect(plan.rechts).toEqual({ displayId: 3, reason: 'auto' })
  })
})

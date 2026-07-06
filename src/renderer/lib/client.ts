import type { MediaFileInfo, TemplateInfo } from '../../shared/types'
import type { ScreenName } from '../../shared/screens'

/** Kurzlabels für die Leinwände, wie sie das Team kennt. */
export const SHORT: Record<ScreenName, string> = {
  LinksLinks: 'LL',
  LinksRechts: 'LR',
  RechtsLinks: 'RL',
  RechtsRechts: 'RR',
}

// Im Dev-Modus läuft die Seite auf dem Vite-Server, die API auf 8080
export const apiBase = import.meta.env.DEV ? 'http://localhost:8080' : ''
export const wsUrl = import.meta.env.DEV
  ? 'ws://localhost:8080/ws'
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

/** Link zur jeweils anderen Seite (Anwender ↔ Admin). */
export const adminUrl = import.meta.env.DEV ? '/admin.html' : '/ui/admin.html'
export const controlUrl = import.meta.env.DEV ? '/control.html' : '/ui/control.html'

export function mediaUrl(file: string): string {
  return `${apiBase}/media/${file.split('/').map(encodeURIComponent).join('/')}`
}

export function thumbUrl(info: MediaFileInfo | { file: string; kind: string }): string {
  if (info.kind === 'video') {
    return `${apiBase}/thumbs/${info.file.split('/').map(encodeURIComponent).join('/')}`
  }
  return mediaUrl(info.file)
}

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

/** URL-Pfadsegmente für eine Vorlagen-Referenz ("Gruppe/Name" oder "Name"). */
export function templateApplyPath(t: TemplateInfo): string {
  const segments = t.group ? [t.group, t.name] : [t.name]
  return `/api/template/${segments.map(encodeURIComponent).join('/')}/apply`
}

/** Gruppe eines Einzelbilds: erster Pfadteil ("Pimi/bild.jpg" → "Pimi"), Wurzel = ''. */
export function singleGroup(file: string): string {
  const slash = file.indexOf('/')
  return slash === -1 ? '' : file.slice(0, slash)
}

/**
 * Gruppen aus Vorlagen UND Einzelbildern ableiten, sortiert: "Pimi" (falls
 * vorhanden) zuerst, dann alphabetisch; Wurzel-Inhalte ('') zuletzt als "Allgemein".
 */
export function groupNames(templates: TemplateInfo[], singles: MediaFileInfo[] = []): string[] {
  const set = new Set<string>([...templates.map((t) => t.group), ...singles.map((s) => singleGroup(s.file))])
  const named = [...set].filter((g) => g !== '')
  named.sort((a, b) => {
    const aPimi = a.toLowerCase() === 'pimi' ? 0 : 1
    const bPimi = b.toLowerCase() === 'pimi' ? 0 : 1
    if (aPimi !== bPimi) return aPimi - bPimi
    return a.localeCompare(b, 'de')
  })
  if (set.has('')) named.push('')
  return named
}

/** Anzeigename einer Gruppe ('' = Wurzel-Vorlagen). */
export function groupLabel(group: string): string {
  return group === '' ? 'Allgemein' : group
}

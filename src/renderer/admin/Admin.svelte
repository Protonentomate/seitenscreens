<script lang="ts">
  import type { AppState, Quad } from '../../shared/types'
  import { SCREEN_NAMES, WINDOW_ROLES, WINDOW_SCREENS, type ScreenName, type WindowRole } from '../../shared/screens'
  import { spanCrops, span2Pairs } from '../../shared/span'
  import { placementNeedsConfirmation } from '../../shared/placement'
  import { SHORT, LONG, apiBase, wsUrl, controlUrl, thumbUrl, groupNames, groupLabel, singleGroup } from '../lib/client'

  type Corner = 'tl' | 'tr' | 'br' | 'bl'
  const CORNERS: Corner[] = ['tl', 'tr', 'br', 'bl']

  let state = $state<AppState | null>(null)
  let connected = $state(false)
  let banner = $state<{ kind: 'error' | 'ok'; text: string } | null>(null)
  let bannerTimer: ReturnType<typeof setTimeout> | null = null

  type Tab = 'upload' | 'inhalte' | 'kalibrierung' | 'anzeige' | 'einstellungen'
  const TABS: Tab[] = ['upload', 'inhalte', 'kalibrierung', 'anzeige', 'einstellungen']
  // Direktlink auf einen Tab, z.B. /admin#anzeige (Hinweis auf der Anwender-Seite)
  const hashTab = location.hash.slice(1) as Tab
  let tab = $state<Tab>(TABS.includes(hashTab) ? hashTab : 'upload')

  function showBanner(kind: 'error' | 'ok', text: string): void {
    banner = { kind, text }
    if (bannerTimer) clearTimeout(bannerTimer)
    bannerTimer = setTimeout(() => (banner = null), kind === 'ok' ? 3000 : 8000)
  }

  function connect(): void {
    const ws = new WebSocket(wsUrl)
    ws.onopen = () => (connected = true)
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.type === 'state') state = msg.state
    }
    ws.onclose = () => {
      connected = false
      setTimeout(connect, 2000)
    }
    ws.onerror = () => ws.close()
  }
  connect()

  async function api(path: string, body?: unknown): Promise<boolean> {
    try {
      const res = await fetch(apiBase + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        showBanner('error', data.error ?? `Fehler ${res.status}`)
        return false
      }
      return true
    } catch (err) {
      showBanner('error', `Nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  // ============================================================
  // Hochladen (mit Vorschau aller 4 Leinwände)
  // ============================================================

  const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv']

  type Fit = 'contain' | 'cover' | 'stretch'
  const isVideoName = (name: string) => VIDEO_EXT.some((e) => name.toLowerCase().endsWith(e))

  let uploadFile = $state<File | null>(null)
  let uploadGroupChoice = $state<string>('')
  let uploadGroupNew = $state('')
  let uploadTemplateName = $state('')
  // Standard: über alle 4 gespannt, äussere Abstände korrekt, Mitte direkt,
  // gestreckt — so ist das ganze Motiv zu sehen und nichts Grosses fehlt in der Mitte
  let uploadMode = $state<'clone' | 'span' | 'span2' | 'single' | 'quad'>('span')
  let uploadTarget = $state<ScreenName>('LinksLinks')
  let uploadFit = $state<Fit>('stretch')
  let uploadGaps = $state<'exact' | 'exact-nomid' | 'none'>('exact-nomid')
  let uploadMirrorLeft = $state(false)
  let uploadMirrorRight = $state(false)
  let uploadLoopSmooth = $state(false)
  let uploadLoopCrossfadeS = $state(0.5)
  let uploading = $state(false)

  // Modus 'quad': je Leinwand eine eigene Datei + Einpassung
  let quadFiles = $state<Record<ScreenName, File | null>>({
    LinksLinks: null,
    LinksRechts: null,
    RechtsLinks: null,
    RechtsRechts: null,
  })
  let quadFit = $state<Record<ScreenName, Fit>>({
    LinksLinks: 'contain',
    LinksRechts: 'contain',
    RechtsLinks: 'contain',
    RechtsRechts: 'contain',
  })

  const groups = $derived(state ? groupNames(state.mediaIndex.templates, state.mediaIndex.singles, state.defaultGroup) : [])
  const NEW_GROUP = '\u0000neu'
  const effectiveGroup = $derived(uploadGroupChoice === NEW_GROUP ? uploadGroupNew.trim() : uploadGroupChoice)
  // Erste vorhandene Gruppe vorwählen (Pimi zuerst), sobald der State da ist
  let groupInitialized = $state(false)
  $effect(() => {
    if (!groupInitialized && groups.length > 0) {
      uploadGroupChoice = groups[0]
      groupInitialized = true
    }
  })

  // Case-/Unicode-insensitiv wie das Dateisystem des Beamer-PCs (NTFS):
  // "sommerfest" trifft "Sommerfest", NFD-gesyncte Umlaute treffen NFC-Eingabe
  const normName = (s: string) => s.trim().normalize('NFC').toLowerCase()
  const overwriteTarget = $derived(
    state
      ? state.mediaIndex.templates.find(
          (t) => normName(t.group) === normName(effectiveGroup) && normName(t.name) === normName(uploadTemplateName),
        ) ?? null
      : null,
  )
  const overwritesExisting = $derived(overwriteTarget !== null)
  const groupTemplateNames = $derived(
    state ? state.mediaIndex.templates.filter((t) => t.group === effectiveGroup).map((t) => t.name) : [],
  )

  const isVideoUpload = $derived(uploadFile ? isVideoName(uploadFile.name) : false)
  // Loop-Glättung nur sinnvoll bei Video-Uploads (bei quad: irgendeine Videodatei)
  const hasVideoSelected = $derived(
    uploadMode === 'quad'
      ? SCREEN_NAMES.some((s) => quadFiles[s] && isVideoName(quadFiles[s]!.name))
      : isVideoUpload,
  )

  // Objekt-URL für die Vorschau (mit Aufräumen beim Wechsel)
  let previewUrl = $state<string | null>(null)
  $effect(() => {
    if (!uploadFile) {
      previewUrl = null
      return
    }
    const url = URL.createObjectURL(uploadFile)
    previewUrl = url
    return () => URL.revokeObjectURL(url)
  })

  // Objekt-URLs je Leinwand für die quad-Vorschau
  let quadUrls = $state<Record<ScreenName, string | null>>({
    LinksLinks: null,
    LinksRechts: null,
    RechtsLinks: null,
    RechtsRechts: null,
  })
  $effect(() => {
    const created: string[] = []
    const next = {} as Record<ScreenName, string | null>
    for (const s of SCREEN_NAMES) {
      const f = quadFiles[s]
      if (f) {
        const url = URL.createObjectURL(f)
        next[s] = url
        created.push(url)
      } else next[s] = null
    }
    quadUrls = next
    return () => created.forEach((u) => URL.revokeObjectURL(u))
  })

  // Vorschau-Geometrie: exakt dieselbe Zuschnitt-Rechnung wie der Server
  const TILE_W = 132
  const TILE_H = Math.round((TILE_W * 16) / 9)
  const previewSpan = $derived(state ? spanCrops(state.layout, TILE_W, TILE_H, uploadGaps) : null)
  const previewSpan2 = $derived(state ? span2Pairs(state.layout, TILE_W, TILE_H, uploadGaps) : null)
  /** Für die Vorschau: Wand-Masse + Offset des Zuschnitts dieser Leinwand. */
  function previewGeometry(screen: ScreenName): { wallW: number; wallH: number; x: number; y: number } | null {
    if (uploadMode === 'span' && previewSpan) {
      const crop = previewSpan.crops.find((c) => c.screen === screen)
      return crop ? { wallW: previewSpan.wallW, wallH: previewSpan.wallH, x: crop.x, y: crop.y } : null
    }
    if (uploadMode === 'span2' && previewSpan2) {
      for (const pair of previewSpan2) {
        const crop = pair.crops.find((c) => c.screen === screen)
        if (crop) return { wallW: pair.wallW, wallH: pair.wallH, x: crop.x, y: crop.y }
      }
    }
    return null
  }
  const objFit = $derived(uploadFit === 'stretch' ? 'fill' : uploadFit)
  const isSpanMode = $derived(uploadMode === 'span' || uploadMode === 'span2')

  // "Mitte direkt" gibt es nur bei „über alle 4": bei span2 vorübergehend auf
  // 'exact' — wer zurück auf „über alle 4" wechselt, bekommt „Mitte direkt" wieder
  let gapsParked = false
  $effect(() => {
    if (uploadMode !== 'span' && uploadGaps === 'exact-nomid') {
      uploadGaps = 'exact'
      gapsParked = true
    } else if (uploadMode === 'span' && gapsParked) {
      if (uploadGaps === 'exact') uploadGaps = 'exact-nomid'
      gapsParked = false
    }
  })

  /** Spiegelt die Vorschau der linken/rechten Leinwände (span2). */
  function previewMirrored(screen: ScreenName): boolean {
    if (uploadMode !== 'span2') return false
    const left = screen === 'LinksLinks' || screen === 'LinksRechts'
    return left ? uploadMirrorLeft : uploadMirrorRight
  }

  /** Empfohlenes Quellformat je Modus, aus dem echten Wand-Layout gerechnet. */
  const formatHint = $derived.by(() => {
    if (!state) return ''
    const layout = state.layout
    const h = layout.canvasHmm
    if (uploadMode === 'span') {
      const gapSum =
        uploadGaps === 'exact'
          ? layout.gapsMm[0] + layout.gapsMm[1] + layout.gapsMm[2]
          : uploadGaps === 'exact-nomid'
            ? layout.gapsMm[0] + layout.gapsMm[2]
            : 0
      const ratio = (4 * layout.canvasWmm + gapSum) / h
      return `Ideal: sehr breites Querformat, Seitenverhältnis ≈ ${ratio.toFixed(2)}:1 (z.B. ${Math.round(1080 * ratio)}×1080).`
    }
    if (uploadMode === 'span2') {
      const ratio = (2 * layout.canvasWmm + (uploadGaps === 'none' ? 0 : layout.gapsMm[0])) / h
      return `Ideal: Seitenverhältnis ≈ ${ratio.toFixed(2)}:1 (z.B. ${Math.round(1440 * ratio)}×1440) — normales Quer-/Quadratformat passt hier gut.`
    }
    return 'Ideal: Hochformat 9:16 (z.B. 1080×1920) — normale Querformat-Fotos bekommen beim „Einpassen" schwarze Ränder.'
  })

  async function submitUpload(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (!uploadTemplateName.trim()) {
      showBanner('error', 'Vorlagen-Name angeben')
      return
    }
    const quadSelected = SCREEN_NAMES.filter((s) => quadFiles[s])
    if (uploadMode === 'quad') {
      if (quadSelected.length === 0) {
        showBanner('error', 'Mindestens eine Datei je Leinwand wählen')
        return
      }
    } else if (!uploadFile) {
      showBanner('error', 'Datei wählen')
      return
    }
    if (uploadGroupChoice === NEW_GROUP && !uploadGroupNew.trim()) {
      showBanner('error', 'Name der neuen Gruppe angeben')
      return
    }
    uploading = true
    try {
      const form = new FormData()
      form.append('templateName', uploadTemplateName.trim())
      form.append('group', effectiveGroup)
      form.append('mode', uploadMode)
      form.append('fit', uploadFit)
      form.append('gaps', uploadGaps)
      form.append('mirrorLeft', uploadMirrorLeft ? '1' : '0')
      form.append('mirrorRight', uploadMirrorRight ? '1' : '0')
      form.append('loopSmooth', uploadLoopSmooth ? '1' : '0')
      form.append('loopCrossfadeS', String(uploadLoopCrossfadeS))
      if (uploadMode === 'single') form.append('target', uploadTarget)
      if (uploadMode === 'quad') {
        for (const s of quadSelected) {
          form.append('fit' + s, quadFit[s])
          form.append('file' + s, quadFiles[s]!)
        }
      } else {
        form.append('file', uploadFile!)
      }
      const res = await fetch(`${apiBase}/api/upload`, { method: 'POST', body: form })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        showBanner('error', data.error ?? `Upload fehlgeschlagen (${res.status})`)
      } else {
        showBanner('ok', overwritesExisting ? 'Hochgeladen — Vorlage wird überschrieben' : 'Hochgeladen — Verarbeitung läuft')
        uploadFile = null
        quadFiles = { LinksLinks: null, LinksRechts: null, RechtsLinks: null, RechtsRechts: null }
        uploadTemplateName = ''
        if (uploadGroupChoice === NEW_GROUP) {
          uploadGroupChoice = uploadGroupNew.trim()
          uploadGroupNew = ''
        }
      }
    } catch (err) {
      showBanner('error', `Upload fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      uploading = false
    }
  }

  const jobStatusLabel: Record<string, string> = {
    queued: 'Wartet',
    running: 'Verarbeitet…',
    done: 'Fertig',
    error: 'Fehler',
  }

  // ============================================================
  // Inhalte (Vorlagen/Einzelbilder in den Papierkorb verschieben)
  // ============================================================

  async function trashTemplate(ref: string): Promise<void> {
    if (!confirm(`Vorlage „${ref}" in den Papierkorb verschieben?\n(Landet in „_Papierkorb" im Medienordner, nichts wird endgültig gelöscht.)`)) return
    if (await api('/api/trash', { type: 'template', ref })) showBanner('ok', `„${ref}" in den Papierkorb verschoben`)
  }

  async function trashSingle(file: string): Promise<void> {
    if (!confirm(`Einzelbild „${file}" in den Papierkorb verschieben?`)) return
    if (await api('/api/trash', { type: 'single', file })) showBanner('ok', `„${file}" in den Papierkorb verschoben`)
  }

  /** Vorlage aus dem gesicherten Original neu rechnen (frische Wandmasse etc.). */
  async function rerenderTemplate(ref: string): Promise<void> {
    const parts = ref.split('/')
    const url =
      parts.length === 2
        ? `/api/template/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/rerender`
        : `/api/template/${encodeURIComponent(ref)}/rerender`
    if (await api(url, {})) showBanner('ok', `„${ref}" wird neu gerechnet — siehe Jobs`)
  }

  async function rerenderAll(): Promise<void> {
    if (!confirm('Alle Span-/Span2-Vorlagen aus dem Original neu rechnen (mit den aktuellen Wandmassen)?')) return
    if (await api('/api/rerender-all?modes=span,span2', {})) showBanner('ok', 'Neuberechnung gestartet — siehe Jobs')
  }

  function templatesOf(group: string) {
    return state ? state.mediaIndex.templates.filter((t) => t.group === group) : []
  }
  function singlesOf(group: string) {
    return state ? state.mediaIndex.singles.filter((s) => singleGroup(s.file) === group) : []
  }

  // ============================================================
  // Kalibrierung (Ecken ziehen, Pfeiltasten, Live auf den Leinwänden)
  // ============================================================

  /** Lokale Überschreibung während des Bearbeitens (Server bestätigt per WS). */
  let editedQuads = $state<Partial<Record<ScreenName, Quad>>>({})
  let selectedCorner = $state<{ screen: ScreenName; corner: Corner } | null>(null)
  let dragging = $state(false)

  // Zoom je Beamer-Fenster (auf die gewählte Ecke zentriert) für Pixel-Feinarbeit
  const ZOOM_MIN = 1
  const ZOOM_MAX = 8
  let zoom = $state<Record<WindowRole, number>>({ links: 1, rechts: 1 })
  let viewCenter = $state<Record<WindowRole, { x: number; y: number }>>({
    links: { x: 960, y: 540 },
    rechts: { x: 960, y: 540 },
  })
  const clampN = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
  function viewBox(role: WindowRole): { x: number; y: number; w: number; h: number } {
    const z = zoom[role]
    const w = 1920 / z
    const h = 1080 / z
    const cx = clampN(viewCenter[role].x, w / 2, 1920 - w / 2)
    const cy = clampN(viewCenter[role].y, h / 2, 1080 - h / 2)
    return { x: cx - w / 2, y: cy - h / 2, w, h }
  }
  const viewBoxStr = (role: WindowRole) => {
    const v = viewBox(role)
    return `${v.x} ${v.y} ${v.w} ${v.h}`
  }
  const roleOfScreen = (screen: ScreenName): WindowRole => (WINDOW_SCREENS.links.includes(screen) ? 'links' : 'rechts')
  const setZoom = (role: WindowRole, z: number) => (zoom = { ...zoom, [role]: clampN(z, ZOOM_MIN, ZOOM_MAX) })
  const centerOn = (role: WindowRole, x: number, y: number) => (viewCenter = { ...viewCenter, [role]: { x, y } })

  function quadFor(screen: ScreenName): Quad | null {
    return editedQuads[screen] ?? state?.calibration[screen]?.corners ?? null
  }

  function polygonPoints(q: Quad): string {
    return `${q.tl.x},${q.tl.y} ${q.tr.x},${q.tr.y} ${q.br.x},${q.br.y} ${q.bl.x},${q.bl.y}`
  }

  // Gesammelt senden: beim Ziehen max. ~20 Requests/s
  const pendingCal = new Map<ScreenName, Quad>()
  let calTimer: number | null = null
  function postCalibration(screen: ScreenName, quad: Quad): void {
    pendingCal.set(screen, quad)
    if (calTimer !== null) return
    calTimer = window.setTimeout(() => {
      calTimer = null
      for (const [s, q] of [...pendingCal]) {
        pendingCal.delete(s)
        void api(`/api/calibration/${s}`, { corners: q })
      }
    }, 50)
  }

  function setCorner(screen: ScreenName, corner: Corner, x: number, y: number): void {
    const current = quadFor(screen)
    if (!current) return
    const next: Quad = {
      tl: { ...current.tl },
      tr: { ...current.tr },
      br: { ...current.br },
      bl: { ...current.bl },
    }
    next[corner] = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }
    editedQuads = { ...editedQuads, [screen]: next }
    postCalibration(screen, next)
  }

  // Zoom-tauglich: durch die LIVE-viewBox skalieren + deren Offset addieren,
  // sonst sitzt der Cursor beim Ziehen im gezoomten Bild neben der Ecke
  function svgPoint(svg: SVGSVGElement, e: PointerEvent, role: WindowRole): { x: number; y: number } {
    const rect = svg.getBoundingClientRect()
    const v = viewBox(role)
    return {
      x: v.x + ((e.clientX - rect.left) * v.w) / rect.width,
      y: v.y + ((e.clientY - rect.top) * v.h) / rect.height,
    }
  }

  function startDrag(e: PointerEvent, screen: ScreenName, corner: Corner): void {
    e.preventDefault()
    selectedCorner = { screen, corner }
    dragging = true
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }

  function moveDrag(e: PointerEvent, svg: SVGSVGElement, role: WindowRole): void {
    if (!dragging || !selectedCorner) return
    const p = svgPoint(svg, e, role)
    setCorner(selectedCorner.screen, selectedCorner.corner, p.x, p.y)
  }

  function endDrag(): void {
    dragging = false
  }

  // Gewählte Ecke dem Player melden (Marker auf der echten Leinwand).
  // Ein einziger POST pro Zustandswechsel — Cleanup-basiertes Clear+Set
  // könnte sich auf dem Netz überholen und den Marker falsch stehen lassen.
  let lastFocusKey = ''
  $effect(() => {
    const focus = tab === 'kalibrierung' ? selectedCorner : null
    const key = focus ? `${focus.screen}|${focus.corner}` : ''
    if (key === lastFocusKey) return
    lastFocusKey = key
    void api('/api/calibration/focus', focus ? { screen: focus.screen, corner: focus.corner } : {})
  })
  $effect(() => {
    if (tab !== 'kalibrierung') {
      if (selectedCorner) selectedCorner = null
      // Lokale Bearbeitungs-Kopien verwerfen — beim nächsten Öffnen
      // gilt wieder der Server-Stand
      if (Object.keys(editedQuads).length > 0) editedQuads = {}
    }
  })

  // Beim Zoom die Ansicht auf die gewählte Ecke zentrieren (folgt auch dem Nudge)
  $effect(() => {
    const sel = selectedCorner
    if (!sel) return
    const role = roleOfScreen(sel.screen)
    if (zoom[role] <= 1) return
    const q = quadFor(sel.screen)
    if (!q) return
    centerOn(role, q[sel.corner].x, q[sel.corner].y)
  })

  // Pfeiltasten: 1 px, Shift = 10 px, Alt = 0.1 px
  $effect(() => {
    if (tab !== 'kalibrierung') return
    const onKey = (e: KeyboardEvent) => {
      if (!selectedCorner) return
      const step = e.altKey ? 0.1 : e.shiftKey ? 10 : 1
      let dx = 0
      let dy = 0
      if (e.key === 'ArrowLeft') dx = -step
      else if (e.key === 'ArrowRight') dx = step
      else if (e.key === 'ArrowUp') dy = -step
      else if (e.key === 'ArrowDown') dy = step
      else return
      e.preventDefault()
      const q = quadFor(selectedCorner.screen)
      if (!q) return
      const c = q[selectedCorner.corner]
      setCorner(selectedCorner.screen, selectedCorner.corner, c.x + dx, c.y + dy)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ============================================================
  // Einstellungen
  // ============================================================

  let formMediaRoot = $state('')
  let formTransitionMs = $state(300)
  let formHostLinks = $state('')
  let formHostRechts = $state('')
  let formCanvasW = $state(1000)
  let formCanvasH = $state(1780)
  let formGap0 = $state(300)
  let formGap1 = $state(4000)
  let formGap2 = $state(300)
  let formYOff = $state<[number, number, number, number]>([0, 0, 0, 0])
  let formDefaultGroup = $state('')
  let settingsLoaded = $state(false)

  $effect(() => {
    if (tab !== 'einstellungen') {
      settingsLoaded = false
      return
    }
    if (settingsLoaded || !state) return
    formMediaRoot = state.mediaRoot
    formTransitionMs = state.transitionMs
    formHostLinks = state.projectors.find((p) => p.id === 'links')?.host ?? ''
    formHostRechts = state.projectors.find((p) => p.id === 'rechts')?.host ?? ''
    formCanvasW = state.layout.canvasWmm
    formCanvasH = state.layout.canvasHmm
    formGap0 = state.layout.gapsMm[0]
    formGap1 = state.layout.gapsMm[1]
    formGap2 = state.layout.gapsMm[2]
    formYOff = [...(state.layout.yOffsetsMm ?? [0, 0, 0, 0])]
    formDefaultGroup = state.defaultGroup
    settingsLoaded = true
  })

  // Beamer-Diagnose (Fehlersuche vor Ort): Webinterface + PJLink-Status
  let diagnose = $state<string>('')
  async function runDiagnose(id: 'links' | 'rechts'): Promise<void> {
    diagnose = `Teste Beamer ${id}…`
    try {
      const res = await fetch(`${apiBase}/api/projector/${id}/diagnose`)
      const data = await res.json()
      diagnose = JSON.stringify(data.diagnose ?? data, null, 2)
    } catch (err) {
      diagnose = `Fehler: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  async function saveSettings(): Promise<void> {
    const ok = await api('/api/config', {
      mediaRoot: formMediaRoot,
      transitionMs: formTransitionMs,
      projectors: [
        { id: 'links', host: formHostLinks },
        { id: 'rechts', host: formHostRechts },
      ],
      layout: {
        canvasWmm: formCanvasW,
        canvasHmm: formCanvasH,
        gapsMm: [formGap0, formGap1, formGap2],
        yOffsetsMm: formYOff,
      },
      defaultGroup: formDefaultGroup,
    })
    if (ok) showBanner('ok', 'Einstellungen gespeichert')
  }

  // ============================================================
  // Anzeige (Displays, Drehung, Identifizieren)
  // ============================================================

  /** Config-Datei importieren (Backup zurückspielen, v.a. Kalibrierung). */
  async function importConfigFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      showBanner('error', 'Datei ist kein gültiges JSON')
      return
    }
    try {
      const res = await fetch(`${apiBase}/api/config/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        showBanner('error', data.error ?? `Import fehlgeschlagen (${res.status})`)
        return
      }
      settingsLoaded = false
      showBanner(
        'ok',
        data.mediaRootKept
          ? 'Konfiguration importiert — Medienordner-Pfad existiert hier nicht, der bisherige bleibt'
          : 'Konfiguration importiert',
      )
    } catch (err) {
      showBanner('error', `Import fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function assignDisplay(role: WindowRole, value: string): Promise<void> {
    if (value === 'auto') {
      if (await api('/api/display/assign', { window: role, displayId: 'auto' })) {
        showBanner('ok', `Fenster „${role}" wird wieder automatisch verteilt`)
      }
      return
    }
    const displayId = Number(value)
    if (!Number.isFinite(displayId)) return
    if (await api('/api/display/assign', { window: role, displayId })) {
      showBanner('ok', `Fenster „${role}" zugeordnet`)
    }
  }

  const PLACEMENT_TEXT: Record<string, string> = {
    assigned: 'fest zugeordnet',
    recognized: 'fest zugeordnet (wiedererkannt)',
    auto: 'automatisch verteilt — noch nicht bestätigt',
    missing: 'kein Beamer erkannt — Fenster wartet versteckt und erscheint beim Anschliessen',
    simulator: 'Simulator',
  }
  function placementText(role: WindowRole): string {
    if (!state) return ''
    const p = state.windowPlacement[role]
    const d = state.displays.find((x) => x.id === p.displayId)
    const where = d ? `${d.label} (${d.bounds.width}×${d.bounds.height})${d.primary ? ', Hauptbildschirm' : ''} — ` : ''
    return where + (PLACEMENT_TEXT[p.reason] ?? p.reason)
  }

  async function setRotation(role: WindowRole, on: boolean): Promise<void> {
    await api('/api/display/rotation', { window: role, deg: on ? 180 : 0 })
  }
</script>

<main>
  <header>
    <h1>Seitenscreens — Verwaltung</h1>
    <span class="dot" class:on={connected} title={connected ? 'Verbunden' : 'Getrennt'}></span>
    <div class="spacer"></div>
    <a class="backlink" href={controlUrl}>← Zur Steuerung</a>
  </header>

  {#if banner}
    <div class="toast {banner.kind}" role="status">{banner.text}</div>
  {/if}

  {#if !state}
    <p class="muted">Verbinde…</p>
  {:else}
    <div class="tabs">
      <button class:selected={tab === 'upload'} onclick={() => (tab = 'upload')}>Hochladen</button>
      <button class:selected={tab === 'inhalte'} onclick={() => (tab = 'inhalte')}>Inhalte</button>
      <button class:selected={tab === 'kalibrierung'} onclick={() => (tab = 'kalibrierung')}>Kalibrierung</button>
      <button class:selected={tab === 'anzeige'} onclick={() => (tab = 'anzeige')}>Anzeige</button>
      <button class:selected={tab === 'einstellungen'} onclick={() => (tab = 'einstellungen')}>Einstellungen</button>
    </div>

    {#if tab === 'upload'}
      <section>
        <h2>Neue Vorlage hochladen</h2>
        <form class="upload" onsubmit={submitUpload}>
          <div class="uploadrow">
            {#if uploadMode !== 'quad'}
              <input
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.mp4,.mov,.webm,.m4v"
                onchange={(e) => (uploadFile = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)}
              />
            {/if}
            <select bind:value={uploadGroupChoice} title="Gruppe (Unterordner im Medienordner)">
              {#each groups as g (g)}
                <option value={g}>{groupLabel(g)}</option>
              {/each}
              {#if !groups.includes('')}<option value="">Allgemein (Wurzel)</option>{/if}
              <option value={NEW_GROUP}>+ Neue Gruppe…</option>
            </select>
            {#if uploadGroupChoice === NEW_GROUP}
              <input type="text" class="ginput" placeholder="Name der neuen Gruppe" bind:value={uploadGroupNew} required />
            {/if}
            <input
              type="text"
              class="tinput"
              placeholder="Vorlagen-Name (neu oder bestehend)"
              bind:value={uploadTemplateName}
              list="template-names"
            />
            <datalist id="template-names">
              {#each groupTemplateNames as n (n)}<option value={n}></option>{/each}
            </datalist>
          </div>
          {#if overwriteTarget}
            <div class="overwritehint">
              ⚠ Es gibt bereits eine Vorlage „{overwriteTarget.name}" in {groupLabel(overwriteTarget.group)} — sie wird
              überschrieben. {state.activeTemplate === overwriteTarget.ref
                ? 'Sie ist gerade LIVE und wird nach der Verarbeitung automatisch neu geladen.'
                : ''}
            </div>
          {/if}
          <div class="uploadrow">
            <label class="radio"><input type="radio" bind:group={uploadMode} value="clone" /> Gleich auf allen 4</label>
            <label class="radio"><input type="radio" bind:group={uploadMode} value="span" /> Über alle 4 spannen</label>
            <label class="radio"><input type="radio" bind:group={uploadMode} value="span2" /> Je über 2 spannen (links & rechts gleich)</label>
            <label class="radio"><input type="radio" bind:group={uploadMode} value="quad" /> 4 Dateien (je eine pro Leinwand)</label>
            <label class="radio">
              <input type="radio" bind:group={uploadMode} value="single" /> Eine Leinwand:
              <select bind:value={uploadTarget} disabled={uploadMode !== 'single'}>
                {#each SCREEN_NAMES as s (s)}<option value={s}>{SHORT[s]}</option>{/each}
              </select>
            </label>
          </div>
          {#if uploadMode === 'quad'}
            <div class="quadpickers">
              {#each SCREEN_NAMES as screen (screen)}
                <div class="quadpick">
                  <span class="qlabel">{SHORT[screen]}</span>
                  <input
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp,.mp4,.mov,.webm,.m4v"
                    onchange={(e) => (quadFiles = { ...quadFiles, [screen]: (e.currentTarget as HTMLInputElement).files?.[0] ?? null })}
                  />
                  <select bind:value={quadFit[screen]} title="Einpassung dieser Leinwand">
                    <option value="contain">Einpassen</option>
                    <option value="cover">Füllen</option>
                    <option value="stretch">Strecken</option>
                  </select>
                </div>
              {/each}
            </div>
          {:else}
            <div class="uploadrow">
              <span class="rowlabel">Einpassen:</span>
              <label class="radio"><input type="radio" bind:group={uploadFit} value="contain" /> Einpassen</label>
              <label class="radio"><input type="radio" bind:group={uploadFit} value="cover" /> Füllen</label>
              <label class="radio"><input type="radio" bind:group={uploadFit} value="stretch" /> Strecken</label>
            </div>
          {/if}
          {#if isSpanMode}
            <div class="uploadrow">
              <span class="rowlabel">Übergang zwischen den Leinwänden:</span>
              <label class="radio" title="Alle Lücken und der Höhenversatz maskieren Bildteile — durchlaufende Motive fluchten physisch">
                <input type="radio" bind:group={uploadGaps} value="exact" /> Geometrisch korrekt (alle Abstände)
              </label>
              {#if uploadMode === 'span'}
                <label class="radio" title="Äussere Paare korrekt, aber der Mittelabstand über der Bühne = 0 — in der Mitte geht das Motiv direkt über (kein Verlust dort)">
                  <input type="radio" bind:group={uploadGaps} value="exact-nomid" /> Korrekt, Mitte direkt (ohne Bühnen-Abstand)
                </label>
              {/if}
              <label class="radio" title="Die Leinwände teilen das Motiv nahtlos — nichts wird abgeschnitten">
                <input type="radio" bind:group={uploadGaps} value="none" /> Nichts abschneiden (nahtlos geteilt)
              </label>
            </div>
          {/if}
          {#if uploadMode === 'span2'}
            <div class="uploadrow">
              <span class="rowlabel">Spiegeln:</span>
              <label class="radio" title="Spiegelt die linke Doppel-Leinwand horizontal">
                <input type="checkbox" bind:checked={uploadMirrorLeft} /> Linke Seite spiegeln
              </label>
              <label class="radio" title="Spiegelt die rechte Doppel-Leinwand horizontal — mit beiden Seiten zeigt die Bewegung symmetrisch zur Mitte">
                <input type="checkbox" bind:checked={uploadMirrorRight} /> Rechte Seite spiegeln
              </label>
            </div>
          {/if}
          {#if hasVideoSelected}
            <div class="uploadrow">
              <label class="radio" title="Blendet das Ende weich in den Anfang — nahtloser Loop für Motion Graphics, deren Ende nicht zum Anfang passt">
                <input type="checkbox" bind:checked={uploadLoopSmooth} /> Loop glätten (Ende weich in Anfang überblenden)
              </label>
              {#if uploadLoopSmooth}
                <label class="radio">
                  Überblendung
                  <input type="number" min="0.1" max="2" step="0.1" bind:value={uploadLoopCrossfadeS} style="width:70px" /> s
                </label>
              {/if}
            </div>
          {/if}
          <div class="uploadrow">
            <p class="formathint">
              {formatHint} Unterstützt: JPG/PNG/WebP und MP4/MOV/WebM — Videos werden automatisch auf das Leinwand-Format
              umgerechnet (stumm, Endlos-Loop). „Einpassen" = schwarze Ränder, „Füllen" = randlos zugeschnitten,
              „Strecken" = verzerrt auf volle Fläche.
            </p>
            <span class="sep"></span>
            <button class="primary" type="submit" disabled={uploading}>
              {uploading ? 'Lädt hoch…' : 'Hochladen & verarbeiten'}
            </button>
          </div>
        </form>

        {#if previewUrl || uploadMode === 'quad'}
          <h2>Vorschau — so sieht es auf den 4 Leinwänden aus</h2>
          <div class="preview">
            {#each SCREEN_NAMES as screen (screen)}
              <div class="pcol">
                <div
                  class="ptile"
                  class:dim={uploadMode === 'single' && uploadTarget !== screen}
                  style="width:{TILE_W}px;height:{TILE_H}px"
                >
                  {#if uploadMode === 'quad'}
                    {@const url = quadUrls[screen]}
                    {@const qf = quadFit[screen] === 'stretch' ? 'fill' : quadFit[screen]}
                    {#if url}
                      {#if quadFiles[screen] && isVideoName(quadFiles[screen]!.name)}
                        <video src={url} muted loop autoplay playsinline style="object-fit:{qf}"></video>
                      {:else}
                        <img src={url} alt="" style="object-fit:{qf}" />
                      {/if}
                    {/if}
                  {:else if uploadMode !== 'single' || uploadTarget === screen}
                    {@const geo = previewGeometry(screen)}
                    {#if geo}
                      {@const mir = previewMirrored(screen) ? ';transform:scaleX(-1)' : ''}
                      {#if isVideoUpload}
                        <video
                          src={previewUrl}
                          muted
                          loop
                          autoplay
                          playsinline
                          class="span"
                          style="width:{geo.wallW}px;height:{geo.wallH}px;left:-{geo.x}px;top:-{geo.y}px;object-fit:{objFit}{mir}"
                        ></video>
                      {:else}
                        <img
                          src={previewUrl}
                          alt=""
                          class="span"
                          style="width:{geo.wallW}px;height:{geo.wallH}px;left:-{geo.x}px;top:-{geo.y}px;object-fit:{objFit}{mir}"
                        />
                      {/if}
                    {:else if isVideoUpload}
                      <video src={previewUrl} muted loop autoplay playsinline style="object-fit:{objFit}"></video>
                    {:else}
                      <img src={previewUrl} alt="" style="object-fit:{objFit}" />
                    {/if}
                  {/if}
                </div>
                <span class="plabel">{SHORT[screen]}</span>
              </div>
            {/each}
          </div>
          <p class="muted small">
            {#if uploadMode === 'quad'}
              Jede Leinwand zeigt ihre eigene Datei.
            {:else}
              Die Vorschau rechnet mit den Leinwand-Abständen aus den Einstellungen.
            {/if}
            {#if isVideoUpload || (uploadMode === 'quad' && hasVideoSelected)}Videos laufen in der Vorschau evtl. nicht ganz synchron — auf den Beamern schon.{/if}
          </p>
        {/if}

        {#if state.jobs.length > 0}
          <h2>Verarbeitung</h2>
          <div class="jobs">
            {#each [...state.jobs].reverse() as job (job.id)}
              <div class="job {job.status}">
                <span class="joblabel">{job.label}</span>
                <span class="jobstatus">{jobStatusLabel[job.status] ?? job.status}{job.error ? ` — ${job.error}` : ''}</span>
                {#if job.status === 'running'}
                  <progress value={job.progress} max="1"></progress>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {:else if tab === 'inhalte'}
      <section>
        <div class="inhaltehead">
          <h2>Inhalte verwalten</h2>
          <button onclick={rerenderAll} title="Alle Span-/Span2-Vorlagen aus dem Original mit den aktuellen Wandmassen neu rechnen">
            ↻ Alle Span-Vorlagen neu rechnen
          </button>
        </div>
        <p class="muted small">
          „Papierkorb" verschiebt in den Ordner „_Papierkorb" im Medienordner — nichts wird endgültig gelöscht.
          Wiederherstellen: in Nextcloud aus „_Papierkorb" zurückschieben. „Neu rechnen" erzeugt eine Vorlage aus
          ihrem gesicherten Original neu (z.B. nach geänderten Leinwand-Massen). Die gerade live geschaltete Vorlage
          kann nicht verschoben werden.
        </p>
        {#each groups as g (g)}
          <h3 class="grouphead">{groupLabel(g)}</h3>
          <div class="contentlist">
            {#each templatesOf(g) as t (t.ref)}
              <div class="contentrow" class:live={state.activeTemplate === t.ref}>
                <div class="minithumbs">
                  {#each SCREEN_NAMES as screen (screen)}
                    {@const f = t.files[screen]}
                    <div class="minithumb">{#if f}<img src={thumbUrl(f)} alt="" loading="lazy" />{/if}</div>
                  {/each}
                </div>
                <span class="tname" title={t.ref}>{t.name}</span>
                {#if t.warnings.length > 0}<span class="warn" title={t.warnings.join('\n')}>⚠</span>{/if}
                {#if state.activeTemplate === t.ref}<span class="livebadge">LIVE</span>{/if}
                <button class="mini" onclick={() => rerenderTemplate(t.ref)} title="Aus dem Original neu rechnen">↻ Neu rechnen</button>
                <button
                  class="mini danger"
                  disabled={state.activeTemplate === t.ref}
                  onclick={() => trashTemplate(t.ref)}
                >
                  🗑 Papierkorb
                </button>
              </div>
            {/each}
            {#each singlesOf(g) as s (s.file)}
              <div class="contentrow">
                <div class="minithumbs single"><div class="minithumb"><img src={thumbUrl(s)} alt="" loading="lazy" /></div></div>
                <span class="tname" title={s.file}>{s.file.split('/').pop()} <em class="muted">(Einzelbild)</em></span>
                <button class="mini danger" onclick={() => trashSingle(s.file)}>🗑 Papierkorb</button>
              </div>
            {/each}
            {#if templatesOf(g).length === 0 && singlesOf(g).length === 0}
              <p class="muted small">Leer.</p>
            {/if}
          </div>
        {/each}
      </section>
    {:else if tab === 'kalibrierung'}
      <section>
        <h2>Kalibrierung — Ecken ziehen (live auf den Leinwänden)</h2>
        <div class="calactions">
          <button
            class:active={state.testPattern}
            onclick={() => api(`/api/testpattern/${state?.testPattern ? 'off' : 'on'}`)}
          >
            Testbild {state.testPattern ? 'aus' : 'ein'}
          </button>
          <span class="muted small">
            Ecke anklicken oder ziehen. Pfeiltasten = 1 px, Shift = 10 px, Alt = 0,1 px. Die gewählte Ecke wird auf der
            Leinwand magenta markiert (bei eingeschaltetem Testbild am besten sichtbar).
          </span>
        </div>
        <div class="calwins">
          {#each WINDOW_ROLES as role (role)}
            {@const z = zoom[role]}
            <div class="calwin">
              <div class="calwinhead">
                <h3>Beamer {role}</h3>
                <label class="zoomctl">
                  Zoom {z.toFixed(1)}×
                  <input
                    type="range"
                    min={ZOOM_MIN}
                    max={ZOOM_MAX}
                    step="0.5"
                    value={z}
                    oninput={(e) => setZoom(role, Number((e.currentTarget as HTMLInputElement).value))}
                  />
                  {#if z > 1}<button class="mini" onclick={() => setZoom(role, 1)}>1×</button>{/if}
                </label>
              </div>
              <svg
                viewBox={viewBoxStr(role)}
                role="application"
                aria-label={`Kalibrierung Beamer ${role}`}
                onpointermove={(e) => moveDrag(e, e.currentTarget as SVGSVGElement, role)}
                onpointerup={endDrag}
                onpointercancel={endDrag}
              >
                <rect x="0" y="0" width="1920" height="1080" class="calframe" style="stroke-width:{4 / z}" />
                {#each WINDOW_SCREENS[role] as screen (screen)}
                  {@const q = quadFor(screen)}
                  {#if q}
                    <polygon
                      points={polygonPoints(q)}
                      class="calquad"
                      class:focused={selectedCorner?.screen === screen}
                      style="stroke-width:{3 / z}"
                    />
                    <text x={(q.tl.x + q.br.x) / 2} y={(q.tl.y + q.br.y) / 2} class="callabel" style="font-size:{64 / z}px">{SHORT[screen]}</text>
                    {#each CORNERS as corner (corner)}
                      <circle
                        cx={q[corner].x}
                        cy={q[corner].y}
                        r={Math.max(6, 22 / z)}
                        class="calhandle"
                        class:selected={selectedCorner?.screen === screen && selectedCorner?.corner === corner}
                        role="button"
                        aria-label={`${SHORT[screen]} Ecke ${corner}`}
                        tabindex="-1"
                        style="stroke-width:{5 / z}"
                        onpointerdown={(e) => startDrag(e, screen, corner)}
                      />
                    {/each}
                  {/if}
                {/each}
              </svg>
            </div>
          {/each}
        </div>
        {#if selectedCorner}
          {@const sc = selectedCorner}
          {@const q = quadFor(sc.screen)}
          {#if q}
            {@const c = q[sc.corner]}
            <div class="cornernum">
              <span class="muted small">Gewählt: {SHORT[sc.screen]} · Ecke {sc.corner.toUpperCase()}</span>
              <label>x
                <input
                  type="number"
                  step="0.1"
                  value={c.x}
                  oninput={(e) => setCorner(sc.screen, sc.corner, Number((e.currentTarget as HTMLInputElement).value), c.y)}
                />
              </label>
              <label>y
                <input
                  type="number"
                  step="0.1"
                  value={c.y}
                  oninput={(e) => setCorner(sc.screen, sc.corner, c.x, Number((e.currentTarget as HTMLInputElement).value))}
                />
              </label>
            </div>
          {/if}
        {/if}
      </section>
    {:else if tab === 'anzeige'}
      <section>
        <h2>Anzeige — Beamer-Fenster & Ausgänge</h2>
        {#if state.simulator}
          <div class="banner ok">
            Simulator-Modus (Entwicklung): Fenster sind gerahmte Vorschau-Fenster, die Zuordnung hat hier keine echte
            Wirkung. Auf dem Beamer-PC erscheinen hier die physischen Ausgänge (HDMI/DisplayPort).
          </div>
        {/if}
        <div class="dispactions">
          <button class="primary" onclick={() => api('/api/display/identify')}>Fenster identifizieren</button>
          <button onclick={() => api('/api/display/swap')}>Links ↔ rechts tauschen</button>
          {#if placementNeedsConfirmation(state.windowPlacement) && !state.simulator}
            <button onclick={() => api('/api/display/confirm')}>Verteilung festhalten</button>
          {/if}
          <button onclick={() => api('/api/display/refullscreen', {})}>Vollbild erzwingen</button>
          <span class="muted small">„Identifizieren" blendet auf jedem Beamer-Fenster 4 s gross „links"/„rechts" ein.</span>
        </div>
        <div class="dispgrid">
          {#each WINDOW_ROLES as role (role)}
            <div class="card">
              <h3>Fenster „{role}"</h3>
              <p class="placement {state.windowPlacement[role].reason}">{placementText(role)}</p>
              <label>
                Display / Ausgang
                <select
                  value={String(state.windowSettings.assignments[role] ?? 'auto')}
                  onchange={(e) => assignDisplay(role, (e.currentTarget as HTMLSelectElement).value)}
                >
                  <option value="auto">Automatisch (von links nach rechts, ohne Hauptbildschirm)</option>
                  {#if state.windowSettings.assignments[role] !== undefined && !state.displays.some((d) => d.id === state?.windowSettings.assignments[role])}
                    <option value={String(state.windowSettings.assignments[role])} disabled>
                      Fest zugeordnetes Display — gerade nicht angeschlossen
                    </option>
                  {/if}
                  {#each state.displays as d (d.id)}
                    <option value={String(d.id)}>
                      {d.label} — {d.bounds.width}×{d.bounds.height} @ {d.bounds.x},{d.bounds.y}{d.primary ? ' (Hauptdisplay)' : ''}
                    </option>
                  {/each}
                </select>
              </label>
              <label class="radio rot">
                <input
                  type="checkbox"
                  checked={state.windowSettings.rotation[role] === 180}
                  onchange={(e) => setRotation(role, (e.currentTarget as HTMLInputElement).checked)}
                />
                Ausgabe um 180° drehen (kopfüber montierter Beamer)
              </label>
            </div>
          {/each}
        </div>
        <label class="radio avoidprimary">
          <input
            type="checkbox"
            checked={state.windowSettings.avoidPrimary}
            onchange={(e) => api('/api/display/settings', { avoidPrimary: (e.currentTarget as HTMLInputElement).checked })}
          />
          Hauptbildschirm (Bediener-Monitor) nie automatisch für einen Beamer verwenden
        </label>
        <p class="muted small">
          Angeschlossene Displays: {state.displays.length}. Fehlt beim Start ein Beamer, wartet sein Fenster versteckt
          und erscheint von selbst, sobald der Beamer angeschlossen bzw. eingeschaltet ist. Ohne feste Zuordnung gilt:
          linker Beamer = Fenster „links". „Links ↔ rechts tauschen" und „Verteilung festhalten" merken sich die
          Zuordnung auch über Neustarts.
        </p>
      </section>
    {:else if tab === 'einstellungen'}
      <section>
        <h2>Einstellungen</h2>
        <div class="settings">
          <label>
            Medienordner (Nextcloud „_Vorlagen")
            <input type="text" bind:value={formMediaRoot} placeholder="z.B. C:\Users\Techniker\Nextcloud\…\_Vorlagen" />
            <small>Pfad auf dem Beamer-PC. Wird geprüft, bevor er übernommen wird.</small>
          </label>
          <label>
            Überblendung (ms)
            <input type="number" bind:value={formTransitionMs} min="0" max="5000" step="50" />
          </label>
          <label>
            Beamer links (IP/Host)
            <input type="text" bind:value={formHostLinks} />
          </label>
          <label>
            Beamer rechts (IP/Host)
            <input type="text" bind:value={formHostRechts} />
          </label>
          <div class="diag">
            <button class="mini" onclick={() => runDiagnose('links')}>Verbindung testen: links</button>
            <button class="mini" onclick={() => runDiagnose('rechts')}>Verbindung testen: rechts</button>
            <small>Fragt Webinterface und PJLink-Status ab (ändert nichts am Beamer) — für die Fehlersuche.</small>
          </div>
          {#if diagnose}<pre class="diagout">{diagnose}</pre>{/if}
          <label>
            Standard-Gruppe (Tab, der beim Öffnen vorgewählt ist)
            <input type="text" bind:value={formDefaultGroup} list="group-names" placeholder="leer = alphabetisch erste" />
          </label>
          <datalist id="group-names">
            {#each groups as g (g)}{#if g}<option value={g}></option>{/if}{/each}
          </datalist>
          <fieldset class="layoutset">
            <legend>Wand-Layout (für „über alle 4 spannen")</legend>
            <div class="layoutgrid">
              <label>Leinwand-Breite (mm)<input type="number" bind:value={formCanvasW} min="100" /></label>
              <label>Leinwand-Höhe (mm)<input type="number" bind:value={formCanvasH} min="100" /></label>
              <label>Abstand LL–LR (mm)<input type="number" bind:value={formGap0} min="0" /></label>
              <label>Abstand Mitte/Bühne (mm)<input type="number" bind:value={formGap1} min="0" /></label>
              <label>Abstand RL–RR (mm)<input type="number" bind:value={formGap2} min="0" /></label>
            </div>
            <p class="muted small">Höhenversatz je Leinwand in mm (positiv = hängt tiefer) — für den geometrisch korrekten Übergang beim Spannen:</p>
            <div class="layoutgrid four">
              {#each SCREEN_NAMES as s, i (s)}
                <label>{SHORT[s]}<input type="number" bind:value={formYOff[i]} step="10" /></label>
              {/each}
            </div>
          </fieldset>
          <div class="settingsfoot">
            <button class="primary" onclick={saveSettings}>Speichern</button>
          </div>
          <!-- Wirken sofort (ohne „Speichern") -->
          <fieldset class="layoutset">
            <legend>Weihnachtsbaum-Modus (Leinwände ausschalten)</legend>
            <p class="muted small">
              Steht etwas vor einer Leinwand, hier ausschalten: Sie bleibt dann bei jeder Vorlage schwarz, alles andere
              läuft normal. Wirkt sofort; die Steuerung zeigt einen Hinweis, solange eine Leinwand aus ist.
            </p>
            {#each SCREEN_NAMES as s (s)}
              <label class="radio">
                <input
                  type="checkbox"
                  checked={state?.disabledScreens?.includes(s) ?? false}
                  onchange={(e) => {
                    const on = (e.currentTarget as HTMLInputElement).checked
                    const current = state?.disabledScreens ?? []
                    const next = on ? [...current, s] : current.filter((x) => x !== s)
                    void api('/api/screens/disabled', { screens: next })
                  }}
                />
                Leinwand {LONG[s]} ausschalten
              </label>
            {/each}
          </fieldset>
          <fieldset class="layoutset">
            <legend>Beim Start des Programms</legend>
            <label class="radio">
              <input
                type="checkbox"
                checked={state?.statusWindow ?? true}
                onchange={(e) => api('/api/settings/options', { statusWindow: (e.currentTarget as HTMLInputElement).checked })}
              />
              Steuerung als Fenster auf dem Hauptbildschirm öffnen
            </label>
            <label class="radio">
              <input
                type="checkbox"
                checked={state?.projectorAutoOn ?? false}
                onchange={(e) => api('/api/settings/options', { projectorAutoOn: (e.currentTarget as HTMLInputElement).checked })}
              />
              Beamer automatisch einschalten (nur zwischen 6 und 22 Uhr)
            </label>
          </fieldset>
          <fieldset class="layoutset">
            <legend>Sichern & Wiederherstellen</legend>
            <div class="backup">
              <a class="btnlike" href={`${apiBase}/api/config/export`} download>⬇ Konfiguration herunterladen</a>
              <label class="btnlike">
                ⬆ Konfiguration importieren…
                <input type="file" accept=".json,application/json" hidden onchange={importConfigFile} />
              </label>
            </div>
            <small>
              Sichert die komplette Konfiguration (inkl. Kalibrierung) als
              <code>seitenscreens-config.json</code>. Beim Import bleibt der Server-Port erhalten;
              ein Medienordner-Pfad, den es auf diesem Rechner nicht gibt, wird nicht übernommen.
            </small>
          </fieldset>
        </div>
      </section>
    {/if}
  {/if}
</main>

<style>
  .backlink {
    color: #8ab0e8;
    font-size: 14px;
    text-decoration: none;
  }
  .backlink:hover {
    text-decoration: underline;
  }
  .small {
    font-size: 12px;
  }
  h3 {
    font-size: 14px;
    margin: 0 0 8px;
    color: #cdd2d9;
  }

  /* Upload */
  .upload {
    background: #1c1f24;
    border: 1px solid #2c313a;
    border-radius: 10px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .uploadrow {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }
  .tinput {
    flex: 1;
    min-width: 220px;
  }
  .ginput {
    min-width: 160px;
  }
  select {
    padding: 8px 10px;
    background: #14161a;
    color: #e8eaed;
    border: 1px solid #3d434c;
    border-radius: 8px;
    font-size: 14px;
  }
  .radio {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: #cdd2d9;
  }
  .sep {
    flex: 1;
  }
  .overwritehint {
    background: #4a3a1a;
    border: 1px solid #f0ad4e;
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 13px;
  }
  .formathint {
    margin: 0;
    font-size: 12px;
    color: #8a919b;
    line-height: 1.5;
  }
  .rowlabel {
    font-size: 13px;
    color: #aab0b8;
  }

  /* Inhalte-Tab */
  .grouphead {
    margin-top: 18px;
  }
  .contentlist {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .contentrow {
    display: flex;
    align-items: center;
    gap: 10px;
    background: #1c1f24;
    border: 1px solid #2c313a;
    border-radius: 8px;
    padding: 6px 10px;
  }
  .contentrow.live {
    border-color: #3a6fc4;
  }
  .minithumbs {
    display: flex;
    gap: 2px;
  }
  .minithumb {
    width: 24px;
    height: 42px;
    background: #000;
    border-radius: 3px;
    overflow: hidden;
    display: flex;
    justify-content: center;
  }
  .minithumb img {
    height: 100%;
    object-fit: cover;
  }
  .livebadge {
    font-size: 11px;
    font-weight: 700;
    color: #8ab0e8;
  }
  .layoutgrid.four {
    grid-template-columns: repeat(4, 1fr);
  }

  /* Sichern & Wiederherstellen */
  .backup {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .btnlike {
    display: inline-block;
    background: #2a2e35;
    color: #e8eaed;
    border: 1px solid #3d434c;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 14px;
    cursor: pointer;
    text-decoration: none;
  }
  .btnlike:hover {
    background: #343a43;
  }
  .settings .layoutset small {
    color: #667;
  }

  /* Vorschau */
  .preview {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
  }
  .pcol {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .ptile {
    position: relative;
    background: #000;
    border: 1px solid #2c313a;
    border-radius: 6px;
    overflow: hidden;
  }
  .ptile.dim {
    opacity: 0.25;
  }
  .ptile img,
  .ptile video {
    width: 100%;
    height: 100%;
    display: block;
  }
  .ptile .span {
    position: absolute;
    top: 0;
    max-width: none;
  }
  .plabel {
    font-size: 12px;
    color: #aab0b8;
  }

  /* Kalibrierung */
  .calactions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .calwins {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .calwinhead {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 8px;
  }
  .calwinhead h3 {
    margin: 0;
  }
  .zoomctl {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #aab0b8;
  }
  .zoomctl input[type='range'] {
    width: 160px;
  }
  .cornernum {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
  }
  .cornernum label {
    font-size: 12px;
    color: #aab0b8;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .cornernum input {
    width: 90px;
  }
  .calwin svg {
    width: 100%;
    aspect-ratio: 16 / 9;
    display: block;
    background: #0a0b0d;
    border-radius: 8px;
    touch-action: none;
  }
  .calframe {
    fill: none;
    stroke: #3d434c;
    stroke-width: 4;
  }
  .calquad {
    fill: rgba(58, 111, 196, 0.18);
    stroke: #3a6fc4;
    stroke-width: 3;
  }
  .calquad.focused {
    fill: rgba(58, 111, 196, 0.3);
  }
  .callabel {
    fill: #aab0b8;
    font-size: 64px;
    font-family: system-ui, sans-serif;
    text-anchor: middle;
    pointer-events: none;
    user-select: none;
  }
  .calhandle {
    fill: #e8eaed;
    stroke: #2b5ca8;
    stroke-width: 5;
    cursor: grab;
  }
  .calhandle.selected {
    fill: #f0f;
    stroke: #fff;
  }

  /* Anzeige */
  .dispactions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .dispgrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 12px;
  }
  .dispgrid label {
    display: block;
    font-size: 13px;
    color: #aab0b8;
    margin-bottom: 10px;
  }
  .dispgrid select {
    display: block;
    width: 100%;
    margin-top: 4px;
  }
  .rot {
    display: flex;
  }
  .placement {
    font-size: 13px;
    margin: 0 0 10px;
    color: #8fd18f;
  }
  .placement.auto {
    color: #f0ad4e;
  }
  .placement.missing {
    color: #e88;
  }
  .avoidprimary {
    margin-top: 12px;
  }

  /* Einstellungen */
  .settings {
    background: #1c1f24;
    border: 1px solid #2c313a;
    border-radius: 10px;
    padding: 16px;
    max-width: 560px;
  }
  .settings label {
    display: block;
    font-size: 13px;
    color: #aab0b8;
    margin-bottom: 12px;
  }
  /* Häkchen-Zeilen (Weihnachtsbaum-Modus, Start-Optionen): Häkchen links neben dem Text */
  .settings label.radio {
    display: flex;
    margin-bottom: 8px;
    color: #cdd2d9;
  }
  .settings label.radio input {
    display: inline-block;
    width: auto;
    margin: 0;
  }
  .settings input {
    display: block;
    width: 100%;
    box-sizing: border-box;
    margin-top: 4px;
  }
  .settings small {
    color: #667;
  }
  .layoutset {
    border: 1px solid #3d434c;
    border-radius: 8px;
    margin-bottom: 12px;
    padding: 10px;
  }
  .layoutset legend {
    font-size: 12px;
    color: #aab0b8;
    padding: 0 6px;
  }
  .layoutgrid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .layoutgrid label {
    margin-bottom: 0;
  }
  .diag {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .diagout {
    background: #0e1013;
    border: 1px solid #2c313a;
    border-radius: 8px;
    padding: 8px;
    font-size: 11px;
    max-height: 260px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .settingsfoot {
    display: flex;
    justify-content: flex-end;
    padding-top: 6px;
  }

  /* Quad-Upload: 4 Datei-Picker */
  .quadpickers {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }
  .quadpick {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #14161a;
    border: 1px solid #2c313a;
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 13px;
  }
  .qlabel {
    font-weight: 700;
    width: 28px;
    color: #aab0b8;
  }
  .quadpick input[type='file'] {
    flex: 1;
    min-width: 0;
  }

  /* Inhalte-Tab Kopf */
  .inhaltehead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
</style>

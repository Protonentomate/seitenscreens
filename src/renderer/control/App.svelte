<script lang="ts">
  import type { AppState, TemplateInfo } from '../../shared/types'
  import { SCREEN_NAMES, WINDOW_ROLES, type ScreenName } from '../../shared/screens'
  import { placementNeedsConfirmation } from '../../shared/placement'
  import { PREVIEW_FRAMES, PREVIEW_FPS } from '../../shared/preview'
  import {
    SHORT,
    LONG,
    inAppWindow,
    apiBase,
    wsUrl,
    adminUrl,
    thumbUrl,
    previewUrl,
    fmtTime,
    templateApplyPath,
    groupNames,
    groupLabel,
    singleGroup,
  } from '../lib/client'

  let state = $state<AppState | null>(null)
  let connected = $state(false)
  let banner = $state<{ kind: 'error' | 'ok'; text: string } | null>(null)
  let bannerTimer: ReturnType<typeof setTimeout> | null = null

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

  // --- Vorlagen-Gruppen (Tabs) ---

  const groups = $derived(state ? groupNames(state.mediaIndex.templates, state.mediaIndex.singles, state.defaultGroup) : [])
  let selectedGroup = $state<string | null>(null)
  // Start-Tab: die konfigurierte Standard-Gruppe (steht vorne), sonst die
  // erste — einmalig, danach bleibt die Auswahl des Anwenders bestehen
  $effect(() => {
    if (selectedGroup === null && groups.length > 0) {
      selectedGroup = groups[0]
    }
    // Gewählte Gruppe verschwunden (Ordner umbenannt) → zurück auf die erste
    if (selectedGroup !== null && groups.length > 0 && !groups.includes(selectedGroup)) {
      selectedGroup = groups[0]
    }
  })
  const visibleTemplates = $derived(
    state ? state.mediaIndex.templates.filter((t) => t.group === (selectedGroup ?? '')) : [],
  )
  const visibleSingles = $derived(
    state ? state.mediaIndex.singles.filter((s) => singleGroup(s.file) === (selectedGroup ?? '')) : [],
  )

  // Erfolg braucht keine Meldung: die Karte zeigt „Aktiv" und „Live" wechselt.
  // Nur Fehler erscheinen — als schwebende Meldung, ohne dass etwas verrutscht.
  async function applyTemplate(t: TemplateInfo): Promise<void> {
    const path = templateApplyPath(t)
    if (!t.complete) {
      if (!confirm(`„${t.name}" ist unvollständig (${t.warnings[0] ?? ''}).\nNur die vorhandenen Leinwände wechseln?`)) return
      await api(`${path}?force=1`)
      return
    }
    await api(path)
  }

  async function setSingle(file: string, screen: ScreenName | 'alle'): Promise<void> {
    const encoded = encodeURIComponent(file)
    if (screen === 'alle') {
      // Ein Batch-Aufruf → eine gemeinsame Epoche → Videos laufen synchron
      await api(`/api/screens/set?file=${encoded}&screens=all`)
    } else {
      await api(`/api/screen/${screen}/set?file=${encoded}`)
    }
  }

  const POWER_LABEL: Record<string, string> = {
    on: 'an',
    off: 'aus',
    warming: 'startet …',
    cooling: 'kühlt ab …',
    offline: 'offline',
    unknown: '?',
    error: '!',
  }

  // --- Vorschau beim Drüberfahren (Videos im Zeitraffer) ---
  // Maus: abspielen, solange sie über den Bildern ist. Touch/Tastatur: antippen
  // schaltet ein/aus (auf dem Handy gibt es kein Hover).
  let previewKey = $state<string | null>(null)
  const spriteStyle = `background-size:${PREVIEW_FRAMES * 100}% 100%;animation-duration:${PREVIEW_FRAMES / PREVIEW_FPS}s;animation-timing-function:steps(${PREVIEW_FRAMES}, jump-none)`
  function previewEnter(e: PointerEvent, key: string): void {
    if (e.pointerType === 'mouse') previewKey = key
  }
  function previewLeave(e: PointerEvent, key: string): void {
    if (e.pointerType === 'mouse' && previewKey === key) previewKey = null
  }
  function previewTap(e: PointerEvent, key: string): void {
    if (e.pointerType !== 'mouse') previewKey = previewKey === key ? null : key
  }
  function previewKeydown(e: KeyboardEvent, key: string): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      previewKey = previewKey === key ? null : key
    }
  }

  // --- Beamer-Fenster: fehlt ein Beamer, oder ist die Verteilung unbestätigt? ---

  const missingBeamers = $derived(
    state && !state.simulator ? WINDOW_ROLES.filter((r) => state!.windowPlacement[r].reason === 'missing') : [],
  )
  const placementUnconfirmed = $derived(
    state && !state.simulator ? placementNeedsConfirmation(state.windowPlacement) : false,
  )

  // --- Video-Steuerung (global, ein Regler für alle Leinwände) ---

  const videoContents = $derived(
    state ? Object.values(state.screens).filter((c) => c?.kind === 'video' && c.epochMs !== undefined) : [],
  )
  const videoDuration = $derived(Math.max(0, ...videoContents.map((c) => c?.durationS ?? 0)))
  let videoPosition = $state(0)
  let sliderDragging = $state(false)

  // Position tickt lokal aus Epoche+Uhr — kein Server-Polling nötig
  $effect(() => {
    if (videoContents.length === 0 || videoDuration <= 0) return
    const tick = () => {
      if (sliderDragging || !state) return
      const first = videoContents[0]
      if (!first?.epochMs) return
      const ref = state.videoPaused && state.videoPausedAtMs ? state.videoPausedAtMs : Date.now()
      const pos = ((ref - first.epochMs) / 1000) % videoDuration
      videoPosition = pos < 0 ? pos + videoDuration : pos
    }
    tick()
    const interval = setInterval(tick, 250)
    return () => clearInterval(interval)
  })

  async function seekTo(toS: number): Promise<void> {
    await api(`/api/video/seek?toS=${toS.toFixed(2)}`)
  }
</script>

<!-- Die 4 Leinwand-Bilder einer Vorlage; bei laufender Vorschau mit Filmstreifen -->
{#snippet templateTiles(t: TemplateInfo)}
  {#each SCREEN_NAMES as screen (screen)}
    {@const f = t.files[screen]}
    <div class="thumb" class:missing={!f}>
      {#if f}<img src={thumbUrl(f)} alt={SHORT[screen]} loading="lazy" />{/if}
      {#if f?.kind === 'video' && previewKey === t.ref}
        <div class="sprite" style="background-image:url('{previewUrl(f.file)}');{spriteStyle}"></div>
      {/if}
    </div>
  {/each}
{/snippet}

<main>
  <header>
    <h1>Seitenscreens</h1>
    <span class="dot" class:on={connected} title={connected ? 'Verbunden' : 'Getrennt'}></span>
    <div class="spacer"></div>
    <a class="adminlink" href={adminUrl}>Verwaltung →</a>
  </header>

  {#if banner}
    <div class="toast {banner.kind}" role="status">{banner.text}</div>
  {/if}

  {#if !state}
    <p class="muted">Verbinde…</p>
  {:else}
    {#if inAppWindow}
      <!-- Statusfenster der App: zeigt, dass es läuft und wo man es sonst erreicht -->
      <p class="appinfo">
        Seitenscreens läuft.
        {#if state.serverUrls?.length}
          Handy/Tablet: {#each state.serverUrls as url, i (url)}{i > 0 ? ' · ' : ''}<strong>{url}</strong>{/each}.
        {/if}
        Dieses Fenster darf man schliessen, die Leinwände laufen weiter.
      </p>
    {/if}

    {#if state.disabledScreens?.length}
      <div class="banner warn">
        🎄 Weihnachtsbaum-Modus: {state.disabledScreens.length === 1 ? 'Leinwand' : 'Leinwände'}
        {state.disabledScreens.map((s) => LONG[s]).join(', ')}
        {state.disabledScreens.length === 1 ? 'ist' : 'sind'} ausgeschaltet und
        {state.disabledScreens.length === 1 ? 'bleibt' : 'bleiben'} schwarz.
        <a href={`${adminUrl}#einstellungen`}>Aufheben unter Verwaltung → Einstellungen</a>
      </div>
    {/if}

    {#if !state.mediaIndex.mediaRootExists}
      <div class="banner error">
        Medienordner nicht gefunden{state.mediaRoot ? `: ${state.mediaRoot}` : ' (nicht konfiguriert)'} — in der
        „Verwaltung" den Pfad zum Nextcloud-Ordner „_Vorlagen" setzen.
      </div>
    {/if}

    {#if missingBeamers.length > 0}
      <div class="banner warn">
        {missingBeamers.length === 2 ? 'Keine Beamer erkannt' : `Beamer ${missingBeamers[0]} nicht erkannt`} —
        {missingBeamers.length === 2 ? 'die Fenster erscheinen' : 'das Fenster erscheint'} automatisch, sobald der Beamer
        angeschlossen bzw. eingeschaltet ist. <a href={`${adminUrl}#anzeige`}>Anzeige prüfen</a>
      </div>
    {/if}
    {#if placementUnconfirmed}
      <div class="banner warn confirmbar">
        <span>
          Die Beamer-Fenster wurden automatisch verteilt. Stimmen links und rechts? Auf den Leinwänden steht kurz
          „links" bzw. „rechts".
        </span>
        <span class="confirmbtns">
          <button class="mini primary" onclick={() => api('/api/display/confirm')}>Ja, stimmt</button>
          <button class="mini" onclick={() => api('/api/display/swap')}>Links ↔ rechts tauschen</button>
          <button class="mini" onclick={() => api('/api/display/identify')}>Nochmals anzeigen</button>
        </span>
      </div>
    {/if}

    <section class="actions">
      <button
        class="big"
        class:danger={state.blackout}
        onclick={() => api(`/api/blackout/${state?.blackout ? 'off' : 'on'}`)}
      >
        {state.blackout ? '■ Blackout aktiv — aufheben' : 'Blackout'}
      </button>
      <button class:active={state.testPattern} onclick={() => api(`/api/testpattern/${state?.testPattern ? 'off' : 'on'}`)}>
        Testbild
      </button>
      <div class="spacer"></div>
      {#each state.projectors as p (p.id)}
        <div class="projector" title={p.lastMessage || p.host}>
          <span class="pname">{p.name}</span>
          <span class="pstate {p.power}">{POWER_LABEL[p.power] ?? p.power}</span>
          <button onclick={() => api(`/api/projector/${p.id}/on`)}>Ein</button>
          <button onclick={() => api(`/api/projector/${p.id}/off`)}>Aus</button>
        </div>
      {/each}
    </section>

    <!-- Immer da (ohne Video nur ausgegraut): sonst springt die ganze Seite,
         sobald man zwischen Bild- und Video-Vorlagen wechselt -->
    {@const hasLiveVideo = videoContents.length > 0 && videoDuration > 0}
    <section class="videobar" class:idle={!hasLiveVideo}>
      <button class="big" disabled={!hasLiveVideo} onclick={() => api('/api/video/toggle')}>
        {state.videoPaused && hasLiveVideo ? '▶ Weiter' : '⏸ Pause'}
      </button>
      <input
        class="seek"
        type="range"
        min="0"
        max={hasLiveVideo ? videoDuration : 1}
        step="0.05"
        disabled={!hasLiveVideo}
        bind:value={videoPosition}
        onpointerdown={() => (sliderDragging = true)}
        onchange={() => {
          void seekTo(videoPosition)
          sliderDragging = false
        }}
      />
      <span class="vtime">
        {hasLiveVideo ? `${fmtTime(videoPosition)} / ${fmtTime(videoDuration)}` : 'Kein Video live'}
      </span>
    </section>

    <section>
      <h2>Live {state.activeTemplate ? `— ${state.activeTemplate}` : ''}</h2>
      <div class="live">
        {#each SCREEN_NAMES as screen (screen)}
          {@const content = state.screens[screen]}
          <!-- Kompakt: nur Kürzel, Dateiname als Tooltip (passt so auch aufs Handy) -->
          {@const off = state.disabledScreens?.includes(screen) ?? false}
          <div
            class="tile"
            title={off
              ? `${SHORT[screen]}: ausgeschaltet (Weihnachtsbaum-Modus)`
              : content
                ? `${SHORT[screen]}: ${content.file}`
                : `${SHORT[screen]}: leer`}
          >
            <div class="frame" class:black={!content || state.blackout || off}>
              {#if off}
                <span class="offlabel">aus</span>
              {:else if content && !state.blackout}
                <img src={thumbUrl(content)} alt={content.file} />
                {#if content.kind === 'video'}<span class="vbadge">▶</span>{/if}
              {/if}
            </div>
            <div class="sname">{SHORT[screen]}</div>
          </div>
        {/each}
      </div>
    </section>

    <section>
      <h2>Vorlagen</h2>
      {#if groups.length > 1}
        <div class="tabs">
          {#each groups as g (g)}
            <button class:selected={selectedGroup === g} onclick={() => (selectedGroup = g)}>{groupLabel(g)}</button>
          {/each}
        </div>
      {/if}
      {#if state.mediaIndex.templates.length === 0}
        <p class="muted">Keine Vorlagen gefunden.</p>
      {/if}
      <div class="grid">
        {#each visibleTemplates as t (t.ref)}
          {@const hasVideo = SCREEN_NAMES.some((sc) => t.files[sc]?.kind === 'video')}
          <div class="card" class:current={state.activeTemplate === t.ref}>
            {#if hasVideo}
              <div
                class="thumbs previewable"
                role="button"
                tabindex="0"
                aria-label={`Vorschau ${t.name}`}
                title="Maus drüber (oder antippen) = Vorschau im Zeitraffer"
                onpointerenter={(e) => previewEnter(e, t.ref)}
                onpointerleave={(e) => previewLeave(e, t.ref)}
                onpointerup={(e) => previewTap(e, t.ref)}
                onkeydown={(e) => previewKeydown(e, t.ref)}
              >
                {@render templateTiles(t)}
              </div>
            {:else}
              <div class="thumbs">{@render templateTiles(t)}</div>
            {/if}
            <div class="cardfoot">
              <span class="tname" title={t.ref}>{t.name}</span>
              {#if t.warnings.length > 0}
                <span class="warn" title={t.warnings.join('\n')}>⚠</span>
              {/if}
              <button class="primary" onclick={() => applyTemplate(t)}>
                {state.activeTemplate === t.ref ? 'Aktiv' : 'Anwenden'}
              </button>
            </div>
          </div>
        {/each}
      </div>
    </section>

    <section>
      <h2>Einzelbilder {selectedGroup ? `— ${groupLabel(selectedGroup)}` : ''}</h2>
      {#if visibleSingles.length === 0}
        <p class="muted">Keine losen Dateien in dieser Gruppe.</p>
      {/if}
      <div class="grid singles">
        {#each visibleSingles as s (s.file)}
          <div class="card">
            {#if s.kind === 'video'}
              <div
                class="singlethumb previewable"
                role="button"
                tabindex="0"
                aria-label={`Vorschau ${s.file}`}
                title="Maus drüber (oder antippen) = Vorschau im Zeitraffer"
                onpointerenter={(e) => previewEnter(e, s.file)}
                onpointerleave={(e) => previewLeave(e, s.file)}
                onpointerup={(e) => previewTap(e, s.file)}
                onkeydown={(e) => previewKeydown(e, s.file)}
              >
                <img src={thumbUrl(s)} alt={s.file} loading="lazy" />
                {#if previewKey === s.file}
                  <div class="sprite" style="background-image:url('{previewUrl(s.file)}');{spriteStyle}"></div>
                {/if}
              </div>
            {:else}
              <div class="singlethumb"><img src={thumbUrl(s)} alt={s.file} loading="lazy" /></div>
            {/if}
            <div class="cardfoot">
              <span class="tname" title={s.file}>{s.file}</span>
            </div>
            <div class="assign">
              {#each SCREEN_NAMES as screen (screen)}
                <button class="mini" onclick={() => setSingle(s.file, screen)}>{SHORT[screen]}</button>
              {/each}
              <button class="mini primary" onclick={() => setSingle(s.file, 'alle')}>Alle</button>
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}
</main>

<style>
  .adminlink {
    color: #8ab0e8;
    font-size: 14px;
    text-decoration: none;
  }
  .adminlink:hover {
    text-decoration: underline;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .videobar {
    display: flex;
    align-items: center;
    gap: 12px;
    background: #1c1f24;
    border: 1px solid #2c313a;
    border-radius: 10px;
    padding: 10px 14px;
    margin-top: 14px;
  }
  .seek {
    flex: 1;
    accent-color: #3a6fc4;
  }
  .videobar.idle {
    opacity: 0.45;
  }
  .videobar button:disabled,
  .videobar input:disabled {
    cursor: default;
  }
  .vtime {
    font-size: 13px;
    color: #aab0b8;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .projector {
    display: flex;
    align-items: center;
    gap: 6px;
    background: #1c1f24;
    border: 1px solid #2c313a;
    border-radius: 8px;
    padding: 6px 10px;
  }
  .pname {
    font-size: 13px;
    color: #aab0b8;
  }
  .pstate {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 10px;
    background: #333;
  }
  .pstate.on {
    background: #2e7d32;
  }
  .pstate.off {
    background: #555;
  }
  .pstate.error {
    background: #a83232;
  }
  .pstate.warming,
  .pstate.cooling {
    background: #8a6200;
  }
  .pstate.offline {
    background: transparent;
    border: 1px dashed #777;
    color: #aaa;
  }

  /* Vier kleine Leinwände in einer Reihe, Lücke in der Mitte wie zwischen
     den Beamern; minmax(0, …) verhindert, dass Inhalt die Spalten aufdrückt */
  .live {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr)) 14px repeat(2, minmax(0, 1fr));
    gap: 6px;
    max-width: 440px;
  }
  .live .tile:nth-child(3) {
    grid-column: 4;
  }
  .tile .frame {
    aspect-ratio: 9 / 16;
    background: #000;
    border: 1px solid #2c313a;
    border-radius: 6px;
    overflow: hidden;
    position: relative;
  }
  .tile .frame img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .offlabel {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #888;
    font-size: 12px;
    border: 1px dashed #444;
    border-radius: 6px;
  }
  .appinfo {
    margin: 0 0 12px;
    padding: 8px 12px;
    border-radius: 8px;
    background: #1b2a1d;
    color: #b9d9bd;
    font-size: 13px;
  }
  .vbadge {
    position: absolute;
    top: 4px;
    right: 4px;
    background: rgba(0, 0, 0, 0.7);
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 5px;
  }
  .sname {
    font-weight: 700;
    font-size: 12px;
    text-align: center;
    padding-top: 3px;
  }

  /* Hover-Vorschau: Filmstreifen über dem Standbild, per steps() durchgeblättert */
  .previewable {
    cursor: zoom-in;
  }
  .thumb,
  .singlethumb {
    position: relative;
  }
  .sprite {
    position: absolute;
    inset: 0;
    background-repeat: no-repeat;
    background-position: 0 0;
    animation-name: filmstrip;
    animation-iteration-count: infinite;
  }
  @keyframes filmstrip {
    from {
      background-position: 0% 0;
    }
    to {
      background-position: 100% 0;
    }
  }

  .singles .singlethumb {
    aspect-ratio: 9 / 16;
    max-height: 180px;
    display: flex;
    justify-content: center;
    background: #000;
    border-radius: 6px;
    overflow: hidden;
  }
  .singlethumb img {
    height: 100%;
    object-fit: cover;
  }
  .assign {
    display: flex;
    gap: 4px;
    padding-top: 8px;
  }
</style>

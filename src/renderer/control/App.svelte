<script lang="ts">
  import type { AppState, MediaFileInfo, TemplateInfo } from '../../shared/types'
  import { SCREEN_NAMES, type ScreenName } from '../../shared/screens'

  /** Kurzlabels für die Leinwände, wie sie das Team kennt. */
  const SHORT: Record<ScreenName, string> = {
    LinksLinks: 'LL',
    LinksRechts: 'LR',
    RechtsLinks: 'RL',
    RechtsRechts: 'RR',
  }

  // Im Dev-Modus läuft die Seite auf dem Vite-Server, die API auf 8080
  const apiBase = import.meta.env.DEV ? 'http://localhost:8080' : ''
  const wsUrl = import.meta.env.DEV
    ? 'ws://localhost:8080/ws'
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

  let state = $state<AppState | null>(null)
  let connected = $state(false)
  let banner = $state<{ kind: 'error' | 'ok'; text: string } | null>(null)
  let bannerTimer: ReturnType<typeof setTimeout> | null = null
  let showSettings = $state(false)

  // Einstellungs-Formular
  let formMediaRoot = $state('')
  let formTransitionMs = $state(300)
  let formHostLinks = $state('')
  let formHostRechts = $state('')

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

  function mediaUrl(file: string): string {
    return `${apiBase}/media/${file.split('/').map(encodeURIComponent).join('/')}`
  }

  function thumbUrl(info: MediaFileInfo | { file: string; kind: string }): string {
    if (info.kind === 'video') {
      return `${apiBase}/thumbs/${info.file.split('/').map(encodeURIComponent).join('/')}`
    }
    return mediaUrl(info.file)
  }

  async function applyTemplate(t: TemplateInfo): Promise<void> {
    const name = encodeURIComponent(t.name)
    if (!t.complete) {
      if (!confirm(`„${t.name}" ist unvollständig (${t.warnings[0] ?? ''}).\nNur die vorhandenen Leinwände wechseln?`)) return
      if (await api(`/api/template/${name}/apply?force=1`)) showBanner('ok', `„${t.name}" angewendet (teilweise)`)
      return
    }
    if (await api(`/api/template/${name}/apply`)) showBanner('ok', `„${t.name}" angewendet`)
  }

  async function setSingle(file: string, screen: ScreenName | 'alle'): Promise<void> {
    const encoded = encodeURIComponent(file)
    if (screen === 'alle') {
      // Ein Batch-Aufruf → eine gemeinsame Epoche → Videos laufen synchron
      if (await api(`/api/screens/set?file=${encoded}&screens=all`)) {
        showBanner('ok', `${file} auf allen Leinwänden`)
      }
    } else {
      if (await api(`/api/screen/${screen}/set?file=${encoded}`)) showBanner('ok', `${file} auf ${SHORT[screen]}`)
    }
  }

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

  function fmtTime(s: number): string {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  async function seekTo(toS: number): Promise<void> {
    await api(`/api/video/seek?toS=${toS.toFixed(2)}`)
  }

  function openSettings(): void {
    if (!state) return
    formMediaRoot = state.mediaRoot
    formTransitionMs = state.transitionMs
    formHostLinks = state.projectors.find((p) => p.id === 'links')?.host ?? ''
    formHostRechts = state.projectors.find((p) => p.id === 'rechts')?.host ?? ''
    showSettings = true
  }

  async function saveSettings(): Promise<void> {
    const ok = await api('/api/config', {
      mediaRoot: formMediaRoot,
      transitionMs: formTransitionMs,
      projectors: [
        { id: 'links', host: formHostLinks },
        { id: 'rechts', host: formHostRechts },
      ],
    })
    if (ok) {
      showBanner('ok', 'Einstellungen gespeichert')
      showSettings = false
    }
  }
</script>

<main>
  <header>
    <h1>Seitenscreens</h1>
    <span class="dot" class:on={connected} title={connected ? 'Verbunden' : 'Getrennt'}></span>
    <div class="spacer"></div>
    <button class="ghost" onclick={openSettings}>⚙︎ Einstellungen</button>
  </header>

  {#if banner}
    <div class="banner {banner.kind}">{banner.text}</div>
  {/if}

  {#if !state}
    <p class="muted">Verbinde…</p>
  {:else}
    {#if !state.mediaIndex.mediaRootExists}
      <div class="banner error">
        Medienordner nicht gefunden{state.mediaRoot ? `: ${state.mediaRoot}` : ' (nicht konfiguriert)'} — unter
        „Einstellungen" den Pfad zum Nextcloud-Ordner „_Vorlagen" setzen.
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
          <span class="pstate {p.power}">{p.power === 'unknown' ? '?' : p.power === 'error' ? '!' : p.power}</span>
          <button onclick={() => api(`/api/projector/${p.id}/on`)}>Ein</button>
          <button onclick={() => api(`/api/projector/${p.id}/off`)}>Aus</button>
        </div>
      {/each}
    </section>

    {#if videoContents.length > 0 && videoDuration > 0}
      <section class="videobar">
        <button class="big" onclick={() => api('/api/video/toggle')}>
          {state.videoPaused ? '▶ Weiter' : '⏸ Pause'}
        </button>
        <input
          class="seek"
          type="range"
          min="0"
          max={videoDuration}
          step="0.05"
          bind:value={videoPosition}
          onpointerdown={() => (sliderDragging = true)}
          onchange={() => {
            void seekTo(videoPosition)
            sliderDragging = false
          }}
        />
        <span class="vtime">{fmtTime(videoPosition)} / {fmtTime(videoDuration)}</span>
      </section>
    {/if}

    <section>
      <h2>Live {state.activeTemplate ? `— ${state.activeTemplate}` : ''}</h2>
      <div class="live">
        {#each SCREEN_NAMES as screen (screen)}
          {@const content = state.screens[screen]}
          <div class="tile">
            <div class="frame" class:black={!content || state.blackout}>
              {#if content && !state.blackout}
                <img src={thumbUrl(content)} alt={content.file} />
                {#if content.kind === 'video'}<span class="vbadge">▶ Video</span>{/if}
              {/if}
            </div>
            <div class="tilefoot">
              <span class="sname">{SHORT[screen]}</span>
              <span class="fname">{content?.file ?? '—'}</span>
            </div>
          </div>
        {/each}
      </div>
    </section>

    <section>
      <h2>Vorlagen</h2>
      {#if state.mediaIndex.templates.length === 0}
        <p class="muted">Keine Vorlagen gefunden.</p>
      {/if}
      <div class="grid">
        {#each state.mediaIndex.templates as t (t.name)}
          <div class="card" class:current={state.activeTemplate === t.name}>
            <div class="thumbs">
              {#each SCREEN_NAMES as screen (screen)}
                {@const f = t.files[screen]}
                <div class="thumb" class:missing={!f}>
                  {#if f}<img src={thumbUrl(f)} alt={SHORT[screen]} loading="lazy" />{/if}
                </div>
              {/each}
            </div>
            <div class="cardfoot">
              <span class="tname" title={t.name}>{t.name}</span>
              {#if t.warnings.length > 0}
                <span class="warn" title={t.warnings.join('\n')}>⚠</span>
              {/if}
              <button class="primary" onclick={() => applyTemplate(t)}>
                {state.activeTemplate === t.name ? 'Aktiv' : 'Anwenden'}
              </button>
            </div>
          </div>
        {/each}
      </div>
    </section>

    <section>
      <h2>Einzelbilder</h2>
      {#if state.mediaIndex.singles.length === 0}
        <p class="muted">Keine losen Dateien im Ordner.</p>
      {/if}
      <div class="grid singles">
        {#each state.mediaIndex.singles as s (s.file)}
          <div class="card">
            <div class="singlethumb"><img src={thumbUrl(s)} alt={s.file} loading="lazy" /></div>
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

  {#if showSettings}
    <div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && (showSettings = false)}>
      <div class="dialog">
        <h2>Einstellungen</h2>
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
        <div class="dialogfoot">
          <button onclick={() => (showSettings = false)}>Abbrechen</button>
          <button class="primary" onclick={saveSettings}>Speichern</button>
        </div>
      </div>
    </div>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: #14161a;
    color: #e8eaed;
    font-family: system-ui, -apple-system, sans-serif;
  }
  main {
    max-width: 1100px;
    margin: 0 auto;
    padding: 12px 16px 48px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0 12px;
  }
  h1 {
    font-size: 20px;
    margin: 0;
  }
  h2 {
    font-size: 15px;
    margin: 22px 0 10px;
    color: #aab0b8;
    font-weight: 600;
  }
  .spacer {
    flex: 1;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #d9534f;
  }
  .dot.on {
    background: #4caf50;
  }
  .banner {
    padding: 10px 14px;
    border-radius: 8px;
    margin-bottom: 10px;
    font-size: 14px;
  }
  .banner.error {
    background: #5a2320;
    border: 1px solid #a94442;
  }
  .banner.ok {
    background: #1e4620;
    border: 1px solid #3c763d;
  }
  .muted {
    color: #777;
  }

  button {
    background: #2a2e35;
    color: #e8eaed;
    border: 1px solid #3d434c;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 14px;
    cursor: pointer;
  }
  button:hover {
    background: #343a43;
  }
  button.primary {
    background: #2b5ca8;
    border-color: #3a6fc4;
  }
  button.primary:hover {
    background: #336ac0;
  }
  button.danger {
    background: #a83232;
    border-color: #c44;
  }
  button.big {
    font-size: 16px;
    padding: 12px 22px;
    font-weight: 600;
  }
  button.active {
    background: #2b5ca8;
  }
  button.ghost {
    background: transparent;
    border-color: transparent;
  }
  button.mini {
    padding: 4px 8px;
    font-size: 12px;
    border-radius: 6px;
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

  .live {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
  }
  @media (max-width: 700px) {
    .live {
      grid-template-columns: repeat(2, 1fr);
    }
  }
  .tile .frame {
    aspect-ratio: 9 / 16;
    background: #000;
    border: 1px solid #2c313a;
    border-radius: 8px;
    overflow: hidden;
    position: relative;
    max-height: 240px;
    display: flex;
    justify-content: center;
  }
  .tile .frame img {
    height: 100%;
    object-fit: cover;
  }
  .vbadge {
    position: absolute;
    top: 6px;
    right: 6px;
    background: rgba(0, 0, 0, 0.7);
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 6px;
  }
  .tilefoot {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 4px;
    font-size: 12px;
  }
  .sname {
    font-weight: 700;
  }
  .fname {
    color: #888;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 12px;
  }
  .card {
    background: #1c1f24;
    border: 1px solid #2c313a;
    border-radius: 10px;
    padding: 10px;
  }
  .card.current {
    border-color: #3a6fc4;
    box-shadow: 0 0 0 1px #3a6fc4;
  }
  .thumbs {
    display: flex;
    gap: 4px;
  }
  .thumb {
    flex: 1;
    aspect-ratio: 9 / 16;
    background: #000;
    border-radius: 4px;
    overflow: hidden;
    display: flex;
    justify-content: center;
  }
  .thumb.missing {
    background: repeating-linear-gradient(45deg, #222, #222 6px, #2a2a2a 6px, #2a2a2a 12px);
  }
  .thumb img {
    height: 100%;
    object-fit: cover;
  }
  .cardfoot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 8px;
  }
  .tname {
    flex: 1;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .warn {
    color: #f0ad4e;
    cursor: help;
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

  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
  }
  .dialog {
    background: #1c1f24;
    border: 1px solid #2c313a;
    border-radius: 12px;
    padding: 20px;
    width: min(480px, 92vw);
  }
  .dialog h2 {
    margin-top: 0;
  }
  .dialog label {
    display: block;
    font-size: 13px;
    color: #aab0b8;
    margin-bottom: 12px;
  }
  .dialog input {
    display: block;
    width: 100%;
    box-sizing: border-box;
    margin-top: 4px;
    padding: 8px 10px;
    background: #14161a;
    color: #e8eaed;
    border: 1px solid #3d434c;
    border-radius: 8px;
    font-size: 14px;
  }
  .dialog small {
    color: #667;
  }
  .dialogfoot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 6px;
  }
</style>

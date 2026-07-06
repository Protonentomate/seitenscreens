<script lang="ts">
  import type { AppState, TemplateInfo } from '../../shared/types'
  import { SCREEN_NAMES, type ScreenName } from '../../shared/screens'
  import {
    SHORT,
    apiBase,
    wsUrl,
    adminUrl,
    thumbUrl,
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

  async function applyTemplate(t: TemplateInfo): Promise<void> {
    const path = templateApplyPath(t)
    if (!t.complete) {
      if (!confirm(`„${t.name}" ist unvollständig (${t.warnings[0] ?? ''}).\nNur die vorhandenen Leinwände wechseln?`)) return
      if (await api(`${path}?force=1`)) showBanner('ok', `„${t.name}" angewendet (teilweise)`)
      return
    }
    if (await api(path)) showBanner('ok', `„${t.name}" angewendet`)
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

  async function seekTo(toS: number): Promise<void> {
    await api(`/api/video/seek?toS=${toS.toFixed(2)}`)
  }
</script>

<main>
  <header>
    <h1>Seitenscreens</h1>
    <span class="dot" class:on={connected} title={connected ? 'Verbunden' : 'Getrennt'}></span>
    <div class="spacer"></div>
    <a class="adminlink" href={adminUrl}>Verwaltung →</a>
  </header>

  {#if banner}
    <div class="banner {banner.kind}">{banner.text}</div>
  {/if}

  {#if !state}
    <p class="muted">Verbinde…</p>
  {:else}
    {#if !state.mediaIndex.mediaRootExists}
      <div class="banner error">
        Medienordner nicht gefunden{state.mediaRoot ? `: ${state.mediaRoot}` : ' (nicht konfiguriert)'} — in der
        „Verwaltung" den Pfad zum Nextcloud-Ordner „_Vorlagen" setzen.
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
          <div class="card" class:current={state.activeTemplate === t.ref}>
            <div class="thumbs">
              {#each SCREEN_NAMES as screen (screen)}
                {@const f = t.files[screen]}
                <div class="thumb" class:missing={!f}>
                  {#if f}<img src={thumbUrl(f)} alt={SHORT[screen]} loading="lazy" />{/if}
                </div>
              {/each}
            </div>
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

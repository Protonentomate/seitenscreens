// Stream-Deck-Plugin „Seitenscreens" (klassische SDK, reines JS).
// Pro Knopf konfiguriert man Basis-URL + Vorlagen-Referenz (z.B. "Pfimi/Welcome").
// - keyDown → wendet die Vorlage an (/api/template/.../apply)
// - im Hintergrund → lädt /api/button/... und setzt es als Knopf-Bild,
//   damit die Vorschau automatisch aktuell bleibt (Poll + direkt nach dem Anwenden).

let ws = null
const contexts = new Map() // context → { timer }

// Wird von der Stream-Deck-Software aufgerufen (Registrierungs-Handshake).
function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent) {
  ws = new WebSocket('ws://127.0.0.1:' + inPort)
  ws.onopen = () => ws.send(JSON.stringify({ event: inRegisterEvent, uuid: inUUID }))
  ws.onmessage = (e) => {
    let msg
    try {
      msg = JSON.parse(e.data)
    } catch {
      return
    }
    const { event, context, payload } = msg
    if (event === 'willAppear' || event === 'didReceiveSettings') start(context, payload && payload.settings)
    else if (event === 'willDisappear') stop(context)
    else if (event === 'keyDown') apply(context, payload && payload.settings)
  }
}
// Stream Deck sucht die Funktion global:
window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket

function cfg(settings) {
  const s = settings || {}
  return {
    base: (s.base || '').replace(/\/+$/, ''),
    ref: s.ref || '',
    apply: s.apply !== false,
    interval: Math.max(3, Number(s.interval) || 15),
    size: Number(s.size) || 144,
  }
}

// "Gruppe/Name" → "Gruppe/Name" mit je-Segment-URL-Kodierung (passt zu den Routen)
function refPath(ref) {
  return ref
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

function start(context, settings) {
  stop(context)
  const c = cfg(settings)
  const entry = {}
  contexts.set(context, entry)
  if (!c.base || !c.ref) return
  const tick = () => refreshImage(context, c)
  tick()
  entry.timer = setInterval(tick, c.interval * 1000)
}

function stop(context) {
  const e = contexts.get(context)
  if (e && e.timer) clearInterval(e.timer)
  contexts.delete(context)
}

async function refreshImage(context, c) {
  try {
    // Cache-Buster (&t=), damit ein geänderter Vorlagen-Inhalt sicher neu geladen wird
    const url = `${c.base}/api/button/${refPath(c.ref)}?format=png&size=${c.size}&t=${Date.now()}`
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return
    const dataUri = await blobToDataUri(await res.blob())
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ event: 'setImage', context, payload: { image: dataUri, target: 0 } }))
    }
  } catch {
    // Server/Netz nicht erreichbar → Bild einfach nicht aktualisieren
  }
}

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = reject
    r.readAsDataURL(blob)
  })
}

async function apply(context, settings) {
  const c = cfg(settings)
  if (!c.base || !c.ref || !c.apply) return
  try {
    await fetch(`${c.base}/api/template/${refPath(c.ref)}/apply`, { cache: 'no-store' })
    refreshImage(context, c) // kurz danach auffrischen
  } catch {
    // ignorieren — der nächste Poll aktualisiert das Bild
  }
}

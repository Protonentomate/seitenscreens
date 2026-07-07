// Property Inspector: liest/speichert die Knopf-Einstellungen (base, ref, apply, interval).
let piWs = null
let piContext = null

function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, _inInfo, inActionInfo) {
  piContext = inUUID
  let info = {}
  try {
    info = JSON.parse(inActionInfo)
  } catch {
    info = {}
  }
  const s = (info.payload && info.payload.settings) || {}

  piWs = new WebSocket('ws://127.0.0.1:' + inPort)
  piWs.onopen = () => {
    piWs.send(JSON.stringify({ event: inRegisterEvent, uuid: inUUID }))
    el('base').value = s.base || ''
    el('ref').value = s.ref || ''
    el('interval').value = s.interval || 15
    el('apply').checked = s.apply !== false
  }

  for (const id of ['base', 'ref', 'interval']) el(id).addEventListener('input', save)
  el('apply').addEventListener('change', save)
}
window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket

function el(id) {
  return document.getElementById(id)
}

function save() {
  if (!piWs || piWs.readyState !== 1) return
  const settings = {
    base: el('base').value.trim(),
    ref: el('ref').value.trim(),
    interval: Number(el('interval').value) || 15,
    apply: el('apply').checked,
  }
  piWs.send(JSON.stringify({ event: 'setSettings', context: piContext, payload: settings }))
}

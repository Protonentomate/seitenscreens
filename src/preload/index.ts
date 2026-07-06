import { contextBridge, ipcRenderer } from 'electron'
import type { AppState } from '../shared/types'

export interface PlayerBridge {
  ready(): void
  onState(callback: (state: AppState) => void): void
  onIdentify(callback: () => void): void
  syncStats(payload: unknown): void
}

const bridge: PlayerBridge = {
  ready() {
    ipcRenderer.send('player:ready')
  },
  onState(callback) {
    ipcRenderer.on('state', (_event, state: AppState) => callback(state))
  },
  onIdentify(callback) {
    ipcRenderer.on('identify', () => callback())
  },
  syncStats(payload) {
    ipcRenderer.send('player:syncstats', payload)
  },
}

contextBridge.exposeInMainWorld('player', bridge)

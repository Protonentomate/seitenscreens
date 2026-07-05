import { contextBridge, ipcRenderer } from 'electron'
import type { AppState } from '../shared/types'

export interface PlayerBridge {
  ready(): void
  onState(callback: (state: AppState) => void): void
}

const bridge: PlayerBridge = {
  ready() {
    ipcRenderer.send('player:ready')
  },
  onState(callback) {
    ipcRenderer.on('state', (_event, state: AppState) => callback(state))
  },
}

contextBridge.exposeInMainWorld('player', bridge)

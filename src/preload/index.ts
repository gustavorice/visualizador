import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AnalyzeRequest } from '@shared/ipc'
import type {
  AnalysisEvent,
  AnalysisResult,
  CaptureSource,
  HealthReport,
  Settings,
  SourceKind
} from '@shared/types'

/**
 * Superfície exposta ao renderer.
 *
 * É deliberadamente estreita: cada método corresponde a uma ação que o usuário
 * pode pedir. Não existe aqui nenhuma primitiva genérica (`invoke` cru, acesso
 * a `fs`, envio de canal arbitrário) — se um dia o renderer for comprometido,
 * o que ele consegue fazer é o que está listado abaixo, e nada além.
 */
const api = {
  /** Consultar um tipo por vez deixa as telas aparecerem sem esperar as janelas. */
  listSources: (kind: SourceKind): Promise<CaptureSource[]> =>
    ipcRenderer.invoke(IPC.listSources, kind),

  analyze: (request: AnalyzeRequest): Promise<AnalysisResult> =>
    ipcRenderer.invoke(IPC.analyze, request),

  cancel: (id: string): Promise<void> => ipcRenderer.invoke(IPC.cancel, id),

  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.getSettings),

  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke(IPC.setSettings, patch),

  health: (): Promise<HealthReport> => ipcRenderer.invoke(IPC.health),

  speak: (text: string): Promise<void> => ipcRenderer.invoke(IPC.speak, text),

  stopSpeaking: (): Promise<void> => ipcRenderer.invoke(IPC.stopSpeaking),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),

  /** Eventos de progresso da análise. Devolve a função de cancelamento. */
  onAnalysisEvent: (handler: (event: AnalysisEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AnalysisEvent): void =>
      handler(payload)
    ipcRenderer.on(IPC.event, listener)
    return () => ipcRenderer.removeListener(IPC.event, listener)
  },

  /** Atalho global acionado fora da janela. */
  onShortcut: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on(IPC.shortcutFired, listener)
    return () => ipcRenderer.removeListener(IPC.shortcutFired, listener)
  }
}

contextBridge.exposeInMainWorld('visualizador', api)

export type VisualizadorApi = typeof api

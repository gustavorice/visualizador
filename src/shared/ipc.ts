/** Nomes de canais IPC. Centralizados para não divergirem entre main e preload. */
export const IPC = {
  listSources: 'capture:list-sources',
  analyze: 'analysis:run',
  cancel: 'analysis:cancel',
  event: 'analysis:event',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  health: 'providers:health',
  speak: 'tts:speak',
  stopSpeaking: 'tts:stop',
  openExternal: 'shell:open-external',
  shortcutFired: 'shortcut:analyze'
} as const

export interface AnalyzeRequest {
  sourceId: string
  sourceName: string
  kind: 'screen' | 'window'
}

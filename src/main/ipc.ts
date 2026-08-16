import { ipcMain, shell, type BrowserWindow } from 'electron'
import { IPC, type AnalyzeRequest } from '@shared/ipc'
import type { AnalysisEvent, Settings } from '@shared/types'
import { listSources } from './capture/capture'
import { analyze, cancelAnalysis } from './pipeline/analyze'
import { getSettings, updateSettings } from './settings'
import { healthReport, warmupProviders } from './providers'
import { speak, stop as stopSpeaking } from './tts/speak'
import { log } from './util/logger'

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const emit = (event: AnalysisEvent): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.event, event)
    }
  }

  ipcMain.handle(IPC.listSources, async (_event, kind: 'screen' | 'window') =>
    listSources(kind)
  )

  ipcMain.handle(IPC.analyze, async (_event, request: AnalyzeRequest) => {
    // A análise só existe como resposta a esta chamada — não há timer, nem
    // laço, nem qualquer caminho que capture a tela sem o usuário pedir.
    const result = await analyze({
      sourceId: request.sourceId,
      sourceName: request.sourceName,
      kind: request.kind,
      emit
    })

    if (getSettings().rememberLastSource) {
      updateSettings({
        lastSourceId: request.sourceId,
        lastSourceName: request.sourceName,
        lastSourceKind: request.kind
      })
    }

    return result
  })

  ipcMain.handle(IPC.cancel, async (_event, id: string) => {
    cancelAnalysis(id)
  })

  ipcMain.handle(IPC.getSettings, async () => getSettings())

  ipcMain.handle(IPC.setSettings, async (_event, patch: Partial<Settings>) => {
    const previous = getSettings()
    const next = updateSettings(patch)

    // Trocar de provedor exige reaquecer, senão a próxima análise paga a
    // inicialização inteira no clique do usuário.
    const changed =
      previous.ocrProvider !== next.ocrProvider ||
      previous.visionProvider !== next.visionProvider ||
      previous.geoProvider !== next.geoProvider ||
      previous.ollamaModel !== next.ollamaModel

    if (changed) {
      void warmupProviders().catch((error) => log.error('reaquecimento falhou', error))
    }

    return next
  })

  ipcMain.handle(IPC.health, async () => healthReport())

  ipcMain.handle(IPC.speak, async (_event, text: string) => {
    speak(text)
  })

  ipcMain.handle(IPC.stopSpeaking, async () => {
    stopSpeaking()
  })

  ipcMain.handle(IPC.openExternal, async (_event, url: string) => {
    // Só http(s) — evita que um link no resultado abra um esquema arbitrário.
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })
}

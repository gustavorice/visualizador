import { app, BrowserWindow, globalShortcut, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { registerIpc } from './ipc'
import { getSettings } from './settings'
import { disposeProviders, warmupProviders } from './providers'
import { cancelAll } from './pipeline/analyze'
import { stop as stopSpeaking } from './tts/speak'
import { log } from './util/logger'

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0f14',
    title: 'Visualizador',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // O renderer não tem acesso a Node: tudo passa pela superfície explícita
      // exposta no preload.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  // Evita o flash branco antes do primeiro paint.
  window.once('ready-to-show', () => window.show())

  // Nada de navegação para fora nem de janelas novas: links externos vão para
  // o navegador do sistema.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function registerShortcut(): void {
  const { globalShortcut: accelerator, rememberLastSource } = getSettings()
  if (!accelerator || !rememberLastSource) return

  try {
    // Atalho global: reanalisa a última fonte sem passar pelo seletor. É o
    // caminho mais curto entre "quero saber" e o resultado falado.
    const registered = globalShortcut.register(accelerator, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.shortcutFired)
      }
    })
    if (!registered) log.warn(`não foi possível registrar o atalho ${accelerator}`)
  } catch (error) {
    log.error('falha ao registrar atalho global', error)
  }
}

// Instância única: uma segunda execução apenas foca a janela existente.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    app.setAppUserModelId('com.visualizador.app')

    mainWindow = createWindow()
    registerIpc(() => mainWindow)
    registerShortcut()

    // Aquecimento em segundo plano: a janela já apareceu, e quando o usuário
    // clicar em "Analisar tela" os provedores já estarão prontos.
    void warmupProviders().catch((error) => log.error('aquecimento inicial falhou', error))

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  cancelAll()
  stopSpeaking()
  void disposeProviders()
})

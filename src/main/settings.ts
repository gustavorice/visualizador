import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Settings } from '@shared/types'
import { log } from './util/logger'

/**
 * Padrões deliberadamente conservadores:
 *  - todos os provedores em 'mock', então o MVP roda offline e sem depender
 *    de nada instalado;
 *  - `saveCaptures: false`, então nenhuma imagem toca o disco;
 *  - `allowNetwork: false`, então nem geocodificação sai da máquina até o
 *    usuário ligar explicitamente.
 */
export const DEFAULT_SETTINGS: Settings = {
  ocrProvider: 'mock',
  visionProvider: 'mock',
  geoProvider: 'mock',

  ocrLanguages: 'por+eng',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5vl:3b',
  ollamaKeepAlive: '30m',

  claudeApiKey: '',
  claudeModel: 'claude-opus-5',

  nominatimUrl: 'https://nominatim.openstreetmap.org',
  contactEmail: '',

  webSearchProvider: 'none',
  webSearchUrl: '',
  webSearchApiKey: '',

  saveCaptures: false,
  captureDir: '',
  allowNetwork: false,

  captureMaxWidth: 1600,
  visionMaxWidth: 1024,
  jpegQuality: 72,
  stageTimeoutMs: 6000,
  totalTimeoutMs: 12000,

  speakResults: true,
  speechRate: 1,
  speechLang: 'pt-BR',

  rememberLastSource: true,
  lastSourceId: '',
  lastSourceName: '',
  lastSourceKind: '',
  globalShortcut: 'Alt+Shift+A'
}

let cached: Settings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): Settings {
  if (cached) return cached
  try {
    const raw = readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<Settings>
    // Merge raso com os padrões: chaves novas de versões futuras aparecem
    // sem quebrar arquivos antigos.
    cached = { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    cached = { ...DEFAULT_SETTINGS }
  }
  return cached
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...patch }
  cached = next
  try {
    const path = settingsPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(next, null, 2), 'utf8')
  } catch (error) {
    log.error('não foi possível gravar as configurações', error)
  }
  return next
}

export function defaultCaptureDir(): string {
  return join(app.getPath('pictures'), 'Visualizador')
}

import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Settings } from '@shared/types'
import { log } from './util/logger'

/**
 * Padrões escolhidos para o app FUNCIONAR no primeiro clique, sem
 * configuração e sem chave de API nenhuma:
 *
 *  - OCR no Tesseract: roda local, não precisa de chave, e é o que resolve o
 *    caso mais comum de captura de tela — mapas, sites e painéis quase sempre
 *    trazem o endereço escrito;
 *  - visão DESLIGADA: um modelo de visão exige instalar o Ollama ou uma chave
 *    de API, e o simulado no lugar dele injetaria pistas falsas. Desligado é
 *    honesto: o OCR trabalha sozinho até o usuário escolher um modelo;
 *  - geocodificação no Nominatim, que é gratuito e sem chave;
 *  - `allowNetwork: true`, porque sem resolver pista em coordenada o app não
 *    tem função. O que sai daqui é apenas TEXTO — as pistas a validar —
 *    nunca a imagem. Quem quiser isolamento total desliga em Configurações.
 *
 * Mantidos conservadores: `saveCaptures: false` (nenhuma imagem toca o disco)
 * e nenhum provedor que envie a imagem para fora.
 */
/**
 * Sobe quando os padrões mudam de um jeito que precisa alcançar quem já usou
 * o app. Sem isso, um `settings.json` gravado antes continuaria preso aos
 * provedores simulados para sempre — mudar o padrão só alcançaria instalações
 * novas.
 */
export const SETTINGS_VERSION = 3

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  ocrProvider: 'tesseract',
  visionProvider: 'off',
  geoProvider: 'nominatim',

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

  useWindowTitle: false,

  saveCaptures: false,
  captureDir: '',
  allowNetwork: true,

  // Medido: abaixo de ~1600px o Tesseract deixa de ler texto de interface por
  // completo, e telas de 1440p/4K seriam reduzidas agressivamente com um teto
  // baixo. 2560 não amplia nada (o desktopCapturer nunca ultrapassa o nativo),
  // só evita encolher telas grandes.
  captureMaxWidth: 2560,
  visionMaxWidth: 1024,
  jpegQuality: 72,
  stageTimeoutMs: 6000,
  // Generoso de propósito: melhor esperar do que matar a única etapa capaz de
  // reconhecer um lugar pela foto. O botão vira "Cancelar" durante a análise.
  visionTimeoutMs: 180_000,
  totalTimeoutMs: 240_000,

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

/**
 * Migra um arquivo de configurações da versão 1.
 *
 * Na v1 cada provedor era só 'mock' ou 'real', e todos vinham em 'mock'. Um
 * 'real' era escolha deliberada do usuário e é preservado; um 'mock' era
 * apenas o padrão antigo e vira o provedor real correspondente.
 */
function migrate(stored: Record<string, unknown>): Partial<Settings> {
  const version = typeof stored.version === 'number' ? stored.version : 1
  if (version >= SETTINGS_VERSION) return stored as Partial<Settings>

  const next = { ...stored } as Record<string, unknown>

  if (version < 2) {
    // v1: cada provedor era só 'mock' ou 'real', e todos vinham em 'mock'. Um
    // 'real' era escolha deliberada e é preservado; um 'mock' era só o padrão
    // antigo e vira o provedor real correspondente.
    next.ocrProvider = 'tesseract'
    next.visionProvider = stored.visionProvider === 'real' ? 'ollama' : 'off'
    next.geoProvider = 'nominatim'
    // Sem rede não há geocodificação, e sem geocodificação o app não responde
    // nada. Só texto sai daqui — nunca a imagem.
    next.allowNetwork = true
  }

  if (version < 3) {
    // v2: o prazo era único para todas as etapas, e 6s matava qualquer modelo
    // de visão local antes de ele terminar. Quem já usou o app tem esses
    // valores gravados, então precisam ser reescritos.
    next.visionTimeoutMs = DEFAULT_SETTINGS.visionTimeoutMs
    next.totalTimeoutMs = DEFAULT_SETTINGS.totalTimeoutMs
  }

  next.version = SETTINGS_VERSION
  log.info(`configurações migradas da versão ${version} para a ${SETTINGS_VERSION}`)
  return next as Partial<Settings>
}

export function getSettings(): Settings {
  if (cached) return cached
  try {
    const raw = readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const migrated = migrate(parsed)
    // Merge raso com os padrões: chaves novas de versões futuras aparecem
    // sem quebrar arquivos antigos.
    cached = { ...DEFAULT_SETTINGS, ...migrated }
    if (cached.version !== (parsed.version ?? 1)) persist(cached)
  } catch {
    cached = { ...DEFAULT_SETTINGS }
  }
  return cached
}

function persist(settings: Settings): void {
  try {
    const path = settingsPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8')
  } catch (error) {
    log.error('não foi possível gravar as configurações', error)
  }
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...patch, version: SETTINGS_VERSION }
  cached = next
  persist(next)
  return next
}

export function defaultCaptureDir(): string {
  return join(app.getPath('pictures'), 'Visualizador')
}

/**
 * Esvazia o cache em memória.
 *
 * Existe para os testes: a migração só roda na PRIMEIRA leitura, então testar
 * v1→v3 exige poder voltar ao estado de app recém-aberto sem reiniciar o
 * processo. Em produção nada chama isto — o cache é justamente o que evita
 * reler o disco a cada consulta de configuração.
 */
export function __resetSettingsCacheForTests(): void {
  cached = null
}

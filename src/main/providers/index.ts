import type { GeoProvider, OcrProvider, VisionProvider } from './types'
import type { HealthReport, Settings } from '@shared/types'
import { getSettings } from '../settings'
import { log } from '../util/logger'

import { MockOcrProvider } from './ocr/mock'
import { TesseractOcrProvider } from './ocr/tesseract'
import { MockVisionProvider } from './vision/mock'
import { OllamaVisionProvider } from './vision/ollama'
import { ClaudeVisionProvider } from './vision/claude'
import { MockGeoProvider } from './geo/mock'
import { NominatimGeoProvider } from './geo/nominatim'
import { OffOcrProvider, OffVisionProvider } from './off'

/**
 * Registro de provedores.
 *
 * As instâncias são memoizadas por id porque os provedores reais carregam
 * estado caro (worker do Tesseract, cliente HTTP, limitador de taxa do
 * Nominatim). Trocar de provedor nas configurações só troca qual instância o
 * pipeline consulta — nenhuma outra parte do código muda, e as regras de
 * fusão, confiança e veredito são as mesmas para todos.
 */

const ocrCache = new Map<Settings['ocrProvider'], OcrProvider>()
const visionCache = new Map<Settings['visionProvider'], VisionProvider>()
const geoCache = new Map<Settings['geoProvider'], GeoProvider>()

/** Provedores simulados — a interface avisa em destaque quando estão ativos. */
export const SIMULATED = new Set<string>(['mock'])

export function getOcrProvider(settings: Settings = getSettings()): OcrProvider {
  const id = settings.ocrProvider
  let provider = ocrCache.get(id)
  if (!provider) {
    provider =
      id === 'tesseract'
        ? new TesseractOcrProvider()
        : id === 'off'
          ? new OffOcrProvider()
          : new MockOcrProvider()
    ocrCache.set(id, provider)
  }
  return provider
}

export function getVisionProvider(settings: Settings = getSettings()): VisionProvider {
  const id = settings.visionProvider
  let provider = visionCache.get(id)
  if (!provider) {
    provider =
      id === 'ollama'
        ? new OllamaVisionProvider()
        : id === 'claude'
          ? new ClaudeVisionProvider()
          : id === 'off'
            ? new OffVisionProvider()
            : new MockVisionProvider()
    visionCache.set(id, provider)
  }
  return provider
}

export function getGeoProvider(settings: Settings = getSettings()): GeoProvider {
  const id = settings.geoProvider
  let provider = geoCache.get(id)
  if (!provider) {
    provider = id === 'nominatim' ? new NominatimGeoProvider() : new MockGeoProvider()
    geoCache.set(id, provider)
  }
  return provider
}

/**
 * Aquecimento disparado no boot e a cada troca de provedor.
 *
 * É o que faz a PRIMEIRA análise ser rápida: sem isso o usuário pagaria a
 * inicialização do worker de OCR e o carregamento do modelo de visão no
 * primeiro clique, justamente quando a impressão de velocidade se forma.
 */
export async function warmupProviders(): Promise<void> {
  const settings = getSettings()
  const tasks: Array<Promise<unknown>> = []

  for (const provider of [
    getOcrProvider(settings),
    getVisionProvider(settings),
    getGeoProvider(settings)
  ]) {
    if (provider.warmup) tasks.push(provider.warmup())
  }

  // Aquecimento é oportunista: falhar aqui não impede o app de abrir.
  const results = await Promise.allSettled(tasks)
  const failed = results.filter((result) => result.status === 'rejected').length
  if (failed > 0) log.warn(`${failed} provedor(es) não aqueceram`)
}

export async function healthReport(): Promise<HealthReport> {
  const settings = getSettings()
  const ocr = getOcrProvider(settings)
  const vision = getVisionProvider(settings)
  const geo = getGeoProvider(settings)

  const [ocrHealth, visionHealth, geoHealth] = await Promise.all([
    ocr.health().catch(() => ({ ready: false, detail: 'Falha ao consultar.' })),
    vision.health().catch(() => ({ ready: false, detail: 'Falha ao consultar.' })),
    geo.health().catch(() => ({ ready: false, detail: 'Falha ao consultar.' }))
  ])

  return {
    ocr: {
      name: ocr.name,
      mode: settings.ocrProvider,
      simulated: SIMULATED.has(settings.ocrProvider),
      ...ocrHealth
    },
    vision: {
      name: vision.name,
      mode: settings.visionProvider,
      simulated: SIMULATED.has(settings.visionProvider),
      ...visionHealth
    },
    geo: {
      name: geo.name,
      mode: settings.geoProvider,
      simulated: SIMULATED.has(settings.geoProvider),
      ...geoHealth
    }
  }
}

export async function disposeProviders(): Promise<void> {
  for (const provider of ocrCache.values()) await provider.dispose?.()
  ocrCache.clear()
}

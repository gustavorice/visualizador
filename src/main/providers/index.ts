import type { GeoProvider, OcrProvider, VisionProvider } from './types'
import type { HealthReport, Settings } from '@shared/types'
import { getSettings } from '../settings'
import { log } from '../util/logger'

import { MockOcrProvider } from './ocr/mock'
import { TesseractOcrProvider } from './ocr/tesseract'
import { MockVisionProvider } from './vision/mock'
import { OllamaVisionProvider } from './vision/ollama'
import { MockGeoProvider } from './geo/mock'
import { NominatimGeoProvider } from './geo/nominatim'

/**
 * Registro de provedores.
 *
 * As instâncias são memoizadas por modo porque os provedores reais carregam
 * estado caro (worker do Tesseract, limitador de taxa do Nominatim). Trocar
 * de simulado para real nas configurações só troca qual instância o pipeline
 * consulta — nenhuma outra parte do código muda.
 */

let ocrMock: OcrProvider | null = null
let ocrReal: OcrProvider | null = null
let visionMock: VisionProvider | null = null
let visionReal: VisionProvider | null = null
let geoMock: GeoProvider | null = null
let geoReal: GeoProvider | null = null

export function getOcrProvider(settings: Settings = getSettings()): OcrProvider {
  if (settings.ocrProvider === 'real') {
    ocrReal ??= new TesseractOcrProvider()
    return ocrReal
  }
  ocrMock ??= new MockOcrProvider()
  return ocrMock
}

export function getVisionProvider(settings: Settings = getSettings()): VisionProvider {
  if (settings.visionProvider === 'real') {
    visionReal ??= new OllamaVisionProvider()
    return visionReal
  }
  visionMock ??= new MockVisionProvider()
  return visionMock
}

export function getGeoProvider(settings: Settings = getSettings()): GeoProvider {
  if (settings.geoProvider === 'real') {
    geoReal ??= new NominatimGeoProvider()
    return geoReal
  }
  geoMock ??= new MockGeoProvider()
  return geoMock
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

  const ocr = getOcrProvider(settings)
  if (ocr.warmup) tasks.push(ocr.warmup())

  const vision = getVisionProvider(settings)
  if (vision.warmup) tasks.push(vision.warmup())

  const geo = getGeoProvider(settings)
  if (geo.warmup) tasks.push(geo.warmup())

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
    ocr: { name: ocr.name, mode: settings.ocrProvider, ...ocrHealth },
    vision: { name: vision.name, mode: settings.visionProvider, ...visionHealth },
    geo: { name: geo.name, mode: settings.geoProvider, ...geoHealth }
  }
}

export async function disposeProviders(): Promise<void> {
  await ocrReal?.dispose?.()
}

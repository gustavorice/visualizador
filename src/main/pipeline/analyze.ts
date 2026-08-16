import type {
  AnalysisEvent,
  AnalysisResult,
  Evidence,
  LocationCandidate,
  OcrResult,
  QueryOutcome,
  SourceKind,
  StageName,
  VisionResult
} from '@shared/types'
import { confidenceLabel } from '@shared/confidence'
import { captureSource } from '../capture/capture'
import { getGeoProvider, getOcrProvider, getVisionProvider } from '../providers'
import type { GeoQuery, ProviderContext } from '../providers/types'
import { getSettings } from '../settings'
import { log, stopwatch } from '../util/logger'
import { hashBuffer, newId } from '../util/id'
import {
  buildQueries,
  extractOcrEvidence,
  extractTitleEvidence,
  mergeEvidence
} from './queries'
import { fuse } from './fuse'

export interface AnalyzeOptions {
  sourceId: string
  sourceName: string
  kind: SourceKind
  emit: (event: AnalysisEvent) => void
}

/** Nome legível de cada etapa, para as mensagens de aviso. */
const STAGE_LABEL: Record<StageName, string> = {
  capture: 'captura',
  preview: 'prévia',
  ocr: 'OCR',
  vision: 'modelo de visão',
  fuse: 'fusão',
  geocode: 'geocodificação',
  verify: 'validação',
  compose: 'veredito'
}

const running = new Map<string, AbortController>()

export function cancelAnalysis(id: string): void {
  running.get(id)?.abort()
}

export function cancelAll(): void {
  for (const controller of running.values()) controller.abort()
  running.clear()
}

/**
 * Orquestra uma análise única.
 *
 * O desenho de latência tem quatro peças:
 *
 * 1. A prévia é emitida assim que a captura termina, antes de qualquer
 *    inferência. O usuário vê algo acontecer em ~150ms.
 * 2. OCR e visão rodam EM PARALELO sobre a mesma captura. São as duas etapas
 *    caras e não dependem uma da outra, então o custo é o max(), não a soma.
 * 3. Cada evidência encontrada é emitida assim que aparece, então a lista na
 *    tela vai se preenchendo enquanto a geocodificação ainda roda.
 * 4. Toda etapa tem deadline. Uma etapa lenta degrada para "pulada" em vez de
 *    travar a análise inteira — resposta parcial rápida vale mais que resposta
 *    completa tardia.
 */
export async function analyze(options: AnalyzeOptions): Promise<AnalysisResult> {
  const { sourceId, sourceName, kind, emit } = options
  const settings = getSettings()
  const id = newId()
  const startedAt = Date.now()
  const total = stopwatch()
  const timings: Partial<Record<StageName, number>> = {}
  const warnings: string[] = []

  const controller = new AbortController()
  running.set(id, controller)

  const globalTimer = setTimeout(() => controller.abort(), settings.totalTimeoutMs)

  const stage = (
    name: StageName,
    status: 'running' | 'done' | 'skipped' | 'error',
    ms?: number,
    message?: string
  ): void => {
    // Uma etapa que falha degrada em silêncio por desenho. Mas se a etapa que
    // falhou é a que o usuário está contando, o silêncio esconde a resposta.
    if (status === 'error' && message) warnings.push(`${STAGE_LABEL[name]}: ${message}`)
    emit({ type: 'stage', id, stage: name, status, ms, message })
  }

  try {
    emit({ type: 'started', id, sourceName })

    // ---- 1. Captura -------------------------------------------------------
    stage('capture', 'running')
    const captureTime = stopwatch()
    const captured = await captureSource(sourceId, kind)
    timings.capture = captureTime()
    stage('capture', 'done', timings.capture)

    // Prévia imediata: nada mais precisa terminar para o usuário ver a imagem.
    emit({ type: 'preview', id, preview: captured.preview })

    // Identidade única do quadro, compartilhada por todas as etapas.
    const context = {
      signal: controller.signal,
      timeoutMs: settings.stageTimeoutMs,
      frameId: hashBuffer(captured.ocrBuffer)
    }

    // ---- 2. OCR e visão em paralelo ---------------------------------------
    stage('ocr', 'running')
    stage('vision', 'running')

    const ocrTime = stopwatch()
    const ocrPromise = getOcrProvider(settings)
      .recognize(captured.ocrBuffer, context)
      .then((result) => {
        timings.ocr = ocrTime()
        stage('ocr', 'done', timings.ocr)
        return result
      })
      .catch((error: unknown) => {
        timings.ocr = ocrTime()
        stage('ocr', 'error', timings.ocr, describe(error))
        return null
      })

    const visionTime = stopwatch()
    const visionPromise = getVisionProvider(settings)
      .analyze(captured.visionBase64, context)
      .then((result) => {
        timings.vision = visionTime()
        stage('vision', 'done', timings.vision)
        return result
      })
      .catch((error: unknown) => {
        timings.vision = visionTime()
        stage('vision', 'error', timings.vision, describe(error))
        return null
      })

    const [ocr, vision] = await Promise.all([ocrPromise, visionPromise])
    throwIfAborted(controller.signal)

    if (!ocr && !vision) {
      throw new Error(
        'Nem o OCR nem o modelo de visão responderam. Verifique os provedores nas configurações.'
      )
    }

    // ---- 3. Fusão das pistas ----------------------------------------------
    stage('fuse', 'running')
    const fuseTime = stopwatch()
    // O título da janela costuma trazer a resposta pronta e exata, então
    // entra junto com as pistas lidas dos pixels. Usamos o nome LIDO NA
    // CAPTURA, nunca o que o usuário escolheu antes: a janela pode ter
    // navegado desde então, e um título velho é texto exato sobre a página
    // errada.
    const textEvidence = [
      ...(settings.useWindowTitle ? extractTitleEvidence(captured.sourceName) : []),
      ...(ocr ? extractOcrEvidence(ocr) : [])
    ]
    const evidence = mergeEvidence(textEvidence, vision?.evidence ?? [])
    timings.fuse = fuseTime()
    stage('fuse', 'done', timings.fuse)

    if (evidence.length > 0) emit({ type: 'evidence', id, evidence })

    // ---- 4. Validação externa (opcional) ----------------------------------
    const geo = getGeoProvider(settings)
    const limit = geo.maxQueries?.() ?? 5
    let queries = buildQueries(evidence, vision?.hint, limit)

    if (queries.length > 0 && geo.verify && settings.allowNetwork) {
      stage('verify', 'running')
      const verifyTime = stopwatch()
      try {
        queries = await geo.verify(queries, context)
        timings.verify = verifyTime()
        stage('verify', 'done', timings.verify)
      } catch (error) {
        timings.verify = verifyTime()
        stage('verify', 'error', timings.verify, describe(error))
      }
    } else {
      stage('verify', 'skipped', 0, 'Pesquisa externa desativada.')
    }

    // ---- 5. Geocodificação -------------------------------------------------
    stage('geocode', 'running')
    const geocodeTime = stopwatch()
    const { candidates, outcomes } = await geocodeAll(queries, context)
    timings.geocode = geocodeTime()
    stage('geocode', 'done', timings.geocode, `${candidates.length} candidato(s)`)

    throwIfAborted(controller.signal)

    // ---- 6. Veredito -------------------------------------------------------
    stage('compose', 'running')
    const composeTime = stopwatch()
    const fused = fuse({
      evidence,
      candidates,
      hint: vision?.hint,
      setup: {
        visionEnabled: settings.visionProvider !== 'off',
        ocrEnabled: settings.ocrProvider !== 'off',
        ocrLineCount: ocr?.lines.length ?? 0,
        queriesAttempted: outcomes.length,
        queriesErrored: outcomes.filter((outcome) => outcome.error).length
      }
    })
    timings.compose = composeTime()
    stage('compose', 'done', timings.compose)

    const result: AnalysisResult = {
      id,
      verdict: fused.verdict,
      granularity: fused.granularity,
      summary: fused.summary,
      spoken: fused.spoken,
      confidence: fused.confidence,
      confidenceLabel: confidenceLabel(fused.confidence),
      location: fused.location,
      alternatives: fused.alternatives,
      evidence: fused.evidence,
      queries: outcomes,
      warnings,
      ocr: ocr ?? undefined,
      vision: vision ?? undefined,
      sourceName: captured.sourceName || sourceName,
      timings,
      totalMs: total(),
      startedAt,
      providers: {
        ocr: getOcrProvider(settings).name,
        vision: getVisionProvider(settings).name,
        geo: geo.name
      }
    }

    log.info('análise concluída', {
      ms: result.totalMs,
      verdict: result.verdict,
      confidence: Math.round(result.confidence * 100)
    })

    emit({ type: 'done', id, result })
    return result
  } catch (error) {
    const message = controller.signal.aborted
      ? 'Análise cancelada ou tempo esgotado.'
      : describe(error)
    log.error('análise falhou', error)
    emit({ type: 'error', id, message })
    throw error instanceof Error ? error : new Error(message)
  } finally {
    clearTimeout(globalTimer)
    running.delete(id)
  }
}

/**
 * Geocodifica todas as consultas concorrentemente.
 *
 * `allSettled` é proposital: uma consulta que falha (rede, limite de taxa,
 * termo sem resultado) não pode derrubar as outras — ela apenas não contribui
 * candidatos, e a fusão trabalha com o que sobrou.
 */
async function geocodeAll(
  queries: GeoQuery[],
  context: ProviderContext
): Promise<{ candidates: LocationCandidate[]; outcomes: QueryOutcome[] }> {
  if (queries.length === 0) return { candidates: [], outcomes: [] }

  const geo = getGeoProvider()
  const settled = await Promise.allSettled(
    queries.map((query) => geo.geocode(query, context))
  )

  const candidates: LocationCandidate[] = []
  const outcomes: QueryOutcome[] = []

  settled.forEach((result, index) => {
    const query = queries[index]!
    if (result.status === 'fulfilled') {
      candidates.push(...result.value)
      outcomes.push({
        text: query.text,
        priority: query.priority,
        resultCount: result.value.length
      })
    } else {
      // O erro é registrado, não engolido: uma consulta bloqueada por limite
      // de taxa é indistinguível de "lugar não existe" quando some.
      outcomes.push({
        text: query.text,
        priority: query.priority,
        resultCount: 0,
        error: describe(result.reason)
      })
    }
  })

  return { candidates, outcomes }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Análise cancelada.')
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export type { OcrResult, VisionResult, Evidence }

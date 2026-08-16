import type { VisionProvider, ProviderContext } from '../types'
import type { Evidence, VisionResult } from '@shared/types'
import { EVIDENCE_WEIGHT } from '@shared/confidence'
import { pickScenario } from '../scenarios'
import { evidenceId } from '../../util/id'

/**
 * Visão simulada. Usa a mesma identidade de quadro que o OCR simulado, então
 * as pistas visuais e o texto extraído sempre contam a mesma história — como
 * aconteceria com um VLM real olhando a mesma tela.
 */
export class MockVisionProvider implements VisionProvider {
  readonly name = 'mock-vision'

  async analyze(_imageBase64: string, context: ProviderContext): Promise<VisionResult> {
    const started = performance.now()
    const scenario = pickScenario(context.frameId)

    // Latência simulada próxima de um VLM pequeno já residente na memória.
    await delay(420, context.signal)

    const evidence: Evidence[] = scenario.clues.map((clue) => ({
      id: evidenceId('vis'),
      kind: clue.kind,
      value: clue.value,
      detail: clue.detail,
      weight: EVIDENCE_WEIGHT[clue.kind],
      source: 'vision'
    }))

    return {
      engine: this.name,
      model: 'simulado',
      evidence,
      hint: scenario.hint,
      sceneDescription: scenario.sceneDescription,
      durationMs: Math.round(performance.now() - started)
    }
  }

  async health(): Promise<{ ready: boolean; detail: string }> {
    return { ready: true, detail: 'Simulado — nenhum modelo local necessário.' }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Cancelado', 'AbortError'))
      },
      { once: true }
    )
  })
}

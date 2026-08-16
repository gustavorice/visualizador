import type { OcrProvider, ProviderContext } from '../types'
import type { OcrResult } from '@shared/types'
import { pickScenario } from '../scenarios'

/**
 * OCR simulado. Escolhe um cenário de forma determinística a partir da
 * identidade do quadro: a mesma tela devolve sempre o mesmo texto, telas
 * diferentes devolvem cenários diferentes. Isso torna o MVP demonstrável sem
 * virar aleatoriedade confusa.
 */
export class MockOcrProvider implements OcrProvider {
  readonly name = 'mock-ocr'

  async recognize(_image: Buffer, context: ProviderContext): Promise<OcrResult> {
    const started = performance.now()
    const scenario = pickScenario(context.frameId)

    // Latência simulada compatível com um OCR real já aquecido.
    await delay(180, context.signal)

    return {
      engine: this.name,
      text: scenario.ocrLines.join('\n'),
      lines: scenario.ocrLines.map((text) => ({ text, confidence: 0.9 })),
      durationMs: Math.round(performance.now() - started)
    }
  }

  async health(): Promise<{ ready: boolean; detail: string }> {
    return { ready: true, detail: 'Simulado — nenhum motor de OCR necessário.' }
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

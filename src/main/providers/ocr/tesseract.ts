import { createWorker, type Worker } from 'tesseract.js'
import type { OcrProvider, ProviderContext } from '../types'
import type { OcrResult } from '@shared/types'
import { getSettings } from '../../settings'
import { log } from '../../util/logger'

/**
 * OCR real via Tesseract (WASM).
 *
 * O custo dominante do Tesseract é a inicialização do worker e o carregamento
 * do `traineddata` — facilmente 1,5–3s. Como o app precisa responder rápido,
 * o worker é criado UMA vez no boot (`warmup`) e reaproveitado em todas as
 * análises; cada reconhecimento passa a custar apenas algumas centenas de ms.
 */
export class TesseractOcrProvider implements OcrProvider {
  readonly name = 'tesseract'
  private worker: Worker | null = null
  private starting: Promise<Worker> | null = null

  private async getWorker(): Promise<Worker> {
    if (this.worker) return this.worker
    if (this.starting) return this.starting

    const { ocrLanguages } = getSettings()
    this.starting = createWorker(ocrLanguages, 1, {
      // Silencia o progresso verboso do tesseract.js no console.
      logger: () => {}
    }).then((worker) => {
      this.worker = worker
      this.starting = null
      return worker
    })

    return this.starting
  }

  async warmup(): Promise<void> {
    try {
      await this.getWorker()
      log.info('worker do tesseract pronto')
    } catch (error) {
      log.error('falha ao aquecer o tesseract', error)
    }
  }

  async recognize(image: Buffer, _context: ProviderContext): Promise<OcrResult> {
    const started = performance.now()
    const worker = await this.getWorker()

    // Pedimos apenas texto e blocos. Gerar hOCR, TSV e PDF custa tempo de
    // serialização a cada análise e nada disso é usado aqui.
    const { data } = await worker.recognize(
      image,
      {},
      { text: true, blocks: true }
    )

    const lines = (data.blocks ?? [])
      .flatMap((block) => block.paragraphs)
      .flatMap((paragraph) => paragraph.lines)
      .map((line) => ({
        text: line.text.trim(),
        confidence: (line.confidence ?? 0) / 100
      }))
      // Linhas de baixíssima confiança são ruído e só atrapalham a fusão.
      .filter((line) => line.text.length > 1 && line.confidence > 0.4)

    return {
      engine: this.name,
      text: data.text ?? '',
      lines,
      durationMs: Math.round(performance.now() - started)
    }
  }

  async health(): Promise<{ ready: boolean; detail: string }> {
    const langs = getSettings().ocrLanguages
    if (this.worker) return { ready: true, detail: `Worker aquecido (${langs}).` }
    // Inicializar leva alguns segundos e baixa os idiomas na primeira vez.
    // Marcar isso como "não pronto" faria o indicador piscar vermelho no boot
    // sem que nada esteja errado.
    if (this.starting) {
      return { ready: true, detail: `Inicializando o worker (${langs})…` }
    }
    return { ready: false, detail: 'Worker ainda não inicializado.' }
  }

  async dispose(): Promise<void> {
    await this.worker?.terminate()
    this.worker = null
  }
}

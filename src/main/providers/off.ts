import type { OcrProvider, VisionProvider, ProviderContext } from './types'
import type { OcrResult, VisionResult } from '@shared/types'
import { getSettings } from '../settings'
import { request } from '../util/http'

/**
 * Provedores desligados.
 *
 * Devolvem resultado vazio em vez de lançar, para que o pipeline siga o seu
 * caminho normal com uma etapa a menos. O uso prático é rodar só OCR +
 * geocodificação: telas quase sempre têm texto, e sem um modelo de visão
 * configurado é melhor desligá-lo do que deixar o simulado injetar pistas
 * falsas — que foi exatamente como um resultado sem sentido apareceu.
 */

export class OffOcrProvider implements OcrProvider {
  readonly name = 'desligado'

  async recognize(_image: Buffer, _context: ProviderContext): Promise<OcrResult> {
    return { engine: this.name, text: '', lines: [], durationMs: 0 }
  }

  async health(): Promise<{ ready: boolean; detail: string }> {
    return { ready: true, detail: 'OCR desligado — nenhum texto será extraído.' }
  }
}

export class OffVisionProvider implements VisionProvider {
  readonly name = 'desligado'

  async analyze(_imageBase64: string, _context: ProviderContext): Promise<VisionResult> {
    return { engine: this.name, evidence: [], durationMs: 0 }
  }

  async health(): Promise<{ ready: boolean; detail: string }> {
    // Se o Ollama já está rodando, o usuário está a um seletor de distância
    // de ter visão — vale dizer isso em vez de só informar que está desligada.
    const models = await installedOllamaModels()
    if (models.length > 0) {
      return {
        ready: true,
        detail:
          `Visão desligada — mas o Ollama está rodando com: ${models.join(', ')}. ` +
          'Selecione "Ollama (local)" em Configurações para ativá-la.'
      }
    }
    return { ready: true, detail: 'Visão desligada — só o OCR extrairá pistas.' }
  }
}

/** Consulta rápida ao Ollama local. Silenciosa quando ele não está de pé. */
async function installedOllamaModels(): Promise<string[]> {
  try {
    const response = await request(`${getSettings().ollamaUrl}/api/tags`, { timeoutMs: 800 })
    const body = (await response.json()) as { models?: Array<{ name?: string }> }
    return (body.models ?? []).map((model) => model.name ?? '').filter(Boolean).slice(0, 3)
  } catch {
    return []
  }
}

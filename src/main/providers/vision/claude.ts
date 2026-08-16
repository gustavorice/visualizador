import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { VisionProvider, ProviderContext } from '../types'
import type { Evidence, VisionResult } from '@shared/types'
import {
  RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  USER_PROMPT,
  isPhotoNoise,
  normalizeKind,
  weightFor
} from './prompt'
import { getSettings } from '../../settings'
import { evidenceId } from '../../util/id'
import { log } from '../../util/logger'

/**
 * Visão na nuvem via API do Claude.
 *
 * Existe porque um modelo local de 3B não tem o conhecimento de mundo
 * necessário para reconhecer um monumento, uma fachada ou um estilo de placa
 * pelo que eles são. Um modelo de fronteira tem — e essa é justamente a
 * diferença que se sente ao pedir "onde foi tirada esta foto".
 *
 * O contrato com o resto do sistema é IDÊNTICO ao do Ollama: o modelo lista
 * pistas observáveis e não decide o local. Trocar visão local por visão na
 * nuvem melhora a qualidade das pistas, não afrouxa as regras de veredito —
 * quem transforma pista em coordenada continua sendo o geocodificador.
 *
 * Contrapartida de privacidade, explícita: aqui a IMAGEM sai da máquina. Nos
 * outros provedores só texto sai, e apenas com a rede liberada. Por isso este
 * provedor não é padrão e a interface avisa quando ele está ativo.
 */

const ClueSchema = z.object({
  kind: z.string(),
  value: z.string(),
  detail: z.string().optional().default('')
})

const ResponseSchema = z.object({
  scene_description: z.string().optional().default(''),
  clues: z.array(ClueSchema).optional().default([]),
  language: z.string().optional().default(''),
  country_guess: z.string().optional().default(''),
  city_guess: z.string().optional().default('')
})

export class ClaudeVisionProvider implements VisionProvider {
  readonly name = 'claude'
  private client: Anthropic | null = null
  private clientKey = ''

  private getClient(apiKey: string): Anthropic {
    // O cliente é recriado só quando a chave muda.
    if (!this.client || this.clientKey !== apiKey) {
      this.client = new Anthropic({ apiKey })
      this.clientKey = apiKey
    }
    return this.client
  }

  async analyze(imageBase64: string, context: ProviderContext): Promise<VisionResult> {
    const started = performance.now()
    const { claudeApiKey, claudeModel } = getSettings()

    if (!claudeApiKey.trim()) {
      throw new Error('Nenhuma chave de API do Claude configurada.')
    }

    const response = await this.getClient(claudeApiKey.trim()).beta.messages.create(
      {
        model: claudeModel,
        max_tokens: 16000,
        // Reserva automática: se os classificadores recusarem, a API refaz o
        // pedido em outro modelo em vez de devolver a recusa crua.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM_PROMPT,
        output_config: {
          // Esforço baixo é o principal controle de latência, e para
          // "transcreva o que está visível" ele é suficiente — a tarefa é de
          // percepção, não de raciocínio longo.
          effort: 'low',
          format: { type: 'json_schema' as const, schema: RESPONSE_SCHEMA }
        },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 }
              },
              { type: 'text', text: USER_PROMPT }
            ]
          }
        ]
      },
      { signal: context.signal, timeout: context.timeoutMs }
    )

    // Uma recusa chega como HTTP 200 com `content` vazio ou parcial: ler
    // content[0] sem checar antes quebraria aqui.
    if (response.stop_reason === 'refusal') {
      throw new Error('O modelo recusou analisar esta imagem.')
    }

    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')

    const parsed = safeParse(text)

    const evidence: Evidence[] = parsed.clues
      .filter((clue) => clue.value.trim().length > 0 && !isPhotoNoise(clue.value))
      .map((clue) => {
        const kind = normalizeKind(clue.kind)
        return {
          id: evidenceId('vis'),
          kind,
          value: clue.value.trim(),
          detail: clue.detail?.trim() || undefined,
          weight: weightFor(kind, clue.value.trim()),
          source: 'vision' as const
        }
      })

    return {
      engine: this.name,
      model: response.model,
      evidence,
      hint: {
        country: parsed.country_guess || undefined,
        city: parsed.city_guess || undefined,
        language: parsed.language || undefined
      },
      sceneDescription: parsed.scene_description || undefined,
      durationMs: Math.round(performance.now() - started)
    }
  }

  async health(): Promise<{ ready: boolean; detail: string }> {
    const { claudeApiKey, claudeModel } = getSettings()
    if (!claudeApiKey.trim()) {
      return { ready: false, detail: 'Nenhuma chave de API do Claude configurada.' }
    }
    return {
      ready: true,
      detail: `Claude (${claudeModel}) — a imagem sai da sua máquina para a API.`
    }
  }
}

function safeParse(content: string): z.infer<typeof ResponseSchema> {
  const empty = {
    scene_description: '',
    clues: [] as Array<{ kind: string; value: string; detail: string }>,
    language: '',
    country_guess: '',
    city_guess: ''
  }
  if (!content.trim()) return empty
  try {
    const result = ResponseSchema.safeParse(JSON.parse(content))
    // Saída malformada é tratada como "nenhuma pista", nunca como licença
    // para o restante do pipeline improvisar.
    if (!result.success) log.warn('resposta do Claude fora do formato esperado')
    return result.success ? result.data : empty
  } catch {
    return empty
  }
}


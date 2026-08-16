import { z } from 'zod'
import type { VisionProvider, ProviderContext } from '../types'
import type { Evidence, EvidenceKind, VisionResult } from '@shared/types'
import { EVIDENCE_WEIGHT } from '@shared/confidence'
import { getSettings } from '../../settings'
import { postJson, request } from '../../util/http'
import { evidenceId } from '../../util/id'
import { log } from '../../util/logger'

/**
 * Visão local via Ollama.
 *
 * Três decisões carregam o desempenho e a honestidade deste provedor:
 *
 * 1. `keep_alive` alto — sem isso o Ollama descarrega o modelo da VRAM após
 *    5 minutos e a análise seguinte paga 2–8s de recarga. Também disparamos
 *    um `warmup` no boot para que a PRIMEIRA análise já encontre o modelo
 *    quente.
 * 2. Saída estruturada via `format` (JSON Schema) — elimina o parsing frágil
 *    de texto livre e reduz tokens gerados, que é onde o tempo vai.
 * 3. O prompt proíbe o modelo de adivinhar o local. Ele lista PISTAS
 *    OBSERVÁVEIS; quem resolve pista em coordenada é o provedor geográfico.
 *    `country_guess` entra apenas como viés de busca, nunca como resposta.
 */

const KNOWN_KINDS: EvidenceKind[] = [
  'landmark',
  'locality',
  'street_sign',
  'business',
  'license_plate',
  'domain',
  'phone',
  'transit',
  'currency',
  'language',
  'flag',
  'architecture',
  'vegetation',
  'landscape',
  'signage_style',
  'text',
  'other'
]

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

/** JSON Schema entregue ao Ollama para forçar saída estruturada. */
const RESPONSE_FORMAT = {
  type: 'object',
  properties: {
    scene_description: { type: 'string' },
    clues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: KNOWN_KINDS },
          value: { type: 'string' },
          detail: { type: 'string' }
        },
        required: ['kind', 'value']
      }
    },
    language: { type: 'string' },
    country_guess: { type: 'string' },
    city_guess: { type: 'string' }
  },
  required: ['scene_description', 'clues']
} as const

const SYSTEM_PROMPT = `Você é um analista de imagens especializado em pistas geográficas.

Sua tarefa é LISTAR O QUE ESTÁ VISÍVEL na imagem. Você NÃO decide onde a foto foi tirada — outro sistema faz isso a partir das suas pistas.

Regras rígidas:
- Relate apenas o que dá para VER. Nunca deduza um local e depois invente pistas que o justifiquem.
- Transcreva textos exatamente como aparecem (placas, nomes de rua, fachadas, cardápios, veículos).
- Se não houver nenhuma pista geográfica, devolva "clues" vazio. Isso é uma resposta correta e esperada.
- Não repita a mesma pista com palavras diferentes.
- "country_guess" e "city_guess" são opcionais e servem só como palpite fraco; deixe vazio se não tiver base visual.

Tipos válidos para "kind": ${KNOWN_KINDS.join(', ')}.

Responda em português do Brasil, em JSON.`

const USER_PROMPT =
  'Liste as pistas geográficas visíveis nesta imagem: placas, nomes de ruas, estabelecimentos, monumentos, placas de veículos, idioma dos textos, moeda, vegetação, relevo e estilo construtivo.'

interface OllamaChatResponse {
  message?: { content?: string }
}

export class OllamaVisionProvider implements VisionProvider {
  readonly name = 'ollama'

  async warmup(): Promise<void> {
    const { ollamaUrl, ollamaModel, ollamaKeepAlive } = getSettings()
    try {
      // Requisição vazia com keep_alive apenas carrega o modelo na memória.
      await postJson(
        `${ollamaUrl}/api/generate`,
        { model: ollamaModel, prompt: '', stream: false, keep_alive: ollamaKeepAlive },
        { timeoutMs: 120_000 }
      )
      log.info('modelo do ollama carregado', { model: ollamaModel })
    } catch (error) {
      log.warn('não foi possível aquecer o ollama; a primeira análise será mais lenta')
      log.error('detalhe do aquecimento', error)
    }
  }

  async analyze(imageBase64: string, context: ProviderContext): Promise<VisionResult> {
    const started = performance.now()
    const { ollamaUrl, ollamaModel, ollamaKeepAlive } = getSettings()

    const payload = {
      model: ollamaModel,
      stream: false,
      format: RESPONSE_FORMAT,
      keep_alive: ollamaKeepAlive,
      options: {
        // Temperatura baixa: queremos transcrição fiel, não criatividade.
        temperature: 0.1,
        top_p: 0.9,
        // Teto de tokens: a saída é uma lista curta, e cada token custa tempo.
        num_predict: 500
      },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_PROMPT, images: [imageBase64] }
      ]
    }

    const response = await postJson<OllamaChatResponse>(`${ollamaUrl}/api/chat`, payload, {
      timeoutMs: context.timeoutMs,
      signal: context.signal
    })

    const content = response.message?.content ?? ''
    const parsed = safeParse(content)

    const evidence: Evidence[] = parsed.clues
      .filter((clue) => clue.value.trim().length > 0)
      .map((clue) => {
        const kind = normalizeKind(clue.kind)
        return {
          id: evidenceId('vis'),
          kind,
          value: clue.value.trim(),
          detail: clue.detail?.trim() || undefined,
          weight: EVIDENCE_WEIGHT[kind],
          source: 'vision' as const
        }
      })

    return {
      engine: this.name,
      model: ollamaModel,
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
    const { ollamaUrl, ollamaModel } = getSettings()
    try {
      const response = await request(`${ollamaUrl}/api/tags`, { timeoutMs: 1500 })
      const body = (await response.json()) as { models?: Array<{ name?: string }> }
      const names = (body.models ?? []).map((model) => model.name ?? '')
      const installed = names.some((name) => name === ollamaModel || name.startsWith(`${ollamaModel}:`))
      if (!installed) {
        return {
          ready: false,
          detail: `Ollama respondeu, mas o modelo "${ollamaModel}" não está instalado. Rode: ollama pull ${ollamaModel}`
        }
      }
      return { ready: true, detail: `Ollama ativo com ${ollamaModel}.` }
    } catch {
      return { ready: false, detail: `Ollama não respondeu em ${ollamaUrl}.` }
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
    // Saída malformada é tratada como "nenhuma pista" — nunca como licença
    // para o restante do pipeline improvisar.
    return result.success ? result.data : empty
  } catch {
    return empty
  }
}

function normalizeKind(raw: string): EvidenceKind {
  const value = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return (KNOWN_KINDS as string[]).includes(value) ? (value as EvidenceKind) : 'other'
}

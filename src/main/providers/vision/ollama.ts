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
 * 3. O prompt (compartilhado em ./prompt.ts) pede que o modelo IDENTIFIQUE
 *    o lugar quando o reconhecer, mas nunca invente um nome. Quem resolve
 *    nome em coordenada continua sendo o provedor geográfico.
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

interface OllamaChatResponse {
  message?: { content?: string }
}

/**
 * Descobre qual modelo com visão está instalado.
 *
 * Exigir que o usuário digite o nome exato do modelo é uma armadilha: quem
 * baixou `llama3.2-vision` e deixou o campo em `qwen2.5vl:3b` recebe um 404 e
 * um lacônico "visão falhou". O Ollama sabe o que tem instalado, então o app
 * pergunta.
 *
 * A capacidade de visão vem de `details.families` (`clip`/`mllama` são os
 * projetores de imagem); o casamento por nome existe como reserva para
 * versões do Ollama que não preenchem esse campo.
 */
interface OllamaTag {
  name?: string
  details?: { families?: string[] }
}

const VISION_NAME_HINTS = /vl|vision|llava|moondream|bakllava|minicpm-v|gemma3|pixtral/i

/**
 * Modelo já descoberto, guardado por preferência configurada.
 *
 * A lista de modelos instalados não muda entre duas análises, mas a consulta
 * estava sendo refeita em toda uma delas — no caminho crítico, antes de a
 * imagem sequer começar a ser processada. É pouco tempo cada vez, e é tempo
 * gasto para reconfirmar uma resposta que já se tinha.
 */
const modelCache = new Map<string, string | null>()

/** Esquecer o que foi descoberto — usado quando o usuário troca o modelo. */
export function forgetVisionModel(): void {
  modelCache.clear()
}

export async function findVisionModel(preferred: string): Promise<string | null> {
  const cached = modelCache.get(preferred)
  if (cached !== undefined) return cached

  const found = await lookupVisionModel(preferred)
  // Só o resultado POSITIVO é guardado: um `null` costuma significar "o
  // Ollama ainda não subiu", e cravar isso deixaria o app dizendo "nenhum
  // modelo instalado" para sempre, mesmo depois de o usuário abrir o Ollama.
  if (found) modelCache.set(preferred, found)
  return found
}

async function lookupVisionModel(preferred: string): Promise<string | null> {
  const { ollamaUrl } = getSettings()
  const response = await request(`${ollamaUrl}/api/tags`, { timeoutMs: 2000 })
  const body = (await response.json()) as { models?: OllamaTag[] }
  const models = body.models ?? []

  const names = models.map((model) => model.name ?? '').filter(Boolean)
  // O modelo escolhido pelo usuário sempre ganha, se estiver instalado.
  const exact = names.find((name) => name === preferred || name.startsWith(`${preferred}:`))
  if (exact) return exact

  const capable = models.find((model) => {
    const families = model.details?.families ?? []
    return (
      families.some((family) => /clip|mllama|vision/i.test(family)) ||
      VISION_NAME_HINTS.test(model.name ?? '')
    )
  })

  return capable?.name ?? null
}

export class OllamaVisionProvider implements VisionProvider {
  readonly name = 'ollama'

  async warmup(): Promise<void> {
    const { ollamaUrl, ollamaModel, ollamaKeepAlive } = getSettings()
    try {
      const model = await findVisionModel(ollamaModel)
      if (!model) {
        log.warn('nenhum modelo com visão instalado no ollama')
        return
      }
      // Requisição vazia com keep_alive apenas carrega o modelo na memória.
      await postJson(
        `${ollamaUrl}/api/generate`,
        { model, prompt: '', stream: false, keep_alive: ollamaKeepAlive },
        { timeoutMs: 120_000 }
      )
      log.info('modelo do ollama carregado', { model })
    } catch (error) {
      log.warn('não foi possível aquecer o ollama; a primeira análise será mais lenta')
      log.error('detalhe do aquecimento', error)
    }
  }

  async analyze(imageBase64: string, context: ProviderContext): Promise<VisionResult> {
    const started = performance.now()
    const { ollamaUrl, ollamaModel, ollamaKeepAlive } = getSettings()

    const model = await findVisionModel(ollamaModel)
    if (!model) {
      throw new Error(
        'Nenhum modelo com visão instalado no Ollama. Rode: ollama pull qwen2.5vl:3b'
      )
    }

    const payload = {
      model,
      stream: false,
      format: RESPONSE_SCHEMA,
      keep_alive: ollamaKeepAlive,
      options: {
        // Temperatura baixa: queremos transcrição fiel, não criatividade.
        temperature: 0.1,
        top_p: 0.9,
        /*
         * Contexto explícito, e não é folga à toa.
         *
         * Várias versões do Ollama usam 2048 por padrão. A conta antiga
         * encostava nisso: ~600 tokens de prompt de sistema, ~700 de imagem a
         * 1024px, mais 500 de geração. Quando estoura, o Ollama descarta os
         * tokens MAIS ANTIGOS — que são justamente as instruções. O modelo
         * então responde sem saber o que foi pedido, e o resultado não parece
         * um erro: parece o modelo sendo ruim. Fixar o valor tira essa
         * variável do jogo, e 4096 sobra para a conta atual (~1100 + 280).
         */
        num_ctx: 4096,
        /*
         * Teto de tokens gerados — e é AQUI que o tempo vai.
         *
         * Num modelo local sem GPU a geração custa a maior parte dos segundos
         * que o usuário passa esperando: cada token sai em dezenas de
         * milissegundos, então 500 tokens são dezenas de segundos sozinhos.
         * Com o esquema limitado a 6 pistas e os textos curtos, a resposta
         * completa cabe folgada em 280 — o resto do orçamento antigo era
         * gasto em prosa que o app descartava.
         */
        num_predict: 280
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
      model,
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
      const model = await findVisionModel(ollamaModel)
      if (!model) {
        return {
          ready: false,
          detail:
            'Ollama respondeu, mas nenhum modelo instalado tem visão. ' +
            'Rode: ollama pull qwen2.5vl:3b'
        }
      }
      const chosen = model === ollamaModel ? model : `${model} (escolhido automaticamente)`
      return { ready: true, detail: `Ollama ativo com ${chosen}.` }
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


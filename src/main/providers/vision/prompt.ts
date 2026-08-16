import type { EvidenceKind } from '@shared/types'
import { EVIDENCE_WEIGHT } from '@shared/confidence'

/**
 * Prompt e normalização compartilhados pelos provedores de visão.
 *
 * Vive fora deles porque Ollama e Claude precisam pedir exatamente a mesma
 * coisa: trocar de modelo tem que mudar a QUALIDADE das pistas, nunca o que
 * foi perguntado. Se os prompts divergirem, comparar os dois deixa de medir o
 * modelo e passa a medir o prompt.
 */

export const KNOWN_KINDS: EvidenceKind[] = [
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

/**
 * A regra continua sendo que o modelo não decide o local — mas RECONHECER um
 * monumento é observação, não adivinhação, e a versão anterior deste prompt
 * proibia as duas coisas juntas. O resultado era um modelo que via a ponte
 * Zhivopisny e respondia "red arch bridge": uma descrição correta, e inútil,
 * porque descrição não geocodifica e nome próprio sim.
 *
 * A garantia contra invenção não vem de proibir o nome; vem de o nome ter que
 * sobreviver à geocodificação. Um nome inventado não resolve em lugar nenhum
 * e morre na etapa seguinte.
 */
export const SYSTEM_PROMPT = `Você é um especialista em determinar onde uma foto foi tirada, no estilo de um jogador profissional de GeoGuessr.

Trabalhe em três frentes, nesta ordem:

1. IDENTIFICAR. Se reconhece um lugar específico — ponte, prédio, monumento, praça, montanha, horizonte de cidade — diga o NOME PRÓPRIO em "landmark". Nome próprio é o que resolve: "Ponte Zhivopisny, Moscou" é útil; "ponte vermelha em arco" não serve, porque nenhum mapa procura por isso. Reconhecendo a cidade pelo conjunto, diga o nome dela em "locality".

2. TRANSCREVER. Copie exatamente todo texto visível: placas de rua com número, fachadas, nomes de comércios, painéis, placas de veículos.

3. DEDUZIR O PAÍS. Esta parte é obrigatória e vale mesmo quando não há nenhum monumento nem texto — a maioria das fotos é assim. Use os sinais que um jogador de GeoGuessr usa e liste os mais fortes como pista:
   - vegetação e clima (oliveiras, palmeiras, coníferas, mato seco, tundra)
   - faixas e sinalização de estrada: cor, tracejado, guard-rail, marcos quilométricos
   - postes de energia e telefonia: formato, material, isoladores
   - lado da via em que os carros andam, e formato das placas dos veículos
   - arquitetura: telhado, janelas, muros, material das construções
   - relevo, cor do solo, tipo de costa
   - ângulo e altura do sol, que indicam hemisfério e latitude
   Termine preenchendo "country_guess" com o país mais provável, e "city_guess" só se tiver base real.

Regras:
- Prefira sempre o específico ao genérico. Entre "catedral gótica" e "Catedral de Colônia", escolha a segunda.
- Não invente NOME de lugar. Se não reconhece, deixe "landmark" vazio — mas ainda assim deduza o país pelos sinais acima.
- Devolver a lista vazia é quase sempre errado: toda foto de rua ou paisagem tem vegetação, estrada, construção ou céu que restringem o país.
- Não liste características fotográficas ("vista aérea", "foto diurna", "close"): não são pistas de lugar.
- Não repita a mesma pista com outras palavras.
- SEJA BREVE. No máximo 6 pistas, as mais fortes. "value" em poucas palavras, "detail" em no máximo 8 palavras, "scene_description" em no máximo 12. Cada palavra a mais é tempo de espera para quem está usando o app, e a resposta é lida por um programa, não por uma pessoa.

Tipos válidos para "kind": ${KNOWN_KINDS.join(', ')}.

Escreva em português do Brasil, mas mantenha nomes próprios na forma como aparecem nos mapas.`

export const USER_PROMPT =
  'Onde esta foto foi tirada? Se reconhecer o lugar, diga o nome próprio. ' +
  'Se não reconhecer, deduza o país pelos sinais visíveis — vegetação, sinalização da estrada, ' +
  'postes, lado da via, arquitetura, relevo, ângulo do sol — e liste cada sinal como pista.'

/** JSON Schema da resposta, compartilhado pelos dois provedores. */
export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    scene_description: { type: 'string' },
    clues: {
      type: 'array',
      // O teto entra no ESQUEMA, não só no texto do prompt: modelos pequenos
      // ignoram "no máximo 6" escrito em português, mas a saída estruturada é
      // imposta pelo decodificador. Cada pista a mais é tempo de geração, e
      // depois da sexta elas viram repetição da mesma observação.
      maxItems: 6,
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

/**
 * Termos que descrevem a FOTOGRAFIA, não o lugar.
 *
 * Modelos menores tendem a listá-los como pistas — "aerial view" chegou
 * classificado como padrão de sinalização. Não localizam nada e só ocupam
 * espaço na lista de evidências.
 */
const PHOTO_NOISE =
  /^(vista a[ée]rea|aerial view|drone|close-?up|panor[âa]mica|panoramic|foto|photo|imagem|image|paisagem urbana|daytime|dia|noite|night|sunny|ensolarado|c[ée]u azul|blue sky|alta resolu[çc][ãa]o)$/i

export function isPhotoNoise(value: string): boolean {
  return PHOTO_NOISE.test(value.trim())
}

/** Parece nome próprio? Duas ou mais palavras com inicial maiúscula, ou uma incomum. */
function looksNamed(value: string): boolean {
  const words = value.trim().split(/\s+/)
  const capitalized = words.filter((word) => /^[A-ZÀ-Þ]/.test(word))
  return capitalized.length >= 2 || (words.length === 1 && /^[A-ZÀ-Þ]/.test(words[0] ?? ''))
}

/**
 * Peso da pista, ajustado pelo quanto ela é acionável.
 *
 * Um "landmark" sem nome próprio — "ponte vermelha em arco" — não é um
 * monumento identificado, é uma descrição. Deixá-lo com o peso máximo de
 * monumento faz uma descrição genérica dominar a fusão e produzir confiança
 * alta sobre nada.
 */
export function weightFor(kind: EvidenceKind, value: string): number {
  const base = EVIDENCE_WEIGHT[kind]
  if ((kind === 'landmark' || kind === 'locality') && !looksNamed(value)) {
    return EVIDENCE_WEIGHT.landscape
  }
  return base
}

export function normalizeKind(raw: string): EvidenceKind {
  const value = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return (KNOWN_KINDS as string[]).includes(value) ? (value as EvidenceKind) : 'other'
}

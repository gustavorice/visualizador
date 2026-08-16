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
export const SYSTEM_PROMPT = `Você é um analista de imagens especializado em identificar lugares.

Sua tarefa tem duas partes, nesta ordem de importância:

1. IDENTIFICAR. Se você reconhece um lugar específico — uma ponte, um prédio, um monumento, uma praça, uma montanha, um horizonte de cidade — diga o NOME PRÓPRIO dele, em "landmark". Nome próprio é o que importa: "Ponte Zhivopisny, Moscou" é útil; "ponte vermelha em arco" não serve para nada, porque nenhum mapa consegue procurar por isso. Se reconhecer a cidade pelo conjunto, diga o nome dela em "locality".

2. TRANSCREVER. Copie exatamente todo texto visível: placas de rua com número, fachadas, nomes de estabelecimentos, painéis, placas de veículos.

Regras:
- Prefira sempre o nome específico ao genérico. Entre "catedral gótica" e "Catedral de Colônia", escolha a segunda.
- Se NÃO reconhecer o lugar, não invente um nome. Descreva o que vê nos tipos genéricos (landscape, architecture, vegetation) e deixe "landmark" de fora. Um nome inventado é pior que nenhum.
- Não liste características fotográficas — "vista aérea", "foto diurna", "close" — não são pistas de lugar.
- Não repita a mesma pista com outras palavras.
- "country_guess" e "city_guess" são palpites; preencha se tiver base visual.

Tipos válidos para "kind": ${KNOWN_KINDS.join(', ')}.

Escreva em português do Brasil, mas mantenha nomes próprios na forma original quando for assim que aparecem nos mapas.`

export const USER_PROMPT =
  'Que lugar é este? Se reconhecer o local ou o monumento, diga o nome próprio. ' +
  'Depois liste as demais pistas visíveis: textos, placas, idioma, moeda, vegetação, relevo e estilo construtivo.'

/** JSON Schema da resposta, compartilhado pelos dois provedores. */
export const RESPONSE_SCHEMA = {
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

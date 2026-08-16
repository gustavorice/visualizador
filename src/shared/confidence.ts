import type { ConfidenceLabel, EvidenceKind, Granularity, Verdict } from './types'

/**
 * Peso base de cada tipo de pista: quão discriminativa ela é sozinha.
 * Um monumento identificado vale muito; "o idioma parece português" vale pouco,
 * porque aponta para 9 países.
 */
export const EVIDENCE_WEIGHT: Record<EvidenceKind, number> = {
  landmark: 0.9,
  // Um nome de cidade lido na própria tela é a pista mais direta que existe:
  // não precisa ser inferido, só confirmado pelo geocodificador.
  locality: 0.72,
  street_sign: 0.62,
  license_plate: 0.6,
  business: 0.5,
  transit: 0.55,
  domain: 0.5,
  phone: 0.48,
  currency: 0.32,
  flag: 0.3,
  language: 0.22,
  signage_style: 0.2,
  architecture: 0.16,
  vegetation: 0.14,
  landscape: 0.14,
  text: 0.1,
  other: 0.08
}

/**
 * Pistas "duras": as que podem ser resolvidas em coordenadas por consulta
 * externa. Sem pelo menos uma delas, o app não afirma uma cidade — no máximo
 * fala em país provável.
 */
export const HARD_EVIDENCE: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>([
  'landmark',
  'locality',
  'street_sign',
  'business',
  'transit',
  'domain',
  'phone'
])

/**
 * Esta pista é dura o bastante para FECHAR um veredito?
 *
 * O tipo quase basta, mas a origem decide um caso: uma cidade LIDA na tela é
 * observação; a mesma cidade DEDUZIDA pelo modelo de visão é palpite.
 *
 * A diferença não é filosófica, é o que a geocodificação consegue conferir.
 * Um monumento nomeado tem que sobreviver à busca: "Ponte Zhivopisny" resolve
 * numa coordenada e um nome inventado morre ali, então o geocodificador de
 * fato confirma alguma coisa. Um nome de cidade não passa por nenhuma prova —
 * TODA cidade existente geocodifica, inclusive a errada. Deixar o palpite
 * fechar veredito era o app afirmando "Atenas" com 70% de confiança porque o
 * modelo achou a foto com cara de Grécia, e isso é exatamente o inventar
 * lugar que o resto do desenho existe para impedir. Como pista ela continua
 * valendo — vira consulta, desambigua rua homônima, sustenta o país —, só não
 * assina sozinha a resposta.
 */
export function isHardEvidence(item: {
  kind: EvidenceKind
  source: 'ocr' | 'title' | 'vision' | 'search'
}): boolean {
  if (item.kind === 'locality' && item.source === 'vision') return false
  return HARD_EVIDENCE.has(item.kind)
}

/** Pistas que restringem no máximo a nível de país. */
export const COUNTRY_EVIDENCE: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>([
  'license_plate',
  'currency',
  'flag',
  'language',
  'signage_style'
])

/**
 * Teto de confiança.
 *
 * Nenhum acúmulo de pistas leva a 100%, porque existe uma incerteza que as
 * pistas não conseguem tocar: a imagem pode ser a foto de um cartaz, um
 * quadro, um filme ou um mapa aberto na tela. Todas as pistas apontariam
 * corretamente para o MASP, e ainda assim a resposta à pergunta "onde isso
 * foi tirado" poderia ser outra. Esse resíduo é sistemático, não estatístico,
 * então ele vira um limite explícito em vez de sumir na soma.
 */
export const MAX_CONFIDENCE = 0.95

/**
 * Confiabilidade da ORIGEM da pista.
 *
 * O título da janela é texto exato entregue pelo sistema operacional; o OCR é
 * texto reconhecido de pixels e erra. Duas pistas com o mesmo peso não valem
 * o mesmo quando uma delas pode simplesmente ter sido lida errado.
 */
export const SOURCE_TRUST: Record<'ocr' | 'title' | 'vision' | 'search', number> = {
  title: 1, // texto exato do sistema, sem reconhecimento envolvido
  search: 0.9, // confirmado por consulta externa
  vision: 0.8, // interpretado por um modelo
  ocr: 0.7 // reconhecido de pixels, sujeito a erro de leitura
}

export const THRESHOLDS = {
  /** Abaixo disso não afirmamos nada. */
  insufficient: 0.3,
  /** A partir daqui afirmamos cidade, desde que haja pista dura + geocódigo. */
  located: 0.55,
  /** A partir daqui a etiqueta vira "alta". */
  high: 0.75
} as const

/**
 * Combinação ruidosa-OU: várias pistas fracas independentes somam, mas nunca
 * chegam a 1. Evita que "idioma + vegetação + arquitetura" simulem certeza.
 */
export function noisyOr(weights: number[]): number {
  if (weights.length === 0) return 0
  const product = weights.reduce((acc, w) => acc * (1 - clamp01(w)), 1)
  return clamp01(1 - product)
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function confidenceLabel(confidence: number): ConfidenceLabel {
  if (confidence >= THRESHOLDS.high) return 'alta'
  if (confidence >= THRESHOLDS.located) return 'média'
  return 'baixa'
}

/**
 * Decide o veredito. Esta é a função que impede a invenção de lugar:
 * nenhum caminho retorna 'located' sem geocódigo resolvido E pista dura.
 */
export function decideVerdict(input: {
  confidence: number
  hasGeocode: boolean
  hasHardEvidence: boolean
  granularity: Granularity
  /** true quando os melhores candidatos discordam de país. */
  conflicting: boolean
}): Verdict {
  const { confidence, hasGeocode, hasHardEvidence, granularity, conflicting } = input

  if (!hasGeocode || granularity === 'none') return 'insufficient'
  if (confidence < THRESHOLDS.insufficient) return 'insufficient'

  if (conflicting) return 'ambiguous'
  if (!hasHardEvidence) return 'ambiguous'
  if (granularity !== 'city') return 'ambiguous'
  if (confidence < THRESHOLDS.located) return 'ambiguous'

  return 'located'
}

/**
 * Raio de incerteza exibido no mapa, em km.
 *
 * `precision` é o que separa "resolvi a cidade" de "resolvi a rua": as duas
 * têm granularidade `city`, mas desenhar 12 km de raio em cima de um endereço
 * exato comunicaria menos certeza do que realmente existe.
 */
export function uncertaintyKm(
  granularity: Granularity,
  confidence: number,
  precision = 0.5
): number {
  const base = granularity === 'city' ? 12 : granularity === 'region' ? 120 : 800

  // Escala do OSM normalizada: ~0,87 é rua, ~1,0 é endereço/prédio.
  const precisionFactor = precision >= 0.85 ? 0.05 : precision >= 0.75 ? 0.2 : 1

  // Confiança baixa alarga o círculo em até 2,5x.
  const km = base * precisionFactor * (1 + (1 - clamp01(confidence)) * 1.5)
  return Math.max(0.3, Math.round(km * 10) / 10)
}

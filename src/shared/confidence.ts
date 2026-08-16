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

/** Raio de incerteza exibido no mapa, em km. */
export function uncertaintyKm(granularity: Granularity, confidence: number): number {
  const base = granularity === 'city' ? 12 : granularity === 'region' ? 120 : 800
  // Confiança baixa alarga o círculo em até 2,5x.
  return Math.round(base * (1 + (1 - clamp01(confidence)) * 1.5))
}

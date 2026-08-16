import type {
  Evidence,
  Granularity,
  LocationCandidate,
  ResolvedLocation,
  Verdict,
  VisionResult
} from '@shared/types'
import {
  COUNTRY_EVIDENCE,
  HARD_EVIDENCE,
  MAX_CONFIDENCE,
  clamp01,
  confidenceLabel,
  decideVerdict,
  noisyOr,
  uncertaintyKm
} from '@shared/confidence'

export interface FusionInput {
  evidence: Evidence[]
  candidates: LocationCandidate[]
  hint?: VisionResult['hint']
}

export interface FusionOutput {
  verdict: Verdict
  granularity: Granularity
  confidence: number
  location?: ResolvedLocation
  alternatives: LocationCandidate[]
  evidence: Evidence[]
  summary: string
  spoken: string
}

interface Cluster {
  key: string
  city?: string
  region?: string
  country?: string
  countryCode?: string
  lat: number
  lon: number
  displayName: string
  geoQuality: number
  evidenceIds: Set<string>
  queries: Set<string>
  score: number
}

/**
 * Funde pistas e candidatos geográficos em um veredito.
 *
 * O ponto central: a confiança nasce do produto entre FORÇA DAS PISTAS e
 * QUALIDADE DA RESOLUÇÃO. Nenhum dos dois sozinho basta. Um monumento
 * reconhecido que não geocodifica não vira resposta; um geocódigo perfeito
 * sustentado só por "o idioma parece português" também não.
 */
export function fuse(input: FusionInput): FusionOutput {
  const { evidence, candidates, hint } = input
  const byId = new Map(evidence.map((item) => [item.id, item]))

  if (candidates.length === 0) {
    return insufficient(evidence, 'Nenhuma pista da imagem pôde ser resolvida em um lugar real.')
  }

  const clusters = buildClusters(candidates)
  if (clusters.length === 0) {
    return insufficient(evidence, 'Nenhuma pista da imagem pôde ser resolvida em um lugar real.')
  }

  // Pistas que restringem apenas o país reforçam qualquer cluster daquele país.
  applyCountryLevelEvidence(clusters, evidence, hint)

  for (const cluster of clusters) {
    cluster.score = scoreCluster(cluster, byId)
  }
  clusters.sort((a, b) => b.score - a.score)

  const winner = clusters[0]!
  const runnerUp = clusters[1]

  // Conflito real: o segundo colocado aponta para OUTRO país com força
  // comparável. Nesse caso não dá para afirmar nada em nível de cidade.
  const conflicting =
    !!runnerUp &&
    !!runnerUp.countryCode &&
    !!winner.countryCode &&
    runnerUp.countryCode !== winner.countryCode &&
    runnerUp.score >= winner.score * 0.8

  const granularity: Granularity = winner.city
    ? 'city'
    : winner.region
      ? 'region'
      : winner.country
        ? 'country'
        : 'none'

  const supporting = [...winner.evidenceIds]
    .map((id) => byId.get(id))
    .filter((item): item is Evidence => Boolean(item))

  const hasHardEvidence = supporting.some((item) => HARD_EVIDENCE.has(item.kind))
  const confidence = clamp01(winner.score)

  const verdict = decideVerdict({
    confidence,
    hasGeocode: true,
    hasHardEvidence,
    granularity,
    conflicting
  })

  // Marca as pistas que sustentaram o vencedor, para exibição.
  const annotated = evidence.map((item) =>
    winner.evidenceIds.has(item.id) ? { ...item, verified: true } : item
  )

  // Regra dura: veredito insuficiente NUNCA carrega localização.
  const location: ResolvedLocation | undefined =
    verdict === 'insufficient'
      ? undefined
      : {
          city: winner.city,
          region: winner.region,
          country: winner.country,
          countryCode: winner.countryCode,
          lat: winner.lat,
          lon: winner.lon,
          displayName: winner.displayName,
          uncertaintyKm: uncertaintyKm(granularity, confidence)
        }

  const alternatives = clusters.slice(1, 4).map((cluster) => ({
    city: cluster.city,
    region: cluster.region,
    country: cluster.country,
    countryCode: cluster.countryCode,
    lat: cluster.lat,
    lon: cluster.lon,
    displayName: cluster.displayName,
    score: clamp01(cluster.score),
    provider: 'fusão',
    supportedBy: [...cluster.evidenceIds]
  }))

  const { summary, spoken } = compose({
    verdict,
    granularity,
    confidence,
    location,
    conflicting,
    supportingCount: supporting.length
  })

  return {
    verdict,
    granularity: verdict === 'insufficient' ? 'none' : granularity,
    confidence,
    location,
    alternatives,
    evidence: annotated,
    summary,
    spoken
  }
}

function buildClusters(candidates: LocationCandidate[]): Cluster[] {
  const map = new Map<string, Cluster>()

  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.lat) || !Number.isFinite(candidate.lon)) continue

    const countryKey = candidate.countryCode ?? candidate.country ?? '??'
    const cityKey = candidate.city ?? ''
    const key = `${countryKey}|${cityKey}`

    const existing = map.get(key)
    if (!existing) {
      map.set(key, {
        key,
        city: candidate.city,
        region: candidate.region,
        country: candidate.country,
        countryCode: candidate.countryCode,
        lat: candidate.lat,
        lon: candidate.lon,
        displayName: candidate.displayName,
        geoQuality: candidate.score,
        evidenceIds: new Set(candidate.supportedBy ?? []),
        queries: new Set(candidate.query ? [candidate.query] : []),
        score: 0
      })
      continue
    }

    for (const id of candidate.supportedBy ?? []) existing.evidenceIds.add(id)
    if (candidate.query) existing.queries.add(candidate.query)
    // Mantém as coordenadas do candidato mais bem pontuado do grupo.
    if (candidate.score > existing.geoQuality) {
      existing.geoQuality = candidate.score
      existing.lat = candidate.lat
      existing.lon = candidate.lon
      existing.displayName = candidate.displayName
      existing.region ??= candidate.region
    }
  }

  const clusters = [...map.values()]

  // Um cluster só de país é redundante quando já existe uma cidade naquele
  // país: em vez de competir com ela, empresta suas pistas e sai de cena.
  const cityCountries = new Set(
    clusters.filter((cluster) => cluster.city).map((cluster) => cluster.countryCode ?? cluster.country)
  )

  return clusters.filter((cluster) => {
    if (cluster.city) return true
    const country = cluster.countryCode ?? cluster.country
    if (!country || !cityCountries.has(country)) return true

    for (const target of clusters) {
      if (target.city && (target.countryCode ?? target.country) === country) {
        for (const id of cluster.evidenceIds) target.evidenceIds.add(id)
      }
    }
    return false
  })
}

/**
 * Pistas de nível país (idioma, moeda, bandeira, placa de veículo) não geram
 * consulta própria, mas confirmam ou enfraquecem um cluster já existente.
 */
function applyCountryLevelEvidence(
  clusters: Cluster[],
  evidence: Evidence[],
  hint: VisionResult['hint'] | undefined
): void {
  const countryEvidence = evidence.filter((item) => COUNTRY_EVIDENCE.has(item.kind))
  if (countryEvidence.length === 0 && !hint?.country) return

  const hintedCountry = hint?.country?.toLowerCase()

  for (const cluster of clusters) {
    const clusterCountry = cluster.country?.toLowerCase()
    if (!clusterCountry) continue
    if (hintedCountry && clusterCountry.includes(hintedCountry)) {
      for (const item of countryEvidence) cluster.evidenceIds.add(item.id)
    }
  }
}

function scoreCluster(cluster: Cluster, byId: Map<string, Evidence>): number {
  const weights = [...cluster.evidenceIds]
    .map((id) => byId.get(id)?.weight ?? 0)
    .filter((weight) => weight > 0)

  const evidenceStrength = noisyOr(weights)
  if (evidenceStrength === 0) return 0

  // A qualidade do geocódigo modula, mas não zera: um lugar pouco "importante"
  // no OSM ainda é um lugar real.
  const geoFactor = 0.55 + 0.45 * clamp01(cluster.geoQuality)
  let score = evidenceStrength * geoFactor

  // Corroboração: consultas independentes que caem no mesmo lugar.
  const independentQueries = cluster.queries.size
  if (independentQueries >= 3) score += (1 - score) * 0.4
  else if (independentQueries === 2) score += (1 - score) * 0.25

  return Math.min(MAX_CONFIDENCE, clamp01(score))
}

function insufficient(evidence: Evidence[], reason: string): FusionOutput {
  return {
    verdict: 'insufficient',
    granularity: 'none',
    confidence: 0,
    alternatives: [],
    evidence,
    summary: `Não há dados suficientes para determinar o local. ${reason}`,
    spoken: 'Não há dados suficientes na imagem para identificar o local.'
  }
}

function compose(input: {
  verdict: Verdict
  granularity: Granularity
  confidence: number
  location?: ResolvedLocation
  conflicting: boolean
  supportingCount: number
}): { summary: string; spoken: string } {
  const { verdict, granularity, confidence, location, conflicting, supportingCount } = input
  const label = confidenceLabel(confidence)
  const percent = Math.round(confidence * 100)

  if (verdict === 'insufficient' || !location) {
    return {
      summary:
        'Não há dados suficientes para determinar o local. As pistas encontradas não são específicas o bastante para apontar uma cidade ou país.',
      spoken: 'Não há dados suficientes na imagem para identificar o local.'
    }
  }

  const place = formatPlace(location)
  const evidenceNote = `${supportingCount} ${supportingCount === 1 ? 'pista sustenta' : 'pistas sustentam'} esta conclusão.`

  if (verdict === 'located') {
    return {
      summary: `${place}. Confiança ${label} (${percent}%). ${evidenceNote}`,
      spoken: `Provavelmente ${spokenPlace(location)}. Confiança ${label}.`
    }
  }

  // Ambíguo — o texto precisa deixar claro o que NÃO foi determinado.
  if (conflicting) {
    return {
      summary: `Resultado ambíguo: as pistas apontam para mais de um país. O candidato mais forte é ${place}, com confiança ${label} (${percent}%), mas não é possível confirmar. ${evidenceNote}`,
      spoken: `As pistas apontam para mais de um país. O candidato mais provável é ${spokenPlace(location)}, mas não dá para confirmar.`
    }
  }

  if (granularity === 'city') {
    return {
      summary: `Indício de ${place}, mas sem confirmação suficiente. Confiança ${label} (${percent}%). ${evidenceNote}`,
      spoken: `Possivelmente ${spokenPlace(location)}, mas a confiança é ${label}.`
    }
  }

  const scope = granularity === 'region' ? 'a região' : 'o país'
  return {
    summary: `Não foi possível determinar a cidade. Só deu para chegar a ${scope}: ${place}. Confiança ${label} (${percent}%). ${evidenceNote}`,
    spoken: `Não consegui determinar a cidade. ${granularity === 'region' ? 'A região' : 'O país'} mais provável é ${spokenPlace(location)}.`
  }
}

/** "Cidade, Região, País" — omitindo o que não foi resolvido. */
export function formatPlace(location: ResolvedLocation): string {
  const parts = [location.city, location.region, location.country].filter(
    (part): part is string => Boolean(part && part.trim())
  )
  // Evita "São Paulo, São Paulo" quando cidade e estado têm o mesmo nome.
  const deduped = parts.filter((part, index) => index === 0 || part !== parts[index - 1])
  return deduped.length > 0 ? deduped.join(', ') : location.displayName
}

function spokenPlace(location: ResolvedLocation): string {
  if (location.city && location.country) return `${location.city}, ${location.country}`
  return location.city ?? location.region ?? location.country ?? location.displayName
}

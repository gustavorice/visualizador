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
  SOURCE_TRUST,
  THRESHOLDS,
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
  /**
   * Quais etapas estavam realmente ativas.
   *
   * Um "não sei" só é útil se disser POR QUE não sabe. Sem isso, uma foto de
   * paisagem analisada com a visão desligada devolve o mesmo texto genérico
   * de uma tela sem nenhuma pista, e o usuário não tem como saber que falta
   * ligar um modelo.
   */
  setup?: {
    visionEnabled: boolean
    ocrEnabled: boolean
    ocrLineCount: number
    queriesAttempted: number
    queriesErrored: number
  }
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
  /** Precisão do candidato representante — decide onde o alfinete cai. */
  precision: number
  evidenceIds: Set<string>
  queries: Set<string>
  score: number
  /** Confiabilidade da melhor origem que sustenta este grupo. */
  trust: number
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
  const { evidence, candidates, hint, setup } = input
  const byId = new Map(evidence.map((item) => [item.id, item]))

  const clusters = candidates.length === 0 ? [] : buildClusters(candidates)
  if (clusters.length === 0) {
    return insufficient(evidence, setup)
  }

  // Pistas que restringem apenas o país reforçam qualquer cluster daquele país.
  applyCountryLevelEvidence(clusters, evidence, hint)

  for (const cluster of clusters) {
    cluster.score = scoreCluster(cluster, byId)
    cluster.trust = trustOf(cluster, byId)
  }
  clusters.sort((a, b) => b.score - a.score)

  const winner = clusters[0]!
  const runnerUp = clusters[1]

  /*
   * Conflito real: o segundo colocado aponta para OUTRO país com força
   * comparável E com pistas de confiabilidade comparável.
   *
   * A segunda condição importa. Um endereço lido do título da janela é texto
   * exato; um endereço quase idêntico lido pelo OCR pode ser o MESMO endereço
   * com um caractere perdido — foi o que aconteceu com "Av. M 17" virando
   * "Av. 17", que existe na Argentina. Sem comparar a confiabilidade das
   * origens, um erro de leitura empata com o dado exato e derruba um acerto
   * para "ambíguo".
   */
  const conflicting =
    !!runnerUp &&
    !!runnerUp.countryCode &&
    !!winner.countryCode &&
    runnerUp.countryCode !== winner.countryCode &&
    runnerUp.score >= winner.score * 0.8 &&
    runnerUp.trust >= winner.trust - 0.15

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

  /*
   * O título da janela diz o que a JANELA é, não o que a IMAGEM mostra.
   *
   * Um navegador aberto em "985 Av. M 17 - Google Maps" pode estar exibindo
   * uma foto qualquer, e aí o título é texto exato sobre a página errada.
   * Quando nada lido dos pixels corrobora o título, o resultado não pode subir
   * a "localizado" — no máximo fica em "ambíguo", dizendo de onde veio a pista
   * para o usuário julgar.
   */
  const titleOnly =
    supporting.length > 0 && supporting.every((item) => item.source === 'title')

  const confidence = titleOnly
    ? Math.min(clamp01(winner.score), THRESHOLDS.located - 0.05)
    : clamp01(winner.score)

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
          uncertaintyKm: uncertaintyKm(granularity, confidence, winner.precision)
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
    titleOnly,
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
        precision: candidate.precision ?? 0.5,
        evidenceIds: new Set(candidate.supportedBy ?? []),
        queries: new Set(candidate.query ? [candidate.query] : []),
        score: 0,
        trust: 0
      })
      continue
    }

    for (const id of candidate.supportedBy ?? []) existing.evidenceIds.add(id)
    if (candidate.query) existing.queries.add(candidate.query)

    // A qualidade do grupo é a do melhor candidato…
    existing.geoQuality = Math.max(existing.geoQuality, candidate.score)

    // …mas o REPRESENTANTE é o mais preciso. Todos os candidatos do grupo
    // concordam sobre a cidade, então entre "Rio Claro" e "Avenida M 17, Rio
    // Claro" a rua é estritamente melhor: mesmo lugar, alfinete mais exato.
    // Usar `score` aqui escolheria a cidade, porque uma cidade é mais
    // "importante" no OSM que uma rua.
    const candidatePrecision = candidate.precision ?? 0.5
    if (candidatePrecision > existing.precision) {
      existing.precision = candidatePrecision
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

/** Confiabilidade do grupo: a melhor origem entre as pistas que o sustentam. */
function trustOf(cluster: Cluster, byId: Map<string, Evidence>): number {
  const values = [...cluster.evidenceIds]
    .map((id) => byId.get(id))
    .filter((item): item is Evidence => Boolean(item))
    .map((item) => SOURCE_TRUST[item.source] ?? 0.7)
  return values.length > 0 ? Math.max(...values) : 0.7
}

function scoreCluster(cluster: Cluster, byId: Map<string, Evidence>): number {
  const weights = [...cluster.evidenceIds]
    .map((id) => byId.get(id)?.weight ?? 0)
    .filter((weight) => weight > 0)

  const evidenceStrength = noisyOr(weights)
  if (evidenceStrength === 0) return 0

  /*
   * A qualidade do geocódigo modula, mas não zera.
   *
   * `importance` do OSM mede FAMA, não qualidade da correspondência — uma rua
   * residencial correta pontua 0,05 e um endereço errado numa cidadezinha
   * pontua 0,00. Usar isso como fator de confiança punia exatamente os acertos
   * mais precisos. A precisão do resultado (rua, endereço) é o sinal certo:
   * ela diz o quão específico foi o casamento. A importância entra só como
   * bônus, para não perder o caso do monumento famoso.
   */
  const resolution = Math.max(clamp01(cluster.precision), clamp01(cluster.geoQuality))
  const geoFactor = 0.55 + 0.45 * resolution
  let score = evidenceStrength * geoFactor

  // Corroboração: consultas independentes que caem no mesmo lugar.
  const independentQueries = cluster.queries.size
  if (independentQueries >= 3) score += (1 - score) * 0.4
  else if (independentQueries === 2) score += (1 - score) * 0.25

  return Math.min(MAX_CONFIDENCE, clamp01(score))
}

function insufficient(evidence: Evidence[], setup: FusionInput['setup']): FusionOutput {
  const foundSomething = evidence.length > 0

  // A recomendação depende de qual etapa poderia ter encontrado a pista que
  // faltou — dizer só "não sei" deixa o usuário sem próximo passo.
  let reason: string
  if (setup && !setup.visionEnabled && !foundSomething && setup.ocrLineCount > 0) {
    // O OCR funcionou: o problema é o CONTEÚDO da tela, não a leitura. Sem
    // essa distinção o usuário fica mexendo no OCR quando o que falta é
    // capturar uma tela que tenha endereço, ou ligar a visão.
    reason =
      `O OCR leu ${setup.ocrLineCount} linha(s) de texto, mas nenhuma continha endereço, ` +
      'cidade, domínio ou telefone reconhecível — e o modelo de visão está desligado. ' +
      'Confira o texto lido no painel abaixo: se o endereço aparece lá, me avise; ' +
      'se a tela não tem endereço escrito, ligue um modelo de visão em Configurações.'
  } else if (setup && !setup.visionEnabled && !foundSomething) {
    reason =
      'O OCR não conseguiu ler nenhum texto nesta imagem e o modelo de visão está ' +
      'desligado, então nada pôde ser reconhecido. Se a tela tem texto pequeno, aumente ' +
      '"Largura da captura" em Configurações; para cenas sem texto (paisagens, fachadas, ' +
      'monumentos), ligue um modelo de visão.'
  } else if (setup && !setup.ocrEnabled) {
    reason =
      'O OCR está desligado, então nenhum texto da tela foi lido. ' +
      'Ligue o Tesseract em Configurações — a maior parte das capturas traz o endereço escrito.'
  } else if (setup && setup.queriesErrored > 0 && setup.queriesErrored === setup.queriesAttempted) {
    // Consulta bloqueada por rede ou limite de taxa não é "lugar não existe".
    reason =
      `Todas as ${setup.queriesAttempted} consulta(s) ao serviço de geocodificação ` +
      'falharam — provavelmente rede ou limite de requisições. Veja o painel ' +
      '"Consultas ao mapa" abaixo e tente de novo em alguns segundos.'
  } else if (setup && setup.queriesAttempted === 0 && foundSomething) {
    // Pistas existem, mas nenhuma é geocodificável (idioma, vegetação…).
    reason =
      'As pistas encontradas não são do tipo que se resolve em coordenada ' +
      '(idioma, vegetação, arquitetura). Faltou algo concreto como nome de rua, ' +
      'cidade, estabelecimento ou monumento.'
  } else if (foundSomething) {
    reason =
      'As pistas encontradas foram consultadas no mapa, mas nenhuma corresponde a um ' +
      'lugar real. Veja o painel "Consultas ao mapa" abaixo para o que foi perguntado.'
  } else {
    reason = 'Nenhuma pista geográfica foi encontrada nesta imagem.'
  }

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
  titleOnly: boolean
  supportingCount: number
}): { summary: string; spoken: string } {
  const { verdict, granularity, confidence, location, conflicting, titleOnly, supportingCount } =
    input
  const label = confidenceLabel(confidence)
  const percent = Math.round(confidence * 100)

  if (verdict === 'insufficient' || !location) {
    // O caminho normal para "insuficiente" é a função `insufficient()`, que
    // monta um texto específico. Este ramo só cobre o caso raro de o veredito
    // virar insuficiente já com candidatos em mãos.
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

  if (titleOnly) {
    return {
      summary:
        `${place} — mas essa pista veio do NOME DA JANELA, não da imagem. ` +
        'Nada no que foi capturado confirma o lugar, e o título pode descrever ' +
        'outra página. Trate como indício fraco.',
      spoken: `O nome da janela sugere ${spokenPlace(location)}, mas a imagem não confirma.`
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

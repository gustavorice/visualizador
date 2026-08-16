/**
 * Verificação do núcleo de análise, sem Electron.
 *
 * Roda o caminho real — extração de pistas do OCR, fusão com as pistas de
 * visão, montagem das consultas, geocodificação e veredito — usando os
 * provedores simulados. É o que garante que as regras anti-invenção estão de
 * fato ativas: em especial, que o cenário sem pistas termina em
 * "insuficiente" e SEM localização, e que uma cena com idioma reconhecível
 * mas nenhuma pista dura para em "ambíguo" no nível de país, sem cravar uma
 * cidade.
 *
 * Uso: npm run verify
 */
import { MockOcrProvider } from '../src/main/providers/ocr/mock'
import { MockVisionProvider } from '../src/main/providers/vision/mock'
import { MockGeoProvider } from '../src/main/providers/geo/mock'
import { buildQueries, extractOcrEvidence, mergeEvidence } from '../src/main/pipeline/queries'
import { fuse } from '../src/main/pipeline/fuse'
import { SCENARIOS } from '../src/main/providers/scenarios'
import type { LocationCandidate, Verdict } from '../src/shared/types'

interface Expectation {
  scenario: string
  verdict: Verdict
  city?: string
  country?: string
  hasLocation: boolean
}

const EXPECTED: Expectation[] = [
  { scenario: 'sao-paulo', verdict: 'located', city: 'São Paulo', country: 'Brasil', hasLocation: true },
  { scenario: 'lisboa', verdict: 'located', city: 'Lisboa', country: 'Portugal', hasLocation: true },
  { scenario: 'japao-generico', verdict: 'ambiguous', country: 'Japão', hasLocation: true },
  { scenario: 'sem-pistas', verdict: 'insufficient', hasLocation: false }
]

const ocrProvider = new MockOcrProvider()
const visionProvider = new MockVisionProvider()
const geoProvider = new MockGeoProvider()

const context = {
  signal: new AbortController().signal,
  timeoutMs: 5000,
  frameId: 'quadro-de-teste'
}

/** Reproduz o pipeline usando um cenário fixo em vez do hash da imagem. */
async function runScenario(key: string): Promise<{
  verdict: Verdict
  city?: string
  country?: string
  confidence: number
  hasLocation: boolean
  evidenceCount: number
  queryCount: number
}> {
  const scenario = SCENARIOS.find((item) => item.key === key)
  if (!scenario) throw new Error(`cenário desconhecido: ${key}`)

  // Os provedores simulados escolhem o cenário pelo hash da entrada, então
  // aqui montamos as saídas diretamente a partir do cenário desejado.
  const ocr = {
    engine: ocrProvider.name,
    text: scenario.ocrLines.join('\n'),
    lines: scenario.ocrLines.map((text) => ({ text, confidence: 0.9 })),
    durationMs: 0
  }

  const vision = await visionProvider.analyze('', context)
  // Substitui as pistas pelo cenário-alvo, mantendo o formato do provedor.
  const visionEvidence = scenario.clues.map((clue, index) => ({
    id: `vis-fixed-${key}-${index}`,
    kind: clue.kind,
    value: clue.value,
    detail: clue.detail,
    weight: vision.evidence[0]?.weight ?? 0.5,
    source: 'vision' as const
  }))

  // Peso correto por tipo, como o provedor real faz.
  const { EVIDENCE_WEIGHT } = await import('../src/shared/confidence')
  for (const item of visionEvidence) item.weight = EVIDENCE_WEIGHT[item.kind]

  const ocrEvidence = extractOcrEvidence(ocr)
  const evidence = mergeEvidence(ocrEvidence, visionEvidence)
  const queries = buildQueries(evidence, scenario.hint, 5)

  const settled = await Promise.all(queries.map((query) => geoProvider.geocode(query, context)))
  const candidates: LocationCandidate[] = settled.flat()

  const result = fuse({ evidence, candidates, hint: scenario.hint })

  return {
    verdict: result.verdict,
    city: result.location?.city,
    country: result.location?.country,
    confidence: result.confidence,
    hasLocation: Boolean(result.location),
    evidenceCount: evidence.length,
    queryCount: queries.length
  }
}

async function main(): Promise<void> {
  let failures = 0

  for (const expectation of EXPECTED) {
    const actual = await runScenario(expectation.scenario)
    const problems: string[] = []

    if (actual.verdict !== expectation.verdict) {
      problems.push(`veredito ${actual.verdict}, esperado ${expectation.verdict}`)
    }
    if (actual.hasLocation !== expectation.hasLocation) {
      problems.push(`hasLocation ${actual.hasLocation}, esperado ${expectation.hasLocation}`)
    }
    if (expectation.city && actual.city !== expectation.city) {
      problems.push(`cidade ${actual.city ?? '(nenhuma)'}, esperada ${expectation.city}`)
    }
    if (expectation.country && actual.country !== expectation.country) {
      problems.push(`país ${actual.country ?? '(nenhum)'}, esperado ${expectation.country}`)
    }
    // Invariante central: veredito insuficiente jamais carrega coordenada.
    if (actual.verdict === 'insufficient' && actual.hasLocation) {
      problems.push('INVARIANTE VIOLADA: veredito insuficiente com localização')
    }

    const status = problems.length === 0 ? 'OK  ' : 'FALHA'
    const place = [actual.city, actual.country].filter(Boolean).join(', ') || '(sem local)'
    console.log(
      `${status} ${expectation.scenario.padEnd(16)} ${actual.verdict.padEnd(13)} ` +
        `${String(Math.round(actual.confidence * 100)).padStart(3)}%  ` +
        `pistas=${String(actual.evidenceCount).padStart(2)} consultas=${actual.queryCount}  ${place}`
    )

    for (const problem of problems) {
      console.log(`      -> ${problem}`)
      failures += 1
    }
  }

  console.log(failures === 0 ? '\nTodos os cenários passaram.' : `\n${failures} verificação(ões) falharam.`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()

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
import { buildQueries, extractOcrEvidence, extractTitleEvidence, mergeEvidence } from '../src/main/pipeline/queries'
import { fuse } from '../src/main/pipeline/fuse'
import { isPhotoNoise, weightFor } from '../src/main/providers/vision/prompt'
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
  // Sem texto nem monumento, o máximo honesto é o país — nunca a cidade.
  { scenario: 'geoguessr-costa', verdict: 'ambiguous', country: 'Grécia', hasLocation: true },
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

/**
 * Extração de endereço a partir de texto real de tela.
 *
 * O caso é uma captura do Street View: o endereço e a cidade estão escritos
 * na própria interface, então um OCR real resolve isso sem depender de
 * nenhum modelo de visão. Estes casos existem porque a versão anterior do
 * extrator perdia os dois — nomes curtos de logradouro ("Av. M 17") e a
 * linha "Cidade, Região" não casavam com nenhum padrão.
 */
const EXTRACTION_CASES: Array<{ nome: string; linhas: string[]; espera: string[] }> = [
  {
    nome: 'street-view-rio-claro',
    linhas: [
      '1387 Av. M 17',
      'Rio Claro, State of São Paulo',
      'Google Street View',
      'Jun 2011  See more dates'
    ],
    espera: ['Av. M 17, 1387', 'Rio Claro, State of São Paulo']
  },
  {
    nome: 'placa-caixa-alta',
    linhas: ['AV. PAULISTA', 'MASP', '(11) 3251-4000', 'www.masp.org.br'],
    espera: ['AV. PAULISTA', '(11) 3251-4000', 'masp.org.br']
  },
  {
    nome: 'rua-numerada',
    linhas: ['Rua 5, 240', 'Goiânia - Goiás'],
    espera: ['Rua 5, 240', 'Goiânia - Goiás']
  }
]

/**
 * Títulos de janela reais. Navegadores põem o título da página na barra, e
 * serviços de mapa põem o endereço no título — a resposta chega exata, sem
 * passar por reconhecimento de imagem.
 */
const TITLE_CASES: Array<{ titulo: string; espera: string[] }> = [
  { titulo: '985 Av. M 17 - Google Maps - Google Chrome', espera: ['Av. M 17, 985'] },
  { titulo: 'Rua Augusta, 1200 - Google Maps', espera: ['Rua Augusta, 1200'] },
  { titulo: 'Visualizador', espera: [] },
  { titulo: 'analyze.ts - visualizador - Visual Studio Code', espera: [] }
]

function checkTitles(): number {
  let failures = 0
  console.log('\n--- extração a partir do título da janela ---')

  for (const caso of TITLE_CASES) {
    const values = extractTitleEvidence(caso.titulo).map((item) => item.value)
    const missing = caso.espera.filter((expected) => !values.includes(expected))
    // Um título sem endereço não pode inventar pista nenhuma.
    const spurious = caso.espera.length === 0 && values.length > 0

    const status = missing.length === 0 && !spurious ? 'OK  ' : 'FALHA'
    console.log(`${status} ${caso.titulo.slice(0, 44).padEnd(46)} ${JSON.stringify(values)}`)
    for (const item of missing) {
      console.log(`      -> não extraiu: ${item}`)
      failures += 1
    }
    if (spurious) {
      console.log('      -> extraiu pista de um título sem endereço')
      failures += 1
    }
  }

  return failures
}

/**
 * Uma descrição não é uma identificação.
 *
 * "ponte vermelha em arco" descreve corretamente a Zhivopisny e não serve
 * para nada: nenhum mapa procura por isso. Deixá-la com peso de monumento faz
 * uma descrição genérica dominar a fusão e produzir confiança alta sobre nada.
 */
function checkWeights(): number {
  let failures = 0
  console.log('\n--- descrição genérica vs. nome próprio ---')

  const cases: Array<{ valor: string; nomeado: boolean }> = [
    { valor: 'Red arch bridge', nomeado: false },
    { valor: 'ponte vermelha em arco', nomeado: false },
    { valor: 'Ponte Zhivopisny', nomeado: true },
    { valor: 'Zhivopisny', nomeado: true },
    { valor: 'Catedral de Colônia', nomeado: true }
  ]

  for (const caso of cases) {
    const peso = weightFor('landmark', caso.valor)
    // Nomeado mantém peso de monumento; genérico cai para peso de paisagem.
    const ok = caso.nomeado ? peso >= 0.8 : peso <= 0.2
    if (!ok) failures += 1
    console.log(`${ok ? 'OK  ' : 'FALHA'} ${caso.valor.padEnd(26)} peso=${peso.toFixed(2)}`)
  }

  for (const ruido of ['Aerial view', 'vista aérea', 'foto']) {
    const ok = isPhotoNoise(ruido)
    if (!ok) failures += 1
    console.log(`${ok ? 'OK  ' : 'FALHA'} descartado como ruído: ${ruido}`)
  }

  return failures
}

function checkExtraction(): number {
  let failures = 0
  console.log('\n--- extração de endereço a partir do OCR ---')

  for (const caso of EXTRACTION_CASES) {
    const evidence = extractOcrEvidence({
      engine: 'teste',
      text: caso.linhas.join('\n'),
      lines: caso.linhas.map((text) => ({ text, confidence: 0.95 })),
      durationMs: 0
    })

    const values = evidence.map((item) => item.value)
    const missing = caso.espera.filter((expected) => !values.includes(expected))
    const status = missing.length === 0 ? 'OK  ' : 'FALHA'

    console.log(`${status} ${caso.nome.padEnd(24)} ${JSON.stringify(values)}`)
    for (const item of missing) {
      console.log(`      -> não extraiu: ${item}`)
      failures += 1
    }
  }

  return failures
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

  failures += checkExtraction()
  failures += checkTitles()
  failures += checkWeights()

  console.log(failures === 0 ? '\nTodos os cenários passaram.' : `\n${failures} verificação(ões) falharam.`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()

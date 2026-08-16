import { before, describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { NominatimGeoProvider } from '../src/main/providers/geo/nominatim'
import { fuse } from '../src/main/pipeline/fuse'
import { buildQueries } from '../src/main/pipeline/queries'
import type { Evidence, EvidenceKind, LocationCandidate } from '../src/shared/types'
import { EVIDENCE_WEIGHT } from '../src/shared/confidence'

/**
 * Testes contra os serviços REAIS: Wikidata e Nominatim.
 *
 * Ficam atrás de `VISUALIZADOR_TESTE_REDE=1` (`npm run test:live`) porque
 * dependem de rede e das políticas de uso de terceiros — a instância pública
 * do Nominatim aceita 1 req/s, então esta suíte é lenta por construção e não
 * pode rodar a cada salvamento.
 *
 * O que ela cobre é o que nenhum teste com dados falsos cobre: se um lugar de
 * verdade, escrito como o modelo de visão escreveria, resolve mesmo. Foi
 * exatamente aí que o app falhava — "Ponte Zhivopisny" existe no OSM apenas
 * como "Живописный мост", e a consulta voltava vazia sem nenhum erro.
 *
 * Cada teste começa checando se o serviço está mesmo atendendo. Rodar a suíte
 * várias vezes seguidas faz a instância pública começar a recusar, e um teste
 * vermelho porque "o Nominatim disse não" é pior que nenhum teste: manda
 * procurar defeito onde não há. Nesse caso a suíte se declara PULADA, com o
 * motivo. Se isso acontecer, espere alguns minutos antes de repetir.
 */

const ATIVO = process.env.VISUALIZADOR_TESTE_REDE === '1'
const motivo = ATIVO ? false : 'requer rede — rode com `npm run test:live`'

const geo = new NominatimGeoProvider()
const context = { signal: new AbortController().signal, timeoutMs: 20_000, frameId: 'live' }

/** Preenchido quando o serviço externo não está atendendo. */
let servicoFora: string | null = null

before(async () => {
  if (!ATIVO) return
  const saude = await geo.health().catch(() => ({ ready: false, detail: 'sem resposta' }))
  if (!saude.ready) {
    servicoFora = `geocodificador indisponível ou limitando requisições (${saude.detail})`
  }
})

/** Interrompe o teste com explicação quando o problema é do serviço, não nosso. */
function exigeServico(t: TestContext): boolean {
  if (!servicoFora) return false
  t.skip(servicoFora)
  return true
}

let seq = 0
function evidence(kind: EvidenceKind, value: string, source: Evidence['source'] = 'vision'): Evidence {
  seq += 1
  return { id: `live-${seq}`, kind, value, weight: EVIDENCE_WEIGHT[kind], source }
}

/** Roda o caminho real: pistas -> consultas -> geocodificação -> veredito. */
async function analisar(
  pistas: Evidence[],
  hint?: { country?: string; city?: string; language?: string }
): Promise<ReturnType<typeof fuse> & { candidates: LocationCandidate[] }> {
  const queries = buildQueries(pistas, hint, geo.maxQueries?.() ?? 4)
  const candidates: LocationCandidate[] = []
  let erros = 0

  for (const query of queries) {
    try {
      candidates.push(...(await geo.geocode(query, context)))
    } catch {
      erros += 1
    }
  }

  const resultado = fuse({
    evidence: pistas,
    candidates,
    hint,
    setup: {
      visionEnabled: true,
      ocrEnabled: true,
      ocrLineCount: 4,
      queriesAttempted: queries.length,
      queriesErrored: erros
    }
  })

  return { ...resultado, candidates }
}

describe('lugares reais — monumentos', { skip: motivo, timeout: 240_000 }, () => {
  it('resolve um monumento cujo nome no OSM está em outro alfabeto', async (t) => {
    if (exigeServico(t)) return
    // O caso que motivou o resolvedor da Wikidata: no OSM esta ponte só existe
    // como "Живописный мост". Nem a transliteração nem o nome em português
    // retornam qualquer coisa do Nominatim.
    const resultado = await analisar([evidence('landmark', 'Ponte Zhivopisny, Moscou')])

    assert.equal(resultado.location?.countryCode, 'RU', resultado.summary)
    assert.match(resultado.location?.city ?? '', /Mosc/)
  })

  it('resolve um monumento mundialmente conhecido', async (t) => {
    if (exigeServico(t)) return
    const resultado = await analisar([evidence('landmark', 'Torre Eiffel')])
    assert.equal(resultado.location?.countryCode, 'FR', resultado.summary)
    assert.match(resultado.location?.city ?? '', /Paris/)
    assert.equal(resultado.verdict, 'located')
  })

  it('resolve um monumento brasileiro', async (t) => {
    if (exigeServico(t)) return
    const resultado = await analisar([evidence('landmark', 'Cristo Redentor')])
    assert.equal(resultado.location?.countryCode, 'BR', resultado.summary)
    assert.match(resultado.location?.city ?? '', /Rio de Janeiro/)
  })

  it('resolve um monumento português', async (t) => {
    if (exigeServico(t)) return
    const resultado = await analisar([evidence('landmark', 'Elevador de Santa Justa')])
    assert.equal(resultado.location?.countryCode, 'PT', resultado.summary)
    assert.match(resultado.location?.city ?? '', /Lisboa/)
  })

  it('cai para só o nome quando o modelo colou a cidade junto', async (t) => {
    if (exigeServico(t)) return
    // A busca de texto completo trata "Nome, Cidade" como uma frase única e
    // não encontra nada; só o nome encontra na hora.
    const resultado = await analisar([evidence('landmark', 'Coliseu, Roma')])
    assert.equal(resultado.location?.countryCode, 'IT', resultado.summary)
  })
})

describe('lugares reais — endereços', { skip: motivo, timeout: 240_000 }, () => {
  it('resolve um endereço com número', async (t) => {
    if (exigeServico(t)) return
    const resultado = await analisar([
      evidence('street_sign', 'Avenida Paulista, 1578', 'ocr'),
      evidence('locality', 'São Paulo, State of São Paulo', 'ocr')
    ])

    assert.equal(resultado.location?.countryCode, 'BR', resultado.summary)
    assert.match(resultado.location?.city ?? '', /São Paulo/)
    assert.equal(resultado.verdict, 'located')
  })

  it('desambigua uma rua homônima pela cidade lida na tela', async (t) => {
    if (exigeServico(t)) return
    // "Rua Augusta" existe em Lisboa e em São Paulo.
    const lisboa = await analisar([
      evidence('street_sign', 'Rua Augusta', 'ocr'),
      evidence('locality', 'Lisboa, Portugal', 'ocr')
    ])
    assert.equal(lisboa.location?.countryCode, 'PT', lisboa.summary)
  })

  it('resolve uma localidade escrita com o ruído administrativo em inglês', async (t) => {
    if (exigeServico(t)) return
    // Medido: "Rio Claro, State of São Paulo" devolve ZERO resultados e
    // "Rio Claro, São Paulo" devolve três. A limpeza é o que fecha esse buraco.
    const resultado = await analisar([
      evidence('locality', 'Rio Claro, State of São Paulo', 'ocr')
    ])
    assert.equal(resultado.location?.countryCode, 'BR', resultado.summary)
    assert.match(resultado.location?.city ?? '', /Rio Claro/)
  })

  it('põe o alfinete na rua, não no centro da cidade', async (t) => {
    if (exigeServico(t)) return
    const resultado = await analisar([
      evidence('street_sign', 'Avenida Paulista', 'ocr'),
      evidence('locality', 'São Paulo', 'ocr')
    ])

    assert.ok(resultado.location, resultado.summary)
    // O centro geométrico do município fica a mais de 3 km da Paulista; um
    // alfinete na avenida cai a menos de 3 km do ponto de referência abaixo.
    const distancia = distanciaKm(
      resultado.location!.lat,
      resultado.location!.lon,
      -23.5614,
      -46.6558
    )
    assert.ok(distancia < 3, `alfinete a ${distancia.toFixed(1)} km da Avenida Paulista`)
  })
})

describe('lugares reais — recusa de inventar', { skip: motivo, timeout: 240_000 }, () => {
  it('não devolve local para um nome que não existe', async (t) => {
    if (exigeServico(t)) return
    // A garantia contra invenção não é proibir o modelo de dar nomes: é o
    // nome ter que sobreviver à geocodificação. Este não sobrevive.
    const resultado = await analisar([
      evidence('landmark', 'Ponte Memorial Zyxwvu de Testes Automatizados')
    ])

    assert.equal(resultado.verdict, 'insufficient')
    assert.equal(resultado.location, undefined)
  })

  it('preserva o país deduzido quando o nome do monumento não resolve', async (t) => {
    if (exigeServico(t)) return
    // Regressão: a pista dura que não geocodifica derrubava a análise inteira
    // para "não sei", apagando um país perfeitamente deduzido pelos sinais.
    const resultado = await analisar(
      [
        evidence('landmark', 'Ponte Memorial Zyxwvu de Testes Automatizados'),
        evidence('vegetation', 'bétulas e coníferas'),
        evidence('architecture', 'blocos residenciais soviéticos'),
        evidence('language', 'russo')
      ],
      { country: 'Rússia' }
    )

    assert.equal(resultado.location?.countryCode, 'RU', resultado.summary)
    assert.equal(resultado.verdict, 'ambiguous', 'país sozinho nunca é "localizado"')
    assert.equal(resultado.location?.city, undefined)
  })

  it('resolve o país do caso GeoGuessr, sem texto nem monumento', async (t) => {
    if (exigeServico(t)) return
    const resultado = await analisar(
      [
        evidence('vegetation', 'oliveiras e mato seco mediterrâneo'),
        evidence('architecture', 'muro caiado de branco'),
        evidence('signage_style', 'faixa contínua branca na borda da pista'),
        evidence('landscape', 'costa rochosa recortada')
      ],
      { country: 'Grécia' }
    )

    assert.equal(resultado.location?.countryCode, 'GR', resultado.summary)
    assert.equal(resultado.granularity, 'country')
    assert.equal(resultado.verdict, 'ambiguous')
  })
})

describe('serviço acessível', { skip: motivo, timeout: 60_000 }, () => {
  it('o Nominatim responde', async (t) => {
    if (servicoFora) return t.skip(servicoFora)
    const saude = await geo.health()
    assert.equal(saude.ready, true, saude.detail)
  })
})

/** Haversine, só para medir se o alfinete caiu perto do lugar certo. */
function distanciaKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (value: number): number => (value * Math.PI) / 180
  const dLat = rad(lat2 - lat1)
  const dLon = rad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

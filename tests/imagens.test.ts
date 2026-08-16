import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TesseractOcrProvider } from '../src/main/providers/ocr/tesseract'
import { buildQueries, extractOcrEvidence } from '../src/main/pipeline/queries'
import type { Evidence, EvidenceKind, OcrResult } from '../src/shared/types'
import { findBrowser, render, type Scene } from './helpers/render'

/**
 * Caminho completo com IMAGENS DE VERDADE: telas renderizadas num navegador,
 * lidas pelo Tesseract de verdade, extraídas pela lógica de verdade.
 *
 * Vale o custo porque o modo de falha mais caro deste app não é a regex errada
 * — é a regex certa sobre um texto que o OCR nunca conseguiu ler. Um teste que
 * alimenta strings prontas não enxerga essa diferença.
 *
 * A suíte se desliga sozinha, com explicação, quando não há navegador ou
 * quando os dados de idioma não puderam ser obtidos: é infraestrutura
 * ausente, não regressão do código.
 */

const OUT = join(process.cwd(), '.cache', 'cenas')
const ocr = new TesseractOcrProvider()

const CONTEXT = { signal: new AbortController().signal, timeoutMs: 60_000, frameId: 'teste' }

/** Um painel de aplicativo de mapas, que é a captura mais comum na prática. */
function painel(titulo: string, linhas: string[]): string {
  return `<div style="display:flex;height:100vh">
    <div style="width:34%;padding:40px 32px;border-right:1px solid #ddd">
      <div style="font-size:40px;font-weight:700;margin-bottom:18px">${titulo}</div>
      ${linhas
        .map((linha) => `<div style="font-size:28px;margin-bottom:14px">${linha}</div>`)
        .join('')}
    </div>
    <div style="flex:1;background:linear-gradient(160deg,#e8f0e4,#dfe7ef)"></div>
  </div>`
}

const CENAS: Array<Scene & { local: string }> = [
  {
    key: 'sao-paulo-mapa',
    local: 'São Paulo, Brasil',
    html: painel('Av. Paulista, 1578', [
      'São Paulo, State of São Paulo',
      'MASP - Museu de Arte de Sao Paulo',
      'masp.org.br',
      '(11) 3149-5959'
    ])
  },
  {
    key: 'lisboa-mapa',
    local: 'Lisboa, Portugal',
    html: painel('Rua Augusta', ['Lisboa, Portugal', 'Arco da Rua Augusta', 'Baixa-Chiado'])
  },
  {
    key: 'rio-claro-mapa',
    local: 'Rio Claro, Brasil',
    html: painel('985 Av. M 17', ['Rio Claro, State of Sao Paulo', 'CEP 13501-320'])
  },
  {
    key: 'toquio-hotel',
    local: 'Tóquio, Japão',
    html: painel('Shibuya Station Hotel', [
      'Shibuya, Tokyo Prefecture',
      'hotel-shibuya.co.jp',
      'Check-in 15:00'
    ])
  },
  {
    key: 'editor-codigo',
    local: 'nenhum',
    html: `<div style="background:#1e1e28;color:#dcdce4;height:100vh;padding:40px;
             font-family:monospace;font-size:26px;line-height:1.6">
             <div>src/main/pipeline/analyze.ts</div>
             <div>export async function analyze(options: AnalyzeOptions) {</div>
             <div>&nbsp;&nbsp;const settings = getSettings()</div>
             <div>&nbsp;&nbsp;return fuse({ evidence, candidates })</div>
             <div>}</div>
             <div style="margin-top:30px">npm run dev</div>
             <div>TypeScript - UTF-8 - LF</div>
           </div>`
  },
  {
    key: 'paisagem-sem-texto',
    local: 'nenhum',
    // O caso do GeoGuessr: só imagem, nada escrito. O OCR não tem o que fazer,
    // e o app tem que dizer isso em vez de improvisar.
    html: `<div style="height:100vh;background:linear-gradient(#8ec5e8 0%,#cfe3f0 55%,#c9b98a 55%,#a89460 100%)">
             <div style="position:absolute;top:38%;left:0;right:0;height:6px;background:#6b6b60"></div>
           </div>`
  }
]

const imagens = new Map<string, Buffer>()
const leituras = new Map<string, OcrResult>()
let indisponivel: string | null = null

before(async () => {
  if (!findBrowser()) {
    indisponivel = 'nenhum Chromium instalado neste ambiente'
    return
  }

  try {
    for (const cena of CENAS) imagens.set(cena.key, readFileSync(render(cena, OUT)))
  } catch (error) {
    indisponivel = `falha ao renderizar as cenas: ${String(error)}`
    return
  }

  try {
    for (const cena of CENAS) {
      leituras.set(cena.key, await ocr.recognize(imagens.get(cena.key)!, CONTEXT))
    }
  } catch (error) {
    // Primeira execução sem rede: os dados de idioma não puderam ser baixados.
    indisponivel = `Tesseract indisponível (dados de idioma): ${String(error)}`
  }
})

after(async () => {
  await ocr.dispose()
})

/** Lança quando a suíte está desligada, com o motivo, em vez de falhar mudo. */
function leitura(key: string): OcrResult {
  if (indisponivel) throw new Error(indisponivel)
  const found = leituras.get(key)
  assert.ok(found, `cena "${key}" não foi lida`)
  return found
}

function pistas(key: string): Evidence[] {
  return extractOcrEvidence(leitura(key))
}

function valores(evidence: Evidence[], kind: EvidenceKind): string[] {
  return evidence.filter((item) => item.kind === kind).map((item) => item.value)
}

const skip = (): string | false => indisponivel ?? false

describe('imagens renderizadas — São Paulo', { skip: skip() }, () => {
  it('lê o endereço da tela', () => {
    const encontrado = valores(pistas('sao-paulo-mapa'), 'street_sign')
    assert.ok(
      encontrado.some((valor) => /Paulista/.test(valor)),
      `esperado o endereço da Paulista, veio: ${encontrado.join(' | ')}`
    )
  })

  it('lê o domínio e o telefone', () => {
    const encontrado = pistas('sao-paulo-mapa')
    assert.deepEqual(valores(encontrado, 'domain'), ['masp.org.br'])
    assert.ok(valores(encontrado, 'phone').length === 1)
  })

  it('monta a consulta com a cidade lida na tela e sem o ruído administrativo', () => {
    const queries = buildQueries(pistas('sao-paulo-mapa'), undefined, 6)
    const textos = queries.map((query) => query.text)
    assert.ok(
      textos.some((texto) => /Paulista.*S[ãa]o Paulo/.test(texto)),
      `esperada consulta rua+cidade, veio: ${textos.join(' | ')}`
    )
    assert.ok(
      textos.every((texto) => !/State of/.test(texto)),
      `"State of" devolve zero resultados no Nominatim: ${textos.join(' | ')}`
    )
  })
})

describe('imagens renderizadas — Lisboa', { skip: skip() }, () => {
  it('lê a rua e a localidade', () => {
    const encontrado = pistas('lisboa-mapa')
    assert.ok(valores(encontrado, 'street_sign').some((valor) => /Augusta/.test(valor)))
    assert.ok(valores(encontrado, 'locality').some((valor) => /Lisboa/.test(valor)))
  })

  it('desambigua a Rua Augusta com a cidade certa', () => {
    // "Rua Augusta" existe em Lisboa e em São Paulo. Sem a cidade na consulta,
    // o geocodificador escolhe por fama, não por acerto.
    const textos = buildQueries(pistas('lisboa-mapa'), undefined, 6).map((query) => query.text)
    assert.ok(
      textos.some((texto) => /Augusta.*Lisboa/.test(texto)),
      textos.join(' | ')
    )
  })
})

describe('imagens renderizadas — Rio Claro', { skip: skip() }, () => {
  it('lê o endereço de nome curto que o padrão antigo perdia', () => {
    const encontrado = valores(pistas('rio-claro-mapa'), 'street_sign')
    assert.ok(
      encontrado.some((valor) => /M 17/.test(valor)),
      `esperado "Av. M 17", veio: ${encontrado.join(' | ')}`
    )
  })

  it('junta o número predial que aparece antes da via', () => {
    const encontrado = valores(pistas('rio-claro-mapa'), 'street_sign')
    assert.ok(
      encontrado.some((valor) => /M 17,\s*985/.test(valor)),
      `esperado o número 985 junto ao endereço, veio: ${encontrado.join(' | ')}`
    )
  })
})

describe('imagens renderizadas — Tóquio', { skip: skip() }, () => {
  it('lê o domínio territorial e a localidade', () => {
    const encontrado = pistas('toquio-hotel')
    assert.ok(
      valores(encontrado, 'domain').some((valor) => /co\.jp/.test(valor)),
      valores(encontrado, 'domain').join(' | ')
    )
    assert.ok(valores(encontrado, 'locality').some((valor) => /Shibuya/.test(valor)))
  })

  it('preserva "Tokyo Prefecture", que geocodifica bem como está', () => {
    const textos = buildQueries(pistas('toquio-hotel'), undefined, 6).map((query) => query.text)
    assert.ok(
      textos.some((texto) => /Tokyo Prefecture/.test(texto)),
      textos.join(' | ')
    )
  })
})

describe('imagens renderizadas — telas sem lugar nenhum', { skip: skip() }, () => {
  it('não inventa pista numa tela de editor de código', () => {
    // O OCR lê MUITO texto aqui. O teste é que nada disso vira lugar: é o
    // caminho honesto de falha, e é onde um extrator ganancioso se trai.
    const lido = leitura('editor-codigo')
    assert.ok(lido.lines.length > 3, 'a cena precisa mesmo ter texto para o teste valer')

    const encontrado = pistas('editor-codigo')
    assert.deepEqual(
      encontrado.map((item) => `${item.kind}=${item.value}`),
      [],
      'pistas falsas extraídas de uma tela sem geografia'
    )
  })

  it('não extrai nada de uma imagem sem texto', () => {
    assert.deepEqual(pistas('paisagem-sem-texto'), [])
  })

  it('não monta consulta nenhuma sem pista', () => {
    assert.deepEqual(buildQueries(pistas('paisagem-sem-texto'), undefined, 6), [])
  })

  it('sem pista dura, o palpite de país do modelo ainda vira consulta', () => {
    // É o que salva a foto de estrada: sem isso a análise inteira morre em
    // "não sei" mesmo com o país deduzido corretamente.
    const queries = buildQueries(pistas('paisagem-sem-texto'), { country: 'Grécia' }, 6)
    assert.equal(queries.length, 1)
    assert.equal(queries[0]!.text, 'Grécia')
  })
})

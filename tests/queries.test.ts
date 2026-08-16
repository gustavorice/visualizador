import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildQueries,
  cleanForGeocoding,
  extractOcrEvidence,
  extractTitleEvidence,
  mergeEvidence
} from '../src/main/pipeline/queries'
import type { Evidence, EvidenceKind, OcrResult } from '../src/shared/types'
import { EVIDENCE_WEIGHT } from '../src/shared/confidence'

/** Monta um `OcrResult` a partir de linhas soltas. */
function ocr(...lines: string[]): OcrResult {
  return {
    engine: 'teste',
    text: lines.join('\n'),
    lines: lines.map((text) => ({ text, confidence: 0.9 })),
    durationMs: 0
  }
}

/** Valores extraídos de um certo tipo, para asserção legível. */
function valuesOf(evidence: Evidence[], kind: EvidenceKind): string[] {
  return evidence.filter((item) => item.kind === kind).map((item) => item.value)
}

let seq = 0
function evidence(partial: Partial<Evidence> & { kind: EvidenceKind; value: string }): Evidence {
  seq += 1
  return {
    id: `e${seq}`,
    detail: undefined,
    weight: EVIDENCE_WEIGHT[partial.kind],
    source: 'vision',
    ...partial
  }
}

describe('extração de logradouro', () => {
  it('lê um endereço brasileiro comum', () => {
    const found = extractOcrEvidence(ocr('Av. Paulista 1578'))
    assert.deepEqual(valuesOf(found, 'street_sign'), ['Av. Paulista, 1578'])
  })

  it('aceita nome de rua de um caractere só', () => {
    // Cidades planejadas brasileiras usam "Av. M 17", "Rua 5". Sem aceitar o
    // primeiro token curto, o endereço inteiro passava despercebido.
    const found = extractOcrEvidence(ocr('985 Av. M 17'))
    assert.deepEqual(valuesOf(found, 'street_sign'), ['Av. M 17, 985'])
  })

  it('pega o número depois do nome da via', () => {
    const found = extractOcrEvidence(ocr('Rua Augusta, 240'))
    assert.deepEqual(valuesOf(found, 'street_sign'), ['Rua Augusta, 240'])
  })

  it('não confunde número distante com número predial', () => {
    // "1200" está no começo da linha, longe da via: é preço, código, o que for.
    const found = extractOcrEvidence(ocr('1200 pontos ganhos hoje na Rua Augusta'))
    assert.deepEqual(valuesOf(found, 'street_sign'), ['Rua Augusta'])
  })

  it('lê logradouro em caixa alta', () => {
    const found = extractOcrEvidence(ocr('AVENIDA BRASIL'))
    assert.equal(valuesOf(found, 'street_sign').length, 1)
  })

  it('ignora "Street View", que não é endereço', () => {
    // Regressão: enquanto 'Street' era prefixo de logradouro, o rótulo do
    // Google Maps virava um endereço e ia parar no geocodificador.
    const found = extractOcrEvidence(ocr('Street View', 'Imagens © 2024'))
    assert.deepEqual(valuesOf(found, 'street_sign'), [])
  })

  it('não transforma prosa em endereço', () => {
    // Sem a distinção de caixa, "rua estreita" no meio de uma frase casaria.
    const found = extractOcrEvidence(
      ocr('era uma rua estreita e mal iluminada', 'seguimos pela avenida principal')
    )
    assert.deepEqual(valuesOf(found, 'street_sign'), [])
  })

  it('extrai de várias linhas sem misturá-las', () => {
    // Casar através da quebra de linha produziria "Rua Augusta, 900" com o
    // número da linha seguinte — um endereço que não está na tela.
    const found = extractOcrEvidence(ocr('Rua Augusta', '900 metros à frente'))
    assert.deepEqual(valuesOf(found, 'street_sign'), ['Rua Augusta'])
  })
})

describe('extração de localidade, domínio e telefone', () => {
  it('lê "Cidade, Região" numa linha própria', () => {
    const found = extractOcrEvidence(ocr('Rio Claro, State of São Paulo'))
    assert.deepEqual(valuesOf(found, 'locality'), ['Rio Claro, State of São Paulo'])
  })

  it('lê domínio com sufixo territorial', () => {
    const found = extractOcrEvidence(ocr('visite masp.org.br para mais'))
    assert.deepEqual(valuesOf(found, 'domain'), ['masp.org.br'])
  })

  it('lê telefone com DDD', () => {
    const found = extractOcrEvidence(ocr('Farmácia 24h (11) 3251-4000'))
    assert.deepEqual(valuesOf(found, 'phone'), ['(11) 3251-4000'])
  })

  it('lê CEP', () => {
    const found = extractOcrEvidence(ocr('CEP 01310-200'))
    assert.ok(valuesOf(found, 'street_sign').includes('01310-200'))
  })

  it('não repete a mesma pista vista duas vezes', () => {
    const found = extractOcrEvidence(ocr('Rua Augusta', 'RUA AUGUSTA'))
    assert.equal(valuesOf(found, 'street_sign').length, 1)
  })

  it('não encontra nada numa tela de editor de código', () => {
    const found = extractOcrEvidence(
      ocr(
        'src/main/pipeline/analyze.ts',
        'export async function analyze(options: AnalyzeOptions)',
        'npm run dev',
        'TypeScript • UTF-8 • LF'
      )
    )
    assert.deepEqual(found, [], `pistas falsas: ${found.map((item) => item.value).join(' | ')}`)
  })
})

describe('pistas do título da janela', () => {
  it('extrai o endereço que o navegador põe no título', () => {
    const found = extractTitleEvidence('985 Av. M 17 - Google Maps - Google Chrome')
    assert.deepEqual(valuesOf(found, 'street_sign'), ['Av. M 17, 985'])
    assert.equal(found[0]?.source, 'title')
  })

  it('não cola o fim de um segmento no começo do outro', () => {
    // Sem separar por " - ", "Chrome" entraria no nome da via.
    const found = extractTitleEvidence('Rua Augusta - Mozilla Firefox')
    assert.deepEqual(valuesOf(found, 'street_sign'), ['Rua Augusta'])
  })

  it('pesa mais que a mesma pista vinda do OCR', () => {
    const doTitulo = extractTitleEvidence('Rua Augusta - Google Maps')[0]!
    const doOcr = extractOcrEvidence(ocr('Rua Augusta'))[0]!
    assert.ok(doTitulo.weight > doOcr.weight)
    assert.ok(doTitulo.weight <= 0.9, 'nem o título chega a peso máximo')
  })

  it('devolve lista vazia para título sem conteúdo geográfico', () => {
    assert.deepEqual(extractTitleEvidence('Visualizador'), [])
    assert.deepEqual(extractTitleEvidence(''), [])
    assert.deepEqual(extractTitleEvidence('   '), [])
  })
})

describe('fusão de pistas de fontes diferentes', () => {
  it('mantém uma só cópia quando OCR e visão veem a mesma coisa', () => {
    const daVisao = [evidence({ kind: 'street_sign', value: 'Rua Augusta', source: 'vision' })]
    const doOcr = [evidence({ kind: 'street_sign', value: 'RUA AUGUSTA', source: 'ocr' })]

    const merged = mergeEvidence(doOcr, daVisao)
    assert.equal(merged.length, 1)
  })

  it('eleva o peso na corroboração, sem chegar a 1', () => {
    const daVisao = [
      evidence({ kind: 'street_sign', value: 'Rua Augusta', source: 'vision', weight: 0.6 })
    ]
    const doOcr = [evidence({ kind: 'street_sign', value: 'Rua Augusta', source: 'ocr' })]

    const merged = mergeEvidence(doOcr, daVisao)
    assert.ok(merged[0]!.weight > 0.6)
    assert.ok(merged[0]!.weight < 1)
  })

  it('registra a corroboração mesmo quando não havia detalhe', () => {
    // Regressão: o ramo falso do ternário gravava `undefined` e apagava o
    // campo, escondendo justamente a informação mais forte da lista.
    const daVisao = [
      evidence({ kind: 'landmark', value: 'MASP', source: 'vision', detail: undefined })
    ]
    const doOcr = [evidence({ kind: 'landmark', value: 'MASP', source: 'ocr' })]

    const merged = mergeEvidence(doOcr, daVisao)
    assert.match(merged[0]!.detail ?? '', /Confirmado também pelo OCR/)
  })

  it('não altera os objetos originais', () => {
    // A lista da visão é devolvida ao usuário como registro do que o modelo
    // respondeu; a fusão não pode reescrevê-la por baixo.
    const original = evidence({ kind: 'landmark', value: 'MASP', source: 'vision', weight: 0.5 })
    const daVisao = [original]
    const doOcr = [evidence({ kind: 'landmark', value: 'MASP', source: 'ocr' })]

    mergeEvidence(doOcr, daVisao)
    assert.equal(original.weight, 0.5)
    assert.equal(original.detail, undefined)
  })

  it('não soma peso quando a mesma fonte repete a pista', () => {
    const a = evidence({ kind: 'landmark', value: 'MASP', source: 'vision', weight: 0.5 })
    const b = evidence({ kind: 'landmark', value: 'masp', source: 'vision', weight: 0.5 })
    const merged = mergeEvidence([], [a, b])
    assert.equal(merged.length, 1)
    assert.equal(merged[0]!.weight, 0.5)
  })
})

describe('limpeza para geocodificação', () => {
  it('remove qualificador administrativo prefixado', () => {
    // Medido contra o Nominatim: a forma com "State of" devolve zero
    // resultados, a forma sem devolve três.
    assert.equal(cleanForGeocoding('Rio Claro, State of São Paulo'), 'Rio Claro, São Paulo')
    assert.equal(cleanForGeocoding('Rio Claro, Estado de São Paulo'), 'Rio Claro, São Paulo')
    assert.equal(cleanForGeocoding('Córdoba, Provincia de Córdoba'), 'Córdoba, Córdoba')
  })

  it('preserva qualificador posfixado, que geocodifica bem como está', () => {
    assert.equal(cleanForGeocoding('Shibuya, Tokyo Prefecture'), 'Shibuya, Tokyo Prefecture')
    assert.equal(cleanForGeocoding('Anaheim, Orange County'), 'Anaheim, Orange County')
  })

  it('preserva nomes que contêm "Cidade de" de verdade', () => {
    assert.equal(cleanForGeocoding('City of London'), 'City of London')
    assert.equal(cleanForGeocoding('Cidade de Deus, Rio de Janeiro'), 'Cidade de Deus, Rio de Janeiro')
  })

  it('normaliza espaços deixados pela remoção', () => {
    assert.equal(cleanForGeocoding('  Lisboa ,  Portugal  '), 'Lisboa, Portugal')
  })
})

describe('construção das consultas', () => {
  it('só consulta pistas duras', () => {
    const pistas = [
      evidence({ kind: 'landmark', value: 'Torre Eiffel' }),
      evidence({ kind: 'vegetation', value: 'plátanos' }),
      evidence({ kind: 'language', value: 'francês' })
    ]
    const queries = buildQueries(pistas, undefined, 5)
    assert.deepEqual(
      queries.map((query) => query.text),
      ['Torre Eiffel']
    )
  })

  it('gera a variante com cidade e a variante sem, para rua e comércio', () => {
    const pistas = [
      evidence({ kind: 'street_sign', value: 'Rua Augusta', source: 'ocr' }),
      evidence({ kind: 'locality', value: 'Lisboa, Portugal', source: 'ocr' })
    ]
    const textos = buildQueries(pistas, undefined, 5).map((query) => query.text)
    assert.ok(textos.includes('Rua Augusta, Lisboa, Portugal'), textos.join(' | '))
    assert.ok(textos.includes('Rua Augusta'), textos.join(' | '))
  })

  it('prefere a cidade LIDA na tela à cidade palpitada pelo modelo', () => {
    // Regressão: a lista fundida traz as pistas da visão primeiro, então um
    // `find` só por tipo devolvia o palpite antes da leitura.
    const pistas = [
      evidence({ kind: 'locality', value: 'Buenos Aires', source: 'vision' }),
      evidence({ kind: 'street_sign', value: 'Rua Augusta', source: 'ocr' }),
      evidence({ kind: 'locality', value: 'Lisboa', source: 'ocr' })
    ]
    const textos = buildQueries(pistas, { city: 'Madri' }, 6).map((query) => query.text)
    assert.ok(textos.includes('Rua Augusta, Lisboa'), textos.join(' | '))
    assert.ok(!textos.includes('Rua Augusta, Buenos Aires'), textos.join(' | '))
  })

  it('ordena por prioridade e respeita o limite', () => {
    const pistas = [
      evidence({ kind: 'landmark', value: 'Torre Eiffel' }),
      evidence({ kind: 'phone', value: '(11) 3251-4000' }),
      evidence({ kind: 'transit', value: 'Baixa-Chiado' }),
      evidence({ kind: 'domain', value: 'masp.org.br' })
    ]
    const queries = buildQueries(pistas, undefined, 2)
    assert.equal(queries.length, 2)
    assert.equal(queries[0]!.text, 'Torre Eiffel')
    assert.ok(queries[0]!.priority >= queries[1]!.priority)
  })

  it('consulta o país quando o modelo o deduz sem nenhuma pista dura', () => {
    // O caso do GeoGuessr: estrada, sem texto e sem monumento.
    const pistas = [
      evidence({ kind: 'vegetation', value: 'oliveiras e mato seco' }),
      evidence({ kind: 'architecture', value: 'muro caiado de branco' }),
      evidence({ kind: 'signage_style', value: 'faixa contínua na borda' })
    ]
    const queries = buildQueries(pistas, { country: 'Grécia' }, 5)
    assert.equal(queries.length, 1)
    assert.equal(queries[0]!.text, 'Grécia')
    assert.equal(
      queries[0]!.evidenceIds?.length,
      3,
      'a consulta de país precisa carregar as pistas moles; sem evidência ela pontua zero'
    )
    assert.equal(queries[0]!.countryHint, 'GR')
  })

  it('mantém o país como rede de segurança mesmo havendo pista dura', () => {
    // Regressão: um monumento com nome errado não geocodifica, e antes ele
    // derrubava a análise inteira para "não sei" apagando um país bem deduzido.
    const pistas = [
      evidence({ kind: 'landmark', value: 'Ponte Inexistente de Testes' }),
      evidence({ kind: 'vegetation', value: 'bétulas' })
    ]
    const textos = buildQueries(pistas, { country: 'Rússia' }, 5).map((query) => query.text)
    assert.ok(textos.includes('Ponte Inexistente de Testes'), textos.join(' | '))
    assert.ok(textos.includes('Rússia'), textos.join(' | '))
    assert.equal(textos[textos.length - 1], 'Rússia', 'o país é a última opção, nunca a primeira')
  })

  it('deduz o código do país pelo idioma quando ele aponta para um só', () => {
    const pistas = [evidence({ kind: 'transit', value: 'Shibuya Station' })]
    const queries = buildQueries(pistas, { language: 'japonês' }, 5)
    assert.equal(queries[0]!.countryHint, 'JP')
  })

  it('não deduz país por idioma falado em vários', () => {
    const pistas = [evidence({ kind: 'transit', value: 'Estação da Luz' })]
    const queries = buildQueries(pistas, { language: 'português' }, 5)
    assert.equal(queries[0]!.countryHint, undefined)
  })

  it('limpa o ruído administrativo antes de consultar', () => {
    const pistas = [evidence({ kind: 'locality', value: 'Rio Claro, State of São Paulo' })]
    const queries = buildQueries(pistas, undefined, 5)
    assert.equal(queries[0]!.text, 'Rio Claro, São Paulo')
  })

  it('não devolve consultas duplicadas', () => {
    const pistas = [
      evidence({ kind: 'landmark', value: 'MASP' }),
      evidence({ kind: 'business', value: 'masp' })
    ]
    const queries = buildQueries(pistas, undefined, 5)
    assert.equal(queries.length, 1)
  })

  it('devolve lista vazia sem pista nenhuma', () => {
    assert.deepEqual(buildQueries([], undefined, 5), [])
    assert.deepEqual(buildQueries([], {}, 5), [])
  })
})

describe('nome de via com conectivo', () => {
  // Regressão: o nome tinha de começar por maiúscula, então "Rua do Ouvidor"
  // e "Avenida das Nações Unidas" — endereços corriqueiros — não casavam.
  it('lê "Rua do Ouvidor"', () => {
    const found = extractOcrEvidence(ocr('Rua do Ouvidor'))
    assert.deepEqual(valuesOf(found, 'street_sign'), ['Rua do Ouvidor'])
  })

  it('lê "Avenida das Nações Unidas"', () => {
    const found = extractOcrEvidence(ocr('Avenida das Nações Unidas'))
    assert.deepEqual(valuesOf(found, 'street_sign'), ['Avenida das Nações Unidas'])
  })

  it('lê "Rua 25 de Março"', () => {
    const found = extractOcrEvidence(ocr('Rua 25 de Março'))
    assert.deepEqual(valuesOf(found, 'street_sign'), ['Rua 25 de Março'])
  })

  it('para o nome onde a frase começa', () => {
    // Regressão: "Rua Augusta fechada para obras" virava a consulta inteira.
    const found = extractOcrEvidence(ocr('Rua Augusta fechada para obras hoje'))
    assert.deepEqual(valuesOf(found, 'street_sign'), ['Rua Augusta'])
  })

  it('não deixa um conectivo puxar palavra minúscula qualquer', () => {
    const found = extractOcrEvidence(ocr('Rua das casas antigas do bairro'))
    assert.deepEqual(valuesOf(found, 'street_sign'), [])
  })

  it('mantém o número da rodovia dentro do nome da via', () => {
    const found = extractOcrEvidence(ocr('Rodovia BR 116'))
    assert.deepEqual(valuesOf(found, 'street_sign'), ['Rodovia BR 116'])
  })
})

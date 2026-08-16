import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fuse, formatPlace } from '../src/main/pipeline/fuse'
import type { Evidence, EvidenceKind, LocationCandidate } from '../src/shared/types'
import { EVIDENCE_WEIGHT, THRESHOLDS } from '../src/shared/confidence'

let seq = 0
function evidence(
  partial: Partial<Evidence> & { kind: EvidenceKind; value: string }
): Evidence {
  seq += 1
  return {
    id: `e${seq}`,
    weight: EVIDENCE_WEIGHT[partial.kind],
    source: 'vision',
    ...partial
  }
}

function candidate(partial: Partial<LocationCandidate> = {}): LocationCandidate {
  return {
    lat: -23.56,
    lon: -46.65,
    displayName: 'São Paulo, Brasil',
    city: 'São Paulo',
    region: 'São Paulo',
    country: 'Brasil',
    countryCode: 'BR',
    score: 0.6,
    precision: 0.55,
    provider: 'teste',
    ...partial
  }
}

const SETUP = {
  visionEnabled: true,
  ocrEnabled: true,
  ocrLineCount: 5,
  queriesAttempted: 2,
  queriesErrored: 0
}

describe('fusão — caminho de sucesso', () => {
  it('localiza com pista dura forte e resolução precisa', () => {
    const pista = evidence({ kind: 'landmark', value: 'MASP' })
    const resultado = fuse({
      evidence: [pista],
      candidates: [candidate({ precision: 0.9, score: 0.8, supportedBy: [pista.id], query: 'MASP' })],
      setup: SETUP
    })

    assert.equal(resultado.verdict, 'located')
    assert.equal(resultado.location?.city, 'São Paulo')
    assert.equal(resultado.location?.country, 'Brasil')
    assert.ok(resultado.confidence >= THRESHOLDS.located)
  })

  it('marca como verificadas só as pistas que sustentam o vencedor', () => {
    const usada = evidence({ kind: 'landmark', value: 'MASP' })
    const ignorada = evidence({ kind: 'vegetation', value: 'ipês' })
    const resultado = fuse({
      evidence: [usada, ignorada],
      candidates: [candidate({ precision: 0.9, supportedBy: [usada.id] })],
      setup: SETUP
    })

    assert.equal(resultado.evidence.find((item) => item.id === usada.id)?.verified, true)
    assert.notEqual(resultado.evidence.find((item) => item.id === ignorada.id)?.verified, true)
  })

  it('ganha confiança quando consultas independentes concordam', () => {
    const a = evidence({ kind: 'street_sign', value: 'Avenida Paulista' })
    const b = evidence({ kind: 'transit', value: 'Estação Trianon-Masp' })

    const uma = fuse({
      evidence: [a],
      candidates: [candidate({ supportedBy: [a.id], query: 'Avenida Paulista' })],
      setup: SETUP
    })
    const duas = fuse({
      evidence: [a, b],
      candidates: [
        candidate({ supportedBy: [a.id], query: 'Avenida Paulista' }),
        candidate({ supportedBy: [b.id], query: 'Estação Trianon-Masp' })
      ],
      setup: SETUP
    })

    assert.ok(duas.confidence > uma.confidence)
  })
})

describe('fusão — agrupamento de candidatos', () => {
  it('põe o alfinete no candidato mais PRECISO, não no mais famoso', () => {
    // A cidade tem `importance` maior que a rua no OSM. Escolher por
    // importância deixava o alfinete no centro da cidade mesmo com a rua
    // resolvida — foi o erro observado com "Avenida M 17, Rio Claro".
    const pista = evidence({ kind: 'street_sign', value: 'Avenida M 17' })
    const resultado = fuse({
      evidence: [pista],
      candidates: [
        candidate({
          lat: -22.41,
          lon: -47.56,
          displayName: 'Rio Claro, São Paulo, Brasil',
          city: 'Rio Claro',
          score: 0.6,
          precision: 0.53,
          supportedBy: [pista.id],
          query: 'Rio Claro'
        }),
        candidate({
          lat: -22.4123,
          lon: -47.5612,
          displayName: 'Avenida M 17, Rio Claro, São Paulo, Brasil',
          city: 'Rio Claro',
          score: 0.05,
          precision: 0.87,
          supportedBy: [pista.id],
          query: 'Avenida M 17, Rio Claro'
        })
      ],
      setup: SETUP
    })

    assert.match(resultado.location?.displayName ?? '', /Avenida M 17/)
    assert.equal(resultado.location?.lat, -22.4123)
  })

  it('completa o estado a partir de outro candidato do mesmo grupo', () => {
    // Regressão: a resolução de rua costuma vir sem `state` e a de cidade vem
    // com. Como a rua é a mais precisa, ela virava representante e o campo
    // "Estado" saía vazio na tela — apesar de o estado ter sido resolvido.
    const pista = evidence({ kind: 'street_sign', value: 'Avenida M 17' })
    const resultado = fuse({
      evidence: [pista],
      candidates: [
        candidate({
          city: 'Rio Claro',
          region: 'São Paulo',
          precision: 0.53,
          supportedBy: [pista.id],
          query: 'Rio Claro'
        }),
        candidate({
          city: 'Rio Claro',
          region: undefined,
          displayName: 'Avenida M 17, Rio Claro',
          precision: 0.87,
          supportedBy: [pista.id],
          query: 'Avenida M 17'
        })
      ],
      setup: SETUP
    })

    assert.equal(resultado.location?.region, 'São Paulo')
    assert.match(resultado.location?.displayName ?? '', /Avenida M 17/)
  })

  it('absorve o grupo só-de-país quando já existe cidade no mesmo país', () => {
    const dura = evidence({ kind: 'landmark', value: 'MASP' })
    const mole = evidence({ kind: 'language', value: 'português' })

    const resultado = fuse({
      evidence: [dura, mole],
      candidates: [
        candidate({ precision: 0.9, supportedBy: [dura.id], query: 'MASP' }),
        candidate({
          city: undefined,
          region: undefined,
          displayName: 'Brasil',
          precision: 0.13,
          score: 0.45,
          supportedBy: [mole.id],
          query: 'Brasil'
        })
      ],
      setup: SETUP
    })

    assert.equal(resultado.verdict, 'located')
    assert.equal(resultado.alternatives.length, 0, 'o país não compete com a cidade dele mesmo')
    assert.equal(resultado.evidence.find((item) => item.id === mole.id)?.verified, true)
  })

  it('prefere o primeiro resultado da lista ao mais específico da lista', () => {
    /*
     * Regressão medida contra o Nominatim: "Rio Claro, São Paulo" devolve a
     * cidade certa em primeiro (rank OSM 16) e um bairro homônimo de São José
     * dos Campos em terceiro (rank OSM 19). O bairro é o objeto MAIS
     * específico, então vencia por precisão — e o app respondia com a cidade
     * errada, com toda a confiança.
     */
    const pista = evidence({ kind: 'locality', value: 'Rio Claro, São Paulo', source: 'ocr' })
    const resultado = fuse({
      evidence: [pista],
      candidates: [
        candidate({
          city: 'Rio Claro',
          displayName: 'Rio Claro, São Paulo, Brasil',
          score: 0.55,
          precision: 16 / 30,
          rank: 0,
          supportedBy: [pista.id],
          query: 'Rio Claro, São Paulo'
        }),
        candidate({
          city: 'São José dos Campos',
          displayName: 'Rio Claro, São José dos Campos, São Paulo, Brasil',
          lat: -23.19,
          lon: -45.88,
          score: 0.147,
          precision: 19 / 30,
          rank: 2,
          supportedBy: [pista.id],
          query: 'Rio Claro, São Paulo'
        })
      ],
      setup: SETUP
    })

    assert.equal(resultado.location?.city, 'Rio Claro', resultado.summary)
  })

  it('basta uma consulta pôr o lugar em primeiro para ele deixar de ser marginal', () => {
    const pista = evidence({ kind: 'landmark', value: 'MASP' })
    const resultado = fuse({
      evidence: [pista],
      candidates: [
        candidate({ precision: 0.9, rank: 3, supportedBy: [pista.id], query: 'a' }),
        candidate({ precision: 0.9, rank: 0, supportedBy: [pista.id], query: 'b' })
      ],
      setup: SETUP
    })
    assert.equal(resultado.verdict, 'located', resultado.summary)
  })

  it('descarta candidato com coordenada inválida', () => {
    const pista = evidence({ kind: 'landmark', value: 'MASP' })
    const resultado = fuse({
      evidence: [pista],
      candidates: [
        candidate({ lat: Number.NaN, lon: 0, supportedBy: [pista.id] }),
        candidate({ precision: 0.9, supportedBy: [pista.id] })
      ],
      setup: SETUP
    })
    assert.equal(resultado.verdict, 'located')
    assert.equal(resultado.alternatives.length, 0)
  })
})

describe('fusão — recusa de afirmar', () => {
  it('não devolve local nenhum sem candidatos', () => {
    const resultado = fuse({ evidence: [], candidates: [], setup: SETUP })
    assert.equal(resultado.verdict, 'insufficient')
    assert.equal(resultado.location, undefined)
    assert.equal(resultado.confidence, 0)
    assert.equal(resultado.granularity, 'none')
  })

  it('não sobe a cidade quando só pistas moles sustentam', () => {
    const mole = evidence({ kind: 'vegetation', value: 'oliveiras' })
    const resultado = fuse({
      evidence: [mole],
      candidates: [candidate({ precision: 0.9, supportedBy: [mole.id] })],
      setup: SETUP
    })
    assert.notEqual(resultado.verdict, 'located')
  })

  it('não crava a cidade que o modelo de visão só palpitou', () => {
    /*
     * O caso do GeoGuessr: sem texto e sem monumento, o modelo olha o conjunto
     * e diz "Atenas". Isso geocodifica lindamente — toda cidade geocodifica —,
     * e o app respondia com veredito fechado sobre um palpite. Como pista ela
     * continua valendo (vira consulta, sustenta o país); o que ela não pode é
     * assinar sozinha a resposta.
     */
    const palpite = evidence({ kind: 'locality', value: 'Atenas', source: 'vision' })
    const resultado = fuse({
      evidence: [palpite],
      candidates: [
        candidate({
          city: 'Atenas',
          region: 'Ática',
          country: 'Grécia',
          countryCode: 'GR',
          lat: 37.98,
          lon: 23.72,
          displayName: 'Atenas, Grécia',
          score: 0.8,
          precision: 0.53,
          supportedBy: [palpite.id],
          query: 'Atenas'
        })
      ],
      hint: { country: 'Grécia', city: 'Atenas' },
      setup: SETUP
    })

    assert.notEqual(resultado.verdict, 'located', resultado.summary)
    assert.equal(resultado.location?.city, 'Atenas', 'segue aparecendo, como indício')
  })

  it('a mesma cidade LIDA na tela fecha o veredito', () => {
    const lida = evidence({ kind: 'locality', value: 'Atenas', source: 'ocr' })
    const resultado = fuse({
      evidence: [lida],
      candidates: [
        candidate({
          city: 'Atenas',
          country: 'Grécia',
          countryCode: 'GR',
          lat: 37.98,
          lon: 23.72,
          displayName: 'Atenas, Grécia',
          score: 0.8,
          precision: 0.53,
          supportedBy: [lida.id],
          query: 'Atenas'
        })
      ],
      setup: SETUP
    })

    assert.equal(resultado.verdict, 'located', resultado.summary)
  })

  it('para no país quando só o país resolveu', () => {
    const a = evidence({ kind: 'vegetation', value: 'oliveiras e mato seco' })
    const b = evidence({ kind: 'architecture', value: 'muro caiado' })
    const c = evidence({ kind: 'signage_style', value: 'faixa contínua na borda' })
    const d = evidence({ kind: 'landscape', value: 'costa rochosa' })

    const resultado = fuse({
      evidence: [a, b, c, d],
      candidates: [
        candidate({
          city: undefined,
          region: undefined,
          country: 'Grécia',
          countryCode: 'GR',
          displayName: 'Grécia',
          lat: 39.07,
          lon: 21.82,
          score: 0.45,
          precision: 0.13,
          supportedBy: [a.id, b.id, c.id, d.id],
          query: 'Grécia'
        })
      ],
      hint: { country: 'Grécia' },
      setup: SETUP
    })

    assert.equal(resultado.verdict, 'ambiguous')
    assert.equal(resultado.granularity, 'country')
    assert.equal(resultado.location?.country, 'Grécia')
    assert.equal(resultado.location?.city, undefined)
    assert.match(resultado.summary, /Não foi possível determinar a cidade/)
  })

  it('nunca acompanha veredito insuficiente de uma localização', () => {
    // Invariante do produto: "não sei" e um alfinete no mapa são
    // mutuamente exclusivos.
    const fraca = evidence({ kind: 'other', value: 'algo', weight: 0.02 })
    const resultado = fuse({
      evidence: [fraca],
      candidates: [candidate({ score: 0.05, precision: 0.1, supportedBy: [fraca.id] })],
      setup: SETUP
    })

    assert.equal(resultado.verdict, 'insufficient')
    assert.equal(resultado.location, undefined)
    assert.deepEqual(resultado.alternatives, [])
  })

  it('explica que o lugar foi achado mas não sustentado', () => {
    // Regressão: este caminho caía no texto genérico de "nenhuma pista
    // encontrada", que descreve uma situação diferente da que ocorreu.
    const fraca = evidence({ kind: 'other', value: 'algo', weight: 0.02 })
    const resultado = fuse({
      evidence: [fraca],
      candidates: [candidate({ score: 0.05, precision: 0.1, supportedBy: [fraca.id] })],
      setup: SETUP
    })

    assert.match(resultado.summary, /sustentação é fraca/)
    assert.doesNotMatch(resultado.summary, /Nenhuma pista geográfica foi encontrada/)
  })
})

describe('fusão — conflito entre países', () => {
  it('marca ambiguidade quando dois países empatam', () => {
    const a = evidence({ kind: 'street_sign', value: 'Rua Augusta', source: 'ocr' })
    const b = evidence({ kind: 'street_sign', value: 'Rua Augusta', source: 'ocr' })

    const resultado = fuse({
      evidence: [a, b],
      candidates: [
        candidate({
          city: 'São Paulo',
          country: 'Brasil',
          countryCode: 'BR',
          precision: 0.87,
          supportedBy: [a.id],
          query: 'Rua Augusta BR'
        }),
        candidate({
          city: 'Lisboa',
          region: 'Lisboa',
          country: 'Portugal',
          countryCode: 'PT',
          lat: 38.71,
          lon: -9.14,
          displayName: 'Rua Augusta, Lisboa',
          precision: 0.87,
          supportedBy: [b.id],
          query: 'Rua Augusta PT'
        })
      ],
      setup: SETUP
    })

    assert.equal(resultado.verdict, 'ambiguous')
    assert.match(resultado.summary, /mais de um país/)
  })

  it('não deixa leitura de OCR empatar com texto exato do título', () => {
    // Regressão: "Av. M 17" lido do título contra "Av. 17" (a mesma via com um
    // caractere perdido pelo OCR), que existe na Argentina. Sem comparar a
    // confiabilidade das origens, o erro de leitura empatava com o dado exato
    // e derrubava um acerto para "ambíguo".
    const doTitulo = evidence({ kind: 'street_sign', value: 'Av. M 17', source: 'title' })
    const lidoNaTela = evidence({ kind: 'locality', value: 'Rio Claro', source: 'ocr' })
    const lidoErrado = evidence({ kind: 'street_sign', value: 'Av. 17', source: 'ocr' })

    const resultado = fuse({
      evidence: [doTitulo, lidoNaTela, lidoErrado],
      candidates: [
        candidate({
          city: 'Rio Claro',
          countryCode: 'BR',
          precision: 0.87,
          supportedBy: [doTitulo.id, lidoNaTela.id],
          query: 'Av. M 17, Rio Claro'
        }),
        candidate({
          city: 'Rosário',
          country: 'Argentina',
          countryCode: 'AR',
          lat: -32.95,
          lon: -60.66,
          displayName: 'Av. 17, Rosário, Argentina',
          precision: 0.87,
          supportedBy: [lidoErrado.id],
          query: 'Av. 17'
        })
      ],
      setup: SETUP
    })

    assert.equal(resultado.verdict, 'located')
    assert.equal(resultado.location?.city, 'Rio Claro')
    assert.doesNotMatch(resultado.summary, /mais de um país/)
  })

  it('palpite de país errado não derruba um endereço lido da tela', () => {
    /*
     * Regressão: com a consulta de país virando rede de segurança, um punhado
     * de sinais de ambiente ("oliveiras", "muro caiado", "parece grego") mais
     * um palpite errado do modelo formava um cluster que PONTUAVA como
     * concorrente sem SER um — ele não afirma uma cidade, afirma um país
     * inteiro por semelhança. O endereço correto caía para "não é possível
     * confirmar".
     */
    const rua = evidence({ kind: 'street_sign', value: 'Rua Augusta', source: 'ocr' })
    const moles = [
      evidence({ kind: 'vegetation', value: 'oliveiras' }),
      evidence({ kind: 'architecture', value: 'muro caiado' }),
      evidence({ kind: 'signage_style', value: 'faixa contínua' }),
      evidence({ kind: 'language', value: 'grego' })
    ]

    const resultado = fuse({
      evidence: [rua, ...moles],
      candidates: [
        candidate({
          displayName: 'Rua Augusta, São Paulo',
          score: 0.3,
          precision: 0.87,
          supportedBy: [rua.id],
          query: 'Rua Augusta'
        }),
        candidate({
          city: undefined,
          region: undefined,
          country: 'Grécia',
          countryCode: 'GR',
          lat: 39,
          lon: 21.8,
          displayName: 'Grécia',
          score: 0.8,
          precision: 0.13,
          supportedBy: moles.map((item) => item.id),
          query: 'Grécia'
        })
      ],
      hint: { country: 'Grécia' },
      setup: SETUP
    })

    assert.equal(resultado.verdict, 'located', resultado.summary)
    assert.equal(resultado.location?.city, 'São Paulo')
    assert.doesNotMatch(resultado.summary, /mais de um país/)
  })

  it('o título sozinho não crava, mas o motivo é o título — não o conflito', () => {
    // Os dois freios existem e dizem coisas diferentes. Quando só o título
    // sustenta o vencedor, o texto tem que apontar o título; dizer "as pistas
    // apontam para mais de um país" mandaria o usuário investigar a coisa errada.
    const doTitulo = evidence({ kind: 'street_sign', value: 'Av. M 17', source: 'title' })
    const lidoErrado = evidence({ kind: 'street_sign', value: 'Av. 17', source: 'ocr' })

    const resultado = fuse({
      evidence: [doTitulo, lidoErrado],
      candidates: [
        candidate({
          city: 'Rio Claro',
          countryCode: 'BR',
          precision: 0.87,
          supportedBy: [doTitulo.id],
          query: 'Av. M 17, Rio Claro'
        }),
        candidate({
          city: 'Rosário',
          country: 'Argentina',
          countryCode: 'AR',
          lat: -32.95,
          lon: -60.66,
          displayName: 'Av. 17, Rosário, Argentina',
          precision: 0.87,
          supportedBy: [lidoErrado.id],
          query: 'Av. 17'
        })
      ],
      setup: SETUP
    })

    assert.equal(resultado.verdict, 'ambiguous')
    assert.equal(resultado.location?.city, 'Rio Claro')
    assert.match(resultado.summary, /NOME DA JANELA/)
  })
})

describe('fusão — pista vinda só do nome da janela', () => {
  const doTitulo = evidence({ kind: 'street_sign', value: 'Av. M 17', source: 'title' })
  const resultado = fuse({
    evidence: [doTitulo],
    candidates: [
      candidate({ city: 'Rio Claro', precision: 0.87, supportedBy: [doTitulo.id], query: 'Av. M 17' })
    ],
    setup: SETUP
  })

  it('não deixa o título sozinho cravar o lugar', () => {
    // O título diz o que a JANELA é, não o que a IMAGEM mostra: um navegador
    // aberto no Google Maps pode estar exibindo uma foto qualquer.
    assert.equal(resultado.verdict, 'ambiguous')
    assert.ok(resultado.confidence < THRESHOLDS.located)
  })

  it('diz de onde veio a pista, para o usuário julgar', () => {
    assert.match(resultado.summary, /NOME DA JANELA/)
  })
})

describe('fusão — pistas de país', () => {
  it('reforça o cluster do país que o modelo apontou', () => {
    const dura = evidence({ kind: 'landmark', value: 'Acrópole de Atenas' })
    const idioma = evidence({ kind: 'language', value: 'grego' })
    const vegetacao = evidence({ kind: 'vegetation', value: 'oliveiras' })

    const semReforco = fuse({
      evidence: [dura],
      candidates: [
        candidate({ city: 'Atenas', country: 'Grécia', countryCode: 'GR', precision: 0.9, supportedBy: [dura.id] })
      ],
      setup: SETUP
    })
    const comReforco = fuse({
      evidence: [dura, idioma, vegetacao],
      candidates: [
        candidate({ city: 'Atenas', country: 'Grécia', countryCode: 'GR', precision: 0.9, supportedBy: [dura.id] })
      ],
      hint: { country: 'Grécia' },
      setup: SETUP
    })

    assert.ok(comReforco.confidence > semReforco.confidence)
  })

  it('conta idioma e bandeira mesmo sem o modelo palpitar o país', () => {
    // Regressão: sem palpite de país, nenhuma pista de nível país era
    // atribuída a cluster nenhum — e um cluster sem sustentação pontua zero.
    const idioma = evidence({ kind: 'language', value: 'japonês' })
    const dura = evidence({ kind: 'transit', value: 'Shibuya Station' })

    const resultado = fuse({
      evidence: [dura, idioma],
      candidates: [
        candidate({
          city: 'Tóquio',
          region: 'Tóquio',
          country: 'Japão',
          countryCode: 'JP',
          lat: 35.66,
          lon: 139.7,
          displayName: 'Shibuya Station, Tóquio',
          precision: 0.9,
          supportedBy: [dura.id]
        })
      ],
      setup: SETUP
    })

    assert.equal(resultado.evidence.find((item) => item.id === idioma.id)?.verified, true)
  })

  it('não confunde países por continência de nome curto', () => {
    const idioma = evidence({ kind: 'language', value: 'persa' })
    const dura = evidence({ kind: 'landmark', value: 'Ponte Ha’penny' })

    const resultado = fuse({
      evidence: [dura, idioma],
      candidates: [
        candidate({
          city: 'Dublin',
          country: 'Irlanda',
          countryCode: 'IE',
          lat: 53.34,
          lon: -6.26,
          displayName: 'Ha’penny Bridge, Dublin',
          precision: 0.9,
          supportedBy: [dura.id]
        })
      ],
      hint: { country: 'Irã' },
      setup: SETUP
    })

    assert.notEqual(
      resultado.evidence.find((item) => item.id === idioma.id)?.verified,
      true,
      '"Irã" não pode casar dentro de "Irlanda"'
    )
  })
})

describe('fusão — diagnóstico do "não sei"', () => {
  const semNada = { evidence: [], candidates: [] }

  it('aponta a visão desligada quando o OCR leu texto sem geografia', () => {
    const resultado = fuse({
      ...semNada,
      setup: { ...SETUP, visionEnabled: false, ocrLineCount: 12 }
    })
    assert.match(resultado.summary, /leu 12 linha\(s\)/)
    assert.match(resultado.summary, /modelo de visão/)
  })

  it('aponta a captura pequena quando o OCR não leu nada', () => {
    const resultado = fuse({
      ...semNada,
      setup: { ...SETUP, visionEnabled: false, ocrLineCount: 0 }
    })
    assert.match(resultado.summary, /Largura da captura/)
  })

  it('aponta o OCR desligado', () => {
    const resultado = fuse({ ...semNada, setup: { ...SETUP, ocrEnabled: false } })
    assert.match(resultado.summary, /OCR está desligado/)
  })

  it('distingue falha de rede de "lugar não existe"', () => {
    const pista = evidence({ kind: 'landmark', value: 'MASP' })
    const resultado = fuse({
      evidence: [pista],
      candidates: [],
      setup: { ...SETUP, queriesAttempted: 2, queriesErrored: 2 }
    })
    assert.match(resultado.summary, /limite de requisições/)
  })

  it('distingue "pistas não geocodificáveis" de "nada encontrado"', () => {
    const mole = evidence({ kind: 'vegetation', value: 'oliveiras' })
    const resultado = fuse({
      evidence: [mole],
      candidates: [],
      setup: { ...SETUP, queriesAttempted: 0 }
    })
    assert.match(resultado.summary, /não são do tipo que se resolve em coordenada/)
  })

  it('diz claramente quando nada foi encontrado', () => {
    const resultado = fuse({ ...semNada, setup: { ...SETUP, queriesAttempted: 0 } })
    assert.match(resultado.summary, /Nenhuma pista geográfica/)
  })

  it('sempre fala a mesma frase honesta em voz alta', () => {
    const resultado = fuse({ ...semNada, setup: SETUP })
    assert.match(resultado.spoken, /Não há dados suficientes/)
  })
})

describe('formatPlace', () => {
  const base = { lat: 0, lon: 0, displayName: 'algum lugar', uncertaintyKm: 1 }

  it('monta "Cidade, Estado, País"', () => {
    assert.equal(
      formatPlace({ ...base, city: 'Lisboa', region: 'Lisboa', country: 'Portugal' }),
      'Lisboa, Portugal'
    )
  })

  it('não repete cidade e estado de mesmo nome', () => {
    assert.equal(
      formatPlace({ ...base, city: 'São Paulo', region: 'São Paulo', country: 'Brasil' }),
      'São Paulo, Brasil'
    )
  })

  it('omite o que não foi resolvido', () => {
    assert.equal(formatPlace({ ...base, country: 'Japão' }), 'Japão')
  })

  it('cai para o nome completo quando não há campo nenhum', () => {
    assert.equal(formatPlace(base), 'algum lugar')
  })
})

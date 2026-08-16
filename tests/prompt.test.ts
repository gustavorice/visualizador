import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  KNOWN_KINDS,
  RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  USER_PROMPT,
  isPhotoNoise,
  normalizeKind,
  weightFor
} from '../src/main/providers/vision/prompt'
import { EVIDENCE_WEIGHT } from '../src/shared/confidence'

describe('normalizeKind', () => {
  it('aceita os tipos conhecidos', () => {
    for (const kind of KNOWN_KINDS) assert.equal(normalizeKind(kind), kind)
  })

  it('tolera variação de caixa, espaço e hífen', () => {
    assert.equal(normalizeKind('Street Sign'), 'street_sign')
    assert.equal(normalizeKind('LICENSE-PLATE'), 'license_plate')
    assert.equal(normalizeKind('  signage style  '), 'signage_style')
  })

  it('joga tipo inventado em "other" em vez de quebrar', () => {
    assert.equal(normalizeKind('vibe'), 'other')
    assert.equal(normalizeKind(''), 'other')
  })
})

describe('isPhotoNoise', () => {
  it('reconhece descrições da FOTO, não do lugar', () => {
    // Observado: "aerial view" chegou classificado como padrão de sinalização.
    for (const ruido of ['vista aérea', 'Aerial view', 'drone', 'close-up', 'foto', 'céu azul']) {
      assert.ok(isPhotoNoise(ruido), `deveria descartar "${ruido}"`)
    }
  })

  it('não descarta pista de lugar de verdade', () => {
    for (const pista of [
      'Ponte Zhivopisny',
      'oliveiras',
      'placa azul de rodovia',
      'fiação aérea densa',
      'paisagem de montanha'
    ]) {
      assert.ok(!isPhotoNoise(pista), `não deveria descartar "${pista}"`)
    }
  })

  it('exige o termo inteiro, não um pedaço', () => {
    // "Foto de Estúdio Paulista" não é ruído fotográfico: contém um nome.
    assert.ok(!isPhotoNoise('Foto Estúdio Paulista'))
  })
})

describe('weightFor', () => {
  it('mantém o peso alto de um monumento realmente nomeado', () => {
    assert.equal(weightFor('landmark', 'Ponte Zhivopisny'), EVIDENCE_WEIGHT.landmark)
    assert.equal(weightFor('landmark', 'Catedral de Colônia'), EVIDENCE_WEIGHT.landmark)
    assert.equal(weightFor('landmark', 'MASP'), EVIDENCE_WEIGHT.landmark)
  })

  it('rebaixa descrição genérica que veio rotulada como monumento', () => {
    // "ponte vermelha em arco" não é um monumento identificado, é uma
    // descrição — e descrição nenhuma geocodifica. Com peso de monumento ela
    // dominaria a fusão e produziria confiança alta sobre nada.
    assert.equal(weightFor('landmark', 'ponte vermelha em arco'), EVIDENCE_WEIGHT.landscape)
    assert.equal(weightFor('landmark', 'catedral gótica'), EVIDENCE_WEIGHT.landscape)
  })

  it('aplica a mesma régua a localidade', () => {
    assert.equal(weightFor('locality', 'Moscou'), EVIDENCE_WEIGHT.locality)
    assert.equal(weightFor('locality', 'cidade grande'), EVIDENCE_WEIGHT.landscape)
  })

  it('não mexe no peso dos demais tipos', () => {
    assert.equal(weightFor('vegetation', 'oliveiras'), EVIDENCE_WEIGHT.vegetation)
    assert.equal(weightFor('language', 'japonês'), EVIDENCE_WEIGHT.language)
  })
})

describe('contrato do prompt', () => {
  it('pede nome próprio, que é o que geocodifica', () => {
    assert.match(SYSTEM_PROMPT, /NOME PRÓPRIO/)
    assert.match(USER_PROMPT, /nome próprio/i)
  })

  it('proíbe inventar nome de lugar', () => {
    assert.match(SYSTEM_PROMPT, /Não invente NOME de lugar/)
  })

  it('exige a dedução de país mesmo sem monumento nem texto', () => {
    // É o caso do GeoGuessr, e é a maioria das fotos.
    assert.match(SYSTEM_PROMPT, /DEDUZIR O PAÍS/)
    assert.match(SYSTEM_PROMPT, /country_guess/)
  })

  it('lista exatamente os tipos que o pipeline entende', () => {
    for (const kind of KNOWN_KINDS) assert.ok(SYSTEM_PROMPT.includes(kind), `faltou ${kind}`)
  })

  it('o esquema de resposta cobre os tipos conhecidos', () => {
    assert.deepEqual([...RESPONSE_SCHEMA.properties.clues.items.properties.kind.enum], KNOWN_KINDS)
    assert.deepEqual([...RESPONSE_SCHEMA.required], ['scene_description', 'clues'])
  })

  it('limita o número de pistas no ESQUEMA, não só no texto', () => {
    // Modelos pequenos ignoram "no máximo 6" escrito em português; a saída
    // estruturada é imposta pelo decodificador. Cada pista a mais é tempo de
    // geração, que num modelo local é a maior parte da espera.
    assert.equal(RESPONSE_SCHEMA.properties.clues.maxItems, 6)
  })

  it('pede resposta curta, porque cada palavra é espera', () => {
    assert.match(SYSTEM_PROMPT, /SEJA BREVE/)
  })

  it('todo tipo aceito pelo modelo tem peso definido', () => {
    for (const kind of KNOWN_KINDS) {
      assert.equal(typeof EVIDENCE_WEIGHT[kind], 'number', `sem peso para ${kind}`)
    }
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EVIDENCE_WEIGHT,
  HARD_EVIDENCE,
  MAX_CONFIDENCE,
  SOURCE_TRUST,
  THRESHOLDS,
  clamp01,
  confidenceLabel,
  decideVerdict,
  noisyOr,
  uncertaintyKm
} from '../src/shared/confidence'
import type { EvidenceKind } from '../src/shared/types'

describe('noisyOr', () => {
  it('devolve zero sem pistas', () => {
    assert.equal(noisyOr([]), 0)
  })

  it('preserva uma pista isolada', () => {
    assert.ok(Math.abs(noisyOr([0.6]) - 0.6) < 1e-9)
  })

  it('soma pistas fracas sem nunca alcançar a certeza', () => {
    const combinado = noisyOr([0.2, 0.2, 0.2, 0.2, 0.2])
    assert.ok(combinado > 0.2, 'várias pistas fracas somam')
    assert.ok(combinado < 1, 'mas nunca chegam a 1')
  })

  it('é monotônico: acrescentar pista nunca reduz a confiança', () => {
    const antes = noisyOr([0.5])
    const depois = noisyOr([0.5, 0.3])
    assert.ok(depois >= antes)
  })

  it('trata peso fora da faixa sem estourar', () => {
    assert.equal(noisyOr([5]), 1)
    assert.equal(noisyOr([-3]), 0)
  })
})

describe('clamp01', () => {
  it('prende nos limites e neutraliza NaN', () => {
    assert.equal(clamp01(-1), 0)
    assert.equal(clamp01(2), 1)
    assert.equal(clamp01(0.4), 0.4)
    assert.equal(clamp01(Number.NaN), 0)
  })
})

describe('decideVerdict', () => {
  const base = {
    confidence: 0.8,
    hasGeocode: true,
    hasHardEvidence: true,
    granularity: 'city' as const,
    conflicting: false
  }

  it('localiza quando tudo está no lugar', () => {
    assert.equal(decideVerdict(base), 'located')
  })

  it('nunca localiza sem geocódigo', () => {
    assert.equal(decideVerdict({ ...base, hasGeocode: false }), 'insufficient')
  })

  it('nunca localiza sem pista dura, por mais confiança que haja', () => {
    const veredito = decideVerdict({ ...base, hasHardEvidence: false, confidence: 0.99 })
    assert.equal(veredito, 'ambiguous')
  })

  it('nunca localiza acima do nível de cidade', () => {
    assert.equal(decideVerdict({ ...base, granularity: 'country' }), 'ambiguous')
    assert.equal(decideVerdict({ ...base, granularity: 'region' }), 'ambiguous')
  })

  it('não localiza quando os candidatos conflitam', () => {
    assert.equal(decideVerdict({ ...base, conflicting: true }), 'ambiguous')
  })

  it('trata granularidade nenhuma como insuficiente', () => {
    assert.equal(decideVerdict({ ...base, granularity: 'none' }), 'insufficient')
  })

  it('exige confiança acima do piso', () => {
    const abaixo = decideVerdict({ ...base, confidence: THRESHOLDS.insufficient - 0.01 })
    assert.equal(abaixo, 'insufficient')
  })

  it('para em ambíguo entre o piso e o limiar de localizado', () => {
    const meio = decideVerdict({ ...base, confidence: THRESHOLDS.located - 0.01 })
    assert.equal(meio, 'ambiguous')
  })
})

describe('confidenceLabel', () => {
  it('acompanha os limiares', () => {
    assert.equal(confidenceLabel(0.1), 'baixa')
    assert.equal(confidenceLabel(THRESHOLDS.located), 'média')
    assert.equal(confidenceLabel(THRESHOLDS.high), 'alta')
  })
})

describe('uncertaintyKm', () => {
  it('encolhe o raio quando o resultado é preciso', () => {
    const rua = uncertaintyKm('city', 0.8, 0.9)
    const cidade = uncertaintyKm('city', 0.8, 0.5)
    assert.ok(rua < cidade, 'endereço exato não merece raio de cidade')
    assert.ok(rua <= 2, `esperado raio pequeno, veio ${rua}`)
  })

  it('alarga o raio quando a confiança é baixa', () => {
    assert.ok(uncertaintyKm('city', 0.2, 0.5) > uncertaintyKm('city', 0.9, 0.5))
  })

  it('cresce com a granularidade', () => {
    const cidade = uncertaintyKm('city', 0.6, 0.5)
    const regiao = uncertaintyKm('region', 0.6, 0.5)
    const pais = uncertaintyKm('country', 0.6, 0.5)
    assert.ok(cidade < regiao && regiao < pais)
  })

  it('nunca devolve raio zero ou negativo', () => {
    assert.ok(uncertaintyKm('city', 1, 1) > 0)
  })
})

describe('tabelas de pesos', () => {
  it('define peso para todo tipo de pista', () => {
    const tipos: EvidenceKind[] = [
      'landmark', 'locality', 'street_sign', 'business', 'license_plate', 'domain',
      'phone', 'transit', 'currency', 'language', 'flag', 'architecture',
      'vegetation', 'landscape', 'signage_style', 'text', 'other'
    ]
    for (const tipo of tipos) {
      assert.equal(typeof EVIDENCE_WEIGHT[tipo], 'number', `faltou peso para ${tipo}`)
      assert.ok(EVIDENCE_WEIGHT[tipo] > 0 && EVIDENCE_WEIGHT[tipo] <= 1, `peso inválido em ${tipo}`)
    }
  })

  it('dá mais peso a pista dura que a pista de ambiente', () => {
    for (const dura of HARD_EVIDENCE) {
      assert.ok(
        EVIDENCE_WEIGHT[dura] > EVIDENCE_WEIGHT.vegetation,
        `${dura} deveria pesar mais que vegetação`
      )
    }
  })

  it('confia mais em texto do sistema que em texto reconhecido', () => {
    assert.ok(SOURCE_TRUST.title > SOURCE_TRUST.ocr)
    assert.ok(SOURCE_TRUST.title > SOURCE_TRUST.vision)
  })

  it('mantém o teto de confiança abaixo da certeza', () => {
    assert.ok(MAX_CONFIDENCE < 1)
    assert.ok(MAX_CONFIDENCE > THRESHOLDS.high)
  })
})

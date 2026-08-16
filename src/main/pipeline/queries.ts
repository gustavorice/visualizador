import type { Evidence, OcrResult, VisionResult } from '@shared/types'
import { EVIDENCE_WEIGHT, HARD_EVIDENCE } from '@shared/confidence'
import type { GeoQuery } from '../providers/types'
import { evidenceId } from '../util/id'
import { normalize } from '../providers/geo/gazetteer'
import { countryCodeFor, countryCodeForLanguage } from '../providers/geo/countries'

/**
 * Extrai pistas do texto do OCR usando apenas padrões de alta precisão.
 *
 * A divisão de trabalho é proposital: regex cuida do que é formalmente
 * reconhecível (domínio, telefone, CEP, logradouro), e o modelo de visão cuida
 * do que exige interpretação (nome de estabelecimento, monumento). Tentar
 * adivinhar "isto parece o nome de uma loja" com regex só produz ruído, e
 * ruído aqui vira alfinete errado no mapa.
 */
const PATTERNS: Array<{ kind: Evidence['kind']; regex: RegExp; detail: string }> = [
  {
    kind: 'domain',
    regex: /\b[a-z0-9][a-z0-9-]{1,}\.(?:com\.br|org\.br|gov\.br|com\.pt|co\.uk|com\.au|co\.jp|com\.mx|com\.ar|pt|br|jp|fr|de|es|it|nl|se|no|pl|gr|kr|cn)\b/gi,
    detail: 'Domínio de internet com sufixo territorial.'
  },
  {
    kind: 'phone',
    regex: /\(\s?\d{2}\s?\)\s?\d{4,5}[-\s]?\d{4}/g,
    detail: 'Telefone no formato brasileiro, com DDD.'
  },
  {
    kind: 'street_sign',
    regex: /\b\d{5}-\d{3}\b/g,
    detail: 'CEP brasileiro.'
  },
  {
    kind: 'street_sign',
    regex:
      /\b(?:Rua|R\.|Avenida|Av\.|Alameda|Praça|Travessa|Rodovia|Estrada|Largo|Calle|Carrer|Plaza|Via|Viale|Rue|Straße|Strasse|Street|Road|Avenue)\s+[A-ZÀ-Þ][\wÀ-ÿ']{2,}(?:\s+[A-ZÀ-Þa-zà-ÿ][\wÀ-ÿ']{1,}){0,3}/g,
    detail: 'Logradouro identificado no texto da tela.'
  },
  {
    // Placas de rua reais costumam estar em caixa alta, e o OCR devolve
    // exatamente isso. Sem esta variante, "AV. PAULISTA" passaria batido.
    kind: 'street_sign',
    regex:
      /\b(?:RUA|AVENIDA|AV\.|ALAMEDA|PRAÇA|TRAVESSA|RODOVIA|ESTRADA|LARGO|CALLE|CARRER|PLAZA|RUE|STRASSE|STREET|ROAD|AVENUE)\s+[A-ZÀ-Þ0-9][A-ZÀ-Þ0-9'.-]*(?:\s+[A-ZÀ-Þ0-9][A-ZÀ-Þ0-9'.-]*){0,3}/g,
    detail: 'Logradouro identificado no texto da tela.'
  }
]

export function extractOcrEvidence(ocr: OcrResult): Evidence[] {
  const found = new Map<string, Evidence>()

  for (const { kind, regex, detail } of PATTERNS) {
    for (const match of ocr.text.matchAll(regex)) {
      const value = match[0].trim().replace(/\s+/g, ' ')
      const key = `${kind}:${normalize(value)}`
      if (found.has(key)) continue
      found.set(key, {
        id: evidenceId('ocr'),
        kind,
        value,
        detail,
        weight: EVIDENCE_WEIGHT[kind],
        source: 'ocr'
      })
    }
  }

  return [...found.values()]
}

/**
 * Une pistas do OCR e da visão, removendo duplicatas.
 *
 * Quando as duas fontes veem a mesma coisa, isso é corroboração independente:
 * a pista sobrevive uma única vez, mas com peso elevado. É o análogo de dois
 * sensores concordando.
 */
export function mergeEvidence(ocrEvidence: Evidence[], visionEvidence: Evidence[]): Evidence[] {
  const merged: Evidence[] = []
  const byValue = new Map<string, Evidence>()

  for (const evidence of [...visionEvidence, ...ocrEvidence]) {
    const key = normalize(evidence.value)
    if (!key) continue

    const existing = byValue.get(key)
    if (!existing) {
      byValue.set(key, evidence)
      merged.push(evidence)
      continue
    }

    if (existing.source !== evidence.source) {
      // Visto pelo OCR e pela visão: eleva o peso sem nunca chegar a 1.
      existing.weight = Math.min(0.95, existing.weight + (1 - existing.weight) * 0.4)
      existing.detail = existing.detail
        ? `${existing.detail} Confirmado também pelo ${evidence.source === 'ocr' ? 'OCR' : 'modelo de visão'}.`
        : undefined
    }
  }

  return merged
}

/**
 * Constrói as consultas de geocodificação, da mais promissora para a menos.
 *
 * Duas regras importam:
 *  - só pistas DURAS viram consulta. Idioma, vegetação e arquitetura não são
 *    geocodificáveis; elas entram depois, na fusão, como reforço de país.
 *  - pistas ambíguas por natureza (rua, estabelecimento) ganham uma variante
 *    com a cidade sugerida, porque "Rua Augusta" sozinha existe em Lisboa e
 *    em São Paulo.
 */
export function buildQueries(
  evidence: Evidence[],
  hint: VisionResult['hint'] | undefined,
  limit: number
): GeoQuery[] {
  const countryHint =
    countryCodeFor(hint?.country) ??
    countryCodeForLanguage(hint?.language) ??
    countryCodeFor(evidenceValueOfKind(evidence, 'flag'))

  const cityHint = hint?.city?.trim()

  const queries: GeoQuery[] = []
  const seen = new Set<string>()

  const hard = evidence
    .filter((item) => HARD_EVIDENCE.has(item.kind))
    .sort((a, b) => b.weight - a.weight)

  for (const item of hard) {
    const needsCity = item.kind === 'street_sign' || item.kind === 'business'
    const text = needsCity && cityHint ? `${item.value}, ${cityHint}` : item.value

    push(queries, seen, {
      text,
      countryHint,
      evidenceIds: [item.id],
      priority: item.weight
    })

    // Variante sem a cidade, caso o palpite de cidade esteja errado.
    if (needsCity && cityHint) {
      push(queries, seen, {
        text: item.value,
        countryHint,
        evidenceIds: [item.id],
        priority: item.weight * 0.7
      })
    }
  }

  // Rede de segurança: se nada duro apareceu mas há palpite de país, resolvemos
  // ao menos o país. O veredito resultante será 'ambíguo', nunca 'localizado'.
  if (queries.length === 0 && hint?.country) {
    const supporting = evidence
      .filter((item) => item.kind === 'language' || item.kind === 'flag' || item.kind === 'currency')
      .map((item) => item.id)

    push(queries, seen, {
      text: hint.country,
      countryHint,
      evidenceIds: supporting,
      priority: 0.3
    })
  }

  return queries.sort((a, b) => b.priority - a.priority).slice(0, limit)
}

function push(queries: GeoQuery[], seen: Set<string>, query: GeoQuery): void {
  const key = normalize(query.text)
  if (!key || seen.has(key)) return
  seen.add(key)
  queries.push(query)
}

function evidenceValueOfKind(evidence: Evidence[], kind: Evidence['kind']): string | undefined {
  return evidence.find((item) => item.kind === kind)?.value
}

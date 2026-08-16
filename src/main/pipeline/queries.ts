import type { Evidence, OcrResult, VisionResult } from '@shared/types'
import { EVIDENCE_WEIGHT, HARD_EVIDENCE } from '@shared/confidence'
import type { GeoQuery } from '../providers/types'
import { evidenceId } from '../util/id'
import { normalize } from '../providers/geo/gazetteer'
import { countryCodeFor, countryCodeForLanguage } from '../providers/geo/countries'

/**
 * Extração de pistas do texto do OCR.
 *
 * A extração é feita LINHA A LINHA, não sobre o texto inteiro: endereços,
 * localidades e telefones vivem dentro de uma linha, e casar padrões através
 * de quebras de linha só produz combinações que não existem na tela.
 *
 * A divisão de trabalho com o modelo de visão é proposital: aqui ficam os
 * padrões formalmente reconhecíveis (logradouro, localidade, domínio,
 * telefone, CEP); nomes de estabelecimento e monumentos exigem interpretação
 * e ficam com a visão. Tentar adivinhar "isto parece o nome de uma loja" com
 * regex só produz ruído, e ruído aqui vira alfinete errado no mapa.
 */

/** Prefixos de logradouro, em capitalização normal e em caixa alta. */
const STREET_PREFIXES = [
  'Rua',
  'R.',
  'Avenida',
  'Av.',
  'Av',
  'Alameda',
  'Al.',
  'Praça',
  'Praca',
  'Travessa',
  'Rodovia',
  'Estrada',
  'Largo',
  'Calle',
  'Carrer',
  'Plaza',
  'Rue',
  'Strasse',
  'Straße'
  // 'Street', 'Road' e 'Avenue' NÃO entram: em inglês o tipo da via vem
  // depois do nome ("Main Street"), não antes. Como prefixos, eles só
  // produziriam falsos positivos — "Street View" viraria um endereço.
  // Endereços em inglês são cobertos pela linha de localidade.
]

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Alternância com a forma original E a versão em caixa alta.
 *
 * Não usamos a flag `i` de propósito: ela tornaria o NOME do logradouro
 * insensível a maiúsculas também, e aí "via de acesso" ou "rua estreita" no
 * meio de uma frase virariam endereços.
 */
const PREFIX_ALT = STREET_PREFIXES.flatMap((prefix) => [
  escapeRegex(prefix),
  escapeRegex(prefix.toUpperCase())
]).join('|')

/**
 * Palavra do nome do logradouro: começa com maiúscula ou dígito.
 *
 * O dígito e a letra isolada importam — sem eles "Av. M 17" e "Rua 5" não
 * casariam, e nomes assim são a norma em cidades planejadas brasileiras.
 */
const STREET_TOKEN = `[A-ZÀ-Þ0-9][\\wÀ-ÿ'.-]*`

/**
 * Conectivos que aparecem DENTRO de um nome de via: "Rua do Ouvidor",
 * "Avenida das Nações Unidas", "Rua 25 de Março".
 *
 * Precisam de tratamento próprio porque são minúsculos. A versão anterior
 * resolvia isso deixando qualquer palavra minúscula continuar o nome, e o
 * preço eram os dois extremos ao mesmo tempo: "Rua Augusta fechada para
 * obras" virava um endereço inteiro (consulta lixo), enquanto "Rua do
 * Ouvidor" não casava de jeito nenhum — o nome tem que COMEÇAR por
 * maiúscula, e "do" não começa. Aceitar a lista fechada de conectivos, e só
 * ela, corrige os dois casos.
 */
const CONNECTIVE = `(?:d[aeiou]s?|del|des|du|la|las|le|les|el|los|y|von|van|der|den)`

const STREET_NAME =
  `(?:${CONNECTIVE}\\s+)?${STREET_TOKEN}(?:\\s+(?:${CONNECTIVE}\\s+)?${STREET_TOKEN}){0,3}`

const STREET_RE = new RegExp(`\\b(?:${PREFIX_ALT})\\s+${STREET_NAME}`, 'g')

/**
 * Número predial antes do logradouro: "1387 Av. M 17".
 *
 * Ancorado no FIM do trecho anterior ao logradouro, porque é isso que
 * caracteriza um número predial: ele encosta no nome da via.
 */
const NUMBER_BEFORE_RE = /(?:^|\s)(\d{1,6})\s*$/
/** Número predial depois do logradouro: "Rua 5, 240". */
const NUMBER_AFTER_RE = /[,\s]+(\d{1,6})\s*$/

/**
 * Número predial grudado no fim do nome: "Av. Paulista 1578".
 *
 * Exige três dígitos ou mais. Um ou dois quase sempre SÃO o nome da via
 * ("Av. M 17", "Rua 5"), e arrancá-los produziria um endereço que não existe.
 */
const TRAILING_NUMBER_RE = /\s+(\d{3,6})$/

/**
 * Em rodovia e estrada o número designa a VIA, não um imóvel: "Rodovia BR 116"
 * não é o número 116 de uma rua chamada "Rodovia BR".
 */
const HIGHWAY_RE = /^(?:rodovia|estrada)\b/i

/**
 * "Cidade, Região" numa linha própria — o formato que mapas, cabeçalhos de
 * site e painéis de endereço usam. Exige as duas partes começando por
 * maiúscula e ancoragem na linha inteira, o que descarta a maior parte do
 * texto de interface.
 */
const LOCALITY_RE =
  /^([A-ZÀ-Þ][\wÀ-ÿ']{2,}(?:\s+(?:de|da|do|dos|das)?\s*[A-ZÀ-Þ][\wÀ-ÿ']{2,}){0,3})\s*[,–-]\s*([A-ZÀ-Þ][\wÀ-ÿ']{1,}(?:\s+[A-ZÀ-Þa-zà-ÿ][\wÀ-ÿ']{1,}){0,3})$/

const SIMPLE_PATTERNS: Array<{ kind: Evidence['kind']; regex: RegExp; detail: string }> = [
  {
    kind: 'domain',
    regex:
      /\b[a-z0-9][a-z0-9-]{1,}\.(?:com\.br|org\.br|gov\.br|com\.pt|co\.uk|com\.au|co\.jp|com\.mx|com\.ar|pt|br|jp|fr|de|es|it|nl|se|no|pl|gr|kr|cn)\b/gi,
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
  }
]

/**
 * Extrai pistas do NOME da janela ou tela capturada.
 *
 * Navegadores põem o título da página na barra de janela, e serviços de mapa
 * põem o endereço no título da página. O resultado é que a janela costuma se
 * chamar literalmente "985 Av. M 17 - Google Maps - Google Chrome": a
 * resposta, exata, sem passar por reconhecimento de imagem.
 *
 * Por ser texto do sistema e não pixels interpretados, esta pista não tem
 * erro de leitura — daí o peso maior que o equivalente vindo do OCR.
 */
export function extractTitleEvidence(sourceName: string): Evidence[] {
  if (!sourceName?.trim()) return []

  // O título vem em segmentos ("página - site - navegador"); separá-los evita
  // colar o fim de um no começo do outro.
  const segments = sourceName.split(/\s+[-–—|]\s+/)

  const evidence = extractOcrEvidence({
    engine: 'title',
    text: segments.join('\n'),
    lines: segments.map((text) => ({ text, confidence: 1 })),
    durationMs: 0
  })

  return evidence.map((item) => ({
    ...item,
    source: 'title' as const,
    weight: Math.min(0.9, item.weight + (1 - item.weight) * 0.3),
    detail: `${item.detail ?? ''} Lido no título da janela — texto exato, sem erro de OCR.`.trim()
  }))
}

export function extractOcrEvidence(ocr: OcrResult): Evidence[] {
  const found = new Map<string, Evidence>()

  const add = (kind: Evidence['kind'], value: string, detail: string): void => {
    const clean = value.trim().replace(/\s+/g, ' ')
    if (!clean) return
    const key = `${kind}:${normalize(clean)}`
    if (found.has(key)) return
    found.set(key, {
      id: evidenceId('ocr'),
      kind,
      value: clean,
      detail,
      weight: EVIDENCE_WEIGHT[kind],
      source: 'ocr'
    })
  }

  const lines =
    ocr.lines.length > 0 ? ocr.lines.map((line) => line.text) : ocr.text.split('\n')

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line) continue

    for (const { kind, regex, detail } of SIMPLE_PATTERNS) {
      for (const match of line.matchAll(regex)) add(kind, match[0], detail)
    }

    for (const match of line.matchAll(STREET_RE)) {
      const matched = match[0]
      const before = line.slice(0, match.index ?? 0)
      const after = line.slice((match.index ?? 0) + matched.length)

      // O número que grudou no fim do nome sai dele e vira número predial.
      const trailing = HIGHWAY_RE.test(matched) ? null : TRAILING_NUMBER_RE.exec(matched)
      const street = trailing ? matched.slice(0, trailing.index) : matched

      // O número predial transforma um logradouro numa coordenada exata,
      // então vale procurá-lo dos três lados possíveis do nome da via.
      const number =
        NUMBER_BEFORE_RE.exec(before)?.[1] ??
        trailing?.[1] ??
        NUMBER_AFTER_RE.exec(after)?.[1] ??
        null

      add(
        'street_sign',
        number ? `${street}, ${number}` : street,
        number
          ? 'Endereço com número, lido na tela.'
          : 'Logradouro identificado no texto da tela.'
      )
    }

    const locality = LOCALITY_RE.exec(line)
    if (locality) {
      add('locality', line, 'Nome de cidade/região lido na tela.')
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
      // Cópia deliberada: a fusão ajusta peso e detalhe, e mutar o objeto
      // original alteraria também o `VisionResult` que é devolvido ao
      // usuário como registro do que o modelo respondeu.
      const copy = { ...evidence }
      byValue.set(key, copy)
      merged.push(copy)
      continue
    }

    if (existing.source !== evidence.source) {
      // Visto pelo OCR e pela visão: eleva o peso sem nunca chegar a 1.
      existing.weight = Math.min(0.95, existing.weight + (1 - existing.weight) * 0.4)
      // A nota de corroboração é acrescentada mesmo quando a pista não tinha
      // detalhe nenhum. Antes o `undefined` do ramo falso APAGAVA o campo, e
      // o usuário perdia justamente a informação mais forte da lista: que
      // duas fontes independentes viram a mesma coisa.
      const note = `Confirmado também pelo ${SOURCE_LABEL[evidence.source]}.`
      existing.detail = existing.detail ? `${existing.detail} ${note}` : note
    }
  }

  return merged
}

const SOURCE_LABEL: Record<Evidence['source'], string> = {
  ocr: 'OCR',
  title: 'título da janela',
  vision: 'modelo de visão',
  search: 'busca externa'
}

/**
 * Constrói as consultas de geocodificação, da mais promissora para a menos.
 *
 * Três regras importam:
 *  - só pistas DURAS viram consulta. Idioma, vegetação e arquitetura não são
 *    geocodificáveis; entram depois, na fusão, como reforço de país.
 *  - uma localidade LIDA na tela vale mais como contexto que uma cidade
 *    PALPITADA pelo modelo de visão, então ela tem prioridade para
 *    desambiguar ruas e estabelecimentos.
 *  - pistas ambíguas por natureza (rua, estabelecimento) ganham a variante
 *    com cidade e a variante sem, porque "Rua Augusta" existe em Lisboa e em
 *    São Paulo, mas o palpite de cidade também pode estar errado.
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

  /*
   * Localidade LIDA na tela ganha do palpite do modelo.
   *
   * O `find` precisa filtrar pela ORIGEM, não só pelo tipo: a lista fundida
   * traz as pistas da visão primeiro, então procurar apenas por `locality`
   * devolvia a cidade PALPITADA antes da cidade LIDA — o inverso exato da
   * regra que o comentário anunciava.
   */
  const readLocality =
    evidence.find(
      (item) =>
        item.kind === 'locality' && (item.source === 'ocr' || item.source === 'title')
    )?.value ?? evidence.find((item) => item.kind === 'locality')?.value

  const cityContext = readLocality ?? hint?.city?.trim()

  const queries: GeoQuery[] = []
  const seen = new Set<string>()

  const hard = evidence
    .filter((item) => HARD_EVIDENCE.has(item.kind))
    .sort((a, b) => b.weight - a.weight)

  for (const item of hard) {
    const needsCity = item.kind === 'street_sign' || item.kind === 'business'

    if (needsCity && cityContext) {
      push(queries, seen, {
        text: `${item.value}, ${cityContext}`,
        kind: item.kind,
        countryHint,
        evidenceIds: [item.id],
        // A combinação endereço + cidade é a consulta mais precisa possível.
        priority: Math.min(1, item.weight + 0.2)
      })
    }

    push(queries, seen, {
      text: item.value,
      kind: item.kind,
      countryHint,
      evidenceIds: [item.id],
      priority: needsCity && cityContext ? item.weight * 0.7 : item.weight
    })
  }

  /*
   * O país entra SEMPRE que o modelo arriscar um, não só quando não há pista
   * dura. O veredito de uma resposta só de país é 'ambíguo' por construção —
   * nunca 'localizado' —, então isto não abre caminho para cravar cidade a
   * partir de sinal fraco; o que ele evita é o buraco em que uma pista dura
   * que NÃO geocodifica (um monumento com nome errado, uma rua inexistente)
   * derruba a análise inteira para "não sei", apagando um país que estava
   * perfeitamente deduzido. Com prioridade 0,3 ele fica no fim da fila e só
   * ocupa vaga que sobrou.
   *
   * A sustentação são TODAS as pistas moles, não só idioma e bandeira: numa
   * foto de estrada sem texto nem monumento — o caso comum — quem restringe o
   * país é a vegetação, a sinalização da via, o poste, o telhado. Filtrar
   * essas fora deixava a consulta sem nenhuma evidência atrás dela, e uma
   * consulta sem evidência pontua zero por construção.
   */
  if (hint?.country?.trim()) {
    const supporting = evidence
      .filter((item) => !HARD_EVIDENCE.has(item.kind))
      .map((item) => item.id)

    push(queries, seen, {
      text: hint.country.trim(),
      countryHint,
      evidenceIds: supporting,
      priority: 0.3
    })
  }

  return queries.sort((a, b) => b.priority - a.priority).slice(0, limit)
}

/**
 * Qualificadores administrativos que os geocodificadores não entendem.
 *
 * Mapas em inglês escrevem "Rio Claro, State of São Paulo"; o Nominatim
 * devolve ZERO resultados para isso e três para "Rio Claro, São Paulo".
 * Como o texto vem de uma interface, e não de uma placa, esse ruído é
 * previsível e vale limpar antes de consultar.
 *
 * Só formas PREFIXADAS entram na lista. "Tokyo Prefecture" e "Orange County"
 * são posfixadas e resolvem bem como estão — removê-las quebraria consultas
 * que hoje funcionam. Também ficam de fora "City of" e "Cidade de", que
 * costumam fazer parte do nome real do lugar ("City of London",
 * "Cidade de Deus").
 */
const ADMIN_NOISE =
  /\b(?:State|Province|Prefecture|Region|Department)\s+of\s+|\b(?:Estado|Província|Provincia|Departamento|Região)\s+(?:de|do|da)\s+/gi

export function cleanForGeocoding(text: string): string {
  return text.replace(ADMIN_NOISE, '').replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim()
}

function push(queries: GeoQuery[], seen: Set<string>, query: GeoQuery): void {
  // A limpeza vale para a CONSULTA, não para a evidência: a evidência mostra
  // ao usuário o que estava escrito na tela, e isso deve continuar fiel.
  const text = cleanForGeocoding(query.text)
  const key = normalize(text)
  if (!key || seen.has(key)) return
  seen.add(key)
  queries.push({ ...query, text })
}

function evidenceValueOfKind(evidence: Evidence[], kind: Evidence['kind']): string | undefined {
  return evidence.find((item) => item.kind === kind)?.value
}

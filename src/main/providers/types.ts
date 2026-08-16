import type { EvidenceKind, LocationCandidate, OcrResult, VisionResult } from '@shared/types'

export interface ProviderContext {
  signal: AbortSignal
  timeoutMs: number
  /**
   * Identidade estável do quadro capturado, calculada uma única vez por
   * análise.
   *
   * Existe porque OCR e visão recebem representações DIFERENTES da mesma
   * captura (PNG em tamanho cheio contra JPEG reduzido). Os provedores
   * simulados escolhem o cenário por hash, e hashear a própria entrada faria
   * cada um cair num cenário distinto — texto em japonês junto de pistas
   * visuais de São Paulo. Com um identificador comum, os dois contam a mesma
   * história, como um OCR e um modelo de visão reais olhando a mesma tela.
   * Provedores reais ignoram este campo.
   */
  frameId: string
}

export interface OcrProvider {
  readonly name: string
  /** Aquecimento opcional, chamado na inicialização do app. */
  warmup?(): Promise<void>
  recognize(image: Buffer, context: ProviderContext): Promise<OcrResult>
  health(): Promise<{ ready: boolean; detail: string }>
  dispose?(): Promise<void>
}

export interface VisionProvider {
  readonly name: string
  warmup?(): Promise<void>
  /** Recebe JPEG em base64 (sem prefixo data:). */
  analyze(imageBase64: string, context: ProviderContext): Promise<VisionResult>
  health(): Promise<{ ready: boolean; detail: string }>
}

export interface GeoQuery {
  /** Texto a consultar, ex.: "Museu de Arte de São Paulo". */
  text: string
  /**
   * Tipo da pista que originou a consulta.
   *
   * Decide QUAL resolvedor usar: nome de lugar famoso vai para a Wikidata,
   * que é multilíngue; endereço vai para o Nominatim, que entende
   * logradouro e número. São problemas diferentes com ferramentas diferentes.
   */
  kind?: EvidenceKind
  /** Código de país para enviesar a busca, quando houver pista. */
  countryHint?: string
  /** IDs das evidências que originaram esta consulta. */
  evidenceIds: string[]
  /** Prioridade 0..1 — consultas mais promissoras primeiro. */
  priority: number
}

export interface GeoProvider {
  readonly name: string
  warmup?(): Promise<void>
  /**
   * Quantas consultas o provedor aceita por análise. Existe porque a
   * instância pública do Nominatim é limitada a 1 req/s: lá vale a pena
   * gastar as consultas nas pistas mais fortes em vez de disparar todas.
   */
  maxQueries?(): number
  geocode(query: GeoQuery, context: ProviderContext): Promise<LocationCandidate[]>
  /**
   * Validação opcional por pesquisa externa: confirma que a pista existe e
   * refina o texto antes da geocodificação. Provedores sem busca devolvem
   * a consulta inalterada.
   */
  verify?(queries: GeoQuery[], context: ProviderContext): Promise<GeoQuery[]>
  health(): Promise<{ ready: boolean; detail: string }>
}

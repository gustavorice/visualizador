/**
 * Contratos compartilhados entre main, preload e renderer.
 *
 * Regra de ouro do projeto: o modelo de visão NUNCA decide a localização.
 * Ele só extrai *pistas observáveis*. Quem transforma pista em coordenada é
 * o provedor geográfico (geocodificação / pesquisa externa). Isso é o que
 * impede o app de inventar um lugar plausível.
 */

export type SourceKind = 'screen' | 'window'

/** Uma tela ou janela que o usuário pode escolher para capturar. */
export interface CaptureSource {
  id: string
  name: string
  kind: SourceKind
  /** Miniatura pequena, só para o seletor. Nunca é persistida. */
  thumbnailDataUrl: string
  displayId?: string
}

export interface CapturePreview {
  dataUrl: string
  width: number
  height: number
  capturedAt: number
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

export interface OcrLine {
  text: string
  confidence: number
}

export interface OcrResult {
  engine: string
  text: string
  lines: OcrLine[]
  durationMs: number
}

// ---------------------------------------------------------------------------
// Visão (VLM local)
// ---------------------------------------------------------------------------

/**
 * Tipos de pista. A ordem importa: `HARD_EVIDENCE` (em confidence.ts) define
 * quais são concretamente resolvíveis em coordenadas.
 */
export type EvidenceKind =
  | 'landmark' // monumento / ponto turístico reconhecível
  | 'locality' // nome de cidade/região lido na tela ("Rio Claro, São Paulo")
  | 'street_sign' // placa de rua, número, CEP
  | 'business' // nome de estabelecimento
  | 'license_plate' // padrão de placa de veículo
  | 'domain' // domínio de internet (.com.br, .pt, .jp)
  | 'phone' // formato/DDD de telefone
  | 'transit' // linha de metrô, ônibus, estação
  | 'currency' // moeda / símbolo de preço
  | 'language' // idioma predominante
  | 'flag' // bandeira visível
  | 'architecture' // estilo construtivo
  | 'vegetation' // vegetação / bioma
  | 'landscape' // relevo, litoral, clima aparente
  | 'signage_style' // padrão visual de sinalização viária
  | 'text' // texto solto relevante
  | 'other'

export interface Evidence {
  id: string
  kind: EvidenceKind
  /** A pista literal, como observada. */
  value: string
  /** Por que essa pista importa geograficamente. */
  detail?: string
  /** Quão discriminativa é a pista, 0..1. */
  weight: number
  source: 'ocr' | 'vision' | 'search'
  /** true quando a pesquisa externa confirmou a pista. */
  verified?: boolean
}

export interface VisionResult {
  engine: string
  model?: string
  evidence: Evidence[]
  /** Pista de país/cidade que o modelo *sugere*. Usada só para enviesar a
   *  busca — nunca é aceita como resposta final por si só. */
  hint?: {
    country?: string
    region?: string
    city?: string
    language?: string
  }
  /** Descrição livre da cena, exibida ao usuário. */
  sceneDescription?: string
  durationMs: number
}

// ---------------------------------------------------------------------------
// Geografia
// ---------------------------------------------------------------------------

export interface LocationCandidate {
  city?: string
  region?: string
  country?: string
  countryCode?: string
  lat: number
  lon: number
  displayName: string
  /** 0..1 — confiança do provedor nessa resolução. */
  score: number
  /**
   * 0..1 — quão específico é o lugar (país → estado → cidade → rua → prédio).
   * Separado de `score`: uma cidade é mais "importante" que uma rua, mas a
   * rua é mais precisa, e é a precisão que decide onde cai o alfinete.
   */
  precision?: number
  provider: string
  /** Qual consulta gerou este candidato (para auditoria). */
  query?: string
  /** IDs das evidências que sustentam este candidato. */
  supportedBy?: string[]
}

export type Granularity = 'city' | 'region' | 'country' | 'none'

export type Verdict = 'located' | 'ambiguous' | 'insufficient'

export type ConfidenceLabel = 'baixa' | 'média' | 'alta'

export interface ResolvedLocation {
  city?: string
  region?: string
  country?: string
  countryCode?: string
  lat: number
  lon: number
  displayName: string
  /** Raio de incerteza em km, derivado da granularidade e da confiança. */
  uncertaintyKm: number
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

export type StageName =
  | 'capture'
  | 'preview'
  | 'ocr'
  | 'vision'
  | 'fuse'
  | 'geocode'
  | 'verify'
  | 'compose'

export type StageStatus = 'running' | 'done' | 'skipped' | 'error'

export interface StageEvent {
  stage: StageName
  status: StageStatus
  ms?: number
  message?: string
}

export interface AnalysisResult {
  id: string
  verdict: Verdict
  granularity: Granularity
  /** Texto em pt-BR mostrado na tela. */
  summary: string
  /** Versão curta para a síntese de voz. */
  spoken: string
  confidence: number
  confidenceLabel: ConfidenceLabel
  location?: ResolvedLocation
  alternatives: LocationCandidate[]
  evidence: Evidence[]
  ocr?: OcrResult
  vision?: VisionResult
  sourceName: string
  timings: Partial<Record<StageName, number>>
  totalMs: number
  startedAt: number
  providers: {
    ocr: string
    vision: string
    geo: string
  }
}

export type AnalysisEvent =
  | { type: 'started'; id: string; sourceName: string }
  | { type: 'stage'; id: string; stage: StageName; status: StageStatus; ms?: number; message?: string }
  | { type: 'preview'; id: string; preview: CapturePreview }
  | { type: 'evidence'; id: string; evidence: Evidence[] }
  | { type: 'done'; id: string; result: AnalysisResult }
  | { type: 'error'; id: string; message: string }

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

/**
 * Cada provedor tem o seu próprio conjunto de opções.
 *
 * 'off' existe para o caso prático de rodar só OCR + geocodificação: telas
 * quase sempre contêm texto, e sem um modelo de visão configurado é melhor
 * desligá-lo do que deixar o simulado injetar pistas falsas no resultado.
 */
export type OcrProviderId = 'mock' | 'tesseract' | 'off'
export type VisionProviderId = 'mock' | 'ollama' | 'claude' | 'off'
export type GeoProviderId = 'mock' | 'nominatim'
export type AnyProviderId = OcrProviderId | VisionProviderId | GeoProviderId

export interface Settings {
  /** Versão do formato. Usada para migrar configurações já salvas em disco. */
  version: number

  ocrProvider: OcrProviderId
  visionProvider: VisionProviderId
  geoProvider: GeoProviderId

  ocrLanguages: string
  ollamaUrl: string
  ollamaModel: string
  /** Mantém o modelo residente na VRAM entre análises — principal ganho de latência. */
  ollamaKeepAlive: string

  /** Visão na nuvem (Claude). Troca privacidade por precisão de modelo de fronteira. */
  claudeApiKey: string
  claudeModel: string

  /** Geocodificação. Nominatim exige um User-Agent identificável. */
  nominatimUrl: string
  contactEmail: string

  /** Pesquisa externa opcional para validar pistas antes de geocodificar. */
  webSearchProvider: 'none' | 'searxng' | 'brave' | 'tavily'
  webSearchUrl: string
  webSearchApiKey: string

  /** Privacidade */
  saveCaptures: boolean
  captureDir: string
  allowNetwork: boolean

  /** Desempenho */
  captureMaxWidth: number
  visionMaxWidth: number
  jpegQuality: number
  stageTimeoutMs: number
  totalTimeoutMs: number

  /** Voz */
  speakResults: boolean
  speechRate: number
  speechLang: string

  /** Fluxo */
  rememberLastSource: boolean
  lastSourceId: string
  lastSourceName: string
  lastSourceKind: SourceKind | ''
  globalShortcut: string
}

export interface ProviderHealth {
  name: string
  mode: AnyProviderId
  ready: boolean
  detail: string
  /** true quando o provedor é simulado — a interface avisa em destaque. */
  simulated: boolean
}

export interface HealthReport {
  ocr: ProviderHealth
  vision: ProviderHealth
  geo: ProviderHealth
}

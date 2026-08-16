import type { EvidenceKind, ResolvedLocation, StageName, Verdict } from '@shared/types'

export const VERDICT_LABEL: Record<Verdict, string> = {
  located: 'Localizado',
  ambiguous: 'Ambíguo',
  insufficient: 'Dados insuficientes'
}

export const STAGE_LABEL: Record<StageName, string> = {
  capture: 'captura',
  preview: 'prévia',
  ocr: 'OCR',
  vision: 'visão',
  fuse: 'fusão',
  geocode: 'geocodificação',
  verify: 'validação',
  compose: 'veredito'
}

export const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  landmark: 'monumento',
  locality: 'cidade/região',
  street_sign: 'placa/rua',
  business: 'estabelecimento',
  license_plate: 'placa veicular',
  domain: 'domínio',
  phone: 'telefone',
  transit: 'transporte',
  currency: 'moeda',
  language: 'idioma',
  flag: 'bandeira',
  architecture: 'arquitetura',
  vegetation: 'vegetação',
  landscape: 'paisagem',
  signage_style: 'sinalização',
  text: 'texto',
  other: 'outro'
}

/** "Cidade, Região, País" — omite o que não foi resolvido. */
export function formatPlace(location: ResolvedLocation): string {
  const parts = [location.city, location.region, location.country].filter(
    (part): part is string => Boolean(part && part.trim())
  )
  const deduped = parts.filter((part, index) => index === 0 || part !== parts[index - 1])
  return deduped.length > 0 ? deduped.join(', ') : location.displayName
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

export function confidenceColor(confidence: number): string {
  if (confidence >= 0.75) return 'var(--ok)'
  if (confidence >= 0.55) return 'var(--warn)'
  return 'var(--bad)'
}

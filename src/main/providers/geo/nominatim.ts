import type { GeoProvider, GeoQuery, ProviderContext } from '../types'
import type { LocationCandidate } from '@shared/types'
import { getSettings } from '../../settings'
import { getJson } from '../../util/http'
import { Lru } from '../../util/lru'
import { log } from '../../util/logger'
import { RateLimiter } from './ratelimit'
import { verifyQueries } from './websearch'
import { normalize } from './gazetteer'

/**
 * Geocodificação real via Nominatim (OpenStreetMap).
 *
 * Sobre velocidade: a instância pública é limitada a 1 req/s pela Usage
 * Policy do OSM, o que impõe um teto duro de latência quando há várias
 * pistas para resolver. O provedor detecta se `nominatimUrl` aponta para a
 * instância pública e, nesse caso, serializa e reduz o número de consultas.
 * Apontando para um Nominatim ou Photon local, ele libera o paralelismo —
 * é aí que a análise fecha abaixo de 2s. Ver docs/OLLAMA-E-PESQUISA.md.
 */

interface NominatimPlace {
  lat: string
  lon: string
  display_name: string
  importance?: number
  address?: {
    city?: string
    town?: string
    village?: string
    municipality?: string
    suburb?: string
    state?: string
    region?: string
    country?: string
    country_code?: string
  }
}

const cache = new Lru<string, LocationCandidate[]>(300)

export class NominatimGeoProvider implements GeoProvider {
  readonly name = 'nominatim'
  private readonly limiter: RateLimiter

  constructor() {
    this.limiter = new RateLimiter(this.isPublicInstance() ? 1100 : 0)
  }

  private isPublicInstance(): boolean {
    return getSettings().nominatimUrl.includes('nominatim.openstreetmap.org')
  }

  /** Quantas consultas vale a pena disparar por análise. */
  maxQueries(): number {
    return this.isPublicInstance() ? 2 : 5
  }

  async verify(queries: GeoQuery[], context: ProviderContext): Promise<GeoQuery[]> {
    return verifyQueries(queries, context)
  }

  async geocode(query: GeoQuery, context: ProviderContext): Promise<LocationCandidate[]> {
    const settings = getSettings()
    const text = query.text.trim()
    if (!text) return []

    const cacheKey = `${normalize(text)}|${query.countryHint ?? ''}`
    const cached = cache.get(cacheKey)
    if (cached) {
      // Reanexa as evidências desta análise ao resultado em cache.
      return cached.map((candidate) => ({ ...candidate, supportedBy: query.evidenceIds }))
    }

    const url = new URL('/search', settings.nominatimUrl)
    url.searchParams.set('q', text)
    url.searchParams.set('format', 'jsonv2')
    url.searchParams.set('addressdetails', '1')
    url.searchParams.set('limit', '3')
    url.searchParams.set('accept-language', 'pt-BR')
    if (query.countryHint) url.searchParams.set('countrycodes', query.countryHint.toLowerCase())

    const places = await this.limiter.schedule(() =>
      getJson<NominatimPlace[]>(url.toString(), {
        timeoutMs: context.timeoutMs,
        signal: context.signal,
        headers: {
          // A Usage Policy exige identificação da aplicação.
          'user-agent': userAgent(),
          'accept-language': 'pt-BR'
        }
      })
    )

    const candidates = places.map((place) => toCandidate(place, query, this.name))
    cache.set(cacheKey, candidates)
    return candidates
  }

  async health(): Promise<{ ready: boolean; detail: string }> {
    const settings = getSettings()
    if (!settings.allowNetwork) {
      return { ready: false, detail: 'Acesso à rede desativado nas configurações.' }
    }
    try {
      const url = new URL('/search', settings.nominatimUrl)
      url.searchParams.set('q', 'Lisboa')
      url.searchParams.set('format', 'jsonv2')
      url.searchParams.set('limit', '1')
      await getJson<NominatimPlace[]>(url.toString(), {
        timeoutMs: 2500,
        headers: { 'user-agent': userAgent() }
      })
      const mode = this.isPublicInstance()
        ? 'instância pública (1 req/s — considere hospedar localmente)'
        : 'instância própria (paralelismo liberado)'
      return { ready: true, detail: `Nominatim acessível — ${mode}.` }
    } catch (error) {
      log.error('verificação do nominatim falhou', error)
      return { ready: false, detail: 'Nominatim não respondeu.' }
    }
  }
}

function userAgent(): string {
  const { contactEmail } = getSettings()
  const contact = contactEmail.trim() || 'sem-contato-configurado'
  return `Visualizador/0.1 (${contact})`
}

function toCandidate(
  place: NominatimPlace,
  query: GeoQuery,
  provider: string
): LocationCandidate {
  const address = place.address ?? {}
  const city =
    address.city ?? address.town ?? address.village ?? address.municipality ?? undefined

  return {
    city,
    region: address.state ?? address.region,
    country: address.country,
    countryCode: address.country_code?.toUpperCase(),
    lat: Number.parseFloat(place.lat),
    lon: Number.parseFloat(place.lon),
    displayName: place.display_name,
    // `importance` do Nominatim já é 0..1 e reflete relevância do lugar.
    score: clamp(place.importance ?? 0.4),
    provider,
    query: query.text,
    supportedBy: query.evidenceIds
  }
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

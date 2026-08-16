import type { GeoProvider, GeoQuery, ProviderContext } from '../types'
import type { LocationCandidate } from '@shared/types'
import { GAZETTEER, normalize } from './gazetteer'

/**
 * Geocodificação simulada contra um gazetteer local pequeno.
 *
 * Importante: este provedor implementa a MESMA interface do Nominatim, e o
 * restante do pipeline (fusão, confiança, veredito) roda idêntico nos dois
 * modos. Trocar simulado por real não muda uma linha da lógica de decisão.
 */
export class MockGeoProvider implements GeoProvider {
  readonly name = 'mock-geo'

  async geocode(query: GeoQuery, context: ProviderContext): Promise<LocationCandidate[]> {
    await delay(60, context.signal)

    const needle = normalize(query.text)
    if (!needle) return []

    const matches: LocationCandidate[] = []
    for (const entry of GAZETTEER) {
      const hit = entry.match.some(
        (term) => needle.includes(term) || term.includes(needle)
      )
      if (!hit) continue

      matches.push({
        city: entry.city,
        region: entry.region,
        country: entry.country,
        countryCode: entry.countryCode,
        lat: entry.lat,
        lon: entry.lon,
        displayName: entry.displayName,
        score: entry.score,
        provider: this.name,
        query: query.text,
        supportedBy: query.evidenceIds
      })
    }

    return matches.sort((a, b) => b.score - a.score).slice(0, 3)
  }

  async health(): Promise<{ ready: boolean; detail: string }> {
    return {
      ready: true,
      detail: `Simulado — gazetteer local com ${GAZETTEER.length} entradas.`
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Cancelado', 'AbortError'))
      },
      { once: true }
    )
  })
}

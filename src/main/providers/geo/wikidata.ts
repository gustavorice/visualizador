import type { LocationCandidate } from '@shared/types'
import type { ProviderContext } from '../types'
import { getJson } from '../../util/http'
import { Lru } from '../../util/lru'
import { log } from '../../util/logger'

/**
 * Resolvedor de LUGARES NOMEADOS via Wikidata.
 *
 * Existe porque o Nominatim resolve endereços, não monumentos. Ele casa com a
 * etiqueta `name` do OSM, que está no idioma local: a ponte Zhivopisny só é
 * encontrada como "Живописный мост" — nem a transliteração, nem o nome em
 * inglês, nem o em português retornam qualquer coisa. Um modelo de visão que
 * responde "Ponte Zhivopisny, Moscou" acerta o lugar e mesmo assim não
 * geocodifica.
 *
 * A Wikidata é multilíngue por construção: a busca de texto completo encontra
 * a entidade a partir do nome em praticamente qualquer idioma, e a propriedade
 * P625 dá a coordenada. É a ferramenta certa para "nome de lugar famoso ->
 * coordenada", assim como o Nominatim é para "endereço -> coordenada".
 */

const API = 'https://www.wikidata.org/w/api.php'
const cache = new Lru<string, LocationCandidate | null>(200)

interface SearchResponse {
  query?: { search?: Array<{ title?: string }> }
}

interface EntitiesResponse {
  entities?: Record<
    string,
    {
      labels?: Record<string, { value?: string }>
      claims?: {
        P625?: Array<{
          mainsnak?: { datavalue?: { value?: { latitude?: number; longitude?: number } } }
        }>
      }
    }
  >
}

function userAgent(contact: string): string {
  return `Visualizador/0.1 (${contact.trim() || 'sem-contato-configurado'})`
}

/**
 * Procura um lugar nomeado e devolve a coordenada.
 *
 * Usa a busca de TEXTO COMPLETO (`list=search`) em vez de `wbsearchentities`:
 * a segunda casa com rótulos de um idioma só, e o rótulo português desta ponte
 * é "Ponte Pitoresca" — não bate com "Ponte Zhivopisny". A busca de texto
 * completo varre todos os idiomas e aliases, que é o que faz o nome dado pelo
 * modelo funcionar.
 */
export async function resolveLandmark(
  text: string,
  contact: string,
  context: ProviderContext
): Promise<LocationCandidate | null> {
  const key = text.trim().toLowerCase()
  if (!key) return null

  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const headers = { 'user-agent': userAgent(contact) }
  const options = { timeoutMs: context.timeoutMs, signal: context.signal, headers }

  /*
   * O modelo costuma responder "Ponte Zhivopisny, Moscou" — nome e cidade
   * juntos. A busca de texto completo trata isso como uma frase só e não
   * encontra nada, enquanto "Ponte Zhivopisny" sozinho acha na hora. Então
   * tentamos a forma completa primeiro (mais específica, desambigua nomes
   * repetidos) e caímos para só o nome quando ela falha.
   */
  const attempts = [text]
  const beforeComma = text.split(',')[0]?.trim()
  if (beforeComma && beforeComma !== text) attempts.push(beforeComma)

  try {
    let ids: string[] = []
    for (const attempt of attempts) {
      const search = new URL(API)
      search.searchParams.set('action', 'query')
      search.searchParams.set('list', 'search')
      search.searchParams.set('srsearch', attempt)
      search.searchParams.set('srlimit', '3')
      search.searchParams.set('format', 'json')

      const found = await getJson<SearchResponse>(search.toString(), options)
      ids = (found.query?.search ?? [])
        .map((item) => item.title ?? '')
        .filter((id) => /^Q\d+$/.test(id))
      if (ids.length > 0) break
    }

    if (ids.length === 0) {
      cache.set(key, null)
      return null
    }

    const entities = new URL(API)
    entities.searchParams.set('action', 'wbgetentities')
    entities.searchParams.set('ids', ids.join('|'))
    entities.searchParams.set('props', 'claims|labels')
    entities.searchParams.set('languages', 'pt|en')
    entities.searchParams.set('format', 'json')

    const detail = await getJson<EntitiesResponse>(entities.toString(), options)

    // A ordem da busca é por relevância, então o primeiro que TEM coordenada é
    // o melhor palpite. Entidades sem P625 (conceitos, pessoas) são puladas.
    for (const id of ids) {
      const entity = detail.entities?.[id]
      const point = entity?.claims?.P625?.[0]?.mainsnak?.datavalue?.value
      if (typeof point?.latitude !== 'number' || typeof point?.longitude !== 'number') continue

      const label =
        entity?.labels?.pt?.value ?? entity?.labels?.en?.value ?? text

      const candidate: LocationCandidate = {
        lat: point.latitude,
        lon: point.longitude,
        displayName: label,
        score: 0.85,
        // Um monumento nomeado é uma resolução bastante específica.
        precision: 0.9,
        provider: 'wikidata',
        query: text
      }
      cache.set(key, candidate)
      return candidate
    }

    cache.set(key, null)
    return null
  } catch (error) {
    log.error('busca na wikidata falhou', error)
    return null
  }
}

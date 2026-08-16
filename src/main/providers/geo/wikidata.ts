import type { LocationCandidate } from '@shared/types'
import type { ProviderContext } from '../types'
import { getJson, type RequestOptions } from '../../util/http'
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
 * A Wikidata é multilíngue por construção, e oferece DUAS buscas que erram em
 * direções opostas — daí o encadeamento abaixo em vez de uma só.
 */

const API = 'https://www.wikidata.org/w/api.php'
const cache = new Lru<string, LocationCandidate | null>(200)

interface LabelSearchResponse {
  search?: Array<{ id?: string }>
}

interface FullTextResponse {
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
 * As duas buscas da Wikidata falham em casos opostos, e foi medindo os dois
 * que esta ordem apareceu:
 *
 *  - `wbsearchentities` casa RÓTULOS e apelidos e ordena por proeminência.
 *    Para "Cristo Redentor" devolve a estátua do Rio em primeiro lugar. É o
 *    que se quer quase sempre: quem fotografa um monumento fotografa o famoso.
 *  - a busca de TEXTO COMPLETO ordena por relevância textual, e para o mesmo
 *    "Cristo Redentor" devolve oito homônimos obscuros sem que o do Rio
 *    apareça em nenhum deles — mas é a única que encontra "Ponte Zhivopisny",
 *    nome que não é rótulo nem apelido em idioma nenhum, só aparece no CORPO
 *    do artigo.
 *
 * Por isso a proeminência vem primeiro e o texto completo entra como resgate.
 * Inverter a ordem devolve monumentos errados para nomes famosos, que é o erro
 * mais caro que este resolvedor pode cometer.
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

  const options: RequestOptions = {
    timeoutMs: context.timeoutMs,
    signal: context.signal,
    headers: { 'user-agent': userAgent(contact) }
  }

  /*
   * O modelo costuma responder "Ponte Zhivopisny, Moscou" — nome e cidade
   * juntos. Nenhuma das buscas casa a frase inteira, enquanto só o nome
   * encontra na hora. A forma completa é tentada primeiro mesmo assim, porque
   * quando ela funciona já vem desambiguada.
   */
  const names = [text.trim()]
  const beforeComma = text.split(',')[0]?.trim()
  if (beforeComma && beforeComma !== text.trim()) names.push(beforeComma)

  try {
    // Todas as tentativas por rótulo antes de qualquer uma por texto completo:
    // a ordem entre as ESTRATÉGIAS importa mais que a ordem entre os nomes.
    for (const search of [searchByLabel, searchByFullText]) {
      for (const name of names) {
        const ids = await search(name, options)
        const found = await firstWithCoordinate(ids, options)
        if (!found) continue

        const candidate: LocationCandidate = {
          lat: found.lat,
          lon: found.lon,
          displayName: found.label ?? text,
          score: 0.85,
          // Um monumento nomeado é uma resolução bastante específica.
          precision: 0.9,
          provider: 'wikidata',
          query: text
        }
        cache.set(key, candidate)
        return candidate
      }
    }

    cache.set(key, null)
    return null
  } catch (error) {
    log.error('busca na wikidata falhou', error)
    return null
  }
}

/**
 * Busca por rótulo e apelido, ordenada por proeminência.
 *
 * Tenta português e depois inglês porque o modelo escreve em pt-BR mas
 * mantém nomes próprios como aparecem nos mapas, que muitas vezes é o inglês.
 */
async function searchByLabel(name: string, options: RequestOptions): Promise<string[]> {
  for (const language of ['pt', 'en']) {
    const url = new URL(API)
    url.searchParams.set('action', 'wbsearchentities')
    url.searchParams.set('search', name)
    url.searchParams.set('language', language)
    url.searchParams.set('uselang', language)
    url.searchParams.set('type', 'item')
    url.searchParams.set('limit', '5')
    url.searchParams.set('format', 'json')

    const body = await getJson<LabelSearchResponse>(url.toString(), options)
    const ids = (body.search ?? [])
      .map((item) => item.id ?? '')
      .filter((id) => /^Q\d+$/.test(id))
    if (ids.length > 0) return ids
  }
  return []
}

/**
 * Busca no texto dos artigos — varre todos os idiomas e aliases, que é o que
 * faz um nome transliterado funcionar.
 *
 * `haswbstatement:P625` limita a itens que TÊM coordenada. Sem isso a lista
 * vinha cheia de conceitos, pessoas e obras de arte homônimas, e cada uma
 * gastava uma vaga das cinco antes de ser descartada na etapa seguinte.
 */
async function searchByFullText(name: string, options: RequestOptions): Promise<string[]> {
  const url = new URL(API)
  url.searchParams.set('action', 'query')
  url.searchParams.set('list', 'search')
  url.searchParams.set('srsearch', `${name} haswbstatement:P625`)
  url.searchParams.set('srlimit', '5')
  url.searchParams.set('format', 'json')

  const body = await getJson<FullTextResponse>(url.toString(), options)
  return (body.query?.search ?? [])
    .map((item) => item.title ?? '')
    .filter((id) => /^Q\d+$/.test(id))
}

/**
 * Primeira entidade da lista que tem coordenada.
 *
 * A ordem vem da busca e é significativa, então percorremos preservando-a.
 * Entidades sem P625 (conceitos, pessoas, pinturas com o nome do monumento)
 * são puladas em vez de descartarem a busca inteira.
 */
async function firstWithCoordinate(
  ids: string[],
  options: RequestOptions
): Promise<{ lat: number; lon: number; label?: string } | null> {
  if (ids.length === 0) return null

  const url = new URL(API)
  url.searchParams.set('action', 'wbgetentities')
  url.searchParams.set('ids', ids.join('|'))
  url.searchParams.set('props', 'claims|labels')
  url.searchParams.set('languages', 'pt|en')
  url.searchParams.set('format', 'json')

  const detail = await getJson<EntitiesResponse>(url.toString(), options)

  for (const id of ids) {
    const entity = detail.entities?.[id]
    const point = entity?.claims?.P625?.[0]?.mainsnak?.datavalue?.value
    if (typeof point?.latitude !== 'number' || typeof point?.longitude !== 'number') continue

    return {
      lat: point.latitude,
      lon: point.longitude,
      label: entity?.labels?.pt?.value ?? entity?.labels?.en?.value
    }
  }

  return null
}

import type { GeoQuery, ProviderContext } from '../types'
import { getSettings } from '../../settings'
import { getJson, postJson } from '../../util/http'
import { log } from '../../util/logger'
import { normalize } from './gazetteer'

/**
 * Validação de pistas por pesquisa externa.
 *
 * O uso mais valioso da busca aqui NÃO é descobrir coordenadas — disso o
 * geocodificador dá conta. É **descartar pistas inexistentes**: se o modelo
 * de visão leu errado uma fachada e inventou "Restaurante Vila Nogueira",
 * a busca não devolve nada, a consulta é despriorizada e aquele falso
 * positivo nunca vira um alfinete no mapa.
 *
 * O segundo uso é enriquecer a consulta com um topônimo que apareça de forma
 * consistente nos resultados, o que ajuda o geocodificador a desambiguar
 * nomes repetidos ("Rua Augusta" existe em Lisboa e em São Paulo).
 */

export interface SearchResult {
  title: string
  snippet: string
  url: string
}

export async function verifyQueries(
  queries: GeoQuery[],
  context: ProviderContext
): Promise<GeoQuery[]> {
  const settings = getSettings()
  if (settings.webSearchProvider === 'none' || !settings.allowNetwork) {
    return queries
  }

  // Um provedor escolhido sem a configuração que ele exige é o mesmo que
  // nenhum provedor: seguir adiante só produziria uma falha por consulta,
  // engolida pelo tratamento de erro, custando tempo e não entregando nada.
  const missingConfig =
    (settings.webSearchProvider === 'searxng' && !settings.webSearchUrl.trim()) ||
    ((settings.webSearchProvider === 'brave' || settings.webSearchProvider === 'tavily') &&
      !settings.webSearchApiKey.trim())

  if (missingConfig) {
    log.warn(`busca externa "${settings.webSearchProvider}" sem configuração; etapa ignorada`)
    return queries
  }

  // Todas as buscas em paralelo: são independentes e a etapa inteira tem
  // deadline próprio no orquestrador.
  const verified = await Promise.all(
    queries.map(async (query) => {
      try {
        const results = await search(query.text, context)

        if (results.length === 0) {
          // Nada encontrado: a pista provavelmente não existe. Não removemos
          // a consulta (a busca também erra), mas derrubamos a prioridade
          // para que ela não domine a fusão.
          return { ...query, priority: query.priority * 0.35 }
        }

        const toponym = frequentToponym(results, query.text)
        return {
          ...query,
          text: toponym ? `${query.text}, ${toponym}` : query.text,
          priority: Math.min(1, query.priority * 1.15)
        }
      } catch (error) {
        log.error('busca externa falhou; usando a consulta original', error)
        return query
      }
    })
  )

  return verified
}

async function search(query: string, context: ProviderContext): Promise<SearchResult[]> {
  const settings = getSettings()
  const options = { timeoutMs: context.timeoutMs, signal: context.signal }

  switch (settings.webSearchProvider) {
    case 'searxng': {
      const url = new URL('/search', settings.webSearchUrl)
      url.searchParams.set('q', query)
      url.searchParams.set('format', 'json')
      const body = await getJson<{ results?: Array<{ title?: string; content?: string; url?: string }> }>(
        url.toString(),
        options
      )
      return (body.results ?? []).slice(0, 5).map((item) => ({
        title: item.title ?? '',
        snippet: item.content ?? '',
        url: item.url ?? ''
      }))
    }

    case 'brave': {
      const url = new URL('https://api.search.brave.com/res/v1/web/search')
      url.searchParams.set('q', query)
      url.searchParams.set('count', '5')
      const body = await getJson<{
        web?: { results?: Array<{ title?: string; description?: string; url?: string }> }
      }>(url.toString(), {
        ...options,
        headers: {
          accept: 'application/json',
          'x-subscription-token': settings.webSearchApiKey
        }
      })
      return (body.web?.results ?? []).map((item) => ({
        title: item.title ?? '',
        snippet: item.description ?? '',
        url: item.url ?? ''
      }))
    }

    case 'tavily': {
      const body = await postJson<{
        results?: Array<{ title?: string; content?: string; url?: string }>
      }>(
        'https://api.tavily.com/search',
        {
          api_key: settings.webSearchApiKey,
          query,
          max_results: 5,
          search_depth: 'basic'
        },
        options
      )
      return (body.results ?? []).map((item) => ({
        title: item.title ?? '',
        snippet: item.content ?? '',
        url: item.url ?? ''
      }))
    }

    default:
      return []
  }
}

/**
 * Extrai o topônimo mais recorrente dos resultados.
 *
 * Heurística deliberadamente conservadora: só aceita uma sequência iniciada
 * por maiúscula que apareça em ao menos DOIS resultados distintos. Exigir
 * corroboração evita pescar um nome próprio qualquer de um único snippet.
 * Mesmo assim, o topônimo é apenas anexado à consulta — quem decide continua
 * sendo o geocodificador, então um palpite ruim falha de forma silenciosa em
 * vez de virar resposta.
 */
function frequentToponym(results: SearchResult[], originalQuery: string): string | null {
  const queryTokens = new Set(normalize(originalQuery).split(' '))
  const counts = new Map<string, Set<number>>()

  results.forEach((result, index) => {
    const text = `${result.title} ${result.snippet}`
    for (const match of text.matchAll(TOPONYM_PATTERN)) {
      const candidate = match[0].trim()
      const key = normalize(candidate)

      if (key.length < 4) continue
      if (STOPWORDS.has(key)) continue
      // Ignora o que já está na própria consulta.
      if (key.split(' ').every((token) => queryTokens.has(token))) continue

      if (!counts.has(candidate)) counts.set(candidate, new Set())
      counts.get(candidate)!.add(index)
    }
  })

  let best: string | null = null
  let bestCount = 1 // exige aparecer em >= 2 resultados
  for (const [candidate, sources] of counts) {
    if (sources.size > bestCount) {
      best = candidate
      bestCount = sources.size
    }
  }

  return best
}

/** Sequências de palavras iniciadas por maiúscula (inclui acentos latinos). */
const TOPONYM_PATTERN = /\b[A-ZÀ-Þ][a-zà-ÿ]{2,}(?:\s+(?:de|da|do|dos|das|d')?\s*[A-ZÀ-Þ][a-zà-ÿ]{2,}){0,2}/gu

const STOPWORDS = new Set([
  'wikipedia',
  'google',
  'maps',
  'tripadvisor',
  'facebook',
  'instagram',
  'youtube',
  'booking',
  'saiba mais',
  'veja',
  'sobre',
  'como',
  'onde',
  'quando',
  'the',
  'este',
  'esta',
  'para'
])

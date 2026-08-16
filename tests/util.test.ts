import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Lru } from '../src/main/util/lru'
import { RateLimiter } from '../src/main/providers/geo/ratelimit'
import { withDeadline } from '../src/main/util/http'
import { countryCodeFor, countryCodeForLanguage } from '../src/main/providers/geo/countries'
import { normalize } from '../src/main/providers/geo/gazetteer'

describe('Lru', () => {
  it('guarda e devolve', () => {
    const cache = new Lru<string, number>(3)
    cache.set('a', 1)
    assert.equal(cache.get('a'), 1)
    assert.equal(cache.get('inexistente'), undefined)
  })

  it('descarta o menos usado recentemente ao encher', () => {
    const cache = new Lru<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a') // 'a' volta a ser o mais recente
    cache.set('c', 3)

    assert.equal(cache.get('b'), undefined, '"b" era o mais antigo em uso')
    assert.equal(cache.get('a'), 1)
    assert.equal(cache.get('c'), 3)
  })

  it('distingue "sem entrada" de "entrada com valor nulo"', () => {
    // O resolvedor da Wikidata guarda `null` para dizer "já procurei e não
    // existe". Se isso fosse indistinguível de "nunca procurei", cada análise
    // repetiria a mesma busca perdida.
    const cache = new Lru<string, string | null>(2)
    cache.set('nada', null)
    assert.equal(cache.get('nada'), null)
    assert.equal(cache.get('outro'), undefined)
  })

  it('esvazia', () => {
    const cache = new Lru<string, number>(2)
    cache.set('a', 1)
    cache.clear()
    assert.equal(cache.get('a'), undefined)
  })
})

describe('RateLimiter', () => {
  it('espaça as chamadas no intervalo pedido', async () => {
    // A instância pública do Nominatim bloqueia por IP quem dispara em
    // paralelo; o espaçamento é o que mantém o app dentro da política.
    const limiter = new RateLimiter(60)
    const marcas: number[] = []
    const inicio = Date.now()

    await Promise.all(
      [0, 1, 2].map(() =>
        limiter.schedule(async () => {
          marcas.push(Date.now() - inicio)
        })
      )
    )

    assert.equal(marcas.length, 3)
    assert.ok(marcas[1]! >= 55, `segunda chamada em ${marcas[1]}ms`)
    assert.ok(marcas[2]! >= 115, `terceira chamada em ${marcas[2]}ms`)
  })

  it('não quebra a fila quando uma tarefa falha', async () => {
    // Uma consulta que dá erro não pode travar as seguintes: elas são
    // independentes, e a análise trabalha com o que sobrar.
    const limiter = new RateLimiter(10)
    await assert.rejects(limiter.schedule(async () => Promise.reject(new Error('falhou'))))
    assert.equal(await limiter.schedule(async () => 'ok'), 'ok')
  })

  it('não espera nada quando o intervalo é zero', async () => {
    const limiter = new RateLimiter(0)
    const inicio = Date.now()
    await Promise.all([1, 2, 3, 4].map(() => limiter.schedule(async () => null)))
    assert.ok(Date.now() - inicio < 50, 'instância própria libera o paralelismo')
  })
})

describe('withDeadline', () => {
  it('devolve o valor quando a promessa chega a tempo', async () => {
    assert.equal(await withDeadline(Promise.resolve('pronto'), 50, 'reserva'), 'pronto')
  })

  it('degrada para a reserva quando estoura o prazo', async () => {
    const lenta = new Promise<string>((resolve) => setTimeout(() => resolve('tarde'), 200))
    assert.equal(await withDeadline(lenta, 20, 'reserva'), 'reserva')
  })
})

describe('normalize', () => {
  it('tira acento e caixa para comparar', () => {
    assert.equal(normalize('São Paulo'), 'sao paulo')
    assert.equal(normalize('GRÉCIA'), 'grecia')
  })

  it('colapsa espaço e pontuação', () => {
    assert.equal(normalize('  Rua   Augusta, 240 '), 'rua augusta 240')
  })

  it('faz duas grafias da mesma coisa colidirem', () => {
    assert.equal(normalize('AV. PAULISTA'), normalize('Av. Paulista'))
  })
})

describe('mapa de países', () => {
  it('converte nome de país em código ISO', () => {
    assert.equal(countryCodeFor('Brasil'), 'BR')
    assert.equal(countryCodeFor('BRASIL'), 'BR')
    assert.equal(countryCodeFor('Japão'), 'JP')
    assert.equal(countryCodeFor('Estados Unidos'), 'US')
  })

  it('devolve indefinido para nome desconhecido, em vez de chutar', () => {
    // Nome fora da lista não é erro: ele entra como texto na consulta e o
    // geocodificador resolve. Chutar um código erraria o filtro de país.
    assert.equal(countryCodeFor('Freedonia'), undefined)
    assert.equal(countryCodeFor(undefined), undefined)
    assert.equal(countryCodeFor(''), undefined)
  })

  it('deduz país por idioma só quando ele aponta para um só', () => {
    assert.equal(countryCodeForLanguage('japonês'), 'JP')
    assert.equal(countryCodeForLanguage('grego'), 'GR')
  })

  it('não deduz país por idioma falado em muitos', () => {
    // "português" apontaria para 9 países e "espanhol" para 20; deduzir daí
    // produziria um viés errado no filtro da consulta.
    assert.equal(countryCodeForLanguage('português'), undefined)
    assert.equal(countryCodeForLanguage('espanhol'), undefined)
    assert.equal(countryCodeForLanguage('inglês'), undefined)
  })
})

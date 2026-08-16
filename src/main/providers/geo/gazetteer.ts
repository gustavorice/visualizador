/** Gazetteer mínimo usado pelo provedor geográfico simulado. */
export interface GazetteerEntry {
  /** Termos que casam com a consulta (já normalizados). */
  match: string[]
  city?: string
  region?: string
  country: string
  countryCode: string
  lat: number
  lon: number
  displayName: string
  score: number
}

export const GAZETTEER: GazetteerEntry[] = [
  {
    match: ['masp', 'museu de arte de sao paulo'],
    city: 'São Paulo',
    region: 'São Paulo',
    country: 'Brasil',
    countryCode: 'BR',
    lat: -23.5614,
    lon: -46.6558,
    displayName: 'MASP, Avenida Paulista, Bela Vista, São Paulo, Brasil',
    score: 0.96
  },
  {
    match: ['avenida paulista', 'av paulista', 'av. paulista'],
    city: 'São Paulo',
    region: 'São Paulo',
    country: 'Brasil',
    countryCode: 'BR',
    lat: -23.5613,
    lon: -46.656,
    displayName: 'Avenida Paulista, São Paulo, Brasil',
    score: 0.88
  },
  {
    match: ['trianon-masp', 'trianon masp', 'estacao trianon'],
    city: 'São Paulo',
    region: 'São Paulo',
    country: 'Brasil',
    countryCode: 'BR',
    lat: -23.5617,
    lon: -46.6553,
    displayName: 'Estação Trianon-Masp, Linha 2-Verde, São Paulo, Brasil',
    score: 0.9
  },
  {
    match: ['masp.org.br', '11 3251-4000', '11 32514000'],
    city: 'São Paulo',
    region: 'São Paulo',
    country: 'Brasil',
    countryCode: 'BR',
    lat: -23.5614,
    lon: -46.6558,
    displayName: 'São Paulo, Brasil',
    score: 0.7
  },
  {
    match: ['arco da rua augusta', 'rua augusta'],
    city: 'Lisboa',
    region: 'Lisboa',
    country: 'Portugal',
    countryCode: 'PT',
    lat: 38.7092,
    lon: -9.1367,
    displayName: 'Arco da Rua Augusta, Baixa, Lisboa, Portugal',
    score: 0.93
  },
  {
    match: ['baixa-chiado', 'baixa chiado'],
    city: 'Lisboa',
    region: 'Lisboa',
    country: 'Portugal',
    countryCode: 'PT',
    lat: 38.7107,
    lon: -9.14,
    displayName: 'Estação Baixa-Chiado, Metropolitano de Lisboa, Portugal',
    score: 0.9
  },
  {
    match: ['elevador de santa justa', 'santa justa'],
    city: 'Lisboa',
    region: 'Lisboa',
    country: 'Portugal',
    countryCode: 'PT',
    lat: 38.7124,
    lon: -9.1394,
    displayName: 'Elevador de Santa Justa, Lisboa, Portugal',
    score: 0.94
  },
  {
    match: ['pasteis de belem', 'praca do comercio'],
    city: 'Lisboa',
    region: 'Lisboa',
    country: 'Portugal',
    countryCode: 'PT',
    lat: 38.7077,
    lon: -9.1365,
    displayName: 'Praça do Comércio, Lisboa, Portugal',
    score: 0.85
  },
  // Entradas de nível país: resolvem, mas sem cidade — geram veredito ambíguo.
  {
    match: ['japao', 'japan', 'japones', 'iene', 'yen'],
    country: 'Japão',
    countryCode: 'JP',
    lat: 36.2048,
    lon: 138.2529,
    displayName: 'Japão',
    score: 0.5
  },
  {
    match: ['brasil', 'brazil'],
    country: 'Brasil',
    countryCode: 'BR',
    lat: -14.235,
    lon: -51.9253,
    displayName: 'Brasil',
    score: 0.45
  },
  {
    match: ['grecia', 'greece'],
    country: 'Grécia',
    countryCode: 'GR',
    lat: 39.0742,
    lon: 21.8243,
    displayName: 'Grécia',
    score: 0.45
  },
  {
    match: ['portugal'],
    country: 'Portugal',
    countryCode: 'PT',
    lat: 39.3999,
    lon: -8.2245,
    displayName: 'Portugal',
    score: 0.45
  }
]

/** Remove acentos e pontuação para comparação tolerante. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

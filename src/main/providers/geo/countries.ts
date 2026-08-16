import { normalize } from './gazetteer'

/**
 * Mapa reduzido de nome de país -> código ISO-3166-1 alfa-2.
 *
 * Serve só para converter o palpite textual do modelo de visão em um filtro
 * `countrycodes` para o geocodificador. Nome desconhecido não é erro: nesse
 * caso o país entra como texto na consulta e o geocodificador resolve.
 */
const COUNTRY_CODES: Record<string, string> = {
  brasil: 'BR',
  brazil: 'BR',
  portugal: 'PT',
  japao: 'JP',
  japan: 'JP',
  argentina: 'AR',
  chile: 'CL',
  uruguai: 'UY',
  paraguai: 'PY',
  colombia: 'CO',
  peru: 'PE',
  mexico: 'MX',
  'estados unidos': 'US',
  eua: 'US',
  'united states': 'US',
  canada: 'CA',
  espanha: 'ES',
  spain: 'ES',
  franca: 'FR',
  france: 'FR',
  italia: 'IT',
  italy: 'IT',
  alemanha: 'DE',
  germany: 'DE',
  'reino unido': 'GB',
  inglaterra: 'GB',
  'united kingdom': 'GB',
  irlanda: 'IE',
  holanda: 'NL',
  'paises baixos': 'NL',
  belgica: 'BE',
  suica: 'CH',
  austria: 'AT',
  grecia: 'GR',
  turquia: 'TR',
  marrocos: 'MA',
  'africa do sul': 'ZA',
  china: 'CN',
  'coreia do sul': 'KR',
  india: 'IN',
  tailandia: 'TH',
  vietna: 'VN',
  indonesia: 'ID',
  australia: 'AU',
  'nova zelandia': 'NZ',
  noruega: 'NO',
  suecia: 'SE',
  dinamarca: 'DK',
  finlandia: 'FI',
  polonia: 'PL',
  'republica tcheca': 'CZ',
  hungria: 'HU',
  romenia: 'RO',
  russia: 'RU'
}

export function countryCodeFor(name: string | undefined): string | undefined {
  if (!name) return undefined
  return COUNTRY_CODES[normalize(name)]
}

/**
 * Idioma -> país provável. Só é aplicado quando o idioma mapeia para UM país
 * dominante; "português" e "espanhol" ficam de fora de propósito, porque
 * apontariam para vários países e produziriam um viés errado.
 */
const LANGUAGE_TO_COUNTRY: Record<string, string> = {
  japones: 'JP',
  japanese: 'JP',
  coreano: 'KR',
  tailandes: 'TH',
  grego: 'GR',
  hebraico: 'IL',
  polones: 'PL',
  turco: 'TR',
  vietnamita: 'VN',
  hungaro: 'HU'
}

export function countryCodeForLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined
  return LANGUAGE_TO_COUNTRY[normalize(language)]
}

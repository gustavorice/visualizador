import type { EvidenceKind } from '@shared/types'

/**
 * Cenários usados pelos provedores simulados.
 *
 * Existem quatro de propósito, cobrindo os três vereditos possíveis, para que
 * dê para exercitar o caminho honesto de falha ("não sei") sem precisar do
 * Ollama instalado. Os provedores simulados escolhem o cenário pelo hash da
 * imagem, então cada tela/janela cai consistentemente no mesmo caso.
 */

export interface ScenarioClue {
  kind: EvidenceKind
  value: string
  detail: string
}

export interface Scenario {
  key: string
  ocrLines: string[]
  clues: ScenarioClue[]
  sceneDescription: string
  hint: { country?: string; region?: string; city?: string; language?: string }
}

export const SCENARIOS: Scenario[] = [
  {
    key: 'sao-paulo',
    ocrLines: [
      'AV. PAULISTA',
      'MASP - Museu de Arte de São Paulo Assis Chateaubriand',
      'Estação Trianon-Masp',
      'Farmácia 24h  (11) 3251-4000',
      'www.masp.org.br'
    ],
    clues: [
      {
        kind: 'landmark',
        value: 'MASP — Museu de Arte de São Paulo',
        detail: 'Vão livre vermelho suspenso, silhueta inconfundível.'
      },
      {
        kind: 'street_sign',
        value: 'Avenida Paulista',
        detail: 'Placa de logradouro no padrão da CET-SP.'
      },
      {
        kind: 'transit',
        value: 'Estação Trianon-Masp',
        detail: 'Estação da Linha 2-Verde do Metrô de São Paulo.'
      },
      {
        kind: 'phone',
        value: '(11) 3251-4000',
        detail: 'DDD 11 corresponde à região metropolitana de São Paulo.'
      },
      {
        kind: 'domain',
        value: 'masp.org.br',
        detail: 'Domínio .br indica Brasil.'
      },
      { kind: 'language', value: 'português', detail: 'Textos em português brasileiro.' }
    ],
    sceneDescription:
      'Avenida larga com canteiro central, prédio de concreto e vidro suspenso por vigas vermelhas ao fundo, trânsito intenso e vegetação urbana.',
    hint: { country: 'Brasil', region: 'São Paulo', city: 'São Paulo', language: 'português' }
  },
  {
    key: 'lisboa',
    ocrLines: [
      'RUA AUGUSTA',
      'Elevador de Santa Justa',
      'Pastéis de Belém — desde 1837',
      'Praça do Comércio',
      'Metropolitano de Lisboa — Baixa-Chiado'
    ],
    clues: [
      {
        kind: 'landmark',
        value: 'Arco da Rua Augusta',
        detail: 'Arco triunfal que liga a Rua Augusta à Praça do Comércio.'
      },
      {
        kind: 'street_sign',
        value: 'Rua Augusta',
        detail: 'Placa azulejada, padrão típico lisboeta.'
      },
      {
        kind: 'transit',
        value: 'Baixa-Chiado',
        detail: 'Estação do Metropolitano de Lisboa.'
      },
      {
        kind: 'architecture',
        value: 'calçada portuguesa',
        detail: 'Pavimento em pedra calcária preta e branca.'
      },
      { kind: 'language', value: 'português europeu', detail: 'Grafia europeia nos letreiros.' }
    ],
    sceneDescription:
      'Rua pedonal ladeada por edifícios pombalinos amarelos, calçada em mosaico preto e branco, arco monumental ao fundo.',
    hint: { country: 'Portugal', region: 'Lisboa', city: 'Lisboa', language: 'português' }
  },
  {
    key: 'japao-generico',
    // Sem monumento e sem nome de rua resolvível: só dá para chegar ao país.
    ocrLines: ['営業中', '禁煙', '自動販売機', '¥ 150'],
    clues: [
      { kind: 'language', value: 'japonês', detail: 'Kanji e kana nos letreiros.' },
      { kind: 'currency', value: 'iene (¥)', detail: 'Preços marcados em ¥.' },
      {
        kind: 'signage_style',
        value: 'máquinas de venda automática',
        detail: 'Densidade de vending machines típica do Japão.'
      },
      {
        kind: 'architecture',
        value: 'fiação aérea densa',
        detail: 'Postes com feixes de cabos, comum em ruas japonesas.'
      }
    ],
    sceneDescription:
      'Rua estreita com letreiros verticais luminosos, máquinas de venda automática junto ao meio-fio e fiação aérea densa.',
    hint: { country: 'Japão', language: 'japonês' }
  },
  {
    key: 'sem-pistas',
    // Uma tela de editor de código: nada geográfico. Caminho honesto de falha.
    ocrLines: [
      'src/main/pipeline/analyze.ts',
      'export async function analyze(options: AnalyzeOptions)',
      'npm run dev',
      'TypeScript  •  UTF-8  •  LF'
    ],
    clues: [
      {
        kind: 'text',
        value: 'interface de editor de código',
        detail: 'Conteúdo de software, sem referência a lugar físico.'
      }
    ],
    sceneDescription:
      'Janela de editor de texto com código-fonte em tema escuro, barra lateral de arquivos e terminal integrado.',
    hint: {}
  }
]

/** Escolhe um cenário de forma estável a partir de um hash hexadecimal. */
export function pickScenario(hash: string): Scenario {
  const nibble = Number.parseInt(hash.slice(0, 8), 16)
  const index = Number.isNaN(nibble) ? 0 : nibble % SCENARIOS.length
  return SCENARIOS[index]!
}

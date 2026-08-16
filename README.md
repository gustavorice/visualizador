# Visualizador

Aplicativo desktop para Windows que captura **uma única imagem** de uma tela ou
janela escolhida por você e tenta identificar **em que lugar do mundo** aquela
imagem foi tirada ou exibida — usando OCR, um modelo de visão local e validação
geográfica externa.

O resultado traz **cidade, região e país**, o nível de confiança, as evidências
que sustentam a conclusão e um mapa com marcador. Quando não há dados
suficientes, o app **diz isso claramente** em vez de inventar um lugar.

## Como começar

```bash
npm install
npm run dev        # abre o app em modo desenvolvimento
```

Outros comandos:

```bash
npm run verify     # roda o núcleo de análise sem Electron e confere os vereditos
npm run build      # typecheck + build de produção
npm run build:win  # gera instalador NSIS e versão portátil para Windows
```

**Funciona no primeiro clique, sem configurar nada e sem chave de API.** Os
padrões já vêm em provedores reais:

| Etapa | Padrão | Precisa de quê? |
| --- | --- | --- |
| OCR | **Tesseract** (local) | nada — já é dependência |
| Visão | **desligada** | um modelo, se você quiser (veja abaixo) |
| Geografia | **Nominatim** (OSM) | nada — gratuito e sem chave |

Isso resolve o caso mais comum de captura de tela: mapas, sites e painéis
quase sempre trazem o endereço escrito, e o OCR lê. Medição real, ponta a
ponta, numa captura do Street View:

```
OCR leu ....... "1387 Av. M 17" / "Rio Claro, State of São Paulo"
extraiu ....... [placa/rua] Av. M 17, 1387   [cidade] Rio Claro, São Paulo
Nominatim ..... Avenida M 17, Vila Martins, Rio Claro, São Paulo, 13505-150
veredito ...... Localizado · 78% · -22.38641, -47.55964
```

**Modelo de visão (opcional).** É o que resolve fotos *sem* texto — paisagens,
fachadas, monumentos:

| Provedor | Precisão | Precisa de quê? | A imagem sai da máquina? |
| --- | --- | --- | --- |
| Desligado | — | — | não |
| Ollama (local) | boa para texto, fraca para reconhecer lugares | instalar o Ollama | **não** |
| Claude (nuvem) | alta — reconhece monumentos e fachadas | chave de API | **sim** |
| Simulado | nenhuma — **ignora a imagem** | — | não |

> ⚠️ **O modo simulado ignora a sua imagem.** Ele devolve um cenário de
> demonstração fixo, escolhido pelo hash do quadro, então o resultado não tem
> relação com o que está na tela. Ele não é mais padrão, e o app avisa em
> destaque enquanto qualquer provedor simulado estiver ativo.

Detalhes de cada provedor em
[`docs/OLLAMA-E-PESQUISA.md`](docs/OLLAMA-E-PESQUISA.md).

## A regra que impede o app de inventar lugares

Esta é a decisão de arquitetura mais importante do projeto:

> **O modelo de visão nunca decide a localização. Ele só extrai pistas
> observáveis. Quem transforma pista em coordenada é o provedor geográfico.**

Um modelo de linguagem com visão, se perguntado "onde foi tirada esta foto?",
responde com algo plausível — e plausível não é verdadeiro. Então ele nunca
recebe essa pergunta. A ele cabe listar o que está visível: o texto da placa, o
nome da fachada, o idioma, a vegetação. Essas pistas viram consultas de
geocodificação, e só uma pista que **resolve em um lugar real** pode virar
resposta.

Isso é reforçado por regras explícitas em
[`src/shared/confidence.ts`](src/shared/confidence.ts):

- O veredito só é `located` se houver geocódigo resolvido **e** pelo menos uma
  pista "dura" (monumento, placa de rua, estabelecimento, transporte, domínio,
  telefone). Idioma e vegetação sozinhos nunca produzem uma cidade.
- Pistas que restringem só o país (idioma, moeda, bandeira, placa veicular)
  levam no máximo a `ambiguous` em nível de país — o app diz "não consegui
  determinar a cidade".
- Veredito `insufficient` **nunca** carrega coordenada. Isso é testado como
  invariante em `npm run verify`.
- A confiança tem teto de 95%: a imagem pode ser a foto de um cartaz, um filme
  ou um mapa aberto na tela, e nenhuma quantidade de pistas elimina esse
  resíduo.

Os três vereditos possíveis:

| Veredito | O que significa | Mostra local? |
| --- | --- | --- |
| **Localizado** | Cidade resolvida, com pista dura e confiança ≥ 55% | Sim |
| **Ambíguo** | Só deu para chegar a região/país, ou os candidatos discordam | Sim, com raio de incerteza grande |
| **Dados insuficientes** | Nada resolvível na imagem | **Não** |

## Privacidade

- **Nada de captura contínua.** Não existe timer nem laço no código que capture
  a tela. A captura só acontece dentro do handler IPC disparado pelo seu clique.
- **Nada é salvo por padrão.** As imagens vivem em memória durante a análise.
  Gravar em disco é uma opção desligada (`saveCaptures`).
- **A imagem não sai da máquina** com os provedores padrão. O OCR roda
  localmente e o Ollama roda em `localhost`. Para a rede sai apenas **texto** —
  as pistas a serem validadas. A exceção é explícita: escolher **Claude** como
  visão envia a imagem para a API, e a interface avisa isso enquanto ele
  estiver ativo.
- **`allowNetwork` vem ligado**, porque sem resolver pista em coordenada o app
  não tem função. Desligue em Configurações para isolamento total — aí nada
  sai, e o veredito para em "dados insuficientes".
- **Ressalva honesta:** o Tesseract baixa o pacote de idiomas do CDN na
  primeira execução. Esse download é interno da biblioteca e não passa pelo
  controle `allowNetwork` do app. Para evitá-lo, baixe os `.traineddata` e
  aponte `langPath` (veja `docs/OLLAMA-E-PESQUISA.md`).
- **Sem telemetria e sem autoatualização.** Não há log em disco; o console
  registra apenas nomes de etapa e durações, nunca o conteúdo da sua tela.

## Velocidade

O caminho do clique ao resultado falado é curto por desenho, não por acaso:

1. **Captura em uma chamada nativa.** `desktopCapturer` com `thumbnailSize` já
   no tamanho de análise devolve o quadro pronto. Não há stream de vídeo para
   negociar nem primeiro frame para esperar.
2. **Prévia imediata.** A imagem aparece na tela antes de qualquer inferência.
3. **OCR e visão em paralelo.** São as duas etapas caras e não dependem uma da
   outra, então o custo é o `max()`, não a soma.
4. **Provedores aquecidos no boot.** O worker do Tesseract e o modelo do Ollama
   são carregados quando o app abre, para que o primeiro clique não pague a
   inicialização.
5. **Resultados progressivos.** As pistas aparecem enquanto a geocodificação
   ainda roda.
6. **Prazo em toda etapa.** Uma etapa lenta degrada para "pulada" em vez de
   travar a análise — resposta parcial rápida vale mais que resposta completa
   tardia.
7. **Atalho global.** `Alt+Shift+A` reanalisa a última fonte sem abrir o
   seletor.

A linha do tempo no topo da janela mostra o custo de cada etapa, para você ver
onde o tempo está indo. Medição real do MVP simulado, ponta a ponta:

```
captura 64ms | OCR 181ms | visão 421ms | fusão 1ms | geocodificação 62ms | total 489ms
```

Com provedores reais, o gargalo passa a ser o modelo de visão e o
geocodificador — as duas coisas que `docs/OLLAMA-E-PESQUISA.md` ensina a
ajustar.

## Estrutura

```
src/
├── shared/              contratos entre processos + regras de confiança
│   ├── types.ts
│   ├── ipc.ts
│   └── confidence.ts    pesos das pistas, limiares e a função de veredito
├── main/                processo principal (Node)
│   ├── index.ts         ciclo de vida, janela, atalho global
│   ├── ipc.ts           handlers IPC
│   ├── settings.ts      configuração persistida
│   ├── capture/         captura de tela/janela
│   ├── pipeline/
│   │   ├── analyze.ts   orquestrador (paralelismo e prazos)
│   │   ├── queries.ts   extração de pistas e montagem de consultas
│   │   └── fuse.ts      agrupamento, confiança e veredito
│   ├── providers/
│   │   ├── types.ts     interfaces OCR / visão / geografia
│   │   ├── ocr/         mock.ts · tesseract.ts
│   │   ├── vision/      mock.ts · ollama.ts
│   │   ├── geo/         mock.ts · nominatim.ts · websearch.ts
│   │   └── scenarios.ts cenários usados pelo modo simulado
│   └── tts/speak.ts     voz do sistema (reserva)
├── preload/             ponte segura e estreita para o renderer
└── renderer/            React + Vite
    └── src/
        ├── App.tsx
        ├── components/  seletor, prévia, resultado, evidências, mapa…
        ├── hooks/       useAnalysis.ts
        └── lib/         tts.ts · format.ts
scripts/smoke.ts         verificação do núcleo sem Electron
```

## Stack

| Camada | Escolha | Por quê |
| --- | --- | --- |
| Shell | Electron 43 | `desktopCapturer` dá captura de tela/janela nativa no Windows |
| Build | electron-vite 5 | HMR nos três processos, integra com electron-builder |
| UI | React 19 + TypeScript | — |
| Mapa | MapLibre GL 6 + OSM | sem chave de API, sem rastreamento |
| OCR | Tesseract.js 7 | roda local, worker reaproveitado entre análises |
| Visão (local) | Ollama (`qwen2.5vl:3b`) | roda na máquina, saída estruturada por JSON Schema |
| Visão (nuvem) | Claude (`claude-opus-5`) | conhecimento de mundo que um modelo de 3B não tem |
| Geo | Nominatim (OSM) | gratuito; pode ser auto-hospedado para ganhar velocidade |
| Voz | Web Speech API + SAPI | vozes do sistema, sem rede |
| Empacotamento | electron-builder | NSIS + portátil |

## Documentação

- [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) — fluxo de dados, decisões e
  limites conhecidos.
- [`docs/OLLAMA-E-PESQUISA.md`](docs/OLLAMA-E-PESQUISA.md) — como sair do modo
  simulado e ligar Ollama, Tesseract e pesquisa externa.

## Licença

MIT.

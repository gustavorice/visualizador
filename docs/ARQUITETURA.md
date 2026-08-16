# Arquitetura

## Visão geral dos processos

```
┌─────────────────────────────────────────────────────────────────┐
│ RENDERER (React + Vite)          sem acesso a Node              │
│  App.tsx · useAnalysis · MapView · SourcePicker · ResultPanel    │
└───────────────────────────┬─────────────────────────────────────┘
                            │ contextBridge — superfície estreita
                            │ (listSources, analyze, cancel, settings,
                            │  health, speak, openExternal, eventos)
┌───────────────────────────┴─────────────────────────────────────┐
│ PRELOAD                    contextIsolation: true               │
└───────────────────────────┬─────────────────────────────────────┘
                            │ IPC
┌───────────────────────────┴─────────────────────────────────────┐
│ MAIN (Node)                                                     │
│                                                                 │
│  capture/  ──▶ pipeline/analyze.ts ──▶ providers/               │
│                     │                    ├── ocr/    (mock│tesseract)
│                     │                    ├── vision/ (mock│ollama)
│                     ▼                    └── geo/    (mock│nominatim)
│              pipeline/queries.ts                                │
│              pipeline/fuse.ts ──▶ shared/confidence.ts          │
└─────────────────────────────────────────────────────────────────┘
```

Toda chamada de rede acontece no processo principal. O renderer nunca fala com
Ollama, Nominatim ou buscadores — o que também permite manter a CSP do renderer
restrita a `connect-src 'self'`.

## Fluxo de uma análise

```
clique em "Analisar tela"
  │
  ├─▶ captura (uma chamada nativa, ~60-150ms)
  │     └─▶ emite PRÉVIA imediatamente ────────────▶ usuário já vê algo
  │
  ├─▶ ┌── OCR ────────────┐  em paralelo: o custo é o max(), não a soma
  │   └── visão (VLM) ────┘
  │         │
  │         └─▶ emite PISTAS conforme chegam ──────▶ lista se preenche
  │
  ├─▶ fusão de pistas (dedup + corroboração OCR×visão)
  │
  ├─▶ validação por busca (opcional) — derruba pistas inexistentes
  │
  ├─▶ geocodificação (paralela, allSettled)
  │
  ├─▶ agrupamento + confiança + veredito
  │
  └─▶ emite RESULTADO ──▶ mapa voa até o ponto ──▶ voz fala o resumo
```

Cada etapa emite eventos de progresso pelo canal `analysis:event`. O renderer é
uma máquina de estados alimentada por esses eventos
(`src/renderer/src/hooks/useAnalysis.ts`), e não uma espera por uma promessa
única — é isso que permite mostrar prévia e pistas antes do fim.

## Decisões que carregam o projeto

### 1. O modelo de visão não decide o lugar

Ele extrai pistas; o geocodificador resolve. Um VLM perguntado "onde é isto?"
sempre responde algo plausível, e plausível não é verdadeiro. Ao restringi-lo a
"liste o que está visível", o erro dele vira uma pista que não geocodifica — e
uma pista que não geocodifica não vira resposta.

### 2. A confiança é um produto, não uma soma

`confiança = força das pistas × qualidade da resolução`, com bônus de
corroboração quando consultas independentes caem no mesmo lugar.

A força das pistas usa **ruidosa-OU** (`1 - Π(1 - wᵢ)`): várias pistas fracas
somam, mas nunca chegam a 1. Sem isso, "idioma + vegetação + arquitetura"
simularia certeza, quando na prática as três juntas ainda apontam para meio
continente.

### 3. Granularidade é explícita

O resultado carrega `granularity: 'city' | 'region' | 'country' | 'none'`. Uma
cena com texto em japonês e preços em iene resolve o país honestamente, e o app
diz "não consegui determinar a cidade" — em vez de escolher Tóquio porque é a
cidade mais provável do país. O raio de incerteza no mapa cresce junto, para que
um resultado de nível país não apareça como um ponto preciso.

### 4. Prazos em vez de esperas

Toda requisição carrega `AbortController` + timer, composto com o sinal de
cancelamento do usuário via `AbortSignal.any`. A geocodificação usa
`allSettled`: uma consulta que falha não derruba as outras, apenas não
contribui candidatos.

### 5. Provedores são intercambiáveis por interface

`OcrProvider`, `VisionProvider` e `GeoProvider` (em
`src/main/providers/types.ts`) são implementados duas vezes: simulado e real. O
modo simulado não é um atalho de demonstração — ele exercita **o mesmo**
pipeline, a mesma fusão e as mesmas regras de veredito. É por isso que
`npm run verify` tem valor: o que ele valida é a lógica de produção.

## Limites conhecidos

- **Uma tela mostrando a foto de um lugar** é indistinguível de uma janela
  aberta naquele lugar. O app identifica onde a imagem foi *tirada ou exibida*,
  e essa ambiguidade é real. É a razão do teto de 95% de confiança.
- **O gazetteer simulado tem 11 entradas.** Ele existe para exercitar o
  pipeline, não para geocodificar de verdade.
- **A extração de topônimos da busca é heurística.** Exige corroboração em dois
  resultados e, mesmo assim, só enriquece a consulta — quem arbitra é o
  geocodificador.
- **Regex de OCR cobrem só padrões de alta precisão** (domínio, telefone, CEP,
  logradouro, inclusive em caixa alta). Nome de estabelecimento e monumento são
  responsabilidade do modelo de visão; tentar adivinhá-los com regex produziria
  ruído, e ruído aqui vira alfinete errado no mapa.
- **O mapa exige WebGL2.** Em máquinas virtuais, sessões de área de trabalho
  remota e drivers na lista de bloqueio ele não desenha; nesse caso a interface
  mostra o local e as coordenadas em texto, e o resto do app segue funcionando.
- **Sem testes automatizados de interface.** `npm run verify` cobre o núcleo de
  análise; a interface foi verificada manualmente e por um roteiro Playwright
  durante o desenvolvimento.

## Notas de plataforma

O alvo é Windows, mas o código não tem dependência nativa exclusiva dele:

- Captura: `desktopCapturer` funciona em Windows, macOS e Linux/X11. No macOS o
  sistema exige a permissão de Gravação de Tela.
- Voz: Web Speech API no renderer (SAPI no Windows), com reserva no processo
  principal via PowerShell no Windows, `say` no macOS e `spd-say` no Linux. O
  texto vai para o PowerShell por `stdin` com `-EncodedCommand`, nunca
  interpolado na linha de comando.
- Empacotamento: `electron-builder.yml` está configurado para NSIS e portátil
  x64.

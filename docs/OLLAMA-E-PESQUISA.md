# Do simulado para o real

O MVP roda com os três provedores em modo **simulado**. Este documento mostra
como trocar cada um pelo provedor real.

A troca é intencionalmente barata: os provedores reais **já estão escritos e
ligados**. O que muda é qual instância o pipeline consulta. A extração de
pistas, a fusão, o cálculo de confiança e as regras de veredito são exatamente
os mesmos código nos dois modos — o que você validou no simulado é o que roda
no real.

Você pode trocar um de cada vez pelo painel **Configurações** dentro do app, ou
editar `settings.json` em `%APPDATA%\Visualizador\settings.json`.

---

## 0. Qual provedor de visão escolher

| Provedor | Precisão | Latência | A imagem sai da máquina? | Custo |
| --- | --- | --- | --- | --- |
| **Simulado** | nenhuma — ignora a imagem | ~400ms | não | zero |
| **Ollama** (`qwen2.5vl:3b`) | boa para texto, fraca para reconhecer lugares | 0,6–1,5s em GPU | **não** (roda em localhost) | zero |
| **Claude** (`claude-opus-5`) | alta — reconhece monumentos, fachadas, estilo de sinalização | 1,5–4s | **sim** | por token |
| **Desligado** | — | 0 | não | zero |

A escolha real é entre **privacidade** e **conhecimento de mundo**. Um modelo
local de 3B lê texto bem, mas não sabe que aquele vão vermelho suspenso é o
MASP. Um modelo de fronteira sabe. Se o que você captura tem texto legível
(mapas, sites, Street View), o OCR já resolve e o Ollama basta; se você
analisa fotos sem texto, o Claude é a diferença entre "dados insuficientes" e
uma resposta.

> **Atalho que resolve muita coisa sem instalar nada:** ponha OCR em
> `Tesseract`, Visão em `Desligado` e Geografia em `Nominatim`. Capturas de
> tela quase sempre têm o endereço escrito em algum lugar — e o `Desligado`
> existe justamente para o simulado não injetar pistas falsas nesse arranjo.

## 1. Visão: simulado → Claude (nuvem)

O caminho mais direto para precisão de modelo de fronteira.

1. Gere uma chave em [console.anthropic.com](https://console.anthropic.com).
2. Em **Configurações → Claude**, cole a chave. Ela fica apenas neste
   computador, no `settings.json` do app.
3. Em **Configurações → Provedores → Visão**, escolha `Claude (nuvem)`.

O provedor está em
[`src/main/providers/vision/claude.ts`](../src/main/providers/vision/claude.ts)
e é deliberadamente parecido com o do Ollama:

- **O mesmo prompt e o mesmo contrato.** O modelo lista pistas observáveis e
  não decide o local. Trocar visão local por visão na nuvem melhora a
  qualidade das pistas, não afrouxa as regras de veredito.
- **Saída estruturada** por JSON Schema (`output_config.format`), o que
  elimina parsing frágil e reduz tokens gerados.
- **`effort: low`**, o principal controle de latência. A tarefa é de
  percepção, não de raciocínio longo, então esforço baixo é suficiente e
  bem mais rápido.
- **Recusas são tratadas.** Uma recusa chega como HTTP 200 com conteúdo vazio;
  ler o primeiro bloco sem checar `stop_reason` quebraria. O provedor também
  ativa a reserva automática do servidor, que refaz o pedido em outro modelo
  em vez de devolver a recusa.

**O que muda em privacidade:** neste modo a **imagem** sai da sua máquina.
Em todos os outros, só texto sai — e apenas com a rede liberada. Por isso o
Claude não é padrão, e o rodapé do app mostra o provedor ativo o tempo todo.

## 2. Visão: simulado → Ollama (local)

### Instalar

```powershell
winget install Ollama.Ollama
ollama pull qwen2.5vl:3b
```

### Escolher o modelo

O modelo é o principal determinante da latência. Todos são multimodais e rodam
local:

| Modelo | VRAM aprox. | Latência típica | Observação |
| --- | --- | --- | --- |
| `moondream` | ~2 GB | mais rápido | leitura de texto fraca; bom só para cena |
| `qwen2.5vl:3b` | ~4 GB | rápido | **padrão** — melhor equilíbrio, lê placas bem |
| `qwen2.5vl:7b` | ~8 GB | médio | leitura de texto sensivelmente melhor |
| `llama3.2-vision:11b` | ~12 GB | lento | use só com GPU sobrando |

Comece no `qwen2.5vl:3b`. Se as placas estiverem sendo lidas errado, suba para
o `7b` antes de mexer em qualquer outra coisa.

### Ligar

Em **Configurações → Provedores → Visão**, troque `Simulado` por
`Ollama (local)`. O app reaquece o provedor sozinho ao detectar a mudança.

O indicador **Visão** no rodapé fica verde quando o Ollama responde e o modelo
está instalado; passando o mouse aparece o motivo exato quando está vermelho.

### O que ajustar para ficar rápido

- **`Manter na memória` (`ollamaKeepAlive`, padrão `30m`).** É o ajuste de maior
  impacto. Sem ele o Ollama descarrega o modelo da VRAM após 5 minutos, e a
  análise seguinte paga de 2 a 8 segundos só para recarregar. O app também
  dispara um aquecimento no boot para que o **primeiro** clique já encontre o
  modelo quente.
- **`Largura para a visão` (`visionMaxWidth`, padrão `1024`).** A imagem vira
  tokens; menos pixels significa prefill menor e resposta mais rápida. Abaixo de
  768 a leitura de placas pequenas começa a sofrer.
- **GPU.** Confirme com `ollama ps` que o modelo está em `GPU` e não em `CPU`.
  Em CPU, um VLM de 3B leva dezenas de segundos.

### Como o provedor conversa com o modelo

Em [`src/main/providers/vision/ollama.ts`](../src/main/providers/vision/ollama.ts):

- A resposta é forçada por **JSON Schema** (parâmetro `format` do Ollama), o
  que elimina parsing frágil de texto livre e reduz tokens gerados.
- `temperature: 0.1` — queremos transcrição fiel, não criatividade.
- `num_predict: 500` — a saída é uma lista curta; cada token custa tempo.
- O prompt **proíbe** o modelo de adivinhar o local e manda devolver `clues`
  vazio quando não houver pista geográfica. Resposta vazia é considerada
  correta.
- Saída malformada é tratada como "nenhuma pista", nunca como licença para o
  resto do pipeline improvisar.

`country_guess` e `city_guess` são aceitos, mas entram **apenas** como viés de
busca (filtro `countrycodes` e desambiguação de nomes repetidos). Eles nunca
viram resposta sozinhos: sem uma pista dura que resolva, o veredito para em
"ambíguo" ou "insuficiente".

---

## 3. OCR: simulado → Tesseract

Em **Configurações → Provedores → OCR**, troque para `Tesseract (local)`.

Não precisa instalar nada — o `tesseract.js` já é dependência. Na primeira
execução ele baixa o `traineddata` dos idiomas configurados
(`ocrLanguages`, padrão `por+eng`) e guarda em cache.

> **Para uso totalmente offline**, baixe os arquivos `.traineddata` de
> [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast), coloque-os
> numa pasta local e aponte `langPath` na criação do worker em
> [`src/main/providers/ocr/tesseract.ts`](../src/main/providers/ocr/tesseract.ts).
> Sem isso, a primeira execução precisa de rede.

Notas de desempenho, já implementadas:

- O worker é criado **uma vez** no boot e reaproveitado. A inicialização custa
  de 1,5 a 3 segundos; pagá-la a cada análise seria inaceitável.
- O `recognize` pede apenas `text` e `blocks`. Gerar hOCR, TSV e PDF custa tempo
  de serialização em toda análise e nada disso é usado.
- Menos idiomas significa mais rápido. Se você só analisa telas em português,
  use `por` em vez de `por+eng`.

---

## 4. Geografia: simulado → Nominatim + pesquisa externa

Em **Configurações → Provedores → Geografia**, troque para
`Nominatim + busca`, e **ligue `Permitir acesso à rede`** — sem isso nenhuma
requisição sai da máquina, por desenho.

Preencha também o **e-mail de contato**: a
[Usage Policy do OpenStreetMap](https://operations.osmfoundation.org/policies/nominatim/)
exige um `User-Agent` identificável.

### O limite de 1 requisição por segundo

Esta é a restrição que mais afeta a latência, e ela é de política, não de
código: a instância pública do Nominatim aceita **no máximo 1 req/s**. Uma
análise costuma gerar de 3 a 5 consultas (uma por pista dura), e disparar tudo
em paralelo contra a instância pública é a forma mais rápida de tomar bloqueio
de IP.

O provedor detecta isso sozinho
([`nominatim.ts`](../src/main/providers/geo/nominatim.ts)):

| Endereço configurado | Comportamento |
| --- | --- |
| `nominatim.openstreetmap.org` | serializa com 1,1s entre chamadas, **máx. 2 consultas** por análise |
| qualquer outro | paralelismo liberado, **até 5 consultas** por análise |

Ou seja: **na instância pública, a geocodificação sozinha custa ~2s.** Para
descer abaixo de 1 segundo no total, hospede localmente:

```bash
# Nominatim completo (pesado, mas oferece busca por endereço completa)
docker run -it -e PBF_URL=https://download.geofabrik.de/south-america/brazil-latest.osm.pbf \
  -p 8080:8080 mediagis/nominatim:4.4

# Photon — mais leve e mais rápido para busca por nome
docker run -p 2322:2322 ghcr.io/komoot/photon
```

Depois aponte `nominatimUrl` para `http://localhost:8080` e o paralelismo é
liberado automaticamente.

Resultados são cacheados em LRU por consulta, então análises repetidas da mesma
tela não repetem chamadas.

### Pesquisa externa (opcional)

Em **Configurações → Pesquisa externa**, escolha um provedor:

| Provedor | Configuração |
| --- | --- |
| `searxng` | auto-hospedado; preencha o endereço (ex.: `http://127.0.0.1:8080`). Sem chave, sem rastreamento |
| `brave` | preencha a chave da Brave Search API |
| `tavily` | preencha a chave da Tavily |

**O uso mais valioso da busca aqui não é descobrir coordenadas** — disso o
geocodificador dá conta. É **descartar pistas inexistentes**. Se o modelo de
visão leu errado uma fachada e produziu "Restaurante Vila Nogueira", a busca não
devolve nada, a consulta é despriorizada (peso × 0,35) e aquele falso positivo
nunca vira um alfinete no mapa.

O segundo uso é desambiguar: a busca extrai um topônimo que apareça de forma
consistente em **pelo menos dois** resultados distintos e o anexa à consulta —
o que resolve casos como "Rua Augusta", que existe em Lisboa e em São Paulo. A
heurística é conservadora de propósito, e mesmo errando ela falha em silêncio:
quem decide continua sendo o geocodificador.

Custo: a etapa de validação roda todas as buscas em paralelo, com prazo próprio.
Some algo entre 200 e 600ms ao total. Se a velocidade importar mais que a
precisão, deixe em `Nenhum` — o pipeline funciona sem ela.

---

## 5. Conferindo o resultado

Depois de trocar os provedores:

1. Os três indicadores no rodapé devem estar **verdes**. Passe o mouse para ver
   o diagnóstico de cada um.
2. Clique em **Analisar tela** e observe a linha do tempo no topo: ela mostra
   quanto cada etapa custou, e é assim que você descobre o que ajustar.
3. Rode `npm run verify` a qualquer momento para confirmar que as regras de
   veredito continuam íntegras — em especial a invariante de que "dados
   insuficientes" nunca vem acompanhado de uma localização.

## Orçamento de latência esperado

Com Ollama (`qwen2.5vl:3b` em GPU), Tesseract aquecido e Nominatim local:

| Etapa | Custo típico |
| --- | --- |
| captura | 60–150ms |
| OCR ‖ visão (em paralelo) | 600–1500ms ← domina o total |
| fusão | < 5ms |
| validação por busca (opcional) | 200–600ms |
| geocodificação (local, paralela) | 50–200ms |
| **total** | **~1 a 2,5s** |

Na instância pública do Nominatim, some ~2s. Com o modelo de visão em CPU, some
de 10 a 40s — é o item que mais vale conferir primeiro (`ollama ps`).

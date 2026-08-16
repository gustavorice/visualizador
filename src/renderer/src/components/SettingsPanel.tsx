import type { Settings } from '@shared/types'

interface Props {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

/**
 * Painel de configurações.
 *
 * A troca simulado -> real acontece aqui, e é só isto: três seletores. O
 * pipeline, a fusão de pistas e as regras de confiança são exatamente os
 * mesmos nos dois modos.
 */
export function SettingsPanel({ settings, onChange }: Props): React.JSX.Element {
  return (
    <section className="panel">
      <div className="panel-head">
        <span>Configurações</span>
      </div>

      <div className="panel-body">
        <div className="section-title">Provedores</div>
        <div className="settings-grid">
          <Field label="OCR" hint="Lê o texto da tela. É o que resolve capturas de mapas e sites.">
            <select
              value={settings.ocrProvider}
              onChange={(event) =>
                onChange({ ocrProvider: event.target.value as Settings['ocrProvider'] })
              }
            >
              <option value="mock">Simulado (ignora a imagem)</option>
              <option value="tesseract">Tesseract (local)</option>
              <option value="off">Desligado</option>
            </select>
          </Field>

          <Field
            label="Visão"
            hint="Reconhece monumentos, fachadas e paisagem. O Claude é muito mais preciso; em troca, a imagem sai da máquina."
          >
            <select
              value={settings.visionProvider}
              onChange={(event) =>
                onChange({ visionProvider: event.target.value as Settings['visionProvider'] })
              }
            >
              <option value="mock">Simulado (ignora a imagem)</option>
              <option value="ollama">Ollama (local)</option>
              <option value="claude">Claude (nuvem, mais preciso)</option>
              <option value="off">Desligado</option>
            </select>
          </Field>

          <Field label="Geografia" hint="Transforma as pistas em coordenadas. Sem isto nada é localizado.">
            <select
              value={settings.geoProvider}
              onChange={(event) =>
                onChange({ geoProvider: event.target.value as Settings['geoProvider'] })
              }
            >
              <option value="mock">Simulado (gazetteer local)</option>
              <option value="nominatim">Nominatim + busca</option>
            </select>
          </Field>
        </div>

        <div className="section-title">Claude (visão na nuvem)</div>
        <div className="settings-grid">
          <Field
            label="Chave de API"
            hint="Obtida em console.anthropic.com. Fica só neste computador, no arquivo de configurações."
          >
            <input
              type="password"
              value={settings.claudeApiKey}
              placeholder="sk-ant-..."
              onChange={(event) => onChange({ claudeApiKey: event.target.value })}
            />
          </Field>
          <Field label="Modelo" hint="claude-opus-5 é o mais capaz para reconhecer lugares.">
            <input
              value={settings.claudeModel}
              onChange={(event) => onChange({ claudeModel: event.target.value })}
            />
          </Field>
        </div>

        <div className="section-title">Ollama</div>
        <div className="settings-grid">
          <Field label="Endereço">
            <input
              value={settings.ollamaUrl}
              onChange={(event) => onChange({ ollamaUrl: event.target.value })}
            />
          </Field>
          <Field label="Modelo" hint="Modelos menores respondem mais rápido.">
            <input
              value={settings.ollamaModel}
              onChange={(event) => onChange({ ollamaModel: event.target.value })}
            />
          </Field>
          <Field
            label="Manter na memória"
            hint="Evita recarregar o modelo a cada análise. Principal ganho de latência."
          >
            <input
              value={settings.ollamaKeepAlive}
              onChange={(event) => onChange({ ollamaKeepAlive: event.target.value })}
            />
          </Field>
        </div>

        <div className="section-title">Pesquisa externa</div>
        <div className="settings-grid">
          <Field label="Provedor de busca">
            <select
              value={settings.webSearchProvider}
              onChange={(event) =>
                onChange({ webSearchProvider: event.target.value as Settings['webSearchProvider'] })
              }
            >
              <option value="none">Nenhum</option>
              <option value="searxng">SearXNG (auto-hospedado)</option>
              <option value="brave">Brave Search API</option>
              <option value="tavily">Tavily</option>
            </select>
          </Field>
          <Field label="Endereço do SearXNG">
            <input
              value={settings.webSearchUrl}
              placeholder="http://127.0.0.1:8080"
              onChange={(event) => onChange({ webSearchUrl: event.target.value })}
            />
          </Field>
          <Field label="Chave de API">
            <input
              type="password"
              value={settings.webSearchApiKey}
              onChange={(event) => onChange({ webSearchApiKey: event.target.value })}
            />
          </Field>
          <Field
            label="Nominatim"
            hint="A instância pública limita a 1 requisição por segundo. Hospedar localmente libera consultas em paralelo."
          >
            <input
              value={settings.nominatimUrl}
              onChange={(event) => onChange({ nominatimUrl: event.target.value })}
            />
          </Field>
          <Field label="E-mail de contato" hint="Exigido pela política de uso do OpenStreetMap.">
            <input
              value={settings.contactEmail}
              placeholder="voce@exemplo.com"
              onChange={(event) => onChange({ contactEmail: event.target.value })}
            />
          </Field>
        </div>

        <div className="section-title">Privacidade</div>
        <div className="settings-grid">
          <Check
            label="Permitir acesso à rede"
            hint="Desligado, nada sai da máquina — nem geocodificação. O Ollama roda em localhost e não é afetado."
            checked={settings.allowNetwork}
            onChange={(allowNetwork) => onChange({ allowNetwork })}
          />
          <Check
            label="Usar o nome da janela como pista"
            hint="Desligado: o título diz o que a janela é, não o que a imagem mostra. Ligue só se quiser aceitar essa dica."
            checked={settings.useWindowTitle}
            onChange={(useWindowTitle) => onChange({ useWindowTitle })}
          />
          <Check
            label="Salvar capturas em disco"
            hint="Desligado por padrão. As imagens vivem apenas na memória durante a análise."
            checked={settings.saveCaptures}
            onChange={(saveCaptures) => onChange({ saveCaptures })}
          />
          <Check
            label="Falar o resultado"
            hint="Síntese de voz local, pelas vozes do sistema."
            checked={settings.speakResults}
            onChange={(speakResults) => onChange({ speakResults })}
          />
          <Check
            label="Lembrar a última fonte"
            hint="Permite reanalisar pelo atalho global, sem passar pelo seletor."
            checked={settings.rememberLastSource}
            onChange={(rememberLastSource) => onChange({ rememberLastSource })}
          />
        </div>

        <div className="section-title">Desempenho</div>
        <div className="settings-grid">
          <Field label="Largura da captura (px)" hint="Menor = OCR mais rápido, menos texto legível.">
            <input
              type="number"
              min={640}
              max={3840}
              value={settings.captureMaxWidth}
              onChange={(event) => onChange({ captureMaxWidth: Number(event.target.value) })}
            />
          </Field>
          <Field label="Largura para a visão (px)" hint="Menor = menos tokens de imagem, resposta mais rápida.">
            <input
              type="number"
              min={384}
              max={2048}
              value={settings.visionMaxWidth}
              onChange={(event) => onChange({ visionMaxWidth: Number(event.target.value) })}
            />
          </Field>
          <Field
            label="Prazo do modelo de visão (ms)"
            hint="Um modelo local leva de 15s a alguns minutos, sobretudo na primeira análise."
          >
            <input
              type="number"
              min={5000}
              max={600_000}
              step={5000}
              value={settings.visionTimeoutMs}
              onChange={(event) => onChange({ visionTimeoutMs: Number(event.target.value) })}
            />
          </Field>
          <Field label="Prazo por etapa (ms)" hint="Vale para OCR e geocodificação, não para a visão.">
            <input
              type="number"
              min={1000}
              max={60_000}
              step={500}
              value={settings.stageTimeoutMs}
              onChange={(event) => onChange({ stageTimeoutMs: Number(event.target.value) })}
            />
          </Field>
          <Field label="Prazo total (ms)">
            <input
              type="number"
              min={2000}
              max={120_000}
              step={1000}
              value={settings.totalTimeoutMs}
              onChange={(event) => onChange({ totalTimeoutMs: Number(event.target.value) })}
            />
          </Field>
        </div>
      </div>
    </section>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}

function Check({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <div className="field">
      <div className="field-check">
        <input
          id={`check-${label}`}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <label htmlFor={`check-${label}`}>{label}</label>
      </div>
      <span className="hint">{hint}</span>
    </div>
  )
}

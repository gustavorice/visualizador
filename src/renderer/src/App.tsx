import { useCallback, useEffect, useRef, useState } from 'react'
import type { CaptureSource, HealthReport, Settings, SourceKind } from '@shared/types'
import { useAnalysis } from './hooks/useAnalysis'
import { SourcePicker } from './components/SourcePicker'
import { PreviewPane } from './components/PreviewPane'
import { ResultPanel } from './components/ResultPanel'
import { EvidenceList } from './components/EvidenceList'
import { OcrPanel } from './components/OcrPanel'
import { QueryPanel } from './components/QueryPanel'
import { MapView } from './components/MapView'
import { StageTimeline } from './components/StageTimeline'
import { StatusBar } from './components/StatusBar'
import { SettingsPanel } from './components/SettingsPanel'
import { cancel as cancelSpeech, speak } from './lib/tts'

interface ChosenSource {
  id: string
  name: string
  kind: SourceKind
}

export function App(): React.JSX.Element {
  const { state, run, cancel, reset } = useAnalysis()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [health, setHealth] = useState<HealthReport | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [source, setSource] = useState<ChosenSource | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  // Garante que cada resultado seja falado uma única vez.
  const spokenIdRef = useRef<string | null>(null)
  // Espelha o estado para os callbacks do atalho global, que são registrados
  // uma vez e não enxergariam valores novos por closure.
  const sourceRef = useRef<ChosenSource | null>(null)
  const runningRef = useRef(false)

  sourceRef.current = source
  runningRef.current = state.status === 'running'

  const refreshHealth = useCallback(() => {
    window.visualizador
      .health()
      .then(setHealth)
      .catch(() => setHealth(null))
  }, [])

  useEffect(() => {
    window.visualizador
      .getSettings()
      .then((loaded) => {
        setSettings(loaded)
        if (loaded.rememberLastSource && loaded.lastSourceId && loaded.lastSourceKind) {
          setSource({
            id: loaded.lastSourceId,
            name: loaded.lastSourceName,
            kind: loaded.lastSourceKind
          })
        }
      })
      .catch(() => setSettings(null))

    refreshHealth()
  }, [refreshHealth])

  const startAnalysis = useCallback(
    async (target: ChosenSource) => {
      setSource(target)
      cancelSpeech()
      await run(target)
    },
    [run]
  )

  // "Analisar tela": sem fonte lembrada abre o seletor; com fonte lembrada
  // dispara direto, que é o caminho rápido.
  const onAnalyzeClick = useCallback(() => {
    if (state.status === 'running') {
      cancel()
      return
    }
    if (source) {
      void startAnalysis(source)
    } else {
      setPickerOpen(true)
    }
  }, [cancel, source, startAnalysis, state.status])

  useEffect(() => {
    const unsubscribe = window.visualizador.onShortcut(() => {
      const target = sourceRef.current
      if (target && !runningRef.current) void startAnalysis(target)
    })
    return unsubscribe
  }, [startAnalysis])

  // Depois de uma análise os provedores estão comprovadamente de pé (ou não),
  // então este é o melhor momento para reavaliar os indicadores do rodapé.
  useEffect(() => {
    if (state.result) refreshHealth()
  }, [state.result, refreshHealth])

  // Fala o resultado assim que ele chega.
  useEffect(() => {
    const result = state.result
    if (!result || !settings?.speakResults) return
    if (spokenIdRef.current === result.id) return

    spokenIdRef.current = result.id
    void speak(result.spoken, settings.speechLang, settings.speechRate)
  }, [state.result, settings])

  const onSettingsChange = useCallback((patch: Partial<Settings>) => {
    // Atualização otimista: o painel responde na hora e o processo principal
    // devolve o estado canônico logo em seguida.
    setSettings((previous) => (previous ? { ...previous, ...patch } : previous))
    window.visualizador
      .setSettings(patch)
      .then(setSettings)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!settings) return
    const timer = setTimeout(refreshHealth, 300)
    return () => clearTimeout(timer)
  }, [
    settings?.ocrProvider,
    settings?.visionProvider,
    settings?.geoProvider,
    settings?.ollamaModel,
    settings?.allowNetwork,
    settings,
    refreshHealth
  ])

  const running = state.status === 'running'

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand-dot" />
        <h1>Visualizador</h1>

        <button className="analyze-button" onClick={onAnalyzeClick}>
          {running ? 'Cancelar' : 'Analisar tela'}
        </button>

        <button onClick={() => setPickerOpen(true)} disabled={running}>
          {source ? 'Trocar fonte' : 'Escolher fonte'}
        </button>

        {state.result && (
          <button
            onClick={() => {
              cancelSpeech()
              spokenIdRef.current = null
              reset()
            }}
            disabled={running}
          >
            Limpar
          </button>
        )}

        <div className="spacer" />

        <StageTimeline stages={state.stages} totalMs={state.result?.totalMs} />

        <button onClick={() => setShowSettings((value) => !value)}>
          {showSettings ? 'Fechar configurações' : 'Configurações'}
        </button>
      </header>

      <div className="columns">
        <div className="column">
          {/* Sem este aviso, um resultado simulado é indistinguível de um erro
              de lógica: o app descreve uma cena que não tem nada a ver com a
              tela capturada, porque os provedores simulados nunca olham para
              a imagem. */}
          {health && (health.ocr.simulated || health.vision.simulated || health.geo.simulated) && (
            <div className="sim-banner">
              <strong>Modo simulado ativo.</strong> Os provedores marcados abaixo não olham
              para a sua imagem — eles devolvem um cenário de demonstração fixo, então o
              resultado não tem relação com o que está na tela.
              <div className="sim-banner-list">
                {health.ocr.simulated && <span>OCR</span>}
                {health.vision.simulated && <span>Visão</span>}
                {health.geo.simulated && <span>Geografia</span>}
              </div>
              <button
                onClick={() => setShowSettings(true)}
                style={{ marginTop: 10 }}
              >
                Configurar provedores reais
              </button>
            </div>
          )}

          <PreviewPane preview={state.preview} sourceName={source?.name ?? null} />

          {state.error && <div className="error-banner">{state.error}</div>}

          <EvidenceList evidence={state.evidence} running={running} />

          <OcrPanel ocr={state.result?.ocr} />

          <QueryPanel queries={state.result?.queries} />

          <section className="panel">
            <div className="panel-head">
              <span>Privacidade</span>
            </div>
            <div className="panel-body">
              <p className="privacy-note" style={{ margin: 0 }}>
                A captura acontece só quando você pede, uma imagem por vez. Não existe
                captura contínua nem gravação em disco por padrão.{' '}
                {settings?.visionProvider === 'claude' ? (
                  <>
                    <strong style={{ color: 'var(--warn)' }}>
                      A visão está no Claude, então a imagem sai desta máquina
                    </strong>{' '}
                    para a API. Troque para Ollama ou Desligado se quiser que ela nunca saia.
                  </>
                ) : (
                  <>
                    <strong>A imagem não sai desta máquina:</strong> o OCR roda aqui e o
                    modelo de visão, quando ligado, roda no Ollama em localhost. Para a
                    rede sai apenas <strong>texto</strong> — as pistas a serem validadas.
                  </>
                )}
              </p>
            </div>
          </section>

          {showSettings && settings && (
            <SettingsPanel settings={settings} onChange={onSettingsChange} />
          )}
        </div>

        <div className="column">
          <ResultPanel result={state.result} running={running} />

          <section className="panel">
            <div className="panel-head">
              <span>Mapa</span>
              <div className="spacer" />
              <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
                OpenStreetMap
              </span>
            </div>
            <div className="panel-body flush">
              <MapView location={state.result?.location ?? null} />
            </div>
          </section>
        </div>
      </div>

      <StatusBar health={health} settings={settings} />

      <SourcePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(picked: CaptureSource) => {
          setPickerOpen(false)
          void startAnalysis({ id: picked.id, name: picked.name, kind: picked.kind })
        }}
      />
    </div>
  )
}

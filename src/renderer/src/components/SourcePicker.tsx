import { useEffect, useState } from 'react'
import type { CaptureSource, SourceKind } from '@shared/types'

interface Props {
  open: boolean
  onPick: (source: CaptureSource) => void
  onClose: () => void
}

interface Group {
  items: CaptureSource[]
  loading: boolean
  error: string | null
}

const EMPTY: Group = { items: [], loading: true, error: null }

/**
 * Seletor de tela ou janela.
 *
 * Telas e janelas são pedidas em paralelo e renderizadas separadamente,
 * conforme chegam. Enumerar telas leva dezenas de ms; enumerar janelas exige
 * uma miniatura de cada janela aberta e pode levar segundos. Esperar as duas
 * para só então desenhar deixaria o seletor vazio justamente no caso mais
 * comum, que é escolher a tela inteira.
 *
 * As miniaturas são um retrato do momento em que o diálogo abriu — não há
 * atualização contínua nem stream de vídeo por trás.
 */
export function SourcePicker({ open, onPick, onClose }: Props): React.JSX.Element | null {
  const [screens, setScreens] = useState<Group>(EMPTY)
  const [windows, setWindows] = useState<Group>(EMPTY)

  useEffect(() => {
    if (!open) return

    let cancelled = false
    setScreens(EMPTY)
    setWindows(EMPTY)

    const load = (kind: SourceKind, apply: (group: Group) => void): void => {
      window.visualizador
        .listSources(kind)
        .then((items) => {
          if (!cancelled) apply({ items, loading: false, error: null })
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            apply({
              items: [],
              loading: false,
              error: cause instanceof Error ? cause.message : String(cause)
            })
          }
        })
    }

    load('screen', setScreens)
    load('window', setWindows)

    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const nothingAtAll =
    !screens.loading &&
    !windows.loading &&
    screens.items.length === 0 &&
    windows.items.length === 0

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Escolher fonte">
      <div className="dialog">
        <div className="dialog-head">
          <h2>Escolha a tela ou janela</h2>
        </div>

        <div className="dialog-body">
          <SourceGroup title="Telas" group={screens} onPick={onPick} />
          <SourceGroup title="Janelas" group={windows} onPick={onPick} />

          {nothingAtAll && (
            <p className="muted">Nenhuma fonte disponível para captura.</p>
          )}
        </div>

        <div className="dialog-foot">
          <span className="muted">
            Uma única imagem é capturada, apenas da fonte escolhida.
          </span>
          <div className="spacer" style={{ flex: 1 }} />
          <button onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </div>
  )
}

function SourceGroup({
  title,
  group,
  onPick
}: {
  title: string
  group: Group
  onPick: (source: CaptureSource) => void
}): React.JSX.Element | null {
  if (!group.loading && !group.error && group.items.length === 0) return null

  return (
    <>
      <div className="source-group-title">{title}</div>

      {group.error && <div className="error-banner">{group.error}</div>}

      {group.loading && group.items.length === 0 && (
        <p className="muted" style={{ margin: '0 0 8px' }}>
          Procurando…
        </p>
      )}

      {group.items.length > 0 && (
        <div className="source-grid">
          {group.items.map((source) => (
            <SourceCard key={source.id} source={source} onPick={onPick} />
          ))}
        </div>
      )}
    </>
  )
}

function SourceCard({
  source,
  onPick
}: {
  source: CaptureSource
  onPick: (source: CaptureSource) => void
}): React.JSX.Element {
  return (
    <button className="source-card" onClick={() => onPick(source)} title={source.name}>
      {source.thumbnailDataUrl ? (
        <img src={source.thumbnailDataUrl} alt="" />
      ) : (
        // Uma tela pode não fornecer miniatura e ainda assim ser capturável.
        <div className="source-card-blank">sem prévia</div>
      )}
      <span>{source.name}</span>
    </button>
  )
}

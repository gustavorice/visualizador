import type { CapturePreview } from '@shared/types'

interface Props {
  preview: CapturePreview | null
  sourceName: string | null
}

export function PreviewPane({ preview, sourceName }: Props): React.JSX.Element {
  return (
    <section className="panel">
      <div className="panel-head">
        <span>Prévia da captura</span>
        <div className="spacer" />
        {sourceName && (
          <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {sourceName}
          </span>
        )}
      </div>

      <div className="panel-body flush">
        <div className="preview">
          {preview ? (
            <>
              <img src={preview.dataUrl} alt="Prévia da tela capturada" />
              <div className="preview-badge">
                {preview.width}×{preview.height}
              </div>
            </>
          ) : (
            <div className="preview-empty">
              Nenhuma captura ainda.
              <br />
              Clique em <strong>Analisar tela</strong> para capturar uma única imagem.
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

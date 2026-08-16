import type { AnalysisResult } from '@shared/types'
import { VERDICT_LABEL, confidenceColor, formatMs, formatPlace } from '../lib/format'

interface Props {
  result: AnalysisResult | null
  running: boolean
}

export function ResultPanel({ result, running }: Props): React.JSX.Element {
  return (
    <section className="panel">
      <div className="panel-head">
        <span>Resultado</span>
        <div className="spacer" />
        {result && <span className="total-badge">{formatMs(result.totalMs)}</span>}
      </div>

      <div className="panel-body">
        {!result && (
          <p className="muted">
            {running
              ? 'Analisando a captura…'
              : 'O resultado aparece aqui depois da análise.'}
          </p>
        )}

        {result && (
          <>
            <div style={{ marginBottom: 10 }}>
              <span className={`verdict verdict-${result.verdict}`}>
                {VERDICT_LABEL[result.verdict]}
              </span>
            </div>

            {result.location ? (
              <h2 className="place">{formatPlace(result.location)}</h2>
            ) : (
              <h2 className="place-empty">Local não determinado</h2>
            )}

            <p className="summary">{result.summary}</p>

            <ConfidenceMeter
              confidence={result.confidence}
              label={result.confidenceLabel}
              /* Sem local resolvido a barra fica zerada: exibir um percentual
                 sobre "nenhum lugar" sugeriria uma certeza inexistente. */
              disabled={!result.location}
            />

            {result.location && (
              <p className="muted" style={{ marginTop: 10 }}>
                {result.location.lat.toFixed(4)}, {result.location.lon.toFixed(4)} · raio de
                incerteza ≈ {result.location.uncertaintyKm} km
              </p>
            )}

            {result.alternatives.length > 0 && (
              <>
                <div className="section-title" style={{ marginBottom: 4 }}>
                  Outros candidatos
                </div>
                <ul className="alt-list">
                  {result.alternatives.map((alternative, index) => (
                    <li key={`${alternative.displayName}-${index}`}>
                      <span>
                        {[alternative.city, alternative.region, alternative.country]
                          .filter(Boolean)
                          .join(', ') || alternative.displayName}
                      </span>
                      <span>{Math.round(alternative.score * 100)}%</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {result.vision?.sceneDescription && (
              <>
                <div className="section-title">Cena descrita</div>
                <p className="muted" style={{ margin: 0 }}>
                  {result.vision.sceneDescription}
                </p>
              </>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function ConfidenceMeter({
  confidence,
  label,
  disabled
}: {
  confidence: number
  label: string
  disabled: boolean
}): React.JSX.Element {
  const percent = disabled ? 0 : Math.round(confidence * 100)

  return (
    <div>
      <div className="meter-label">
        <span>Nível de confiança</span>
        <span className="meter-value">{disabled ? '—' : `${percent}% · ${label}`}</span>
      </div>
      <div
        className="meter"
        role="meter"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Nível de confiança"
      >
        <div
          className="meter-fill"
          style={{ width: `${percent}%`, background: confidenceColor(confidence) }}
        />
      </div>
    </div>
  )
}

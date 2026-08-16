import type { AnalysisResult } from '@shared/types'
import { VERDICT_LABEL, confidenceColor, formatMs } from '../lib/format'

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

            {/* Só país, estado e cidade. O monumento serve para ACHAR o
                lugar, não para ser a resposta — quem pergunta "onde é isto"
                quer o lugar, não a descrição do que está na foto. */}
            {result.location ? (
              <dl className="place-fields">
                <div>
                  <dt>País</dt>
                  <dd>{result.location.country ?? '—'}</dd>
                </div>
                <div>
                  <dt>Estado</dt>
                  <dd>{result.location.region ?? '—'}</dd>
                </div>
                <div>
                  <dt>Cidade</dt>
                  <dd>{result.location.city ?? '—'}</dd>
                </div>
              </dl>
            ) : (
              <h2 className="place-empty">Local não determinado</h2>
            )}

            <p className="summary">{result.summary}</p>

            {/* Uma etapa que falhou muda como ler o resultado — sobretudo a
                visão, que num app de reconhecer lugar pela foto é o produto. */}
            {result.warnings.length > 0 && (
              <div className="error-banner" style={{ marginBottom: 14 }}>
                {result.warnings.map((warning, index) => (
                  <div key={index}>{warning}</div>
                ))}
              </div>
            )}

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

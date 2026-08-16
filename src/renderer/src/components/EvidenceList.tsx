import type { Evidence } from '@shared/types'
import { EVIDENCE_LABEL } from '../lib/format'

interface Props {
  evidence: Evidence[]
  running: boolean
}

export function EvidenceList({ evidence, running }: Props): React.JSX.Element {
  const sorted = [...evidence].sort((a, b) => {
    // Pistas que sustentaram o veredito sobem para o topo.
    if (a.verified !== b.verified) return a.verified ? -1 : 1
    return b.weight - a.weight
  })

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Evidências encontradas</span>
        <div className="spacer" />
        {evidence.length > 0 && <span className="muted">{evidence.length}</span>}
      </div>

      <div className={sorted.length > 0 ? 'panel-body flush' : 'panel-body'}>
        {sorted.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {running
              ? 'Extraindo pistas da imagem…'
              : 'Nenhuma pista extraída ainda. As pistas aparecem conforme o OCR e o modelo de visão as encontram.'}
          </p>
        ) : (
          <ul className="evidence-list">
            {sorted.map((item) => (
              <li key={item.id} className="evidence-item">
                <span className="evidence-kind">{EVIDENCE_LABEL[item.kind]}</span>

                <div>
                  <div className="evidence-value">
                    {item.value}
                    {item.verified && (
                      <span className="check" title="Sustentou o resultado">
                        {' '}
                        ✓
                      </span>
                    )}
                    <span className="evidence-source">
                      {item.source === 'ocr'
                        ? 'OCR'
                        : item.source === 'title'
                          ? 'título da janela'
                          : item.source === 'vision'
                            ? 'visão'
                            : 'busca'}
                    </span>
                  </div>
                  {item.detail && <div className="evidence-detail">{item.detail}</div>}
                </div>

                <span className="evidence-weight" title="Peso desta pista">
                  {Math.round(item.weight * 100)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

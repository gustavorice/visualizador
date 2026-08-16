import { useState } from 'react'
import type { QueryOutcome } from '@shared/types'

interface Props {
  queries: QueryOutcome[] | undefined
}

/**
 * O que foi perguntado ao geocodificador e o que voltou.
 *
 * É a última etapa que era opaca. Uma consulta que falha por limite de taxa
 * e uma consulta que simplesmente não acha o lugar produzem o mesmo
 * resultado final — zero candidatos — mas exigem ações opostas do usuário.
 */
export function QueryPanel({ queries }: Props): React.JSX.Element | null {
  const [open, setOpen] = useState(false)

  if (!queries || queries.length === 0) return null

  const failed = queries.filter((query) => query.error).length

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Consultas ao mapa</span>
        <div className="spacer" />
        <span className="muted">
          {queries.length} consulta(s){failed > 0 ? ` · ${failed} com erro` : ''}
        </span>
        <button
          onClick={() => setOpen((value) => !value)}
          style={{ padding: '2px 9px', fontSize: 11, marginLeft: 8 }}
        >
          {open ? 'Ocultar' : 'Mostrar'}
        </button>
      </div>

      {open && (
        <div className="panel-body">
          <ul className="query-list">
            {queries.map((query, index) => (
              <li key={index}>
                <span className="query-text">{query.text}</span>
                <span
                  className={
                    query.error
                      ? 'query-result query-error'
                      : query.resultCount > 0
                        ? 'query-result query-hit'
                        : 'query-result'
                  }
                >
                  {query.error
                    ? `erro: ${query.error}`
                    : query.resultCount > 0
                      ? `${query.resultCount} resultado(s)`
                      : 'nenhum resultado'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

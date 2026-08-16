import type { StageEvent } from '@shared/types'
import { STAGE_LABEL, formatMs } from '../lib/format'

interface Props {
  stages: StageEvent[]
  totalMs?: number
}

/**
 * Linha do tempo das etapas com o custo de cada uma.
 *
 * Está visível de propósito: quando o objetivo é velocidade, o usuário
 * precisa conseguir ver ONDE o tempo foi gasto para saber o que ajustar
 * (trocar o modelo, hospedar o geocodificador localmente, desligar a busca).
 */
export function StageTimeline({ stages, totalMs }: Props): React.JSX.Element | null {
  if (stages.length === 0) return null

  return (
    <div className="stages">
      {stages.map((stage) => (
        <span key={stage.stage} className={`stage stage-${stage.status}`} title={stage.message}>
          <span className="stage-dot" />
          {STAGE_LABEL[stage.stage]}
          {stage.status === 'done' && stage.ms !== undefined && ` ${formatMs(stage.ms)}`}
          {stage.status === 'skipped' && ' —'}
          {stage.status === 'error' && ' falhou'}
        </span>
      ))}
      {totalMs !== undefined && <span className="total-badge">total {formatMs(totalMs)}</span>}
    </div>
  )
}

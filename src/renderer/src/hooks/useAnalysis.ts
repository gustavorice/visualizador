import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AnalysisEvent,
  AnalysisResult,
  CapturePreview,
  Evidence,
  SourceKind,
  StageEvent
} from '@shared/types'

export type AnalysisStatus = 'idle' | 'running' | 'done' | 'error'

export interface AnalysisState {
  status: AnalysisStatus
  preview: CapturePreview | null
  evidence: Evidence[]
  stages: StageEvent[]
  result: AnalysisResult | null
  error: string | null
  currentId: string | null
}

const INITIAL: AnalysisState = {
  status: 'idle',
  preview: null,
  evidence: [],
  stages: [],
  result: null,
  error: null,
  currentId: null
}

/**
 * Estado da análise, alimentado pelos eventos de progresso do processo
 * principal.
 *
 * A prévia e as pistas chegam antes do resultado final e são renderizadas
 * assim que chegam. É isso que faz o app *parecer* rápido além de ser: o
 * usuário vê a captura em ~150ms e as pistas surgindo enquanto a
 * geocodificação ainda está em curso.
 */
export function useAnalysis(): {
  state: AnalysisState
  run: (source: { id: string; name: string; kind: SourceKind }) => Promise<AnalysisResult | null>
  cancel: () => void
  reset: () => void
} {
  const [state, setState] = useState<AnalysisState>(INITIAL)
  // Espelha o id em curso para o cancelamento não depender do estado do React.
  const currentIdRef = useRef<string | null>(null)

  useEffect(() => {
    const unsubscribe = window.visualizador.onAnalysisEvent((event: AnalysisEvent) => {
      setState((previous) => reduce(previous, event))
      if (event.type === 'started') currentIdRef.current = event.id
      if (event.type === 'done' || event.type === 'error') currentIdRef.current = null
    })
    return unsubscribe
  }, [])

  const run = useCallback(
    async (source: { id: string; name: string; kind: SourceKind }) => {
      setState({ ...INITIAL, status: 'running' })
      try {
        return await window.visualizador.analyze({
          sourceId: source.id,
          sourceName: source.name,
          kind: source.kind
        })
      } catch (error) {
        // O evento 'error' já preencheu a mensagem na maioria dos casos;
        // isto cobre falhas antes do pipeline começar.
        setState((previous) =>
          previous.status === 'error'
            ? previous
            : { ...previous, status: 'error', error: describe(error) }
        )
        return null
      }
    },
    []
  )

  const cancel = useCallback(() => {
    const id = currentIdRef.current
    if (id) void window.visualizador.cancel(id)
  }, [])

  const reset = useCallback(() => setState(INITIAL), [])

  return { state, run, cancel, reset }
}

function reduce(state: AnalysisState, event: AnalysisEvent): AnalysisState {
  switch (event.type) {
    case 'started':
      return { ...INITIAL, status: 'running', currentId: event.id }

    case 'preview':
      return { ...state, preview: event.preview }

    case 'evidence':
      return { ...state, evidence: event.evidence }

    case 'stage': {
      const stages = [...state.stages]
      const index = stages.findIndex((stage) => stage.stage === event.stage)
      const next: StageEvent = {
        stage: event.stage,
        status: event.status,
        ms: event.ms,
        message: event.message
      }
      if (index === -1) stages.push(next)
      else stages[index] = next
      return { ...state, stages }
    }

    case 'done':
      return {
        ...state,
        status: 'done',
        result: event.result,
        // O resultado final traz as pistas anotadas com `verified`.
        evidence: event.result.evidence,
        currentId: null
      }

    case 'error':
      return { ...state, status: 'error', error: event.message, currentId: null }

    default:
      return state
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

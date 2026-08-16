/**
 * Log de console apenas. Por decisão de privacidade não gravamos log em disco
 * e nunca registramos conteúdo de imagem ou texto extraído da tela do usuário
 * — só nomes de etapa e durações.
 */
const prefix = '[visualizador]'

export const log = {
  info(message: string, meta?: Record<string, unknown>): void {
    console.log(prefix, message, meta ? JSON.stringify(meta) : '')
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(prefix, message, meta ? JSON.stringify(meta) : '')
  },
  error(message: string, error?: unknown): void {
    console.error(prefix, message, error instanceof Error ? error.message : (error ?? ''))
  }
}

/** Cronômetro de etapa. */
export function stopwatch(): () => number {
  const start = performance.now()
  return () => Math.round(performance.now() - start)
}

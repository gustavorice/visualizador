/**
 * Serializador com intervalo mínimo entre chamadas.
 *
 * A instância pública do Nominatim permite no máximo 1 requisição por segundo
 * (Usage Policy do OSM). Disparar 5 consultas em paralelo contra ela é a
 * forma mais rápida de tomar bloqueio de IP — então, quando o endereço
 * configurado é o público, as consultas passam por aqui.
 */
export class RateLimiter {
  private chain: Promise<unknown> = Promise.resolve()
  private lastRun = 0

  constructor(private readonly minIntervalMs: number) {}

  schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      if (this.minIntervalMs > 0) {
        const wait = this.lastRun + this.minIntervalMs - Date.now()
        if (wait > 0) await sleep(wait)
      }
      this.lastRun = Date.now()
      return task()
    })
    // A cadeia não pode quebrar quando uma tarefa rejeita.
    this.chain = run.catch(() => undefined)
    return run
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

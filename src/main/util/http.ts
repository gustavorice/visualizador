/**
 * Cliente HTTP com deadline obrigatório.
 *
 * Latência é requisito de produto aqui, então nenhuma chamada de rede pode
 * ficar pendurada: toda requisição carrega um AbortController próprio e um
 * timer, e ambos são compostos com o sinal do pipeline (cancelamento pelo
 * usuário) via `AbortSignal.any`.
 */

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`Tempo esgotado após ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs: number
  signal?: AbortSignal
}

export async function request(url: string, options: RequestOptions): Promise<Response> {
  const { timeoutMs, signal, ...rest } = options
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs)

  const composed = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal

  try {
    const response = await fetch(url, { ...rest, signal: composed })
    if (!response.ok) {
      throw new HttpError(`${response.status} ${response.statusText} em ${url}`, response.status)
    }
    return response
  } catch (error) {
    // O usuário cancelou: propaga como abort para o pipeline distinguir.
    if (signal?.aborted) throw error
    if (timeoutController.signal.aborted) throw new TimeoutError(timeoutMs)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function getJson<T>(url: string, options: RequestOptions): Promise<T> {
  const response = await request(url, options)
  return (await response.json()) as T
}

export async function postJson<T>(
  url: string,
  payload: unknown,
  options: RequestOptions
): Promise<T> {
  const response = await request(url, {
    ...options,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(payload)
  })
  return (await response.json()) as T
}

/**
 * Resolve a promessa, ou devolve `fallback` se estourar o prazo.
 * Usado para degradar etapas opcionais em vez de derrubar a análise inteira.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

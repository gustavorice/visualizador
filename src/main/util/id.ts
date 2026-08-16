import { randomUUID, createHash } from 'node:crypto'

export function newId(): string {
  return randomUUID()
}

/** Hash estável de um buffer — usado pelos provedores simulados para que a
 *  mesma tela produza sempre o mesmo cenário. */
export function hashBuffer(buffer: Buffer): string {
  return createHash('sha1').update(buffer).digest('hex')
}

let counter = 0
export function evidenceId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
}

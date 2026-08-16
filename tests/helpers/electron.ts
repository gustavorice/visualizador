/**
 * Substituto do módulo `electron` para os testes.
 *
 * O código do processo principal usa `app.getPath`, e só isso. Um substituto
 * de poucas linhas evita ter que subir um Electron inteiro para testar lógica
 * que não tem nada de gráfico.
 *
 * O diretório é ESTÁVEL entre execuções, não um `mkdtemp`: é para lá que o
 * Tesseract baixa os ~7 MB de dados de idioma, e um diretório novo a cada
 * execução transformaria `npm test` numa tarefa que depende da rede toda vez.
 * Os testes que precisam de estado limpo apagam os próprios arquivos.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const base = join(process.cwd(), '.cache', 'electron')
mkdirSync(base, { recursive: true })

export const app = {
  getPath: (name: string): string => {
    const path = join(base, name)
    mkdirSync(path, { recursive: true })
    return path
  }
}

export const desktopCapturer = {
  getSources: async (): Promise<never[]> => []
}

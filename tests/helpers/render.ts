/**
 * Gera IMAGENS DE VERDADE para os testes.
 *
 * A suíte de extração trabalha com linhas de texto já prontas, o que testa a
 * lógica mas não o caminho inteiro: entre a tela e a lógica existe um OCR que
 * lê pixels e erra. Renderizar as telas num navegador de verdade e passá-las
 * pelo Tesseract é o que fecha esse vão — é a diferença entre "a regex casa
 * com esta string" e "o app lê este endereço nesta tela".
 *
 * O navegador é o Chromium que já vem instalado no ambiente; nada é baixado.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CANDIDATES = [
  process.env.VISUALIZADOR_CHROMIUM,
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter((path): path is string => Boolean(path))

export function findBrowser(): string | null {
  return CANDIDATES.find((path) => existsSync(path)) ?? null
}

export interface Scene {
  /** Identificador usado no nome do arquivo e nas mensagens de erro. */
  key: string
  /** Corpo da página. Estilo embutido: nada é buscado na rede. */
  html: string
  width?: number
  height?: number
}

/**
 * Renderiza uma cena e devolve o caminho do PNG.
 *
 * A largura padrão é 1600px porque é aí que o Tesseract começa a ler texto de
 * interface de forma confiável — abaixo disso ele devolve linhas vazias, que
 * é justamente o que o padrão `captureMaxWidth` do app existe para evitar.
 */
export function render(scene: Scene, outDir: string): string {
  const browser = findBrowser()
  if (!browser) throw new Error('nenhum Chromium encontrado')

  mkdirSync(outDir, { recursive: true })
  const htmlPath = join(outDir, `${scene.key}.html`)
  const pngPath = join(outDir, `${scene.key}.png`)

  writeFileSync(
    htmlPath,
    `<!doctype html><meta charset="utf-8">
     <body style="margin:0;background:#fff;color:#111;font-family:Arial,Helvetica,sans-serif">
     ${scene.html}
     </body>`,
    'utf8'
  )

  execFileSync(
    browser,
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--screenshot=${pngPath}`,
      `--window-size=${scene.width ?? 1600},${scene.height ?? 900}`,
      `file://${htmlPath}`
    ],
    { stdio: 'ignore', timeout: 60_000 }
  )

  if (!existsSync(pngPath)) throw new Error(`a cena "${scene.key}" não gerou imagem`)
  return pngPath
}

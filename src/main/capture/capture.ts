import { desktopCapturer, type DesktopCapturerSource, type NativeImage } from 'electron'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { CaptureSource, CapturePreview, SourceKind } from '@shared/types'
import { getSettings, defaultCaptureDir } from '../settings'
import { log, stopwatch } from '../util/logger'

/**
 * Captura via `desktopCapturer.getSources` com `thumbnailSize` grande.
 *
 * Por que não `getDisplayMedia` + <video> + canvas: aquele caminho precisa
 * negociar uma stream e esperar o primeiro frame (300–600ms típicos) para
 * depois jogar fora a stream. Como queremos exatamente UM quadro, pedir a
 * miniatura já no tamanho de análise resolve em uma chamada nativa, sem
 * stream nenhuma — mais rápido e, do ponto de vista de privacidade, mais
 * honesto: não existe caminho de código que capture continuamente.
 */

export interface CapturedImage {
  /** PNG em tamanho de análise — entrada do OCR (bordas de texto nítidas). */
  ocrBuffer: Buffer
  /** JPEG reduzido — entrada do VLM (payload base64 menor = prefill menor). */
  visionBase64: string
  preview: CapturePreview
  width: number
  height: number
}

const THUMB_PICKER = { width: 320, height: 180 }

/**
 * Lista as fontes de UM tipo por vez.
 *
 * A separação por tipo é medida, não estética: enumerar telas custa ~20ms,
 * enquanto enumerar janelas exige renderizar uma miniatura de cada janela
 * aberta e pode levar segundos. Numa chamada única com
 * `types: ['screen', 'window']`, a parte lenta atrasa a rápida e o seletor
 * fica vazio esperando. Com a consulta separada, o renderer pede as duas em
 * paralelo e mostra as telas assim que chegam, sem esperar as janelas.
 */
export async function listSources(kind: SourceKind): Promise<CaptureSource[]> {
  let sources: DesktopCapturerSource[]
  try {
    sources = await desktopCapturer.getSources({
      types: [kind],
      thumbnailSize: THUMB_PICKER,
      fetchWindowIcons: false
    })
  } catch (error) {
    log.error(`falha ao listar fontes do tipo ${kind}`, error)
    return []
  }

  // Telas entram sempre: seguem capturáveis mesmo sem miniatura. Já uma
  // janela sem miniatura costuma estar minimizada, e capturá-la devolveria
  // uma imagem vazia — melhor não oferecer.
  const usable =
    kind === 'screen' ? sources : sources.filter((source) => !source.thumbnail.isEmpty())

  return usable.map(toCaptureSource)
}

function toCaptureSource(source: DesktopCapturerSource): CaptureSource {
  return {
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnailDataUrl: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
    displayId: source.display_id || undefined
  }
}

/**
 * Captura um único quadro da fonte escolhida.
 *
 * `getSources` não aceita filtro por id, então pedimos só o tipo relevante
 * (`screen` OU `window`) para não pagar a renderização em alta resolução de
 * todas as janelas abertas.
 */
export async function captureSource(
  sourceId: string,
  kind: SourceKind
): Promise<CapturedImage> {
  const settings = getSettings()
  const elapsed = stopwatch()

  // Só o tipo relevante: pedir 'screen' e 'window' juntos custaria a
  // renderização em alta resolução de tudo que estiver aberto.
  const options: Electron.SourcesOptions = {
    types: [kind],
    thumbnailSize: { width: settings.captureMaxWidth, height: settings.captureMaxWidth },
    fetchWindowIcons: false
  }

  let sources = await desktopCapturer.getSources(options)
  let match = sources.find((source) => source.id === sourceId)

  if (!match) {
    // `getSources` ocasionalmente devolve lista vazia mesmo com a fonte
    // presente. Uma segunda tentativa custa ~20ms e evita mandar o usuário
    // reabrir o seletor à toa.
    await new Promise((resolve) => setTimeout(resolve, 120))
    sources = await desktopCapturer.getSources(options)
    match = sources.find((source) => source.id === sourceId)
  }

  if (!match) {
    throw new Error(
      'A tela ou janela escolhida não está mais disponível. Selecione a fonte novamente.'
    )
  }

  const image = match.thumbnail
  if (image.isEmpty()) {
    throw new Error('A captura veio vazia. A janela pode estar minimizada.')
  }

  const size = image.getSize()
  const ocrBuffer = image.toPNG()
  const visionImage = downscale(image, settings.visionMaxWidth)
  const visionBase64 = visionImage.toJPEG(settings.jpegQuality).toString('base64')
  const previewImage = downscale(image, 640)

  log.info('captura concluída', { ms: elapsed(), width: size.width, height: size.height })

  const captured: CapturedImage = {
    ocrBuffer,
    visionBase64,
    width: size.width,
    height: size.height,
    preview: {
      dataUrl: `data:image/jpeg;base64,${previewImage.toJPEG(60).toString('base64')}`,
      width: size.width,
      height: size.height,
      capturedAt: Date.now()
    }
  }

  if (settings.saveCaptures) {
    await persist(ocrBuffer)
  }

  return captured
}

function downscale(image: NativeImage, maxWidth: number): NativeImage {
  const { width } = image.getSize()
  if (width <= maxWidth) return image
  return image.resize({ width: maxWidth, quality: 'good' })
}

/** Só roda quando o usuário liga `saveCaptures` — desligado por padrão. */
async function persist(buffer: Buffer): Promise<void> {
  const settings = getSettings()
  const dir = settings.captureDir || defaultCaptureDir()
  try {
    await mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await writeFile(join(dir, `captura-${stamp}.png`), buffer)
  } catch (error) {
    log.error('falha ao salvar captura', error)
  }
}

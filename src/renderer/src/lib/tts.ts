/**
 * Síntese de voz local.
 *
 * Caminho principal: Web Speech API. No Windows o Chromium do Electron fala
 * pelas vozes SAPI já instaladas — é local, não faz nenhuma requisição de
 * rede e não exige processo externo.
 *
 * Reserva: se não houver nenhuma voz utilizável (acontece em instalações sem
 * voz em português, e em Linux sem speech-dispatcher), delega ao processo
 * principal, que fala pelo sintetizador do sistema operacional.
 */

let voicesReady: Promise<SpeechSynthesisVoice[]> | null = null

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (voicesReady) return voicesReady

  voicesReady = new Promise((resolve) => {
    const immediate = window.speechSynthesis?.getVoices() ?? []
    if (immediate.length > 0) {
      resolve(immediate)
      return
    }

    // A lista costuma chegar vazia na primeira chamada e ser preenchida
    // depois, de forma assíncrona.
    const timer = setTimeout(() => resolve(window.speechSynthesis?.getVoices() ?? []), 1200)
    window.speechSynthesis?.addEventListener(
      'voiceschanged',
      () => {
        clearTimeout(timer)
        resolve(window.speechSynthesis.getVoices())
      },
      { once: true }
    )
  })

  return voicesReady
}

function pickVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  const target = lang.toLowerCase()
  const prefix = target.split('-')[0] ?? 'pt'

  return (
    voices.find((voice) => voice.lang.toLowerCase() === target) ??
    voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix)) ??
    null
  )
}

export async function speak(text: string, lang: string, rate: number): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return

  cancel()

  if (typeof window.speechSynthesis !== 'undefined') {
    const voices = await loadVoices()
    const voice = pickVoice(voices, lang)

    if (voice) {
      const utterance = new SpeechSynthesisUtterance(trimmed)
      utterance.voice = voice
      utterance.lang = voice.lang
      utterance.rate = rate
      window.speechSynthesis.speak(utterance)
      return
    }
  }

  await window.visualizador.speak(trimmed)
}

export function cancel(): void {
  try {
    window.speechSynthesis?.cancel()
  } catch {
    // Alguns ambientes não expõem speechSynthesis; o cancelamento do
    // processo principal cobre esse caso.
  }
  void window.visualizador.stopSpeaking()
}

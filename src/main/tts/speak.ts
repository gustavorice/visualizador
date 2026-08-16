import { spawn, type ChildProcess } from 'node:child_process'
import { getSettings } from '../settings'
import { log } from '../util/logger'

/**
 * Síntese de voz local, usada como reserva.
 *
 * O caminho principal é a Web Speech API no renderer, que no Windows já fala
 * pelas vozes SAPI instaladas — local, sem rede, e sem processo extra. Este
 * módulo existe para quando o renderer não tem voz disponível (acontece em
 * instalações sem voz pt-BR e em Linux sem speech-dispatcher).
 *
 * O texto vai para o PowerShell via `-EncodedCommand` (UTF-16LE em base64)
 * em vez de interpolado na linha de comando: assim uma aspas ou um `;` no
 * resultado não podem virar comando.
 */

let current: ChildProcess | null = null

export function speak(text: string): void {
  const settings = getSettings()
  if (!settings.speakResults) return
  const trimmed = text.trim()
  if (!trimmed) return

  stop()

  if (process.platform === 'win32') {
    speakWindows(trimmed, settings.speechRate)
  } else if (process.platform === 'darwin') {
    current = spawn('say', [trimmed], { stdio: 'ignore' })
  } else {
    // Linux: spd-say faz parte do speech-dispatcher.
    current = spawn('spd-say', ['--wait', trimmed], { stdio: 'ignore' })
  }

  current?.on('error', (error) => {
    log.warn('síntese de voz do sistema indisponível')
    log.error('detalhe da síntese', error)
  })
}

function speakWindows(text: string, rate: number): void {
  // Rate do SAPI vai de -10 a 10; nossa escala de usuário vai de 0,5 a 2,0.
  const sapiRate = Math.round(Math.min(10, Math.max(-10, (rate - 1) * 5)))

  const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = ${sapiRate}
$voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'pt*' } | Select-Object -First 1
if ($voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }
$synth.Speak([Console]::In.ReadToEnd())
`.trim()

  const encoded = Buffer.from(script, 'utf16le').toString('base64')

  current = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { stdio: ['pipe', 'ignore', 'ignore'] }
  )

  // O texto entra por stdin, nunca pela linha de comando.
  current.stdin?.end(text, 'utf8')
}

export function stop(): void {
  if (!current) return
  try {
    current.kill()
  } catch {
    // Processo já encerrado.
  }
  current = null
}

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from './helpers/electron'
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  getSettings,
  updateSettings,
  __resetSettingsCacheForTests
} from '../src/main/settings'

const PATH = join(app.getPath('userData'), 'settings.json')

/** Grava um settings.json e força a releitura. */
function given(stored: Record<string, unknown> | null): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  if (stored === null) rmSync(PATH, { force: true })
  else writeFileSync(PATH, JSON.stringify(stored), 'utf8')
  __resetSettingsCacheForTests()
}

beforeEach(() => given(null))

describe('padrões de fábrica', () => {
  it('abre funcionando, sem chave de API nenhuma', () => {
    const settings = getSettings()
    assert.equal(settings.ocrProvider, 'tesseract')
    assert.equal(settings.geoProvider, 'nominatim')
    assert.equal(settings.claudeApiKey, '')
  })

  it('não usa provedor simulado por padrão', () => {
    // Modo simulado é indistinguível de falha de lógica para quem usa o app:
    // ele responde com confiança sobre uma imagem que nunca olhou.
    const settings = getSettings()
    assert.notEqual(settings.ocrProvider, 'mock')
    assert.notEqual(settings.visionProvider, 'mock')
    assert.notEqual(settings.geoProvider, 'mock')
  })

  it('mantém a postura de privacidade', () => {
    const settings = getSettings()
    assert.equal(settings.saveCaptures, false, 'nenhuma imagem toca o disco por padrão')
    assert.equal(settings.visionProvider, 'off', 'nenhum provedor manda a imagem para fora')
    assert.equal(settings.useWindowTitle, false, 'o nome da janela não é lido sem pedir')
  })

  it('dá ao modelo de visão um prazo próprio, muito maior que o das outras etapas', () => {
    // Regressão: o prazo único de 6s matava qualquer modelo local antes de ele
    // terminar, e o usuário via só "visão falhou: tempo esgotado".
    const settings = getSettings()
    assert.ok(settings.visionTimeoutMs > settings.stageTimeoutMs * 10)
    assert.ok(settings.totalTimeoutMs > settings.visionTimeoutMs)
  })

  it('captura larga o bastante para o OCR enxergar texto de interface', () => {
    // Medido: abaixo de ~1600px o Tesseract deixa de ler texto de interface.
    assert.ok(DEFAULT_SETTINGS.captureMaxWidth >= 1600)
  })

  it('manda ao modelo de visão uma imagem bem menor que a do OCR', () => {
    // As duas etapas querem coisas diferentes: o OCR precisa de resolução para
    // ler letra miúda, o modelo de visão reconhece cena e paga pela ÁREA.
    assert.ok(DEFAULT_SETTINGS.visionMaxWidth < DEFAULT_SETTINGS.captureMaxWidth / 2)
  })
})

describe('migração de configurações salvas', () => {
  it('tira quem estava na v1 dos provedores simulados', () => {
    given({ version: 1, ocrProvider: 'mock', visionProvider: 'mock', geoProvider: 'mock' })
    const settings = getSettings()
    assert.equal(settings.ocrProvider, 'tesseract')
    assert.equal(settings.geoProvider, 'nominatim')
    assert.equal(settings.visionProvider, 'off')
    assert.equal(settings.version, SETTINGS_VERSION)
  })

  it('preserva o "real" da v1, que era escolha deliberada', () => {
    given({ version: 1, visionProvider: 'real' })
    assert.equal(getSettings().visionProvider, 'ollama')
  })

  it('trata arquivo sem versão como v1', () => {
    given({ ocrProvider: 'mock' })
    assert.equal(getSettings().ocrProvider, 'tesseract')
    assert.equal(getSettings().version, SETTINGS_VERSION)
  })

  it('reescreve na v2 o prazo que matava o modelo de visão', () => {
    given({ version: 2, visionTimeoutMs: 6000, totalTimeoutMs: 15000 })
    const settings = getSettings()
    assert.equal(settings.visionTimeoutMs, DEFAULT_SETTINGS.visionTimeoutMs)
    assert.equal(settings.totalTimeoutMs, DEFAULT_SETTINGS.totalTimeoutMs)
  })

  it('reescreve na v3 a largura que fazia a visão demorar', () => {
    given({ version: 3, visionMaxWidth: 1024 })
    assert.equal(getSettings().visionMaxWidth, DEFAULT_SETTINGS.visionMaxWidth)
    assert.ok(DEFAULT_SETTINGS.visionMaxWidth < 1024)
  })

  it('aplica as duas migrações quando o arquivo é bem antigo', () => {
    given({ version: 1, ocrProvider: 'mock', visionTimeoutMs: 6000, visionMaxWidth: 1024 })
    const settings = getSettings()
    assert.equal(settings.ocrProvider, 'tesseract')
    assert.equal(settings.visionTimeoutMs, DEFAULT_SETTINGS.visionTimeoutMs)
    assert.equal(settings.visionMaxWidth, DEFAULT_SETTINGS.visionMaxWidth)
  })

  it('não mexe em quem já está na versão corrente', () => {
    given({ version: SETTINGS_VERSION, visionTimeoutMs: 42, ocrProvider: 'off' })
    const settings = getSettings()
    assert.equal(settings.visionTimeoutMs, 42, 'escolha do usuário é preservada')
    assert.equal(settings.ocrProvider, 'off')
  })

  it('preenche chaves novas sem quebrar arquivo antigo', () => {
    given({ version: SETTINGS_VERSION, ocrProvider: 'off' })
    const settings = getSettings()
    assert.equal(settings.speechLang, DEFAULT_SETTINGS.speechLang)
    assert.equal(settings.nominatimUrl, DEFAULT_SETTINGS.nominatimUrl)
  })

  it('cai nos padrões diante de arquivo corrompido, em vez de derrubar o app', () => {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(PATH, '{ isto não é json', 'utf8')
    __resetSettingsCacheForTests()
    assert.deepEqual(getSettings(), DEFAULT_SETTINGS)
  })

  it('grava a migração em disco, para não repeti-la a cada abertura', () => {
    given({ version: 1, ocrProvider: 'mock' })
    getSettings()
    assert.ok(existsSync(PATH))
    const gravado = JSON.parse(readFileSync(PATH, 'utf8')) as Record<string, unknown>
    assert.equal(gravado.version, SETTINGS_VERSION)
    assert.equal(gravado.ocrProvider, 'tesseract')
  })
})

describe('atualização de configurações', () => {
  it('aplica o remendo e persiste', () => {
    given({ version: SETTINGS_VERSION })
    updateSettings({ ocrLanguages: 'eng', speakResults: false })
    __resetSettingsCacheForTests()
    const settings = getSettings()
    assert.equal(settings.ocrLanguages, 'eng')
    assert.equal(settings.speakResults, false)
  })

  it('nunca deixa a versão regredir', () => {
    given({ version: SETTINGS_VERSION })
    const settings = updateSettings({ version: 1 } as never)
    assert.equal(settings.version, SETTINGS_VERSION)
  })
})

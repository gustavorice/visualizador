import type { HealthReport, Settings } from '@shared/types'

interface Props {
  health: HealthReport | null
  settings: Settings | null
}

export function StatusBar({ health, settings }: Props): React.JSX.Element {
  return (
    <footer className="statusbar">
      {health && (
        <>
          <HealthPill label="OCR" name={health.ocr.name} ready={health.ocr.ready} detail={health.ocr.detail} />
          <HealthPill
            label="Visão"
            name={health.vision.name}
            ready={health.vision.ready}
            detail={health.vision.detail}
          />
          <HealthPill label="Geo" name={health.geo.name} ready={health.geo.ready} detail={health.geo.detail} />
        </>
      )}

      <div className="spacer" />

      <span title="Nenhuma imagem é gravada em disco enquanto esta opção estiver desligada.">
        {settings?.saveCaptures ? '⚠ salvando capturas' : '✓ nenhuma imagem salva'}
      </span>
      <span title="Quando desligado, nenhuma requisição sai da máquina.">
        {settings?.allowNetwork ? 'rede permitida' : '✓ rede desligada'}
      </span>
      {settings?.rememberLastSource && settings.globalShortcut && (
        <span title="Reanalisa a última fonte sem abrir o seletor.">{settings.globalShortcut}</span>
      )}
    </footer>
  )
}

function HealthPill({
  label,
  name,
  ready,
  detail
}: {
  label: string
  name: string
  ready: boolean
  detail: string
}): React.JSX.Element {
  return (
    <span className="health" title={detail}>
      <span className={`health-dot ${ready ? 'health-ok' : 'health-bad'}`} />
      {label}: {name}
    </span>
  )
}

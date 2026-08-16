import { useState } from 'react'
import type { OcrResult } from '@shared/types'

interface Props {
  ocr: OcrResult | undefined
}

/**
 * Texto bruto lido pelo OCR.
 *
 * Existe para tornar a falha diagnosticável. Sem isto, "não encontrei nada"
 * é indistinguível de três causas muito diferentes: o OCR não leu a tela, leu
 * mas o texto não tem nada geográfico, ou leu errado. Cada uma pede uma ação
 * diferente do usuário, e só o texto cru revela qual é.
 */
export function OcrPanel({ ocr }: Props): React.JSX.Element | null {
  const [open, setOpen] = useState(false)

  if (!ocr || ocr.engine === 'desligado') return null

  const lines = ocr.lines.filter((line) => line.text.trim().length > 0)

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Texto lido na tela</span>
        <div className="spacer" />
        <span className="muted">{lines.length} linha(s)</span>
        <button
          onClick={() => setOpen((value) => !value)}
          style={{ padding: '2px 9px', fontSize: 11, marginLeft: 8 }}
        >
          {open ? 'Ocultar' : 'Mostrar'}
        </button>
      </div>

      {open && (
        <div className="panel-body">
          {lines.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              O OCR não leu nenhum texto nesta imagem. Se a tela tem texto pequeno,
              aumente <strong>Largura da captura</strong> em Configurações.
            </p>
          ) : (
            <ul className="ocr-lines">
              {lines.map((line, index) => (
                <li key={index}>
                  <span className="ocr-text">{line.text}</span>
                  <span className="ocr-conf">{Math.round(line.confidence * 100)}%</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

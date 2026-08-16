import type { VisualizadorApi } from './index'

declare global {
  interface Window {
    visualizador: VisualizadorApi
  }
}

export {}

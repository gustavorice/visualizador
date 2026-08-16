import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/global.css'
import 'maplibre-gl/dist/maplibre-gl.css'

const container = document.getElementById('root')
if (!container) throw new Error('Elemento #root não encontrado.')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)

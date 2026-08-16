import { useEffect, useRef, useState } from 'react'
import {
  type GeoJSONSource,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  prewarm,
  type StyleSpecification
} from 'maplibre-gl'
import type { ResolvedLocation } from '@shared/types'
import { formatPlace } from '../lib/format'

/**
 * Mapa MapLibre com tiles raster do OpenStreetMap.
 *
 * Além do alfinete, desenhamos um círculo de incerteza proporcional à
 * confiança e à granularidade. Isso é honestidade visual: um resultado a
 * nível de país não pode aparecer como um ponto preciso no mapa, porque um
 * alfinete sozinho comunica uma precisão que o dado não tem.
 */

const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© colaboradores do <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
}

const UNCERTAINTY_SOURCE = 'incerteza'

interface Props {
  location: ResolvedLocation | null
}

// Os workers do MapLibre levam algumas centenas de ms para subir. Iniciar
// isso no carregamento do módulo tira esse custo do caminho do resultado.
prewarm()

export function MapView({ location }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const [ready, setReady] = useState(false)
  const [tilesFailed, setTilesFailed] = useState(false)
  const [glFailed, setGlFailed] = useState(false)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    // O MapLibre exige WebGL2, que falta em máquinas virtuais, sessões de
    // área de trabalho remota e drivers na lista de bloqueio. Ele não lança
    // nesse caso: constrói o mapa, engole o erro internamente e deixa um
    // canvas que nunca desenha nada — um retângulo vazio sem explicação.
    // Por isso a checagem vem ANTES, e o evento 'error' abaixo cobre as
    // falhas de GPU que só aparecem depois da construção.
    if (!supportsWebGl2()) {
      setGlFailed(true)
      return
    }

    let map: MapLibreMap
    try {
      map = new MapLibreMap({
        container: containerRef.current,
        style: OSM_STYLE,
        center: [0, 20],
        zoom: 1.2,
        attributionControl: { compact: true }
      })
    } catch (error) {
      console.warn('MapLibre indisponível; exibindo apenas as coordenadas.', error)
      setGlFailed(true)
      return
    }

    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')

    map.on('load', () => {
      map.addSource(UNCERTAINTY_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      })
      map.addLayer({
        id: 'incerteza-preenchimento',
        type: 'fill',
        source: UNCERTAINTY_SOURCE,
        paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.12 }
      })
      map.addLayer({
        id: 'incerteza-borda',
        type: 'line',
        source: UNCERTAINTY_SOURCE,
        paint: { 'line-color': '#38bdf8', 'line-opacity': 0.5, 'line-width': 1.5 }
      })
      setReady(true)
    })

    map.on('error', (event) => {
      const message = String(event?.error?.message ?? '')
      const lower = message.toLowerCase()

      if (lower.includes('webgl') || lower.includes('gpuinitialization')) {
        setGlFailed(true)
        return
      }

      // Sem rede os tiles falham, mas o mapa em si continua de pé; avisamos
      // em vez de deixar um retângulo cinza sem explicação.
      if (lower.includes('tile') || lower.includes('fetch')) {
        setTilesFailed(true)
      }
    })

    mapRef.current = map

    return () => {
      markerRef.current?.remove()
      markerRef.current = null
      map.remove()
      mapRef.current = null
      setReady(false)
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || glFailed) return

    markerRef.current?.remove()
    markerRef.current = null

    const source = map.getSource<GeoJSONSource>(UNCERTAINTY_SOURCE)

    if (!location) {
      source?.setData({ type: 'FeatureCollection', features: [] })
      void map.flyTo({ center: [0, 20], zoom: 1.2, duration: 600 })
      return
    }

    const marker = new Marker({ color: '#38bdf8' })
      .setLngLat([location.lon, location.lat])
      .setPopup(new Popup({ offset: 26, closeButton: false }).setText(formatPlace(location)))
      .addTo(map)
    markerRef.current = marker

    source?.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [circle(location.lon, location.lat, location.uncertaintyKm)]
          }
        }
      ]
    })

    void map.flyTo({
      center: [location.lon, location.lat],
      zoom: zoomFor(location.uncertaintyKm),
      duration: 900
    })
  }, [location, ready, glFailed])

  // Sem WebGL2 não há mapa, mas a coordenada continua sendo informação útil.
  if (glFailed) {
    return (
      <div className="map-wrap">
        <div className="map-placeholder">
          {location ? (
            <>
              Este computador não tem WebGL2, então o mapa não pode ser desenhado.
              <br />
              <br />
              Local encontrado: <strong>{formatPlace(location)}</strong>
              <br />
              {location.lat.toFixed(4)}, {location.lon.toFixed(4)}
            </>
          ) : (
            <>Este computador não tem WebGL2, então o mapa não pode ser desenhado.</>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-canvas" />
      {!location && (
        <div className="map-placeholder">
          O mapa mostra o local assim que uma análise resolver
          <br />
          uma posição com confiança suficiente.
        </div>
      )}
      {location && tilesFailed && (
        <div className="map-placeholder" style={{ background: 'rgba(7, 11, 16, 0.9)' }}>
          Não foi possível carregar os tiles do OpenStreetMap.
          <br />O local encontrado foi <strong>{formatPlace(location)}</strong>
          <br />
          ({location.lat.toFixed(4)}, {location.lon.toFixed(4)}).
        </div>
      )}
    </div>
  )
}

function supportsWebGl2(): boolean {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'))
  } catch {
    return false
  }
}

/** Polígono aproximando um círculo de raio em km ao redor de um ponto. */
function circle(lon: number, lat: number, radiusKm: number, points = 64): [number, number][] {
  const coordinates: [number, number][] = []
  const latRadius = radiusKm / 110.574
  // A distância por grau de longitude encolhe conforme se afasta do equador.
  const lonRadius = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180))

  for (let index = 0; index <= points; index += 1) {
    const angle = (index / points) * 2 * Math.PI
    coordinates.push([lon + lonRadius * Math.cos(angle), lat + latRadius * Math.sin(angle)])
  }

  return coordinates
}

function zoomFor(uncertaintyKm: number): number {
  // Faixas finas embaixo: um endereço exato merece zoom de rua, não de cidade.
  if (uncertaintyKm <= 1) return 17
  if (uncertaintyKm <= 3) return 15
  if (uncertaintyKm <= 20) return 12
  if (uncertaintyKm <= 60) return 10
  if (uncertaintyKm <= 200) return 7
  if (uncertaintyKm <= 600) return 5
  return 3.5
}

# BAQ Lote · Life City

Análisis catastral y normativo de lotes en **Barranquilla**: busca un lote por referencia catastral,
dirección o en el mapa, cruza las capas del geovisor **Panorama Urbano** y calcula **densidad
(viviendas) y altura (pisos)** según la tabla de edificabilidad. Entrega plano **DXF** para Revit,
GeoJSON, CSV e informe HTML. Cada usuario guarda sus consultas en su cuenta.

**App web:** https://baq-lote-lifecity.web.app

## Estructura
| Carpeta | Contenido |
|---|---|
| `web/` | App web (HTML + JS sin compilación, Leaflet, Firebase Auth + Firestore). Se publica en Firebase Hosting |
| `web/js/motor.js` | Búsqueda del lote, cruce de capas y cálculo de norma |
| `web/js/salidas.js` | DXF R12, GeoJSON, CSV e informe HTML |
| `web/js/nube.js` | Inicio de sesión y consultas guardadas |
| `web/norma_edificabilidad_baq.json` | Tabla de edificabilidad (editable) |
| `desktop/` | Versión de escritorio en Python (tkinter / línea de comandos / .exe) |
| `firestore.rules` | Cada usuario solo lee y escribe `users/{uid}/consultas` |
| `ejemplo/` | Salida completa de un lote de ejemplo |

## Fuentes de datos
- **Catastro abierto** de la Alcaldía (`miciudad.barranquilla.gov.co/gis/rest/services/catastro/datosabiertos/MapServer`):
  terreno (EPSG 9377), predio, direcciones, construcciones, manzana.
- **WebMap Panorama Urbano** en ArcGIS Online (`d2af7ac624fe413ca6f14cbbe2b0183d`): tratamientos urbanísticos,
  usos, planes parciales, patrimonio, amenazas, clasificación del suelo, barrio, localidad.

El servidor `geopendata.barranquilla.gov.co` (redes y equipamientos) bloquea clientes automáticos;
la app lo omite y lo avisa en el informe.

## Cómo se calcula la norma
- Se toma la capa *TRATAMIENTOS URBANISTICOS* que cubre el lote; el porcentaje de cobertura se estima por muestreo.
  Si hay varios tratamientos, el principal es el de mayor cobertura; las franjas < 2 % se ignoran.
- Área: la catastral del predio (si no existe, la geométrica). Viviendas = densidad × área, redondeadas hacia abajo.
- Para cambiar la norma edita `web/norma_edificabilidad_baq.json` y vuelve a publicar (`desktop/` tiene su propia copia).

## Desarrollo
```bash
npm run dev          # http://localhost:5000
npm run demo         # genera /test/demo.html: la interfaz con sesión simulada, sin Firebase
npm test             # pruebas sin conexión del motor web
npm run test:vivo    # consulta lotes reales contra los servidores
npm run deploy       # Firebase Hosting + reglas de Firestore (proyecto baq-lote-lifecity)
```

Firestore guarda cada consulta en dos documentos: `users/{uid}/consultas/{id}` (nombre, notas, resumen, para el
historial) y `…/{id}/detalle/datos` (resultado completo en JSON).

Información de referencia: no reemplaza certificados catastrales, conceptos de norma urbanística ni licencias.

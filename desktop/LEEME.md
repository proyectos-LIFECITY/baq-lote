# BAQ Lote · Life City BIM

Extrae de las fuentes públicas del geovisor **Panorama Urbano** (Barranquilla) la geometría,
los datos catastrales y las capas normativas de un lote, y calcula **densidad (viviendas) y
altura (pisos)** con la tabla de edificabilidad de Renovación, Mejoramiento Integral y Consolidación.

## Fuentes
| Fuente | Qué aporta |
|---|---|
| Catastro abierto — `miciudad.barranquilla.gov.co/gis/.../catastro/datosabiertos/MapServer` | Terreno (polígono EPSG 9377), predio (NPN, área catastral, destinación, estrato), direcciones, construcciones, manzana |
| WebMap Panorama Urbano en ArcGIS Online (`d2af7ac624fe413ca6f14cbbe2b0183d`) | Tratamientos urbanísticos, usos, IPT/planes parciales, patrimonio, amenazas, clasificación del suelo, barrio, localidad… |

> El servidor antiguo `appbaq.barranquilla.gov.co:9191` ya no se usa: está detrás de un reto
> anti-bots de Cloudflare y su origen no responde. Las capas de `geopendata.barranquilla.gov.co`
> (redes, equipamientos) también bloquean clientes automáticos; el programa las omite y lo avisa.

## Uso
1. `pip install -r requirements.txt`  (solo `requests`; la interfaz usa tkinter, incluido en Python)
2. `python baq_lote.py` abre la interfaz: elige **Referencia catastral**, **Dirección** o
   **Coordenadas**, y pulsa **Extraer lote** (o Enter). Al terminar abre el informe.
3. Para un .exe sin Python: ejecuta `crear_exe.bat` → `dist\BAQ_Lote.exe`.

Línea de comandos:

    python baq_lote.py --ref 080010105000000040001000000000     (NPN 30 dígitos, o anterior de 20)
    python baq_lote.py --dir "Carrera 59 # 64-221"
    python baq_lote.py --x -74.786999 --y 10.951767             (WGS84)
    python baq_lote.py --x 4804816 --y 2768775 --sr 9377         (MAGNA Origen Nacional)
    python baq_lote.py --ref XXXX --dxf-local --salida C:\Lotes\L1
    python baq_lote.py --ref XXXX --sin-capas                    (solo catastro, más rápido)
    python baq_lote.py --descubrir                               (inventario de capas y campos)

Una referencia parcial (p. ej. los primeros 22 dígitos) lista los predios que coinciden.

## Salidas (carpeta `lote_<NPN>`)
| Archivo | Uso |
|---|---|
| lote.dxf | Revit/AutoCAD: capas LOTE, CONSTRUCCIONES, LOTE_COTAS, LOTE_TEXTO. Metros, EPSG 9377 |
| lote.geojson | QGIS / Google Earth (WGS84): lote + construcciones |
| atributos.csv | Excel (separador `;`): catastro, norma calculada y todas las capas que cruzan, con % del lote |
| informe.html | Ficha: plano con cotas, vértices, densidad y altura, capas normativas, construcciones |
| resumen.json | Todo el resultado estructurado |
| capas_servicio.json | Capas consultadas y servidores no disponibles |

## En Revit
- DXF absoluto: Insertar → Vincular CAD → posicionamiento "Auto - Centro a centro"; si el modelo
  usa coordenadas compartidas, "Adquirir coordenadas" desde el vínculo.
- DXF local (`--dxf-local`): origen en el centroide; el desplazamiento queda en informe.html.

## Densidad y altura
- Se toma el tratamiento de la capa *TRATAMIENTOS URBANISTICOS* que cubre el lote (porcentaje
  estimado por muestreo). Si hay varios, se marca como principal el de mayor cobertura; las
  franjas < 2 % se ignoran (diferencias de digitalización).
- Área usada: la **catastral** del predio; si no existe, la geométrica.
- Viviendas = densidad (viv/m²) × área, redondeadas hacia abajo.
- Conservación, Desarrollo, Espacio Público, etc. se reportan como "fuera de la tabla".
- Si la norma cambia, edita `norma_edificabilidad_baq.json` (junto al .py o al .exe); no hace
  falta recompilar. Si el archivo no está, se usa la tabla interna de `norma_baq.py`.

## Pruebas
    python -m unittest discover tests

## Si algo falla
- "rechazó la consulta (HTTP 403, firewall)": el firewall de la Alcaldía bloqueó una consulta;
  reintenta en unos minutos o busca por referencia/coordenadas en lugar de dirección.
- "Error de certificado SSL" → marca *Ignorar SSL* o usa `--inseguro`.
- Variables de entorno: `BAQ_PAUSA` (segundos entre peticiones, def. 0.15), `BAQ_HILOS` (def. 4).
- Información de referencia: no reemplaza certificados catastrales, conceptos de norma ni licencias.

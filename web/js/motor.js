// Orquestación: busca el lote, cruza capas de Panorama Urbano y calcula la norma
import { ArcGIS, ErrorLote, enParalelo } from "./arcgis.js";
import { CATASTRO, Catastro, L, PAT_TECNICO, SR, camposDe, legibles, valorLegible } from "./catastro.js";
import { areaAnillos, centroide, fraccionDentro, muestrear, perimetro } from "./geom.js";
import { calcular, fuenteNorma, interpretar } from "./norma.js";

export const VERSION = "2.0-web";
export const WEBMAP = "d2af7ac624fe413ca6f14cbbe2b0183d"; // WebMap del geovisor Panorama Urbano
const PORTAL = (id) => `https://www.arcgis.com/sharing/rest/content/items/${id}/data`;
export const MIN_FRACCION_NORMA = 0.02; // tratamientos que cubren menos del 2% se ignoran
const PAT_TRATAMIENTO = /tratam/i;
const PAT_INSTRUMENTO = /plan(es)?[ _]*parcial|plan(es)?[ _]*zonal|pemp|patrimon|bic_|ipt/i;
export const URL_LIFECITY = "https://www.lifecity.com.co/";
export const DESCARGO = "El cálculo de densidad y altura usa únicamente la tabla general de edificabilidad (Renovación, Mejoramiento Integral y Consolidación). Todavía no incorpora la norma específica de Planes Parciales, Planes Zonales ni Planes Especiales de Manejo y Protección (PEMP); si el lote está dentro de alguno de ellos, esa norma prevalece y el resultado puede ser distinto.";

const S3 = "https://services3.arcgis.com/oGYAc07w6wsvgUYr/arcgis/rest/services/";
const CAPAS_RESPALDO = [
  ["POT Urbano 2014", "TRATAMIENTOS URBANISTICOS", "TRATAMIENTOS_URBANISTICOS_2024/FeatureServer/0"],
  ["POT Urbano 2014", "ACTIVIDAD USOS URBANOS _ Tipo Poligono", "ACTIVIDAD_USOS_URBANOS___Tipo_Poligono/FeatureServer/0"],
  ["POT Urbano 2014", "ACTIVIDAD USOS URBANOS _ Actividades", "ACTIVIDAD_USOS_URBANOS___Actividades/FeatureServer/0"],
  ["POT Urbano 2014", "ALINEAMIENTO", "Alineamiento_Bq/FeatureServer/0"],
  ["Instrumentos de Planificación", "Tipo_IPT", "Tipo_IPT/FeatureServer/0"],
  ["Instrumentos de Planificación", "Planes Parciales", "POT_IPT_Planes_Parciales/FeatureServer/1"],
  ["Instrumentos de Planificación", "Area Patrimonial", "AreaPatrimonial/FeatureServer/0"],
  ["Amenaza y Riesgo", "Amenaza por Inundación", "Inundaci%C3%B3n2024/FeatureServer/0"],
  ["POT General 2014", "CLASIFICACIÓN DEL SUELO - Tipo", "CLASIFICACI%C3%93N_DEL_SUELO/FeatureServer/0"],
  ["Básicas", "Piezas Urbanas", "Piezas_URBANAS/FeatureServer/0"],
  ["Básicas", "LIM_Barrio", "LIM_Barrio/FeatureServer/0"],
  ["Básicas", "LIM_Localidad", "LIM_Localidad/FeatureServer/0"],
].map(([grupo, titulo, u]) => ({ grupo, titulo, url: S3 + u }));

export async function capasWebmap(cli, item = WEBMAP) {
  let d;
  try {
    d = await cli.req(PORTAL(item));
  } catch (e) {
    cli.log(`No se pudo leer el WebMap de Panorama Urbano (${e.message}); se usan capas de respaldo.`, "aviso");
    return CAPAS_RESPALDO;
  }
  const capas = [], vistos = new Set();
  const recorrer = (ls, grupo) => {
    for (const l of ls || []) {
      if (l.layers) recorrer(l.layers, l.title || grupo);
      const url = (l.url || "").replace(/\/$/, "");
      if (l.layerType === "ArcGISFeatureLayer" && url && !vistos.has(url) && !url.startsWith(CATASTRO)) {
        vistos.add(url);
        capas.push({ grupo, titulo: l.title || url, url });
      }
    }
  };
  recorrer(d.operationalLayers, "General");
  return capas;
}

export async function cruzarCapas(cli, capas, rings, muestras, progreso = () => {}) {
  const geometry = JSON.stringify({ rings, spatialReference: { wkid: SR } });
  const area = areaAnillos(rings);
  let hechas = 0;
  const res = await enParalelo(capas, async (c) => {
    try {
      const feats = await cli.features(c.url, {
        geometry, geometryType: "esriGeometryPolygon", inSR: SR, spatialRel: "esriSpatialRelIntersects",
        returnGeometry: "true", outSR: SR, resultRecordCount: 100, geometryPrecision: 3,
      });
      if (!feats.length) return null;
      const info = await cli.info(c.url);
      const campos = camposDe(info);
      const elementos = [];
      for (const f of feats) {
        const g = f.geometry || {};
        const fraccion = g.rings ? fraccionDentro(muestras, g.rings) : null;
        if (fraccion === 0) continue; // solo toca el borde del lote
        const attrs = f.attributes || {};
        elementos.push({
          fraccion, area_m2: fraccion === null ? null : fraccion * area,
          atributos: legibles(attrs, campos),
          texto: Object.entries(attrs).filter(([k]) => !PAT_TECNICO.test(k) && !/pemp/i.test(k))
            .map(([k, v]) => valorLegible(v, campos[k])).join(" "),
        });
      }
      if (!elementos.length) return null;
      elementos.sort((a, b) => (b.fraccion || 0) - (a.fraccion || 0));
      const partes = elementos.filter((e) => e.fraccion !== null).map((e) => `${Math.round(100 * e.fraccion)}%`);
      cli.log(`${c.titulo}: ${elementos.length} elemento(s)${partes.length ? ` (${partes.join(", ")})` : ""}`, "ok");
      return { ...c, nombre: info.name, geometria: info.geometryType, elementos };
    } catch (e) {
      if (!/no disponible|rechazó/.test(e.message)) cli.log(`${c.titulo}: ${e.message}`, "aviso");
      return null;
    } finally {
      progreso(++hechas / capas.length);
    }
  }, 4);
  return res.filter(Boolean);
}

/** Tratamientos que cubren el lote -> densidad y altura según la tabla de edificabilidad. */
export function evaluarNorma(cruces, area) {
  const resultados = [], idx = new Map(), porCapa = new Map();
  const buscar = (e, re) => e.atributos.find((a) => re.test(a.campo))?.valor ?? "";
  for (const capa of cruces) {
    if (!PAT_TRATAMIENTO.test(`${capa.titulo} ${capa.nombre || ""}`)) continue;
    for (const e of capa.elementos) {
      if (e.fraccion !== null && e.fraccion < MIN_FRACCION_NORMA) continue; // franja por digitalización
      const [trat, niv] = interpretar(e.texto);
      const etiqueta = buscar(e, /tipo/i), clase = buscar(e, /^trat/i), altura = buscar(e, /altura/i);
      const clave = `${trat || clase}|${niv || etiqueta}`;
      // misma zona en varios polígonos de una capa: se suma; en capas repetidas del WebMap: se toma la mayor
      const k = `${clave}|${capa.url}`;
      porCapa.set(k, (porCapa.get(k) || 0) + (e.fraccion || 0));
      if (idx.has(clave)) {
        const r = idx.get(clave);
        r.fraccion = Math.max(r.fraccion || 0, Math.min(porCapa.get(k), 1));
        continue;
      }
      let res;
      if (trat && niv) res = calcular(trat, niv, area);
      else if (trat) res = { tratamiento: trat, nivel: null, area_m2: area, error: `Tratamiento detectado sin nivel (${etiqueta}); revisa la capa.` };
      else res = { tratamiento: String(clase).toUpperCase() || "SIN TRATAMIENTO", nivel: etiqueta, area_m2: area,
        error: "Tratamiento fuera de la tabla de edificabilidad (Renovación, Mejoramiento Integral, Consolidación)." };
      Object.assign(res, { fuente: capa.titulo, fraccion: e.fraccion, altura_capa: altura, etiqueta: `${clase} ${etiqueta}`.trim() });
      idx.set(clave, res);
      resultados.push(res);
    }
  }
  resultados.sort((a, b) => (b.fraccion || 0) - (a.fraccion || 0));
  if (resultados.length) resultados[0].principal = true;
  return resultados;
}

/**
 * busqueda: {tipo: "ref"|"dir"|"punto", valor, x, y, sr}
 * log(msg, nivel) y etapa(n, texto, fraccion) informan el progreso a la interfaz.
 */
export async function ejecutar(busqueda, { log = () => {}, etapa = () => {}, sinCapas = false } = {}) {
  const cli = new ArcGIS({ log });
  const cat = new Catastro(cli);
  const avisos = [];

  etapa(1, "Buscando el lote en el catastro");
  let terreno, predioBuscado = null;
  if (busqueda.tipo === "ref") [terreno, predioBuscado] = await cat.terrenoPorRef(busqueda.valor);
  else if (busqueda.tipo === "dir") terreno = await cat.terrenoPorDireccion(busqueda.valor);
  else if (busqueda.tipo === "punto") terreno = await cat.terrenoPorPunto(busqueda.x, busqueda.y, busqueda.sr || 4326);
  else throw new ErrorLote("Tipo de búsqueda no válido.");

  const ta = terreno.attributes;
  const npn = ta.name || "";
  log(`Terreno ${npn}`);
  const [rings, ringsWgs] = await Promise.all([
    cat.geometria(L.TERRENO, ta.objectid, SR), cat.geometria(L.TERRENO, ta.objectid, 4326)]);
  if (!rings) throw new ErrorLote("El terreno no tiene geometría poligonal.");

  etapa(2, "Predio, direcciones y construcciones");
  const predios = await cat.prediosDeTerreno(ta.globalid);
  const predio = predioBuscado || predios.find((p) => p.attributes.numero_predial_nacional === npn) || predios[0] || null;
  if (cat.sinPredios)
    avisos.push("El catastro no tiene disponible hoy la tabla de predios: no se muestran área catastral, destinación ni estrato, " +
      "y el cálculo usa el área geométrica del polígono.");
  if (predios.length > 1)
    avisos.push(`El terreno tiene ${predios.length} predios asociados (propiedad horizontal o englobe). ` +
      `Se muestran los datos del predio ${predio.attributes.numero_predial_nacional}.`);
  const pa = predio?.attributes || {};
  const [direcciones, consFeats, manzana, camposT, camposP, camposC] = await Promise.all([
    cat.direcciones(ta.globalid, pa.globalid), cat.construcciones(rings), cat.manzana(rings),
    cat.campos(L.TERRENO), cat.campos(L.PREDIO), cat.campos(L.CONSTRUCCION)]);
  const construcciones = await Promise.all(consFeats.map(async (f) => ({
    objectid: f.attributes.objectid, rings: f.geometry.rings, area: areaAnillos(f.geometry.rings),
    pisos: f.attributes.total_pisos ?? null, atributos: legibles(f.attributes, camposC),
    rings_wgs84: await cat.geometria(L.CONSTRUCCION, f.attributes.objectid, 4326),
  })));
  const area = areaAnillos(rings);
  const areaOficial = pa.area_catastral_terreno || null;
  const [cx, cy] = centroide(rings);
  const lote = {
    npn, direcciones, rings, rings_wgs84: ringsWgs, area, perimetro: perimetro(rings), area_oficial: areaOficial,
    cx, cy, terreno_attrs: legibles(ta, camposT), predio_attrs: predio ? legibles(pa, camposP) : [],
    construcciones, manzana, n_predios: predios.length,
  };
  log(`${direcciones[0] || "Sin dirección"} · ${area.toFixed(2)} m² geométricos` +
    `${areaOficial ? ` · ${areaOficial.toFixed(2)} m² catastrales` : ""} · ${construcciones.length} construcción(es)`);
  if (areaOficial && Math.abs(areaOficial - area) / areaOficial > 0.02)
    avisos.push(`El área catastral (${areaOficial.toFixed(2)} m²) difiere ${(100 * Math.abs(areaOficial - area) / areaOficial).toFixed(1)}% de la geométrica (${area.toFixed(2)} m²).`);

  let cruces = [];
  if (!sinCapas) {
    etapa(3, "Cruzando capas normativas", 0);
    const capas = await capasWebmap(cli);
    cruces = await cruzarCapas(cli, capas, rings, muestrear(rings), (f) => etapa(3, "Cruzando capas normativas", f));
    if (cli.bloqueados.size)
      avisos.push(`No respondieron (protección anti-bots o caídos): ${[...cli.bloqueados].sort().join(", ")}. Sus capas no se incluyen.`);
  }

  etapa(4, "Calculando densidad y altura");
  const areaNorma = areaOficial || area;
  const norma = evaluarNorma(cruces, areaNorma);
  if (!sinCapas && !norma.length) avisos.push("No se identificó tratamiento urbanístico sobre el lote.");
  const instrumentos = cruces.filter((c) => PAT_INSTRUMENTO.test(c.titulo)).map((c) => c.titulo);
  if (instrumentos.length)
    avisos.push(`El lote cruza instrumentos con norma propia (${[...new Set(instrumentos)].join(", ")}). ` +
      "Su norma específica aún no está incorporada al cálculo y prevalece sobre la tabla general: verifica antes de decidir.");
  if (norma.length > 1) avisos.push(`El lote cruza ${norma.length} tratamientos; se marca como principal el de mayor cobertura.`);

  etapa(5, "Listo");
  return {
    version: VERSION, busqueda, lote, norma, cruces, avisos,
    fecha: new Date().toISOString(), area_norma: areaNorma,
    area_fuente: areaOficial ? "área catastral del predio" : "área geométrica del polígono",
    fuente_norma: fuenteNorma, catastro: cat.base, webmap: WEBMAP,
  };
}

/** Resumen corto para listas e historial. */
export function resumir(datos) {
  const p = datos.norma.find((n) => n.principal);
  const max = p && !p.error && p.maxima?.rango ? p.maxima : null;
  return {
    npn: datos.lote.npn,
    direccion: datos.lote.direcciones[0] || "",
    area: Math.round((datos.lote.area_oficial || datos.lote.area) * 100) / 100,
    tratamiento: p ? `${p.tratamiento}${p.nivel ? " " + p.nivel : ""}` : "",
    viviendas_max: max ? max.viviendas_max : null,
    pisos_max: max ? max.altura_pisos : null,
    centro: datos.lote.rings_wgs84 ? centroide(datos.lote.rings_wgs84) : null,
  };
}

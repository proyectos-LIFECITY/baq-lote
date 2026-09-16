// Norma de edificabilidad Barranquilla (Renovación, Mejoramiento Integral, Consolidación).
// La tabla se carga de norma_edificabilidad_baq.json: {"TRAT|NIVEL": {base, maxima, texto_*, nota_maxima_ultimo}}
// Rangos: [área máxima inclusiva m² | null, densidad viv/m², pisos]

let NORMA = {};
export let fuenteNorma = "sin cargar";

export function setNorma(json, fuente = "norma_edificabilidad_baq.json") {
  NORMA = {};
  for (const [clave, regla] of Object.entries(json)) {
    const [trat, niv = ""] = clave.split("|");
    NORMA[`${trat.trim().toUpperCase()}|${niv.trim().toUpperCase()}`] = regla;
  }
  fuenteNorma = fuente;
}

export async function cargarNorma(url = "norma_edificabilidad_baq.json") {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`No se pudo cargar la norma (${r.status})`);
  setNorma(await r.json(), url);
}

export const normalizar = (t) =>
  String(t ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

/** [tratamiento, nivel] a partir de cualquier texto de atributos. */
export function interpretar(texto) {
  const t = normalizar(texto);
  let trat;
  if (/RENOVACION|REACTIVACION|REDESARROLLO/.test(t)) trat = "RENOVACION";
  else if (t.includes("MEJORAMIENTO")) trat = "MEJORAMIENTO INTEGRAL";
  else if (t.includes("CONSOLIDACION")) trat = "CONSOLIDACION";
  else return [null, null];
  if (trat === "RENOVACION") {
    if (t.includes("REDESARROLLO")) return [trat, "REDESARROLLO"];
    if (t.includes("REACTIVACION")) return [trat, "REACTIVACION"];
    return [trat, null];
  }
  if (trat === "MEJORAMIENTO INTEGRAL") {
    const m = t.match(/MEJORAMIENTO INTEGRAL\s*[-_:]?\s*(?:NIVEL\s*)?([12])\b/);
    if (m) return [trat, m[1]];
  }
  if (t.includes("ESPECIAL")) return [trat, "ESPECIAL"];
  const m = t.match(/\b(?:NIVEL|NIV\.?|N)\s*[-_:]?\s*(1\s*[AB]|[123])\b/) || t.match(/\b(1\s*[AB])\b/);
  return [trat, m ? m[1].replace(/\s/g, "") : null];
}

function rango(tabla, area) {
  for (let i = 0; i < tabla.length; i++) {
    const [tope, dens, pisos] = tabla[i];
    if (tope === null || area <= tope) {
      const ant = i ? tabla[i - 1][0] : 0;
      const txt = tabla.length === 1 ? "Todos"
        : i === 0 ? `Hasta ${tope} m²`
        : tope === null ? `Mayor a ${ant} m²`
        : `Entre ${ant + 1} y ${tope} m²`;
      return [i, txt, dens, pisos];
    }
  }
  const [tope, dens, pisos] = tabla[tabla.length - 1];
  return [tabla.length - 1, `Mayor a ${tope} m²`, dens, pisos];
}

/** Norma base y máxima para un predio. Viviendas redondeadas hacia abajo. */
export function calcular(tratamiento, nivel, area) {
  const regla = NORMA[`${tratamiento}|${nivel}`];
  const out = { tratamiento, nivel, area_m2: area };
  if (!regla) return { ...out, error: "Combinación tratamiento/nivel no encontrada en la tabla" };
  for (const esc of ["base", "maxima"]) {
    if (regla["texto_" + esc]) { out[esc] = { nota: regla["texto_" + esc] }; continue; }
    const tabla = regla[esc];
    const [i, txt, dens, pisos] = rango(tabla, area);
    const viv = dens * area;
    const d = { rango: txt, densidad_viv_m2: dens, altura_pisos: pisos,
      viviendas_calculadas: Math.round(viv * 100) / 100, viviendas_max: Math.floor(viv + 1e-9) };
    if (esc === "maxima" && i === tabla.length - 1 && regla.nota_maxima_ultimo) d.nota = regla.nota_maxima_ultimo;
    out[esc] = d;
  }
  return out;
}

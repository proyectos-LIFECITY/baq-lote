// Archivos de salida: DXF (R12), GeoJSON, CSV e informe HTML
import { SR } from "./catastro.js";
import { DESCARGO, URL_LIFECITY } from "./motor.js";
import { abierto, bbox, centroide, lados, puntoInterior } from "./geom.js";

const f4 = (v) => v.toFixed(4);
const pct = (f) => (f === null || f === undefined ? "" : (100 * f).toFixed(1));

// ------------------------------------------------------------------ DXF
function dxfPolilinea(L, pts, capa, ox, oy) {
  L.push("0", "POLYLINE", "8", capa, "66", "1", "70", "1", "10", "0.0", "20", "0.0", "30", "0.0");
  for (const p of abierto(pts)) L.push("0", "VERTEX", "8", capa, "10", f4(p[0] - ox), "20", f4(p[1] - oy), "30", "0.0");
  L.push("0", "SEQEND", "8", capa);
}

function dxfTexto(L, capa, x, y, h, txt, ox, oy) {
  L.push("0", "TEXT", "8", capa, "10", f4(x - ox), "20", f4(y - oy), "30", "0.0", "40", h.toFixed(3),
    "1", txt.slice(0, 250), "50", "0.000", "72", "1", "11", f4(x - ox), "21", f4(y - oy), "31", "0.0");
}

const ascii = (s) => s.normalize("NFKD").replace(/[^\x20-\x7e]/g, "");

export function dxf(lote, { local = false } = {}) {
  const rings = lote.rings;
  const [ox, oy] = local ? centroide(rings) : [0, 0];
  const capas = [["LOTE", 3], ["CONSTRUCCIONES", 8], ["LOTE_TEXTO", 7], ["LOTE_COTAS", 2]];
  const L = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "9", "$INSUNITS", "70", "6",
    "0", "ENDSEC", "0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", String(capas.length)];
  for (const [n, c] of capas) L.push("0", "LAYER", "2", n, "70", "0", "62", String(c), "6", "CONTINUOUS");
  L.push("0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES");
  for (const r of rings) dxfPolilinea(L, r, "LOTE", ox, oy);
  for (const c of lote.construcciones) for (const r of c.rings) dxfPolilinea(L, r, "CONSTRUCCIONES", ox, oy);
  const [x0, y0, x1, y1] = bbox(rings);
  const h = Math.max(0.25, Math.min(1.5, Math.max(x1 - x0, y1 - y0) / 40));
  for (const ld of lados(rings)) dxfTexto(L, "LOTE_COTAS", ld.medio[0], ld.medio[1], h * 0.7, ld.longitud.toFixed(2), ox, oy);
  const [cx, cy] = puntoInterior(rings);
  dxfTexto(L, "LOTE_TEXTO", cx, cy, h, ascii(`LOTE ${lote.npn} A=${lote.area.toFixed(2)} m2`), ox, oy);
  L.push("0", "ENDSEC", "0", "EOF");
  return { texto: L.join("\r\n") + "\r\n", ox, oy };
}

// ------------------------------------------------------------------ GeoJSON
export function geojson(lote) {
  const features = [];
  const props = (attrs) => Object.fromEntries(attrs.map((a) => [a.campo, a.valor]));
  if (lote.rings_wgs84)
    features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: lote.rings_wgs84 },
      properties: { tipo: "lote", npn: lote.npn, direccion: lote.direcciones.join("; "),
        area_geometrica_m2: Math.round(lote.area * 100) / 100, ...props(lote.predio_attrs) } });
  for (const c of lote.construcciones)
    if (c.rings_wgs84)
      features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: c.rings_wgs84 },
        properties: { tipo: "construccion", ...props(c.atributos) } });
  return JSON.stringify({ type: "FeatureCollection", features }, null, 1);
}

// ------------------------------------------------------------------ CSV
export function csv(datos) {
  const { lote, norma, cruces } = datos;
  const filas = [["fuente", "capa", "item", "campo", "alias", "valor", "porcentaje_lote"]];
  lote.terreno_attrs.forEach((a) => filas.push(["CATASTRO", "Terreno", 1, a.campo, a.alias, a.valor, ""]));
  lote.predio_attrs.forEach((a) => filas.push(["CATASTRO", "Predio", 1, a.campo, a.alias, a.valor, ""]));
  lote.direcciones.forEach((d, i) => filas.push(["CATASTRO", "Dirección", i + 1, "nombre_predio", "Dirección", d, ""]));
  lote.construcciones.forEach((c, i) => c.atributos.forEach((a) =>
    filas.push(["CATASTRO", "Construcción", i + 1, a.campo, a.alias, a.valor, ""])));
  filas.push(["CALCULADO", "Lote", 1, "AREA_GEOM_M2", "Área geométrica m²", lote.area.toFixed(2), ""]);
  filas.push(["CALCULADO", "Lote", 1, "PERIMETRO_M", "Perímetro m", lote.perimetro.toFixed(2), ""]);
  for (const n of norma)
    for (const esc of ["base", "maxima"]) {
      const d = n[esc] || {};
      const val = d.rango ? `${d.rango} | ${d.densidad_viv_m2.toFixed(3)} viv/m2 | ${d.viviendas_max} viv | ${d.altura_pisos} pisos`
        : d.nota || n.error || "";
      filas.push(["NORMA", n.fuente, 1, `${n.tratamiento} ${n.nivel || ""}`.trim(), "Propuesta " + esc, val, pct(n.fraccion)]);
    }
  for (const capa of cruces)
    capa.elementos.forEach((e, i) => e.atributos.forEach((a) =>
      filas.push([capa.grupo, capa.titulo, i + 1, a.campo, a.alias, a.valor, pct(e.fraccion)])));
  const celda = (v) => { const s = String(v ?? ""); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return "﻿" + filas.map((f) => f.map(celda).join(";")).join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------ Informe HTML
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const fmt = (v, d = 2) => Number(v).toLocaleString("es-CO", { minimumFractionDigits: d, maximumFractionDigits: d });

export function svgPlano(lote, ancho = 560, alto = 420) {
  const rings = lote.rings;
  const [x0, y0, x1, y1] = bbox([...rings, ...lote.construcciones.flatMap((c) => c.rings)]);
  const m = 46;
  const e = Math.min((ancho - 2 * m) / Math.max(x1 - x0, 1e-6), (alto - 2 * m) / Math.max(y1 - y0, 1e-6));
  const ox = (ancho - (x1 - x0) * e) / 2, oy = (alto - (y1 - y0) * e) / 2;
  const P = (p) => [ox + (p[0] - x0) * e, alto - oy - (p[1] - y0) * e];
  const path = (rs) => rs.map((r) => "M" + abierto(r).map((p) => P(p).map((v) => v.toFixed(1)).join(",")).join(" L") + " Z").join(" ");
  const s = [`<svg viewBox="0 0 ${ancho} ${alto}" xmlns="http://www.w3.org/2000/svg" class="plano" role="img" aria-label="Plano del lote">`];
  for (const c of lote.construcciones) s.push(`<path d="${path(c.rings)}" class="cons" fill-rule="evenodd"/>`);
  s.push(`<path d="${path(rings)}" class="lote" fill-rule="evenodd"/>`);
  const [cx, cy] = centroide(rings);
  abierto(rings[0]).forEach((p, i) => {
    const [qx, qy] = P(p);
    const dx = p[0] - cx, dy = p[1] - cy, dn = Math.hypot(dx, dy) || 1;
    s.push(`<circle cx="${qx.toFixed(1)}" cy="${qy.toFixed(1)}" r="2.6" class="vert"/>`);
    s.push(`<text x="${(qx + 11 * dx / dn - 3).toFixed(1)}" y="${(qy - 11 * dy / dn + 4).toFixed(1)}" class="nv">${i + 1}</text>`);
  });
  for (const ld of lados(rings)) {
    if (ld.longitud * e < 28) continue;
    const [qx, qy] = P(ld.medio);
    s.push(`<text x="${qx.toFixed(1)}" y="${qy.toFixed(1)}" class="cota">${ld.longitud.toFixed(2)}</text>`);
  }
  const paso = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((v) => v * e >= 60) || 1000;
  s.push(`<g class="esc"><line x1="16" y1="${alto - 16}" x2="${(16 + paso * e).toFixed(1)}" y2="${alto - 16}"/><text x="16" y="${alto - 22}">${paso} m</text></g>`);
  s.push(`<g class="norte" transform="translate(${ancho - 24},30)"><path d="M0,-16 L7,8 L0,3 L-7,8 Z"/><text x="0" y="22">N</text></g></svg>`);
  return s.join("");
}

export function informe(datos, { ox = 0, oy = 0 } = {}) {
  const { lote, norma, cruces } = datos;
  let filasNorma = "";
  for (const n of norma) {
    let cab = `<b>${esc(n.tratamiento.charAt(0) + n.tratamiento.slice(1).toLowerCase())}</b>${n.nivel ? " · " + esc(n.nivel) : ""}` +
      `<br><small>${esc(n.fuente)} · cubre ${pct(n.fraccion) || "?"}% del lote${n.principal ? " · principal" : ""}</small>`;
    if (n.altura_capa) cab += `<br><small>Altura máx. registrada en la capa: ${esc(n.altura_capa)} pisos</small>`;
    if (n.error) { filasNorma += `<tr><td>${cab}</td><td colspan=4>${esc(n.error)}</td></tr>`; continue; }
    [["base", "Propuesta base"], ["maxima", "Propuesta máxima"]].forEach(([k, nom], j) => {
      const d = n[k];
      const celda = j === 0 ? `<td rowspan=2>${cab}</td>` : "";
      if (!d.rango) { filasNorma += `<tr>${celda}<td>${nom}</td><td colspan=3>${esc(d.nota)}</td></tr>`; return; }
      filasNorma += `<tr>${celda}<td>${nom}<br><small>${esc(d.rango)}</small></td><td>${fmt(d.densidad_viv_m2, 3)} viv/m²</td>` +
        `<td><b>${d.viviendas_max} viviendas</b><br><small>${fmt(d.viviendas_calculadas)} calculadas</small></td>` +
        `<td><b>${d.altura_pisos} pisos</b>${d.nota ? `<br><small>${esc(d.nota)}</small>` : ""}</td></tr>`;
    });
  }
  filasNorma ||= "<tr><td colspan=5>No se identificó un tratamiento urbanístico sobre el lote.</td></tr>";

  const bloquesCapas = [...cruces].sort((a, b) => (a.grupo + a.titulo).localeCompare(b.grupo + b.titulo)).map((capa) => {
    const els = capa.elementos.map((el, i) => {
      const attrs = el.atributos.map((a) => `<tr><td>${esc(a.alias)}</td><td>${esc(a.valor)}</td></tr>`).join("");
      const p = el.fraccion !== null ? `${pct(el.fraccion)}% del lote · ${fmt(el.area_m2)} m²` : "elemento que cruza el lote";
      return `<div class=el><div class=pct>${i + 1} · ${esc(p)}</div><table>${attrs}</table></div>`;
    }).join("");
    return `<details${/tratam/i.test(capa.titulo) ? " open" : ""}><summary><span class=grp>${esc(capa.grupo)}</span> ${esc(capa.titulo)} ` +
      `<span class=n>${capa.elementos.length}</span></summary><div class=els>${els}</div></details>`;
  }).join("") || "<p>No se obtuvieron capas normativas que crucen el lote.</p>";

  const filasCons = lote.construcciones.map((c, i) => `<tr><td>${i + 1}</td><td>${fmt(c.area)}</td><td>${c.pisos ?? "—"}</td><td>${esc(
    c.atributos.filter((a) => !/pisos/.test(a.campo)).map((a) => `${a.alias}: ${a.valor}`).join(", "))}</td></tr>`).join("")
    || "<tr><td colspan=4>Sin construcciones registradas.</td></tr>";
  const filasPredio = [...lote.terreno_attrs, ...lote.predio_attrs].map((a) => `<tr><td>${esc(a.alias)}</td><td>${esc(a.valor)}</td></tr>`).join("");
  const ls = lados(lote.rings);
  const filasVert = abierto(lote.rings[0]).map((p, i) =>
    `<tr><td>${i + 1}</td><td>${p[0].toFixed(3)}</td><td>${p[1].toFixed(3)}</td><td>${fmt(ls[i].longitud)}</td></tr>`).join("");
  const avisos = datos.avisos.map((a) => `<li>${esc(a)}</li>`).join("");
  const princ = norma.find((n) => n.principal && !n.error && n.maxima?.rango);
  const kpiNorma = princ ? `<div><span>Máx. viviendas / pisos</span><b>${princ.maxima.viviendas_max} viv · ${princ.maxima.altura_pisos} pisos</b></div>` : "";
  let latLon = "—";
  if (lote.rings_wgs84) {
    const [lon, lat] = centroide(lote.rings_wgs84);
    latLon = `<a href="https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}" target="_blank" rel="noopener">${lat.toFixed(6)}, ${lon.toFixed(6)}</a>`;
  }
  const fecha = new Date(datos.fecha).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lote ${esc(lote.npn)} · Life City</title>
<style>
:root{--v:#1f7a4d;--v2:#e7f2ec;--t:#1c1c1c;--m:#5b6660;--b:#d5ddd8;--bg:#fff;--g:#f3f6f4;--a:#b4541a}
@media (prefers-color-scheme:dark){:root{--v:#5cc28d;--v2:#1d3328;--t:#e8ece9;--m:#9aa8a0;--b:#34413a;--bg:#131816;--g:#1b221f;--a:#e59a5f}}
*{box-sizing:border-box}
body{font-family:"Segoe UI",system-ui,Arial,sans-serif;color:var(--t);background:var(--bg);margin:0;line-height:1.45}
header{background:#1f7a4d;color:#fff;padding:22px 32px}
header h1{margin:0;font-size:24px} header div{opacity:.9;font-size:14px}
main{padding:24px 32px;max-width:1150px;margin:auto}
h2{color:var(--v);border-bottom:2px solid var(--v);padding-bottom:4px;margin-top:34px;font-size:19px}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.kpi div{background:var(--g);padding:12px 16px;border-radius:8px}
.kpi span{font-size:12px;color:var(--m);display:block}
.kpi b{display:block;font-size:19px;color:var(--v);word-break:break-all}
.dos{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:24px;align-items:start}
@media (max-width:820px){.dos{grid-template-columns:1fr} main{padding:16px} header{padding:18px 16px}}
.plano{width:100%;height:auto;background:var(--g);border-radius:8px}
.plano .lote{fill:rgba(31,122,77,.14);stroke:var(--v);stroke-width:2}
.plano .cons{fill:rgba(120,120,120,.28);stroke:var(--m);stroke-width:1;stroke-dasharray:3 2}
.plano .vert{fill:var(--v)} .plano text{font-size:11px;fill:var(--t);text-anchor:middle}
.plano .cota{fill:var(--a);font-weight:600;paint-order:stroke;stroke:var(--g);stroke-width:3px}
.plano .nv{fill:var(--m);font-size:10px}
.plano .esc line{stroke:var(--t);stroke-width:2} .plano .esc text{text-anchor:start}
.plano .norte path{fill:var(--t)}
table{border-collapse:collapse;width:100%;font-size:13px;margin-bottom:14px}
td,th{border:1px solid var(--b);padding:5px 8px;text-align:left;vertical-align:top}
th{background:var(--g)} small{color:var(--m)}
.scroll{overflow-x:auto}
details{border:1px solid var(--b);border-radius:8px;margin-bottom:8px}
summary{cursor:pointer;padding:9px 12px;font-weight:600}
summary .grp{font-weight:400;color:var(--m);font-size:12px;margin-right:6px}
summary .n{background:var(--v2);color:var(--v);border-radius:10px;padding:0 8px;font-size:12px;margin-left:6px}
.els{padding:0 12px 6px} .pct{font-size:12px;color:var(--a);font-weight:600;margin:6px 0 4px}
.avisos{background:var(--v2);border-left:4px solid var(--a);padding:10px 14px 10px 30px;border-radius:6px}
a{color:var(--v)}
.descargo{margin-top:28px;border:1px solid var(--b);border-left:4px solid var(--a);border-radius:8px;padding:12px 16px;font-size:12.5px;color:var(--m)}
.cta-lc{margin:16px 0;display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap;background:#1f7a4d;color:#fff;border-radius:10px;padding:16px 20px;font-size:14px}
.cta-lc a{background:#fff;color:#14573a;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:8px;white-space:nowrap}
@media print{header{-webkit-print-color-adjust:exact;print-color-adjust:exact} details{break-inside:avoid}}
</style></head><body>
<header><h1>Ficha de lote — Barranquilla</h1>
<div>Life City BIM Management Hub · BAQ Lote ${esc(datos.version)} · ${esc(fecha)}</div></header><main>
<div class="kpi">
<div><span>Número predial nacional</span><b>${esc(lote.npn)}</b></div>
<div><span>Dirección</span><b>${esc(lote.direcciones[0] || "—")}</b></div>
<div><span>Área catastral</span><b>${lote.area_oficial ? fmt(lote.area_oficial) + " m²" : "—"}</b></div>
<div><span>Área geométrica</span><b>${fmt(lote.area)} m²</b></div>
<div><span>Perímetro</span><b>${fmt(lote.perimetro)} m</b></div>
${kpiNorma}
</div>
${avisos ? `<ul class="avisos">${avisos}</ul>` : ""}
<h2>Plano y localización</h2>
<div class="dos"><div>${svgPlano(lote)}
<p><small>Lote (verde) y construcciones catastrales (gris). Cotas en metros. EPSG ${SR}.</small></p></div>
<div><table>
<tr><th colspan=2>Localización</th></tr>
<tr><td>Manzana</td><td>${esc(lote.manzana?.codigo || "—")}</td></tr>
<tr><td>Centroide EPSG ${SR}</td><td>X=${lote.cx.toFixed(3)}<br>Y=${lote.cy.toFixed(3)}</td></tr>
<tr><td>Centroide WGS84</td><td>${latLon}</td></tr>
<tr><td>Origen DXF</td><td>X=${ox.toFixed(3)} Y=${oy.toFixed(3)}${ox ? " (local)" : " (absoluto)"}</td></tr>
<tr><td>Predios asociados</td><td>${lote.n_predios}</td></tr>
<tr><td>Otras direcciones</td><td>${esc(lote.direcciones.slice(1).join("; ") || "—")}</td></tr>
</table>
<div class="scroll"><table><tr><th>Vértice</th><th>X</th><th>Y</th><th>Lado (m)</th></tr>${filasVert}</table></div>
</div></div>
<h2>Edificabilidad: densidad y altura</h2>
<p><small>Área usada: ${fmt(datos.area_norma)} m² (${esc(datos.area_fuente)}). Viviendas redondeadas hacia abajo.
Tabla: ${esc(datos.fuente_norma)}.</small></p>
<div class="scroll"><table><tr><th>Tratamiento</th><th>Escenario / rango</th><th>Densidad</th><th>Viviendas</th><th>Altura</th></tr>${filasNorma}</table></div>
<h2>Normativa y condicionantes que cruzan el lote (${cruces.length} capas)</h2>
${bloquesCapas}
<h2>Construcciones existentes (catastro)</h2>
<div class="scroll"><table><tr><th>#</th><th>Área huella m²</th><th>Pisos</th><th>Detalle</th></tr>${filasCons}</table></div>
<h2>Datos catastrales</h2>
<div class="scroll"><table><tr><th>Campo</th><th>Valor</th></tr>${filasPredio}</table></div>
<div class="descargo"><b>Descargo de responsabilidad.</b> ${esc(DESCARGO)} Este informe es de referencia y no constituye
concepto de norma urbanística, certificado catastral ni licencia; Life City no se hace responsable por decisiones tomadas
con base en él sin la validación ante la Secretaría de Planeación o una curaduría urbana.</div>
<div class="cta-lc"><div><b>¿Vas a desarrollar este lote?</b><br>Life City lo lleva del lote a la obra con <b>Coordinación BIM Total</b>:
modelado, coordinación de todas las disciplinas, detección de interferencias, planimetría y cantidades de obra.</div>
<a href="${URL_LIFECITY}" target="_blank" rel="noopener">Solicitar propuesta</a></div>
<p><small>Fuentes: ${esc(datos.catastro)} · WebMap Panorama Urbano (${esc(datos.webmap)}).
Información de referencia; no reemplaza certificados catastrales, conceptos de norma urbanística
ni licencias. Porcentajes de superposición estimados por muestreo.</small></p></main></body></html>`;
}

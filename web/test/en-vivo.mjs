// Prueba con conexión: node test/en-vivo.mjs
import { readFileSync } from "node:fs";
import { setNorma } from "../js/norma.js";
import { ejecutar, resumir } from "../js/motor.js";
import { dxf, csv, geojson, informe } from "../js/salidas.js";

setNorma(JSON.parse(readFileSync(new URL("../norma_edificabilidad_baq.json", import.meta.url))));
const casos = [
  { tipo: "ref", valor: "080010105000000040001000000000" },
  { tipo: "dir", valor: "Cra 17 # 18-61" },
  { tipo: "punto", x: -74.793707, y: 11.010986, sr: 4326 },
];
for (const b of casos) {
  const t0 = Date.now();
  const d = await ejecutar(b, { log: (m, n) => n === "aviso" && console.log("   !", m) });
  const r = resumir(d);
  console.log(JSON.stringify(b), "→", r.npn, r.direccion, r.area, r.tratamiento, r.viviendas_max, r.pisos_max,
    `capas=${d.cruces.length}`, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const x = dxf(d.lote); const h = informe(d, x);
  console.log("   dxf", x.texto.length, "csv", csv(d).length, "geojson", geojson(d.lote).length, "html", h.length);
}

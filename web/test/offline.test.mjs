// Pruebas sin conexión del motor web:  node --test web/test/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parsearDireccion } from "../js/catastro.js";
import { areaAnillos, centroide, fraccionDentro, muestrear, perimetro, puntoEn, puntoInterior } from "../js/geom.js";
import { evaluarNorma } from "../js/motor.js";
import { calcular, interpretar, setNorma } from "../js/norma.js";
import { csv, dxf, informe } from "../js/salidas.js";

setNorma(JSON.parse(readFileSync(new URL("../norma_edificabilidad_baq.json", import.meta.url))));
const CUADRADO = [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]];
const CON_HUECO = [...CUADRADO, [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]];

test("interpreta los dominios de la capa de tratamientos", () => {
  const casos = {
    "Consolidacion Nivel 2 11": ["CONSOLIDACION", "2"], "CSD Consolidacion Nivel 1A": ["CONSOLIDACION", "1A"],
    "Consolidacion Especial": ["CONSOLIDACION", "ESPECIAL"],
    "MI Mejoramiento Integral Mejoramiento Integral 2": ["MEJORAMIENTO INTEGRAL", "2"],
    "Renovación Urbana Reactivación": ["RENOVACION", "REACTIVACION"],
    "CSV Conservacion Sector Normativo 2": [null, null],
  };
  for (const [t, esperado] of Object.entries(casos)) assert.deepEqual(interpretar(t), esperado, t);
});

test("calcula densidad y altura como la versión de escritorio", () => {
  let r = calcular("CONSOLIDACION", "2", 3000);
  assert.deepEqual([r.base.viviendas_max, r.base.altura_pisos, r.maxima.viviendas_max, r.maxima.altura_pisos], [60, 2, 150, 8]);
  r = calcular("MEJORAMIENTO INTEGRAL", "2", 484.2);
  assert.deepEqual([r.base.viviendas_max, r.maxima.viviendas_max], [4, 5]);
  r = calcular("RENOVACION", "REACTIVACION", 6148);
  assert.equal(r.maxima.altura_pisos, 40);
  assert.match(r.maxima.nota, /Plan Zonal/);
  assert.equal(calcular("CONSOLIDACION", "2", 600).maxima.rango, "Hasta 600 m²");
  assert.ok(calcular("CONSOLIDACION", "9", 100).error);
});

test("geometría", () => {
  assert.equal(areaAnillos(CUADRADO), 100);
  assert.equal(areaAnillos(CON_HUECO), 96);
  assert.equal(perimetro(CUADRADO), 40);
  assert.deepEqual(centroide(CUADRADO), [5, 5]);
  assert.ok(puntoEn(1, 1, CON_HUECO) && !puntoEn(3, 3, CON_HUECO));
  const f = fraccionDentro(muestrear(CUADRADO, 2500), [[[0, 0], [0, 10], [5, 10], [5, 0], [0, 0]]]);
  assert.ok(Math.abs(f - 0.5) < 0.02);
  const u = [[[0, 0], [0, 10], [3, 10], [3, 3], [7, 3], [7, 10], [10, 10], [10, 0], [0, 0]]];
  assert.ok(puntoEn(...puntoInterior(u), u));
});

test("direcciones", () => {
  const d = parsearDireccion("Cra 59 # 64-221");
  assert.deepEqual([d.clase, d.via, d.gen, d.placa], ["Carrera", "59", "64", "221"]);
  assert.deepEqual([parsearDireccion("calle 14d 45f 23").letra, parsearDireccion("calle 14d 45f 23").letra_gen], ["D", "F"]);
  assert.equal(parsearDireccion("Av. Carrera 38 No. 70-15").clase, "Avenida_Carrera");
  assert.equal(parsearDireccion("Edificio Las Palmas"), null);
});

test("norma unifica capas repetidas e ignora franjas", () => {
  const cruces = [
    { titulo: "TRATAMIENTOS URBANISTICOS", url: "u1", grupo: "POT", elementos: [
      { fraccion: 0.97, texto: "Consolidacion Nivel 2", atributos: [] },
      { fraccion: 0.01, texto: "Consolidacion Nivel 3", atributos: [] }] },
    { titulo: "TRATAMIENTOS URBANISTICOS _ Tipo", url: "u2", grupo: "POT", elementos: [
      { fraccion: 0.97, texto: "Consolidacion Nivel 2", atributos: [] }] },
  ];
  const n = evaluarNorma(cruces, 3000);
  assert.equal(n.length, 1);
  assert.equal(n[0].fraccion, 0.97);
  assert.ok(n[0].principal);
});

test("salidas", () => {
  const lote = { npn: "0800", rings: CUADRADO, construcciones: [{ rings: [[[1, 1], [1, 4], [4, 4], [4, 1], [1, 1]]], atributos: [], area: 9, pisos: 1 }],
    area: 100, perimetro: 40, cx: 5, cy: 5, direcciones: ["Calle 1 # 2-3"], terreno_attrs: [], predio_attrs: [], manzana: null, n_predios: 1, area_oficial: null };
  const d = dxf(lote, { local: true });
  assert.deepEqual([d.ox, d.oy], [5, 5]);
  assert.match(d.texto, /CONSTRUCCIONES/);
  assert.ok(d.texto.trimEnd().endsWith("EOF"));
  const datos = { version: "t", lote, norma: [], cruces: [], avisos: ["<x>"], fecha: new Date().toISOString(), area_norma: 100, area_fuente: "g", fuente_norma: "f", catastro: "c", webmap: "w" };
  assert.match(csv(datos), /AREA_GEOM_M2/);
  const h = informe(datos, d);
  assert.match(h, /&lt;x&gt;/);
  assert.match(h, /<svg/);
});

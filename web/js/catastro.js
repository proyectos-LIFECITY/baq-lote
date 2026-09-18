// Catastro abierto de Barranquilla (Gestor Catastral) y utilidades de formato
import { ErrorLote, sqlTxt } from "./arcgis.js";
import { fraccionDentro, muestrear, puntoInterior } from "./geom.js";
import { normalizar } from "./norma.js";

export const CATASTRO = "https://miciudad.barranquilla.gov.co/gis/rest/services/catastro/datosabiertos/MapServer";
export const L = { TERRENO: 315, MANZANA: 320, CONSTRUCCION: 310, DIRECCION: 105, PREDIO: 500, TERRENO_PREDIO: 601 };
export const SR = 9377; // MAGNA-SIRGAS / Origen Nacional (metros)

export const PAT_TECNICO = /^(objectid(_\d+)?|fid(_.*)?|globalid|shape(__|_|\.).*|st_(area|length).*|created_.*|last_edited_.*|rid|.*_guid)$/i;

export function camposDe(info) {
  const out = {};
  for (const c of info.fields || []) {
    const dominio = {};
    for (const v of c.domain?.codedValues || []) dominio[String(v.code)] = v.name;
    out[c.name] = { nombre: c.name, alias: c.alias || c.name, tipo: c.type, dominio };
  }
  return out;
}

export function valorLegible(v, campo) {
  if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return "";
  if (campo) {
    if (campo.dominio && String(v) in campo.dominio) return campo.dominio[String(v)];
    if (campo.tipo === "esriFieldTypeDate" && typeof v === "number") return new Date(v).toISOString().slice(0, 10);
  }
  if (typeof v === "number" && !Number.isInteger(v)) return Math.round(v * 1000) / 1000;
  if (typeof v === "string") return /^[A-Za-zÁÉÍÓÚáéíóúñÑ_ ]+$/.test(v) ? v.replace(/_/g, " ").trim() : v.trim();
  return v;
}

export function legibles(attrs, campos, tecnicos = false) {
  const out = [];
  for (const [k, v] of Object.entries(attrs || {})) {
    if (!tecnicos && PAT_TECNICO.test(k)) continue;
    const c = campos[k] || {};
    const valor = valorLegible(v, c);
    if (valor === "") continue;
    out.push({ campo: k, alias: c.alias || k, valor });
  }
  return out;
}

// ------------------------------------------------------------------ direcciones
const TIPOS_VIA = [
  ["AVENIDA\\s+CARRERA|AV\\.?\\s*(?:KR|CRA|CR|CARRERA)|AK", "Avenida_Carrera"],
  ["CARRERA|CRA|KRA|KR|CR|CRR", "Carrera"],
  ["CALLE|CLL|CL|CALL", "Calle"],
  ["DIAGONAL|DG|DIAG", "Diagonal"],
  ["TRANSVERSAL|TV|TR|TRANSV", "Transversal"],
  ["CIRCUNVALAR|CIRCUNV", "Circunvalar"],
  ["CIRCULAR|CQ|CIRC", "Circular"],
  ["AVENIDA|AV|AVE", "Avenida"],
  ["VIA", "Via"],
];

/** "Cra 59 # 64-221" -> {clase: "Carrera", via: "59", letra: null, gen: "64", letra_gen: null, placa: "221"} */
export function parsearDireccion(texto) {
  let t = normalizar(texto).replace(/N°|NO\.|#/g, " ");
  t = t.replace(/\bNO\b|\bNRO\.?|\bNUM\.?|\bNUMERO\b/g, " ").replace(/[-,.]/g, " ");
  t = t.replace(/(\d)([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
  for (const [pat, clase] of TIPOS_VIA) {
    const m = t.match(new RegExp(`^(?:${pat})\\s*(\\d+)\\s*([A-Z])?\\s*(?:BIS\\s*)?(\\d+)\\s*([A-Z])?\\s*(?:BIS\\s*)?(\\d+)\\b`));
    if (m) return { clase, via: String(+m[1]), letra: m[2] || null, gen: String(+m[3]), letra_gen: m[4] || null, placa: m[5] };
  }
  return null;
}

// ------------------------------------------------------------------ consultas
export class Catastro {
  constructor(cli, base = CATASTRO) {
    this.cli = cli;
    this.base = base.replace(/\/$/, "");
    this._campos = {};
  }

  url(lid) { return `${this.base}/${lid}`; }

  async campos(lid) {
    if (!this._campos[lid]) {
      try {
        this._campos[lid] = camposDe(await this.cli.info(this.url(lid)));
      } catch (e) {
        if (lid !== L.PREDIO) throw e;
        this._campos[lid] = {};
      }
    }
    return this._campos[lid];
  }

  q(lid, params) { return this.cli.features(this.url(lid), params); }

  /** Consulta a la tabla Predio; el catastro a veces la retira del servicio público. */
  async qPredio(params) {
    if (this.sinPredios) return [];
    try {
      return await this.q(L.PREDIO, params);
    } catch (e) {
      if (!/not found|no existe|invalid/i.test(e.message)) throw e;
      this.sinPredios = true;
      this.cli.log("La tabla Predio no está disponible hoy en el catastro; se continúa solo con el terreno.", "aviso");
      return [];
    }
  }

  async terrenoPorRef(ref) {
    const dig = String(ref).replace(/\D/g, "");
    if (!dig) throw new ErrorLote("La referencia catastral debe contener dígitos.");
    const t = await this.q(L.TERRENO, { where: `name = ${sqlTxt(dig)}` });
    if (t.length) return [t[0], null];
    // Sin OR entre textos: el firewall del servidor lo confunde con inyección SQL
    const campos = ["numero_predial_nacional", "numero_predial_anterior"];
    let predios = [];
    for (const c of campos) predios.push(...await this.qPredio({ where: `${c} = ${sqlTxt(dig)}` }));
    if (!predios.length && dig.length >= 8) {
      this.cli.log(`Sin coincidencia exacta; buscando referencias que empiecen por ${dig}…`);
      for (const c of campos)
        predios.push(...await this.qPredio({ where: `${c} LIKE ${sqlTxt(dig + "%")}`, resultRecordCount: 20 }));
      predios = [...new Map(predios.map((p) => [p.attributes.globalid, p])).values()];
      if (!predios.length) {
        // Sin tabla Predio (o sin coincidencias): se busca el prefijo en los terrenos
        const ts = await this.q(L.TERRENO, { where: `name LIKE ${sqlTxt(dig + "%")}`, resultRecordCount: 20 });
        if (ts.length === 1) return [ts[0], null];
        if (ts.length > 1) {
          const err = new ErrorLote(`La referencia es ambigua (${ts.length}+ terrenos). Elige uno de la lista.`);
          err.opciones = ts.map((t) => t.attributes.name);
          throw err;
        }
      }
      if (predios.length > 1) {
        const err = new ErrorLote(`La referencia es ambigua (${predios.length}+ predios). Elige uno de la lista.`);
        err.opciones = predios.slice(0, 20).map((p) => p.attributes.numero_predial_nacional);
        throw err;
      }
    }
    if (!predios.length)
      throw new ErrorLote(`No se encontró ningún lote con la referencia ${dig}.` + (this.sinPredios
        ? " Hoy el catastro solo permite buscar por el número predial nacional del terreno (30 dígitos); prueba con la dirección o el mapa." : ""));
    const terreno = await this.terrenoDePredio(predios[0].attributes.globalid);
    if (!terreno) throw new ErrorLote("El predio no tiene terreno asociado en la cartografía.");
    return [terreno, predios[0]];
  }

  async terrenoDePredio(predioGid) {
    for (const r of await this.q(L.TERRENO_PREDIO, { where: `cr_predio_guid = ${sqlTxt(predioGid)}` })) {
      const t = await this.q(L.TERRENO, { where: `globalid = ${sqlTxt(r.attributes.cr_terreno_guid)}` });
      if (t.length) return t[0];
    }
    return null;
  }

  async terrenoPorPunto(x, y, sr) {
    const t = await this.q(L.TERRENO, {
      geometry: `${x},${y}`, geometryType: "esriGeometryPoint", inSR: sr, spatialRel: "esriSpatialRelIntersects",
    });
    if (!t.length) throw new ErrorLote("No hay ningún terreno catastral en ese punto (puede ser vía o espacio público).");
    return t[0];
  }

  async terrenoPorDireccion(texto) {
    const d = parsearDireccion(texto);
    let dirs;
    if (d) {
      this.cli.log(`Dirección interpretada: ${d.clase.replace("_", " ")} ${d.via}${d.letra || ""} # ${d.gen}${d.letra_gen || ""} - ${d.placa}`);
      // Consulta corta (el firewall bloquea filtros largos); letras y placa se filtran aquí
      dirs = await this.q(L.DIRECCION, {
        where: `valor_via_principal = ${sqlTxt(d.via)} AND valor_via_generadora = ${sqlTxt(d.gen)}`,
        resultRecordCount: 2000,
      });
      const placa = d.placa.replace(/^0+/, "") || "0";
      const letra = (v) => (v || "").trim().toUpperCase() || null;
      dirs = dirs.filter(({ attributes: a }) => a.clase_via_principal === d.clase
        && ((a.numero_predio || "").replace(/^0+/, "") || "0") === placa
        && (!d.letra || letra(a.letra_via_principal) === d.letra)
        && (!d.letra_gen || letra(a.letra_via_generadora) === d.letra_gen));
      const clave = ({ attributes: a }) => [
        !!a.letra_via_principal !== !!d.letra, !!a.letra_via_generadora !== !!d.letra_gen,
        !!a.complemento, -(a.es_direccion_principal || 0)].map(Number);
      // sin letra en la búsqueda: primero las direcciones que tampoco tienen letra
      dirs.sort((p, q) => {
        const a = clave(p), b = clave(q);
        const i = a.findIndex((v, k) => v !== b[k]);
        return i < 0 ? 0 : a[i] - b[i];
      });
    } else {
      this.cli.log("No se reconoció el formato; buscando el texto tal cual…");
      dirs = await this.q(L.DIRECCION, { where: `UPPER(nombre_predio) LIKE ${sqlTxt("%" + normalizar(texto) + "%")}`, resultRecordCount: 20 });
    }
    if (!dirs.length)
      throw new ErrorLote(`No se encontró la dirección "${texto}". Usa el formato "Carrera 59 # 64-221" o busca en el mapa.`);
    const nombres = [...new Set(dirs.map((f) => f.attributes.nombre_predio))];
    if (nombres.length > 1) this.cli.log(`${nombres.length} direcciones coinciden (${nombres.slice(0, 4).join("; ")}); se usa la primera.`, "aviso");
    for (const { attributes: a } of dirs) {
      if (a.cr_terreno_guid) {
        const t = await this.q(L.TERRENO, { where: `globalid = ${sqlTxt(a.cr_terreno_guid)}` });
        if (t.length) return t[0];
      }
      if (a.cr_predio_guid) {
        const t = await this.terrenoDePredio(a.cr_predio_guid);
        if (t) return t;
      }
    }
    throw new ErrorLote("La dirección existe pero no está asociada a un terreno en la cartografía.");
  }

  async geometria(lid, oid, sr) {
    const f = await this.q(lid, { where: `objectid = ${oid}`, returnGeometry: "true", outSR: sr, outFields: "objectid" });
    return f[0]?.geometry?.rings || null;
  }

  async prediosDeTerreno(terrenoGid) {
    const gids = (await this.q(L.TERRENO_PREDIO, { where: `cr_terreno_guid = ${sqlTxt(terrenoGid)}` }))
      .map((r) => r.attributes.cr_predio_guid);
    const predios = [];
    for (let i = 0; i < gids.length; i += 50)
      predios.push(...await this.qPredio({ where: `globalid IN (${gids.slice(i, i + 50).map(sqlTxt).join(", ")})` }));
    return predios;
  }

  async direcciones(terrenoGid, predioGid) {
    const outFields = "nombre_predio,es_direccion_principal";
    const feats = await this.q(L.DIRECCION, { where: `cr_terreno_guid = ${sqlTxt(terrenoGid)}`, outFields });
    if (predioGid) feats.push(...await this.q(L.DIRECCION, { where: `cr_predio_guid = ${sqlTxt(predioGid)}`, outFields }));
    feats.sort((a, b) => (b.attributes.es_direccion_principal || 0) - (a.attributes.es_direccion_principal || 0));
    return [...new Set(feats.map((f) => f.attributes.nombre_predio).filter(Boolean))];
  }

  async construcciones(rings) {
    const feats = await this.q(L.CONSTRUCCION, {
      geometry: JSON.stringify({ rings, spatialReference: { wkid: SR } }), geometryType: "esriGeometryPolygon",
      inSR: SR, spatialRel: "esriSpatialRelIntersects", returnGeometry: "true", outSR: SR,
    });
    return feats.filter((f) => f.geometry?.rings && fraccionDentro(muestrear(f.geometry.rings, 150), rings) >= 0.5);
  }

  async manzana(rings) {
    const [x, y] = puntoInterior(rings);
    const f = await this.q(L.MANZANA, {
      geometry: `${x},${y}`, geometryType: "esriGeometryPoint", inSR: SR,
      spatialRel: "esriSpatialRelIntersects", outFields: "codigo,nombre",
    });
    return f[0]?.attributes || null;
  }
}

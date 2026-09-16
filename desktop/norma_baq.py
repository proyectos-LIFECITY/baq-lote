# -*- coding: utf-8 -*-
"""
Norma de edificabilidad Barranquilla - Tratamientos de Renovación,
Mejoramiento Integral y Consolidación (tabla suministrada por Life City).
Densidad en viviendas por m² de área de predio. Altura en pisos.
Rangos: (área máxima inclusiva en m², densidad, pisos); None = sin límite superior.

Si existe norma_edificabilidad_baq.json junto al programa (o al .exe), la tabla
se carga desde ese archivo: así se puede actualizar la norma sin recompilar.
"""
import json
import math
import os
import re
import sys
import unicodedata

NOTA_ESPECIAL = "Ver artículos 350 y 353 del decreto"
ARCHIVO_JSON = "norma_edificabilidad_baq.json"

NORMA = {
    ("RENOVACION", "REACTIVACION"): {
        "base":   [(600, .010, 2), (800, .012, 2), (3000, .020, 2), (None, .020, 2)],
        "maxima": [(600, .012, 3), (800, .040, 5), (3000, .060, 8), (None, .070, 40)],
        "nota_maxima_ultimo": "Mayor a 3000 m²: solo cuando lo autorice el Plan Zonal",
    },
    ("RENOVACION", "REDESARROLLO"): {
        "texto_base": "Conforme al Plan Parcial",
        "texto_maxima": "Conforme al Plan Parcial hasta máximo 40 pisos",
    },
    ("MEJORAMIENTO INTEGRAL", "1"): {
        "base":   [(600, .010, 5), (None, .012, 5)],
        "maxima": [(600, .012, 5), (None, .040, 5)],
    },
    ("MEJORAMIENTO INTEGRAL", "2"): {
        "base":   [(600, .010, 5), (800, .012, 5), (None, .020, 5)],
        "maxima": [(600, .012, 5), (800, .040, 5), (None, .050, 8)],
    },
    ("CONSOLIDACION", "1A"): {
        "base":   [(None, .010, 2)],
        "maxima": [(None, .010, 2)],
    },
    ("CONSOLIDACION", "1B"): {
        "base":   [(600, .010, 2), (None, .012, 2)],
        "maxima": [(600, .012, 3), (None, .040, 5)],
    },
    ("CONSOLIDACION", "2"): {
        "base":   [(600, .010, 2), (800, .012, 2), (4000, .020, 2), (None, .020, 2)],
        "maxima": [(600, .012, 3), (800, .040, 5), (4000, .050, 8), (None, .050, 11)],
    },
    ("CONSOLIDACION", "3"): {
        "base":   [(600, .010, 2), (800, .012, 2), (2000, .020, 2), (None, .020, 2)],
        "maxima": [(600, .012, 3), (800, .040, 5), (2000, .050, 8), (None, .060, 16)],
    },
    ("CONSOLIDACION", "ESPECIAL"): {
        "texto_base": NOTA_ESPECIAL,
        "texto_maxima": NOTA_ESPECIAL,
    },
}
FUENTE_NORMA = "tabla interna"


def _rutas_json():
    dirs = [os.path.dirname(os.path.abspath(sys.argv[0] or ".")),
            os.path.dirname(os.path.abspath(__file__)), os.getcwd()]
    if getattr(sys, "_MEIPASS", None):
        dirs.append(sys._MEIPASS)
    return [os.path.join(d, ARCHIVO_JSON) for d in dict.fromkeys(dirs)]


def cargar_json(ruta):
    """Convierte el JSON {"TRAT|NIVEL": {...}} al formato de NORMA."""
    with open(ruta, encoding="utf-8") as fh:
        crudo = json.load(fh)
    tabla = {}
    for clave, regla in crudo.items():
        trat, _, niv = clave.partition("|")
        r = dict(regla)
        for esc in ("base", "maxima"):
            if esc in r:
                r[esc] = [tuple(x) for x in r[esc]]
        tabla[(trat.strip().upper(), niv.strip().upper())] = r
    return tabla


for _ruta in _rutas_json():
    if os.path.isfile(_ruta):
        try:
            NORMA = cargar_json(_ruta)
            FUENTE_NORMA = _ruta
        except (OSError, ValueError, TypeError) as _e:
            print("Aviso: no se pudo leer %s (%s); se usa la tabla interna." % (_ruta, _e))
        break


def _norm(t):
    t = unicodedata.normalize("NFKD", str(t or "")).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", t.upper()).strip()


def interpretar(texto):
    """Devuelve (tratamiento, nivel) a partir de cualquier texto de atributos."""
    t = _norm(texto)
    if "RENOVACION" in t or "REACTIVACION" in t or "REDESARROLLO" in t:
        trat = "RENOVACION"
    elif "MEJORAMIENTO" in t:
        trat = "MEJORAMIENTO INTEGRAL"
    elif "CONSOLIDACION" in t:
        trat = "CONSOLIDACION"
    else:
        return None, None
    if trat == "RENOVACION":
        if "REDESARROLLO" in t:
            return trat, "REDESARROLLO"
        if "REACTIVACION" in t:
            return trat, "REACTIVACION"
        return trat, None
    if trat == "MEJORAMIENTO INTEGRAL":
        m = re.search(r"MEJORAMIENTO INTEGRAL\s*[-_:]?\s*(?:NIVEL\s*)?([12])\b", t)
        if m:
            return trat, m.group(1)
    if "ESPECIAL" in t:
        return trat, "ESPECIAL"
    m = re.search(r"\b(?:NIVEL|NIV\.?|N)\s*[-_:]?\s*(1\s*[AB]|[123])\b", t) or \
        re.search(r"\b(1\s*[AB])\b", t)
    niv = re.sub(r"\s", "", m.group(1)) if m else None
    return trat, niv


def _rango(tabla, area):
    for i, (tope, dens, pisos) in enumerate(tabla):
        if tope is None or area <= tope:
            ant = tabla[i - 1][0] if i else 0
            txt = ("Todos" if len(tabla) == 1 else
                   "Hasta %d m²" % tope if i == 0 else
                   "Mayor a %d m²" % ant if tope is None else
                   "Entre %d y %d m²" % (ant + 1, tope))
            return i, txt, dens, pisos
    # área mayor que el último tope cerrado: se usa el último rango
    tope, dens, pisos = tabla[-1]
    return len(tabla) - 1, "Mayor a %d m²" % tope, dens, pisos


def calcular(tratamiento, nivel, area_m2):
    """Norma base y máxima para un predio. Viviendas redondeadas hacia abajo."""
    regla = NORMA.get((tratamiento, nivel))
    out = {"tratamiento": tratamiento, "nivel": nivel, "area_m2": area_m2}
    if regla is None:
        out["error"] = "Combinación tratamiento/nivel no encontrada en la tabla"
        return out
    for esc in ("base", "maxima"):
        if "texto_" + esc in regla:
            out[esc] = {"nota": regla["texto_" + esc]}
            continue
        tabla = regla[esc]
        i, rango, dens, pisos = _rango(tabla, area_m2)
        viv = dens * area_m2
        d = {"rango": rango, "densidad_viv_m2": dens, "altura_pisos": pisos,
             "viviendas_calculadas": round(viv, 2),
             "viviendas_max": int(math.floor(viv + 1e-9))}
        if esc == "maxima" and i == len(tabla) - 1 and regla.get("nota_maxima_ultimo"):
            d["nota"] = regla["nota_maxima_ultimo"]
        out[esc] = d
    return out

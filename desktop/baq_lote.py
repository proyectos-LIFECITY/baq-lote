# -*- coding: utf-8 -*-
"""
BAQ LOTE - Extractor catastral y normativo de lotes en Barranquilla
Life City BIM Management Hub

Consulta las fuentes públicas que usa hoy el geovisor Panorama Urbano
(Secretaría de Planeación de Barranquilla):
  - Catastro abierto (Gestor Catastral):  terreno, predio, dirección, construcciones
  - WebMap Panorama Urbano (ArcGIS Online): tratamientos, usos, amenazas, IPT, etc.

y genera, para UN lote:
  - lote.dxf            polígono + construcciones en metros (MAGNA-SIRGAS Origen Nacional, EPSG 9377)
  - lote.geojson        lote + construcciones en WGS84 (QGIS / Google Earth / web)
  - atributos.csv       atributos del lote + capas que lo intersectan (separador ;)
  - informe.html        ficha legible: plano, catastro, norma, densidad y altura
  - resumen.json        todo lo anterior en formato estructurado
  - capas_servicio.json inventario de capas y campos consultados

Uso:
  python baq_lote.py                                   -> interfaz gráfica
  python baq_lote.py --descubrir                       -> solo inventario de capas
  python baq_lote.py --ref 080010101000003070025900000000
  python baq_lote.py --dir "Carrera 59 # 64-221"
  python baq_lote.py --x -74.7825 --y 10.9985          (WGS84)
  python baq_lote.py --x 4803930 --y 2773900 --sr 9377

Requisitos: Python 3.9+ y  pip install requests
"""
import argparse
import csv
import datetime as dt
import html
import json
import math
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

try:
    import norma_baq
except ImportError:
    print("Falta norma_baq.py junto a baq_lote.py")
    sys.exit(1)

try:
    import requests
except ImportError:
    print("Falta la librería 'requests'. Instala con:  pip install requests")
    sys.exit(1)

VERSION = "2.0"
CATASTRO = "https://miciudad.barranquilla.gov.co/gis/rest/services/catastro/datosabiertos/MapServer"
WEBMAP = "d2af7ac624fe413ca6f14cbbe2b0183d"          # WebMap del geovisor Panorama Urbano
PORTAL = "https://www.arcgis.com/sharing/rest/content/items/%s/data"
L_TERRENO, L_MANZANA, L_CONSTRUCCION, L_DIRECCION = 315, 320, 310, 105
T_PREDIO, T_TERRENO_PREDIO = 500, 601
SR = 9377                                             # MAGNA-SIRGAS / Origen Nacional (metros)

PAUSA = float(os.environ.get("BAQ_PAUSA", 0.15))      # segundos entre peticiones (uso moderado)
HILOS = int(os.environ.get("BAQ_HILOS", 4))
TIMEOUT = 45
MIN_FRACCION_NORMA = 0.02                             # tratamientos que cubren menos del 2% se ignoran

# Capas normativas de respaldo si no se puede leer el WebMap
_S3 = "https://services3.arcgis.com/oGYAc07w6wsvgUYr/arcgis/rest/services/"
CAPAS_RESPALDO = [
    ("POT Urbano 2014", "TRATAMIENTOS URBANISTICOS", _S3 + "TRATAMIENTOS_URBANISTICOS_2024/FeatureServer/0"),
    ("POT Urbano 2014", "ACTIVIDAD USOS URBANOS _ Tipo Poligono", _S3 + "ACTIVIDAD_USOS_URBANOS___Tipo_Poligono/FeatureServer/0"),
    ("POT Urbano 2014", "ACTIVIDAD USOS URBANOS _ Actividades", _S3 + "ACTIVIDAD_USOS_URBANOS___Actividades/FeatureServer/0"),
    ("POT Urbano 2014", "ALINEAMIENTO", _S3 + "Alineamiento_Bq/FeatureServer/0"),
    ("POT Urbano 2014", "Estratificacion 1994", _S3 + "Estrato1994_Panorama/FeatureServer/0"),
    ("Instrumentos de Planificación", "Tipo_IPT", _S3 + "Tipo_IPT/FeatureServer/0"),
    ("Instrumentos de Planificación", "Planes Parciales", _S3 + "POT_IPT_Planes_Parciales/FeatureServer/1"),
    ("Instrumentos de Planificación", "Area Patrimonial", _S3 + "AreaPatrimonial/FeatureServer/0"),
    ("Instrumentos de Planificación", "PEMP_Prado", _S3 + "PEMP_Prado/FeatureServer/0"),
    ("Amenaza y Riesgo", "Amenaza por Inundación", _S3 + "Inundaci%C3%B3n2024/FeatureServer/0"),
    ("Espacio Público", "Suelos de Protección", _S3 + "SUELOS_DE_PROTECCI%C3%93N_/FeatureServer/0"),
    ("POT General 2014", "CLASIFICACIÓN DEL SUELO - Tipo", _S3 + "CLASIFICACI%C3%93N_DEL_SUELO/FeatureServer/0"),
    ("Básicas", "Piezas Urbanas", _S3 + "Piezas_URBANAS/FeatureServer/0"),
    ("Básicas", "LIM_Barrio", _S3 + "LIM_Barrio/FeatureServer/0"),
    ("Básicas", "LIM_Localidad", _S3 + "LIM_Localidad/FeatureServer/0"),
]

PAT_TECNICO = re.compile(r"^(objectid(_\d+)?|fid(_.*)?|globalid|shape(__|_|\.).*|st_(area|length).*|"
                         r"created_.*|last_edited_.*|rid|.*_guid)$", re.I)
PAT_TRATAMIENTO = re.compile(r"tratam", re.I)
TIPOS_VIA = [
    (r"AVENIDA\s+CARRERA|AV\.?\s*(?:KR|CRA|CR|CARRERA)|AK", "Avenida_Carrera"),
    (r"CARRERA|CRA|KRA|KR|CR|CRR", "Carrera"),
    (r"CALLE|CLL|CL|CALL", "Calle"),
    (r"DIAGONAL|DG|DIAG", "Diagonal"),
    (r"TRANSVERSAL|TV|TR|TRANSV", "Transversal"),
    (r"CIRCUNVALAR|CIRCUNV", "Circunvalar"),
    (r"CIRCULAR|CQ|CIRC", "Circular"),
    (r"AVENIDA|AV|AVE", "Avenida"),
    (r"VIA", "Via"),
]


class ErrorLote(RuntimeError):
    pass


# --------------------------------------------------------------------------- #
#  Cliente ArcGIS REST
# --------------------------------------------------------------------------- #
class ArcGIS:
    def __init__(self, verificar_ssl=True, log=print):
        self.s = requests.Session()
        self.s.headers["User-Agent"] = "LifeCity-BAQ-Lote/%s" % VERSION
        self.s.verify = verificar_ssl
        self.log = log
        self.bloqueados = set()
        self._lock = threading.Lock()
        if not verificar_ssl:
            requests.packages.urllib3.disable_warnings()

    def _req(self, url, params, post=False, reintentos=3):
        host = urlparse(url).netloc
        if host in self.bloqueados:
            raise ErrorLote("servidor %s no disponible" % host)
        params = dict(params, f="json")
        for i in range(reintentos):
            try:
                time.sleep(PAUSA)
                r = (self.s.post(url, data=params, timeout=TIMEOUT) if post
                     else self.s.get(url, params=params, timeout=TIMEOUT))
                if "json" not in r.headers.get("content-type", "") and r.text.lstrip()[:1] != "{":
                    if "Just a moment" in r.text[:600] or r.status_code >= 500:
                        # Reto anti-bots de Cloudflare o servidor caído: no se atienden clientes automáticos
                        with self._lock:
                            if host not in self.bloqueados:
                                self.bloqueados.add(host)
                                self.log("  ! %s responde HTTP %s sin JSON (protección anti-bots o caído); "
                                         "se omiten sus capas." % (host, r.status_code))
                        raise ErrorLote("servidor %s no disponible" % host)
                    raise ErrorLote("%s rechazó la consulta (HTTP %s, firewall)" % (host, r.status_code))
                data = r.json()
                if "error" in data:
                    err = data["error"]
                    raise ErrorLote("%s %s" % (err.get("message", err), " ".join(err.get("details") or [])))
                return data
            except requests.exceptions.SSLError:
                raise ErrorLote("Error de certificado SSL. Reintenta con la opción 'Ignorar SSL' (--inseguro).")
            except (requests.ConnectionError, requests.Timeout, ValueError) as e:
                if i == reintentos - 1:
                    raise ErrorLote("Sin conexión con %s: %s" % (host, e))
                time.sleep(2 * (i + 1))

    def info(self, url):
        return self._req(url, {})

    def query(self, url, **kw):
        p = {"outFields": "*", "returnGeometry": "false"}
        p.update({k: v for k, v in kw.items() if v is not None})
        return self._req(url.rstrip("/") + "/query", p, post=True)

    def features(self, url, **kw):
        return self.query(url, **kw).get("features") or []


def sql_txt(v):
    return "'%s'" % str(v).replace("'", "''")


# --------------------------------------------------------------------------- #
#  Geometría (sin dependencias)
# --------------------------------------------------------------------------- #
def _abierto(r):
    return r[:-1] if len(r) > 1 and r[0][:2] == r[-1][:2] else r


def area_firmada(r):
    pts = _abierto(r)
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1])) / 2.0


def area_anillos(rings):
    """Área neta: ArcGIS usa anillos exteriores horarios (área firmada negativa) y huecos antihorarios."""
    return abs(sum(-area_firmada(r) for r in rings))


def perimetro(rings):
    return sum(math.dist(a[:2], b[:2]) for r in rings
               for a, b in zip(_abierto(r), _abierto(r)[1:] + _abierto(r)[:1]))


def centroide(rings):
    """Centroide de área del polígono (con huecos); promedio de vértices si es degenerado."""
    sx = sy = sa = 0.0
    for r in rings:
        pts = _abierto(r)
        for a, b in zip(pts, pts[1:] + pts[:1]):
            c = a[0] * b[1] - b[0] * a[1]
            sx += (a[0] + b[0]) * c
            sy += (a[1] + b[1]) * c
            sa += c
    if abs(sa) < 1e-9:
        pts = [p for r in rings for p in _abierto(r)]
        return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
    return (sx / (3 * sa), sy / (3 * sa))


def bbox(rings):
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    return min(xs), min(ys), max(xs), max(ys)


def punto_en(x, y, rings):
    """Regla par-impar sobre todos los anillos (respeta huecos)."""
    dentro = False
    for r in rings:
        pts = _abierto(r)
        j = len(pts) - 1
        for i in range(len(pts)):
            xi, yi = pts[i][:2]
            xj, yj = pts[j][:2]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                dentro = not dentro
            j = i
    return dentro


def muestrear(rings, n=1600):
    """Malla regular de puntos dentro del polígono (para calcular superposiciones)."""
    x0, y0, x1, y1 = bbox(rings)
    area_bb = max((x1 - x0) * (y1 - y0), 1e-12)
    paso = math.sqrt(area_bb / n)
    pts, y = [], y0 + paso / 2
    while y < y1:
        x = x0 + paso / 2
        while x < x1:
            if punto_en(x, y, rings):
                pts.append((x, y))
            x += paso
        y += paso
    return pts or [centroide(rings)]


def fraccion_dentro(puntos, rings):
    if not puntos:
        return 0.0
    x0, y0, x1, y1 = bbox(rings)
    n = sum(1 for x, y in puntos if x0 <= x <= x1 and y0 <= y <= y1 and punto_en(x, y, rings))
    return n / len(puntos)


def punto_interior(rings):
    c = centroide(rings)
    if punto_en(c[0], c[1], rings):
        return c
    pts = muestrear(rings, 400)
    return min(pts, key=lambda p: math.dist(p, c))


def lados(rings):
    """Longitud y punto medio de cada lado del anillo exterior."""
    pts = _abierto(rings[0])
    return [{"desde": i + 1, "hasta": (i + 1) % len(pts) + 1, "longitud": math.dist(a[:2], b[:2]),
             "medio": ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)}
            for i, (a, b) in enumerate(zip(pts, pts[1:] + pts[:1]))]


# --------------------------------------------------------------------------- #
#  Formato de valores
# --------------------------------------------------------------------------- #
def campos_de(info):
    return {c["name"]: {"nombre": c["name"], "alias": c.get("alias") or c["name"], "tipo": c.get("type"),
                        "dominio": {str(v["code"]): v["name"]
                                    for v in (c.get("domain") or {}).get("codedValues") or []}}
            for c in info.get("fields") or []}


def valor_legible(v, campo):
    if v is None or (isinstance(v, str) and not v.strip()):
        return ""
    if campo:
        dom = campo.get("dominio") or {}
        if str(v) in dom:
            return dom[str(v)]
        if campo.get("tipo") == "esriFieldTypeDate" and isinstance(v, (int, float)):
            fecha = dt.datetime(1970, 1, 1) + dt.timedelta(milliseconds=v)
            return fecha.strftime("%Y-%m-%d")
    if isinstance(v, float):
        return round(v, 3)
    if isinstance(v, str):
        return v.replace("_", " ").strip() if re.fullmatch(r"[A-Za-zÁÉÍÓÚáéíóúñÑ_ ]+", v) else v.strip()
    return v


def legibles(attrs, campos, tecnicos=False):
    out = []
    for k, v in attrs.items():
        if not tecnicos and PAT_TECNICO.match(k):
            continue
        c = campos.get(k) or {}
        val = valor_legible(v, c)
        if val == "":
            continue
        out.append({"campo": k, "alias": c.get("alias") or k, "valor": val})
    return out


# --------------------------------------------------------------------------- #
#  Direcciones
# --------------------------------------------------------------------------- #
def parsear_direccion(texto):
    """'Cra 59 # 64-221' -> {'clase': 'Carrera', 'via': '59', 'letra': None, 'gen': '64', ...}"""
    t = norma_baq._norm(texto).replace("N°", " ").replace("NO.", " ").replace("#", " ")
    t = re.sub(r"\bNO\b|\bNRO\.?|\bNUM\.?|\bNUMERO\b", " ", t)
    t = re.sub(r"[-,.]", " ", t)
    t = re.sub(r"(\d)([A-Z])", r"\1 \2", t)
    t = re.sub(r"\s+", " ", t).strip()
    for pat, clase in TIPOS_VIA:
        m = re.match(r"(?:%s)\s*(\d+)\s*([A-Z])?\s*(?:BIS\s*)?(\d+)\s*([A-Z])?\s*(?:BIS\s*)?(\d+)\b" % pat, t)
        if m:
            via, letra, gen, letra_gen, placa = m.groups()
            return {"clase": clase, "via": str(int(via)), "letra": letra, "gen": str(int(gen)),
                    "letra_gen": letra_gen, "placa": placa}
    return None


def variantes_numero(n):
    base = str(int(n))
    return list(dict.fromkeys([n, base, base.zfill(2), base.zfill(3)]))


# --------------------------------------------------------------------------- #
#  Catastro
# --------------------------------------------------------------------------- #
class Catastro:
    def __init__(self, cli, base=CATASTRO):
        self.cli, self.base = cli, base.rstrip("/")
        self._campos = {}

    def url(self, lid):
        return "%s/%s" % (self.base, lid)

    def campos(self, lid):
        if lid not in self._campos:
            self._campos[lid] = campos_de(self.cli.info(self.url(lid)))
        return self._campos[lid]

    def q(self, lid, **kw):
        return self.cli.features(self.url(lid), **kw)

    # --- búsqueda de terreno ---------------------------------------------- #
    def terreno_por_ref(self, ref):
        dig = re.sub(r"\D", "", ref)
        if not dig:
            raise ErrorLote("La referencia catastral debe contener dígitos.")
        feats = self.q(L_TERRENO, where="name = %s" % sql_txt(dig))
        if feats:
            return feats[0], None
        # Número predial nacional (30) o anterior (20) en la tabla de predios (p.ej. unidades PH)
        # (sin OR entre textos: el firewall del servidor lo confunde con inyección SQL)
        campos = ("numero_predial_nacional", "numero_predial_anterior")
        predios = [f for c in campos for f in self.q(T_PREDIO, where="%s = %s" % (c, sql_txt(dig)))]
        if not predios and len(dig) >= 8:
            self.cli.log("  Sin coincidencia exacta; buscando referencias que empiecen por %s…" % dig)
            predios = [f for c in campos for f in self.q(T_PREDIO, where="%s LIKE %s" % (c, sql_txt(dig + "%")),
                                                         resultRecordCount=20)]
            predios = list({p["attributes"]["globalid"]: p for p in predios}.values())
            if len(predios) > 1:
                ops = ", ".join(p["attributes"]["numero_predial_nacional"] for p in predios[:10])
                raise ErrorLote("La referencia es ambigua (%d+ predios). Opciones: %s" % (len(predios), ops))
        if not predios:
            raise ErrorLote("No se encontró ningún predio con la referencia %s." % dig)
        predio = predios[0]
        t = self.terreno_de_predio(predio["attributes"]["globalid"])
        if not t:
            raise ErrorLote("El predio %s no tiene terreno asociado en la cartografía."
                            % predio["attributes"]["numero_predial_nacional"])
        return t, predio

    def terreno_de_predio(self, predio_gid):
        rel = self.q(T_TERRENO_PREDIO, where="cr_predio_guid = %s" % sql_txt(predio_gid))
        for r in rel:
            feats = self.q(L_TERRENO, where="globalid = %s" % sql_txt(r["attributes"]["cr_terreno_guid"]))
            if feats:
                return feats[0]
        return None

    def terreno_por_punto(self, x, y, sr):
        feats = self.q(L_TERRENO, geometry="%r,%r" % (x, y), geometryType="esriGeometryPoint",
                       inSR=sr, spatialRel="esriSpatialRelIntersects")
        if not feats:
            raise ErrorLote("No hay ningún terreno catastral en ese punto (X=%s, Y=%s, EPSG %s). "
                            "Revisa el orden X/Y y el sistema de coordenadas." % (x, y, sr))
        return feats[0]

    def terreno_por_direccion(self, texto):
        d = parsear_direccion(texto)
        if d:
            self.cli.log("  Dirección interpretada: %s %s%s # %s%s - %s" % (
                d["clase"].replace("_", " "), d["via"], d["letra"] or "", d["gen"], d["letra_gen"] or "", d["placa"]))
            # Consulta corta (el firewall bloquea filtros largos); letras y placa se filtran aquí
            dirs = self.q(L_DIRECCION, where="valor_via_principal = %s AND valor_via_generadora = %s" % (
                sql_txt(d["via"]), sql_txt(d["gen"])), resultRecordCount=2000)
            placas = {v.lstrip("0") or "0" for v in variantes_numero(d["placa"])}
            letra = lambda v: (v or "").strip().upper() or None
            dirs = [f for f in dirs
                    if f["attributes"].get("clase_via_principal") == d["clase"]
                    and (f["attributes"].get("numero_predio") or "").lstrip("0") in placas
                    and (not d["letra"] or letra(f["attributes"].get("letra_via_principal")) == d["letra"])
                    and (not d["letra_gen"] or letra(f["attributes"].get("letra_via_generadora")) == d["letra_gen"])]
            # sin letra en la búsqueda: primero las direcciones que tampoco tienen letra
            dirs.sort(key=lambda f: (bool(f["attributes"].get("letra_via_principal")) != bool(d["letra"]),
                                     bool(f["attributes"].get("letra_via_generadora")) != bool(d["letra_gen"]),
                                     bool(f["attributes"].get("complemento")),
                                     -(f["attributes"].get("es_direccion_principal") or 0)))
        else:
            self.cli.log("  No se reconoció el formato; buscando el texto tal cual…")
            dirs = self.q(L_DIRECCION, where="UPPER(nombre_predio) LIKE %s" % sql_txt(
                "%" + norma_baq._norm(texto) + "%"), resultRecordCount=20)
        if not dirs:
            raise ErrorLote("No se encontró la dirección '%s' en el catastro. Prueba con el formato "
                            "'Carrera 59 # 64-221' o busca por referencia/coordenadas." % texto)
        nombres = list(dict.fromkeys(f["attributes"]["nombre_predio"] for f in dirs))
        if len(nombres) > 1:
            self.cli.log("  ! %d direcciones coinciden (%s); se usa la primera." % (len(nombres), "; ".join(nombres[:5])))
        for f in dirs:
            a = f["attributes"]
            if a.get("cr_terreno_guid"):
                t = self.q(L_TERRENO, where="globalid = %s" % sql_txt(a["cr_terreno_guid"]))
                if t:
                    return t[0]
            if a.get("cr_predio_guid"):
                t = self.terreno_de_predio(a["cr_predio_guid"])
                if t:
                    return t
        raise ErrorLote("La dirección existe pero no está asociada a un terreno en la cartografía.")

    # --- datos complementarios ------------------------------------------ #
    def geometria(self, lid, oid, sr):
        f = self.q(lid, where="objectid = %d" % oid, returnGeometry="true", outSR=sr, outFields="objectid")
        return (f[0].get("geometry") or {}).get("rings") if f else None

    def predios_de_terreno(self, terreno_gid):
        rel = self.q(T_TERRENO_PREDIO, where="cr_terreno_guid = %s" % sql_txt(terreno_gid))
        gids = [r["attributes"]["cr_predio_guid"] for r in rel]
        predios = []
        for i in range(0, len(gids), 50):
            predios += self.q(T_PREDIO, where="globalid IN (%s)" % ", ".join(sql_txt(g) for g in gids[i:i + 50]))
        return predios

    def direcciones(self, terreno_gid, predio_gid=None):
        feats = self.q(L_DIRECCION, where="cr_terreno_guid = %s" % sql_txt(terreno_gid),
                       outFields="nombre_predio,es_direccion_principal")
        if predio_gid:
            feats += self.q(L_DIRECCION, where="cr_predio_guid = %s" % sql_txt(predio_gid),
                            outFields="nombre_predio,es_direccion_principal")
        feats.sort(key=lambda f: -(f["attributes"].get("es_direccion_principal") or 0))
        return list(dict.fromkeys(f["attributes"]["nombre_predio"] for f in feats
                                  if f["attributes"].get("nombre_predio")))

    def construcciones(self, rings):
        geom = json.dumps({"rings": rings, "spatialReference": {"wkid": SR}})
        feats = self.q(L_CONSTRUCCION, geometry=geom, geometryType="esriGeometryPolygon", inSR=SR,
                       spatialRel="esriSpatialRelIntersects", returnGeometry="true", outSR=SR)
        propias = []
        for f in feats:
            cr = (f.get("geometry") or {}).get("rings")
            if cr and fraccion_dentro(muestrear(cr, 150), rings) >= 0.5:
                propias.append(f)
        return propias

    def manzana(self, rings):
        x, y = punto_interior(rings)
        f = self.q(L_MANZANA, geometry="%r,%r" % (x, y), geometryType="esriGeometryPoint", inSR=SR,
                   spatialRel="esriSpatialRelIntersects", outFields="codigo,nombre")
        return f[0]["attributes"] if f else None


# --------------------------------------------------------------------------- #
#  Capas normativas (WebMap Panorama Urbano)
# --------------------------------------------------------------------------- #
def capas_webmap(cli, item=WEBMAP):
    try:
        d = cli._req(PORTAL % item, {})
    except ErrorLote as e:
        cli.log("  ! No se pudo leer el WebMap de Panorama Urbano (%s); se usan capas de respaldo." % e)
        return [{"grupo": g, "titulo": t, "url": u} for g, t, u in CAPAS_RESPALDO]
    capas, vistos = [], set()

    def recorrer(ls, grupo):
        for l in ls or []:
            if l.get("layers"):
                recorrer(l["layers"], l.get("title") or grupo)
            url = (l.get("url") or "").rstrip("/")
            if (l.get("layerType") == "ArcGISFeatureLayer" and url and url not in vistos
                    and not url.startswith(CATASTRO)):
                vistos.add(url)
                capas.append({"grupo": grupo, "titulo": l.get("title") or url.rsplit("/", 2)[-2], "url": url})
    recorrer(d.get("operationalLayers"), "General")
    return capas


def descubrir(cli, cat, webmap=WEBMAP):
    inv = {"catastro": cat.base, "webmap": webmap, "version": VERSION,
           "consultado": dt.datetime.now().isoformat(timespec="seconds"), "capas": []}
    for lid, nombre in ((L_TERRENO, "Catastro · Terreno"), (L_MANZANA, "Catastro · Manzana"),
                        (L_CONSTRUCCION, "Catastro · Construcción"), (L_DIRECCION, "Catastro · Dirección"),
                        (T_PREDIO, "Catastro · Predio (tabla)")):
        try:
            info = cli.info(cat.url(lid))
            inv["capas"].append(_ficha_capa("Catastro", nombre, cat.url(lid), info))
            cli.log("  [catastro %s] %s" % (lid, info.get("name")))
        except ErrorLote as e:
            cli.log("  ! catastro %s: %s" % (lid, e))

    def ficha(c):
        try:
            return _ficha_capa(c["grupo"], c["titulo"], c["url"], cli.info(c["url"]))
        except ErrorLote as e:
            return dict(c, error=str(e))
    with ThreadPoolExecutor(HILOS) as ex:
        for f in ex.map(ficha, capas_webmap(cli, webmap)):
            inv["capas"].append(f)
            cli.log("  %s %s / %s" % ("!" if "error" in f else "·", f["grupo"], f["titulo"]))
    return inv


def _ficha_capa(grupo, titulo, url, info):
    return {"grupo": grupo, "titulo": titulo, "url": url, "nombre": info.get("name"),
            "geometria": info.get("geometryType"), "maxRecordCount": info.get("maxRecordCount"),
            "campos": list(campos_de(info).values())}


def cruzar_capas(cli, capas, rings, muestras):
    geom = json.dumps({"rings": rings, "spatialReference": {"wkid": SR}})
    area = area_anillos(rings)

    def una(c):
        try:
            feats = cli.features(c["url"], geometry=geom, geometryType="esriGeometryPolygon", inSR=SR,
                                 spatialRel="esriSpatialRelIntersects", returnGeometry="true", outSR=SR,
                                 resultRecordCount=100, geometryPrecision=3)
            if not feats:
                return None
            info = cli.info(c["url"])
        except ErrorLote as e:
            return dict(c, error=str(e))
        campos = campos_de(info)
        elems = []
        for f in feats:
            g = f.get("geometry") or {}
            frac = fraccion_dentro(muestras, g["rings"]) if g.get("rings") else None
            if frac is not None and frac == 0:
                continue                    # solo toca el borde del lote
            elems.append({"fraccion": frac, "area_m2": None if frac is None else frac * area,
                          "attrs": f.get("attributes") or {},
                          "atributos": legibles(f.get("attributes") or {}, campos),
                          "texto": " ".join(str(valor_legible(v, campos.get(k)))
                                            for k, v in (f.get("attributes") or {}).items()
                                            if not PAT_TECNICO.match(k) and "pemp" not in k.lower())})
        if not elems:
            return None
        elems.sort(key=lambda e: -(e["fraccion"] or 0))
        return dict(c, nombre=info.get("name"), geometria=info.get("geometryType"), elementos=elems)

    resultados = []
    with ThreadPoolExecutor(HILOS) as ex:
        for r in ex.map(una, capas):
            if not r:
                continue
            if "error" in r:
                if "no disponible" not in r["error"]:
                    cli.log("  ! %s: %s" % (r["titulo"], r["error"]))
                continue
            partes = ", ".join("%.0f%%" % (100 * e["fraccion"]) for e in r["elementos"] if e["fraccion"] is not None)
            cli.log("  ✓ %s: %d elemento(s)%s" % (r["titulo"], len(r["elementos"]), " (" + partes + ")" if partes else ""))
            resultados.append(r)
    return resultados


def evaluar_norma(cruces, area):
    """Tratamientos que cubren el lote -> densidad y altura según la tabla de edificabilidad."""
    resultados, idx, por_capa = [], {}, {}
    for capa in cruces:
        if not PAT_TRATAMIENTO.search(capa["titulo"] + " " + (capa.get("nombre") or "")):
            continue
        for e in capa["elementos"]:
            if e["fraccion"] is not None and e["fraccion"] < MIN_FRACCION_NORMA:
                continue                    # franja mínima por diferencias de digitalización
            trat, niv = norma_baq.interpretar(e["texto"])
            etiqueta = next((a["valor"] for a in e["atributos"] if re.search(r"tipo", a["campo"], re.I)), "")
            clase = next((a["valor"] for a in e["atributos"] if re.search(r"^trat", a["campo"], re.I)), "")
            altura_capa = next((a["valor"] for a in e["atributos"] if re.search(r"altura", a["campo"], re.I)), "")
            clave = (trat or clase, niv or etiqueta)
            # misma zona en varios polígonos de una capa: se suma; en capas repetidas del WebMap: se toma la mayor
            k = (clave, capa["url"])
            por_capa[k] = por_capa.get(k, 0) + (e["fraccion"] or 0)
            if clave in idx:
                idx[clave]["fraccion"] = max(idx[clave]["fraccion"] or 0, min(por_capa[k], 1.0))
                continue
            if trat and niv:
                res = norma_baq.calcular(trat, niv, area)
            elif trat:
                res = {"tratamiento": trat, "nivel": None, "area_m2": area,
                       "error": "Tratamiento detectado sin nivel (%s); revisa la capa." % etiqueta}
            else:
                res = {"tratamiento": str(clase).upper() or "SIN TRATAMIENTO", "nivel": etiqueta, "area_m2": area,
                       "error": "Tratamiento fuera de la tabla de edificabilidad (Renovación, "
                                "Mejoramiento Integral, Consolidación)."}
            res.update(fuente=capa["titulo"], fraccion=e["fraccion"], altura_capa=altura_capa,
                       etiqueta="%s %s" % (clase, etiqueta))
            idx[clave] = res
            resultados.append(res)
    resultados.sort(key=lambda r: -(r["fraccion"] or 0))
    if resultados:
        resultados[0]["principal"] = True
    return resultados


# --------------------------------------------------------------------------- #
#  Salidas
# --------------------------------------------------------------------------- #
def _dxf_polilinea(L, pts, capa, ox, oy):
    L += ["0", "POLYLINE", "8", capa, "66", "1", "70", "1", "10", "0.0", "20", "0.0", "30", "0.0"]
    for p in _abierto(pts):
        L += ["0", "VERTEX", "8", capa, "10", "%.4f" % (p[0] - ox), "20", "%.4f" % (p[1] - oy), "30", "0.0"]
    L += ["0", "SEQEND", "8", capa]


def _dxf_texto(L, capa, x, y, h, txt, ox, oy, rot=0.0):
    L += ["0", "TEXT", "8", capa, "10", "%.4f" % (x - ox), "20", "%.4f" % (y - oy), "30", "0.0",
          "40", "%.3f" % h, "1", txt[:250], "50", "%.3f" % rot, "72", "1", "11", "%.4f" % (x - ox),
          "21", "%.4f" % (y - oy), "31", "0.0"]


def escribir_dxf(ruta, rings, construcciones=(), local=False, texto=""):
    ox, oy = centroide(rings) if local else (0.0, 0.0)
    capas = [("LOTE", 3), ("CONSTRUCCIONES", 8), ("LOTE_TEXTO", 7), ("LOTE_COTAS", 2)]
    L = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "9", "$INSUNITS", "70", "6",
         "0", "ENDSEC", "0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", str(len(capas))]
    for nombre, color in capas:
        L += ["0", "LAYER", "2", nombre, "70", "0", "62", str(color), "6", "CONTINUOUS"]
    L += ["0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"]
    for r in rings:
        _dxf_polilinea(L, r, "LOTE", ox, oy)
    for c in construcciones:
        for r in c["rings"]:
            _dxf_polilinea(L, r, "CONSTRUCCIONES", ox, oy)
    x0, y0, x1, y1 = bbox(rings)
    h = max(0.25, min(1.5, max(x1 - x0, y1 - y0) / 40))
    for ld in lados(rings):
        _dxf_texto(L, "LOTE_COTAS", ld["medio"][0], ld["medio"][1], h * 0.7, "%.2f" % ld["longitud"], ox, oy)
    if texto:
        cx, cy = punto_interior(rings)
        _dxf_texto(L, "LOTE_TEXTO", cx, cy, h, texto, ox, oy)
    L += ["0", "ENDSEC", "0", "EOF"]
    with open(ruta, "w", encoding="ascii", errors="replace", newline="\r\n") as fh:
        fh.write("\n".join(L) + "\n")
    return ox, oy


def escribir_geojson(ruta, lote):
    feats = []
    if lote.get("rings_wgs84"):
        props = {"tipo": "lote", "npn": lote["npn"], "direccion": "; ".join(lote["direcciones"]),
                 "area_geometrica_m2": round(lote["area"], 2)}
        props.update({a["campo"]: a["valor"] for a in lote["predio_attrs"]})
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "Polygon", "coordinates": lote["rings_wgs84"]}})
    for c in lote["construcciones"]:
        if c.get("rings_wgs84"):
            props = {"tipo": "construccion"}
            props.update({a["campo"]: a["valor"] for a in c["atributos"]})
            feats.append({"type": "Feature", "properties": props,
                          "geometry": {"type": "Polygon", "coordinates": c["rings_wgs84"]}})
    with open(ruta, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh, ensure_ascii=False, indent=1, default=str)


def escribir_csv(ruta, lote, cruces, norma):
    with open(ruta, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["fuente", "capa", "item", "campo", "alias", "valor", "porcentaje_lote"])
        for a in lote["terreno_attrs"]:
            w.writerow(["CATASTRO", "Terreno", 1, a["campo"], a["alias"], a["valor"], ""])
        for a in lote["predio_attrs"]:
            w.writerow(["CATASTRO", "Predio", 1, a["campo"], a["alias"], a["valor"], ""])
        for i, d in enumerate(lote["direcciones"]):
            w.writerow(["CATASTRO", "Dirección", i + 1, "nombre_predio", "Dirección", d, ""])
        for i, c in enumerate(lote["construcciones"]):
            for a in c["atributos"]:
                w.writerow(["CATASTRO", "Construcción", i + 1, a["campo"], a["alias"], a["valor"], ""])
        w.writerow(["CALCULADO", "Lote", 1, "AREA_GEOM_M2", "Área geométrica m²", "%.2f" % lote["area"], ""])
        w.writerow(["CALCULADO", "Lote", 1, "PERIMETRO_M", "Perímetro m", "%.2f" % lote["perimetro"], ""])
        for n in norma:
            for esc in ("base", "maxima"):
                d = n.get(esc) or {}
                val = ("%s | %.3f viv/m2 | %d viv | %d pisos" % (d["rango"], d["densidad_viv_m2"],
                       d["viviendas_max"], d["altura_pisos"]) if "rango" in d
                       else d.get("nota") or n.get("error", ""))
                w.writerow(["NORMA", n["fuente"], 1, "%s %s" % (n["tratamiento"], n["nivel"] or ""),
                            "Propuesta " + esc, val, _pct(n.get("fraccion"))])
        for capa in cruces:
            for i, e in enumerate(capa["elementos"]):
                for a in e["atributos"]:
                    w.writerow([capa["grupo"], capa["titulo"], i + 1, a["campo"], a["alias"], a["valor"],
                                _pct(e["fraccion"])])


def _pct(f):
    return "" if f is None else "%.1f" % (100 * f)


def svg_plano(lote, ancho=560, alto=420):
    rings = lote["rings"]
    todas = rings + [r for c in lote["construcciones"] for r in c["rings"]]
    x0, y0, x1, y1 = bbox(todas)
    m = 46
    esc = min((ancho - 2 * m) / max(x1 - x0, 1e-6), (alto - 2 * m) / max(y1 - y0, 1e-6))
    ox = (ancho - (x1 - x0) * esc) / 2
    oy = (alto - (y1 - y0) * esc) / 2

    def P(p):
        return "%.1f,%.1f" % (ox + (p[0] - x0) * esc, alto - oy - (p[1] - y0) * esc)

    def path(rs):
        return " ".join("M" + " L".join(P(p) for p in _abierto(r)) + " Z" for r in rs)
    s = ['<svg viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg" class="plano" role="img" '
         'aria-label="Plano del lote">' % (ancho, alto)]
    for c in lote["construcciones"]:
        s.append('<path d="%s" class="cons" fill-rule="evenodd"/>' % path(c["rings"]))
    s.append('<path d="%s" class="lote" fill-rule="evenodd"/>' % path(rings))
    pts = _abierto(rings[0])
    cx, cy = centroide(rings)
    for i, p in enumerate(pts):
        q = P(p).split(",")
        s.append('<circle cx="%s" cy="%s" r="2.6" class="vert"/>' % tuple(q))
        dx, dy = p[0] - cx, p[1] - cy
        dn = math.hypot(dx, dy) or 1
        s.append('<text x="%.1f" y="%.1f" class="nv">%d</text>' % (
            float(q[0]) + 11 * dx / dn - 3, float(q[1]) - 11 * dy / dn + 4, i + 1))
    for ld in lados(rings):
        if ld["longitud"] * esc < 28:
            continue
        q = P(ld["medio"]).split(",")
        s.append('<text x="%s" y="%s" class="cota">%.2f</text>' % (q[0], q[1], ld["longitud"]))
    # escala gráfica y norte
    paso = next((v for v in (1, 2, 5, 10, 20, 50, 100, 200, 500) if v * esc >= 60), 1000)
    s.append('<g class="esc"><line x1="16" y1="%d" x2="%.1f" y2="%d"/><text x="16" y="%d">%d m</text></g>' % (
        alto - 16, 16 + paso * esc, alto - 16, alto - 22, paso))
    s.append('<g class="norte" transform="translate(%d,30)"><path d="M0,-16 L7,8 L0,3 L-7,8 Z"/>'
             '<text x="0" y="22">N</text></g>' % (ancho - 24))
    s.append("</svg>")
    return "".join(s)


def escribir_informe(ruta, datos):
    e = lambda v: html.escape(str(v))
    lote, norma, cruces = datos["lote"], datos["norma"], datos["cruces"]
    fmt = lambda v, d=2: ("{:,.%df}" % d).format(v).replace(",", "X").replace(".", ",").replace("X", ".")

    filas_norma = ""
    for n in norma:
        cab = "<b>%s</b>%s<br><small>%s · cubre %s%% del lote%s</small>" % (
            e(n["tratamiento"].title()), (" · " + e(n["nivel"])) if n.get("nivel") else "",
            e(n["fuente"]), _pct(n.get("fraccion")) or "?", " · principal" if n.get("principal") else "")
        if n.get("altura_capa"):
            cab += "<br><small>Altura máx. registrada en la capa: %s pisos</small>" % e(n["altura_capa"])
        if "error" in n:
            filas_norma += "<tr><td>%s</td><td colspan=4>%s</td></tr>" % (cab, e(n["error"]))
            continue
        for j, (esc, nom) in enumerate((("base", "Propuesta base"), ("maxima", "Propuesta máxima"))):
            d = n[esc]
            celda = "<td rowspan=2>%s</td>" % cab if j == 0 else ""
            if "rango" not in d:
                filas_norma += "<tr>%s<td>%s</td><td colspan=3>%s</td></tr>" % (celda, nom, e(d["nota"]))
                continue
            filas_norma += ("<tr>%s<td>%s<br><small>%s</small></td><td>%s viv/m²</td>"
                            "<td><b>%d viviendas</b><br><small>%s calculadas</small></td><td><b>%d pisos</b>%s</td></tr>") % (
                celda, nom, e(d["rango"]), fmt(d["densidad_viv_m2"], 3), d["viviendas_max"],
                fmt(d["viviendas_calculadas"]), d["altura_pisos"],
                "<br><small>%s</small>" % e(d["nota"]) if d.get("nota") else "")
    if not filas_norma:
        filas_norma = ("<tr><td colspan=5>No se identificó un tratamiento urbanístico sobre el lote "
                       "(la capa de tratamientos no respondió o el lote está fuera de ella).</td></tr>")

    bloques_capas = ""
    for capa in sorted(cruces, key=lambda c: (c["grupo"], c["titulo"])):
        filas = ""
        for i, el in enumerate(capa["elementos"]):
            attrs = "".join("<tr><td>%s</td><td>%s</td></tr>" % (e(a["alias"]), e(a["valor"])) for a in el["atributos"])
            pct = ("%s%% del lote · %s m²" % (_pct(el["fraccion"]), fmt(el["area_m2"]))) if el["fraccion"] is not None \
                else "elemento que cruza el lote"
            filas += "<div class=el><div class=pct>%d · %s</div><table>%s</table></div>" % (i + 1, e(pct), attrs)
        bloques_capas += ("<details%s><summary><span class=grp>%s</span> %s <span class=n>%d</span></summary>"
                          "<div class=els>%s</div></details>") % (
            " open" if PAT_TRATAMIENTO.search(capa["titulo"]) else "", e(capa["grupo"]), e(capa["titulo"]),
            len(capa["elementos"]), filas)
    if not bloques_capas:
        bloques_capas = "<p>No se obtuvieron capas normativas que crucen el lote.</p>"

    filas_cons = "".join(
        "<tr><td>%d</td><td>%s</td><td>%s</td><td>%s</td></tr>" % (
            i + 1, fmt(c["area"]), e(c["pisos"] if c["pisos"] is not None else "—"),
            e(", ".join("%s: %s" % (a["alias"], a["valor"]) for a in c["atributos"]
                        if not re.search(r"pisos", a["campo"]))))
        for i, c in enumerate(lote["construcciones"])) or "<tr><td colspan=4>Sin construcciones registradas.</td></tr>"
    filas_predio = "".join("<tr><td>%s</td><td>%s</td></tr>" % (e(a["alias"]), e(a["valor"]))
                           for a in lote["terreno_attrs"] + lote["predio_attrs"])
    filas_vert = "".join("<tr><td>%d</td><td>%s</td><td>%s</td><td>%s</td></tr>" % (
        i + 1, "%.3f" % p[0], "%.3f" % p[1], fmt(l["longitud"]))
        for i, (p, l) in enumerate(zip(_abierto(lote["rings"][0]), lados(lote["rings"]))))
    avisos = "".join("<li>%s</li>" % e(a) for a in datos["avisos"])
    princ = next((n for n in norma if n.get("principal") and "error" not in n and "rango" in n.get("maxima", {})), None)
    kpi_norma = ("<div><span>Máx. viviendas / pisos</span><b>%d viv · %d pisos</b></div>" % (
        princ["maxima"]["viviendas_max"], princ["maxima"]["altura_pisos"])) if princ else ""
    lat_lon = ""
    if lote.get("rings_wgs84"):
        lon, lat = centroide(lote["rings_wgs84"])
        lat_lon = ('<a href="https://www.google.com/maps/search/?api=1&query=%.6f,%.6f" target="_blank" '
                   'rel="noopener">%.6f, %.6f</a>' % (lat, lon, lat, lon))

    doc = f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lote {e(lote['npn'])} · Life City</title>
<style>
:root{{--v:#1f7a4d;--v2:#e7f2ec;--t:#1c1c1c;--m:#5b6660;--b:#d5ddd8;--bg:#fff;--g:#f3f6f4;--a:#b4541a}}
@media (prefers-color-scheme:dark){{:root{{--v:#5cc28d;--v2:#1d3328;--t:#e8ece9;--m:#9aa8a0;--b:#34413a;--bg:#131816;--g:#1b221f;--a:#e59a5f}}}}
*{{box-sizing:border-box}}
body{{font-family:"Segoe UI",system-ui,Arial,sans-serif;color:var(--t);background:var(--bg);margin:0;line-height:1.45}}
header{{background:#1f7a4d;color:#fff;padding:22px 32px}}
header h1{{margin:0;font-size:24px}} header div{{opacity:.9;font-size:14px}}
main{{padding:24px 32px;max-width:1150px;margin:auto}}
h2{{color:var(--v);border-bottom:2px solid var(--v);padding-bottom:4px;margin-top:34px;font-size:19px}}
.kpi{{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}}
.kpi div{{background:var(--g);padding:12px 16px;border-radius:8px}}
.kpi span{{font-size:12px;color:var(--m);display:block}}
.kpi b{{display:block;font-size:19px;color:var(--v);word-break:break-all}}
.dos{{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:24px;align-items:start}}
@media (max-width:820px){{.dos{{grid-template-columns:1fr}} main{{padding:16px}} header{{padding:18px 16px}}}}
.plano{{width:100%;height:auto;background:var(--g);border-radius:8px}}
.plano .lote{{fill:rgba(31,122,77,.14);stroke:var(--v);stroke-width:2}}
.plano .cons{{fill:rgba(120,120,120,.28);stroke:var(--m);stroke-width:1;stroke-dasharray:3 2}}
.plano .vert{{fill:var(--v)}} .plano text{{font-size:11px;fill:var(--t);text-anchor:middle}}
.plano .cota{{fill:var(--a);font-weight:600;paint-order:stroke;stroke:var(--g);stroke-width:3px}}
.plano .nv{{fill:var(--m);font-size:10px}}
.plano .esc line{{stroke:var(--t);stroke-width:2}} .plano .esc text{{text-anchor:start}}
.plano .norte path{{fill:var(--t)}}
table{{border-collapse:collapse;width:100%;font-size:13px;margin-bottom:14px}}
td,th{{border:1px solid var(--b);padding:5px 8px;text-align:left;vertical-align:top}}
th{{background:var(--g)}} small{{color:var(--m)}}
.scroll{{overflow-x:auto}}
details{{border:1px solid var(--b);border-radius:8px;margin-bottom:8px}}
summary{{cursor:pointer;padding:9px 12px;font-weight:600}}
summary .grp{{font-weight:400;color:var(--m);font-size:12px;margin-right:6px}}
summary .n{{background:var(--v2);color:var(--v);border-radius:10px;padding:0 8px;font-size:12px;margin-left:6px}}
.els{{padding:0 12px 6px}} .pct{{font-size:12px;color:var(--a);font-weight:600;margin:6px 0 4px}}
.avisos{{background:var(--v2);border-left:4px solid var(--a);padding:10px 14px 10px 30px;border-radius:6px}}
a{{color:var(--v)}}
@media print{{header{{-webkit-print-color-adjust:exact;print-color-adjust:exact}} details{{break-inside:avoid}}}}
</style></head><body>
<header><h1>Ficha de lote — Barranquilla</h1>
<div>Life City BIM Management Hub · BAQ Lote v{VERSION} · {e(datos['fecha'])}</div></header><main>
<div class="kpi">
<div><span>Número predial nacional</span><b>{e(lote['npn'])}</b></div>
<div><span>Dirección</span><b>{e(lote['direcciones'][0] if lote['direcciones'] else '—')}</b></div>
<div><span>Área catastral</span><b>{fmt(lote['area_oficial']) + ' m²' if lote['area_oficial'] else '—'}</b></div>
<div><span>Área geométrica</span><b>{fmt(lote['area'])} m²</b></div>
<div><span>Perímetro</span><b>{fmt(lote['perimetro'])} m</b></div>
{kpi_norma}
</div>
{('<ul class="avisos">' + avisos + '</ul>') if avisos else ''}
<h2>Plano y localización</h2>
<div class="dos"><div>{svg_plano(lote)}
<p><small>Lote (verde) y construcciones catastrales (gris). Cotas en metros. EPSG {SR}.</small></p></div>
<div><table>
<tr><th colspan=2>Localización</th></tr>
<tr><td>Manzana</td><td>{e((lote['manzana'] or {}).get('codigo') or '—')}</td></tr>
<tr><td>Centroide EPSG {SR}</td><td>X={lote['cx']:.3f}<br>Y={lote['cy']:.3f}</td></tr>
<tr><td>Centroide WGS84</td><td>{lat_lon or '—'}</td></tr>
<tr><td>Origen DXF</td><td>X={datos['ox']:.3f} Y={datos['oy']:.3f}{' (local)' if datos['ox'] else ' (absoluto)'}</td></tr>
<tr><td>Predios asociados</td><td>{lote['n_predios']}</td></tr>
<tr><td>Otras direcciones</td><td>{e('; '.join(lote['direcciones'][1:]) or '—')}</td></tr>
</table>
<div class="scroll"><table><tr><th>Vértice</th><th>X</th><th>Y</th><th>Lado (m)</th></tr>{filas_vert}</table></div>
</div></div>

<h2>Edificabilidad: densidad y altura</h2>
<p><small>Área usada: {fmt(datos['area_norma'])} m² ({e(datos['area_fuente'])}). Viviendas redondeadas hacia abajo.
Tabla: {e(datos['fuente_norma'])}.</small></p>
<div class="scroll"><table><tr><th>Tratamiento</th><th>Escenario / rango</th><th>Densidad</th><th>Viviendas</th><th>Altura</th></tr>{filas_norma}</table></div>

<h2>Normativa y condicionantes que cruzan el lote ({len(cruces)} capas)</h2>
{bloques_capas}

<h2>Construcciones existentes (catastro)</h2>
<div class="scroll"><table><tr><th>#</th><th>Área huella m²</th><th>Pisos</th><th>Detalle</th></tr>{filas_cons}</table></div>

<h2>Datos catastrales</h2>
<div class="scroll"><table><tr><th>Campo</th><th>Valor</th></tr>{filas_predio}</table></div>

<p><small>Fuentes: {e(datos['catastro'])} · WebMap Panorama Urbano ({e(datos['webmap'])}).
Información de referencia; no reemplaza certificados catastrales, conceptos de norma urbanística
ni licencias. Porcentajes de superposición estimados por muestreo.</small></p></main></body></html>"""
    with open(ruta, "w", encoding="utf-8") as fh:
        fh.write(doc)


# --------------------------------------------------------------------------- #
#  Orquestación
# --------------------------------------------------------------------------- #
def nombre_carpeta(ident):
    return "lote_" + re.sub(r"[^\w.-]+", "_", str(ident)).strip("_")[:60]


def ejecutar(ref=None, direccion=None, x=None, y=None, sr_punto=4326, salida=None, inseguro=False,
             dxf_local=False, solo_descubrir=False, sin_capas=False, log=print,
             catastro=CATASTRO, webmap=WEBMAP):
    cli = ArcGIS(verificar_ssl=not inseguro, log=log)
    cat = Catastro(cli, catastro)
    avisos = []

    if solo_descubrir:
        salida = salida or os.path.join(os.getcwd(), "inventario_capas")
        os.makedirs(salida, exist_ok=True)
        log("Inventario de capas (catastro + Panorama Urbano)…")
        inv = descubrir(cli, cat, webmap)
        ruta = os.path.join(salida, "capas_servicio.json")
        with open(ruta, "w", encoding="utf-8") as fh:
            json.dump(inv, fh, ensure_ascii=False, indent=1)
        log("Listo: %d capas → %s" % (len(inv["capas"]), ruta))
        return salida

    log("1/5 Buscando el lote en el catastro…")
    predio_buscado = None
    if ref:
        terreno, predio_buscado = cat.terreno_por_ref(ref)
    elif direccion:
        terreno = cat.terreno_por_direccion(direccion)
    elif x is not None and y is not None:
        if sr_punto == 4326 and abs(x) <= 90 and abs(y) > 50:
            x, y = y, x
            log("  ! Coordenadas invertidas detectadas: se usa X(longitud)=%s, Y(latitud)=%s" % (x, y))
        terreno = cat.terreno_por_punto(x, y, sr_punto)
    else:
        raise ErrorLote("Ingresa la referencia catastral, la dirección o las coordenadas X/Y.")

    ta = terreno["attributes"]
    npn = ta.get("name") or ""
    log("  Terreno %s" % npn)
    rings = cat.geometria(L_TERRENO, ta["objectid"], SR)
    if not rings:
        raise ErrorLote("El terreno no tiene geometría poligonal.")
    rings_wgs = cat.geometria(L_TERRENO, ta["objectid"], 4326)

    log("2/5 Predio, direcciones, manzana y construcciones…")
    predios = cat.predios_de_terreno(ta["globalid"])
    predio = predio_buscado or next((p for p in predios if p["attributes"].get("numero_predial_nacional") == npn),
                                    predios[0] if predios else None)
    if len(predios) > 1:
        avisos.append("El terreno tiene %d predios asociados (propiedad horizontal o englobe). "
                      "Se muestran los datos del predio %s." % (
                          len(predios), predio["attributes"].get("numero_predial_nacional")))
    pa = predio["attributes"] if predio else {}
    direcciones = cat.direcciones(ta["globalid"], pa.get("globalid"))
    cons = []
    for f in cat.construcciones(rings):
        a = f["attributes"]
        cr = f["geometry"]["rings"]
        cons.append({"objectid": a.get("objectid"), "rings": cr, "area": area_anillos(cr),
                     "pisos": a.get("total_pisos"),
                     "atributos": legibles(a, cat.campos(L_CONSTRUCCION))})
    for c in cons:
        c["rings_wgs84"] = cat.geometria(L_CONSTRUCCION, c["objectid"], 4326)
    area = area_anillos(rings)
    area_of = pa.get("area_catastral_terreno")
    cx, cy = centroide(rings)
    lote = {"npn": npn, "direcciones": direcciones, "rings": rings, "rings_wgs84": rings_wgs,
            "area": area, "perimetro": perimetro(rings), "area_oficial": area_of, "cx": cx, "cy": cy,
            "terreno_attrs": legibles(ta, cat.campos(L_TERRENO)),
            "predio_attrs": legibles(pa, cat.campos(T_PREDIO)) if pa else [],
            "construcciones": cons, "manzana": cat.manzana(rings), "n_predios": len(predios)}
    log("  %s · área geométrica %.2f m²%s · %d construcción(es)" % (
        direcciones[0] if direcciones else "sin dirección", area,
        (" · catastral %.2f m²" % area_of) if area_of else "", len(cons)))
    if area_of and abs(area_of - area) / area_of > 0.02:
        avisos.append("El área catastral (%.2f m²) difiere %.1f%% de la geométrica (%.2f m²)." % (
            area_of, 100 * abs(area_of - area) / area_of, area))

    cruces = []
    if not sin_capas:
        log("3/5 Cruzando con capas normativas de Panorama Urbano…")
        capas = capas_webmap(cli, webmap)
        cruces = cruzar_capas(cli, capas, rings, muestrear(rings))
        if cli.bloqueados:
            avisos.append("No respondieron (protección anti-bots o caídos): %s. Sus capas no se incluyen."
                          % ", ".join(sorted(cli.bloqueados)))
    else:
        log("3/5 Cruce de capas omitido.")

    log("4/5 Calculando densidad y altura…")
    area_norma = area_of or area
    area_fuente = "área catastral del predio" if area_of else "área geométrica del polígono"
    norma = evaluar_norma(cruces, area_norma)
    for n in norma:
        pct = ("%.0f%%" % (100 * n["fraccion"])) if n.get("fraccion") is not None else "?"
        if "error" in n:
            log("  · %s %s (%s): %s" % (n["tratamiento"], n.get("nivel") or "", pct, n["error"]))
        elif "rango" in n["maxima"]:
            log("  Norma %s %s (%s): base %d viv / %d pisos · máx %d viv / %d pisos" % (
                n["tratamiento"], n["nivel"], pct, n["base"]["viviendas_max"], n["base"]["altura_pisos"],
                n["maxima"]["viviendas_max"], n["maxima"]["altura_pisos"]))
        else:
            log("  Norma %s %s (%s): %s" % (n["tratamiento"], n["nivel"], pct, n["maxima"]["nota"]))
    if not sin_capas and not norma:
        avisos.append("No se identificó tratamiento urbanístico sobre el lote.")
    if len(norma) > 1:
        avisos.append("El lote cruza %d tratamientos; se marca como principal el de mayor cobertura." % len(norma))

    log("5/5 Escribiendo archivos…")
    salida = salida or os.path.join(os.getcwd(), nombre_carpeta(npn))
    os.makedirs(salida, exist_ok=True)
    ox, oy = escribir_dxf(os.path.join(salida, "lote.dxf"), rings, cons, dxf_local,
                          "LOTE %s A=%.2f m2" % (npn, area))
    escribir_geojson(os.path.join(salida, "lote.geojson"), lote)
    escribir_csv(os.path.join(salida, "atributos.csv"), lote, cruces, norma)
    datos = {"lote": lote, "norma": norma, "cruces": cruces, "avisos": avisos,
             "fecha": dt.datetime.now().strftime("%Y-%m-%d %H:%M"), "ox": ox, "oy": oy,
             "area_norma": area_norma, "area_fuente": area_fuente, "fuente_norma": norma_baq.FUENTE_NORMA,
             "catastro": cat.base, "webmap": webmap}
    escribir_informe(os.path.join(salida, "informe.html"), datos)
    resumen = dict(datos, lote={k: v for k, v in lote.items()},
                   cruces=[{k: v for k, v in c.items() if k != "elementos"} |
                           {"elementos": [{k: v for k, v in el.items() if k not in ("attrs", "texto")}
                                          for el in c["elementos"]]} for c in cruces])
    with open(os.path.join(salida, "resumen.json"), "w", encoding="utf-8") as fh:
        json.dump(resumen, fh, ensure_ascii=False, indent=1, default=str)
    with open(os.path.join(salida, "capas_servicio.json"), "w", encoding="utf-8") as fh:
        json.dump({"catastro": cat.base, "webmap": webmap, "capas_consultadas": capas if not sin_capas else [],
                   "no_disponibles": sorted(cli.bloqueados)}, fh, ensure_ascii=False, indent=1)
    for a in avisos:
        log("  ! " + a)
    log("Listo. Archivos en: %s" % salida)
    return salida


# --------------------------------------------------------------------------- #
#  Interfaz gráfica
# --------------------------------------------------------------------------- #
def gui():
    import tkinter as tk
    from tkinter import ttk, filedialog, scrolledtext

    root = tk.Tk()
    root.title("BAQ Lote · Life City BIM")
    root.geometry("780x620")
    root.minsize(640, 480)
    frm = ttk.Frame(root, padding=12)
    frm.pack(fill="both", expand=True)

    v = {k: tk.StringVar() for k in ("ref", "dir", "x", "y", "salida")}
    v["sr"] = tk.StringVar(value="4326")
    modo = tk.StringVar(value="ref")
    inseguro, local, sin_capas = tk.BooleanVar(), tk.BooleanVar(), tk.BooleanVar()
    abrir = tk.BooleanVar(value=True)

    busq = ttk.LabelFrame(frm, text="Buscar lote por", padding=8)
    busq.grid(row=0, column=0, columnspan=3, sticky="we")
    busq.columnconfigure(2, weight=1)
    entradas = {}
    filas = [("ref", "Referencia catastral", "Número predial nacional (30 dígitos) o anterior (20)"),
             ("dir", "Dirección", "Ej.: Carrera 59 # 64-221"),
             ("xy", "Coordenadas", "")]
    for i, (k, t, ayuda) in enumerate(filas):
        ttk.Radiobutton(busq, text=t, value=k, variable=modo, command=lambda: refrescar()).grid(
            row=i * 2, column=0, sticky="w", pady=(4, 0))
        if k == "xy":
            fxy = ttk.Frame(busq)
            fxy.grid(row=i * 2, column=1, columnspan=2, sticky="w")
            ttk.Label(fxy, text="X / Long.").pack(side="left")
            ex = ttk.Entry(fxy, textvariable=v["x"], width=16)
            ex.pack(side="left", padx=4)
            ttk.Label(fxy, text="Y / Lat.").pack(side="left")
            ey = ttk.Entry(fxy, textvariable=v["y"], width=16)
            ey.pack(side="left", padx=4)
            ttk.Label(fxy, text="EPSG").pack(side="left")
            es = ttk.Combobox(fxy, textvariable=v["sr"], values=["4326", "9377", "3116"], width=7)
            es.pack(side="left", padx=4)
            entradas[k] = [ex, ey, es]
        else:
            en = ttk.Entry(busq, textvariable=v[k])
            en.grid(row=i * 2, column=1, columnspan=2, sticky="we", padx=(8, 0))
            ttk.Label(busq, text=ayuda, foreground="#667").grid(row=i * 2 + 1, column=1, columnspan=2,
                                                                sticky="w", padx=(8, 0))
            entradas[k] = [en]

    def refrescar():
        for k, ws in entradas.items():
            for w in ws:
                w.state(["!disabled"] if modo.get() == k else ["disabled"])
    refrescar()

    opc = ttk.Frame(frm)
    opc.grid(row=1, column=0, columnspan=3, sticky="we", pady=(10, 0))
    opc.columnconfigure(1, weight=1)
    ttk.Label(opc, text="Carpeta de salida").grid(row=0, column=0, sticky="w")
    ttk.Entry(opc, textvariable=v["salida"]).grid(row=0, column=1, sticky="we", padx=6)
    ttk.Button(opc, text="…", width=3, command=lambda: v["salida"].set(
        filedialog.askdirectory() or v["salida"].get())).grid(row=0, column=2)
    chk = ttk.Frame(opc)
    chk.grid(row=1, column=0, columnspan=3, sticky="w", pady=4)
    ttk.Checkbutton(chk, text="DXF en coordenadas locales (origen en el centroide)", variable=local).pack(anchor="w")
    ttk.Checkbutton(chk, text="Solo catastro (sin cruce de capas normativas)", variable=sin_capas).pack(anchor="w")
    ttk.Checkbutton(chk, text="Ignorar SSL (certificado del servidor)", variable=inseguro).pack(anchor="w")
    ttk.Checkbutton(chk, text="Abrir el informe al terminar", variable=abrir).pack(anchor="w")

    barra = ttk.Frame(frm)
    barra.grid(row=2, column=0, columnspan=3, sticky="w", pady=6)
    log = scrolledtext.ScrolledText(frm, height=14, font=("Consolas", 9), wrap="word")
    log.grid(row=3, column=0, columnspan=3, sticky="nsew")
    estado = ttk.Label(frm, text="Listo.", foreground="#1f7a4d")
    estado.grid(row=4, column=0, columnspan=3, sticky="w", pady=(4, 0))
    frm.columnconfigure(1, weight=1)
    frm.rowconfigure(3, weight=1)
    ultima = {"carpeta": None}

    def escribir(msg):
        root.after(0, lambda: (log.insert("end", str(msg) + "\n"), log.see("end")))

    def correr(descubrir_solo):
        def tarea():
            ok = False
            try:
                kw = {}
                if not descubrir_solo:
                    m = modo.get()
                    if m == "ref":
                        kw["ref"] = v["ref"].get().strip() or None
                    elif m == "dir":
                        kw["direccion"] = v["dir"].get().strip() or None
                    else:
                        try:
                            kw["x"] = float(v["x"].get().replace(",", "."))
                            kw["y"] = float(v["y"].get().replace(",", "."))
                            kw["sr_punto"] = int(v["sr"].get() or 4326)
                        except ValueError:
                            raise ErrorLote("Las coordenadas X/Y y el EPSG deben ser números.")
                out = ejecutar(salida=v["salida"].get().strip() or None, inseguro=inseguro.get(),
                               dxf_local=local.get(), sin_capas=sin_capas.get(),
                               solo_descubrir=descubrir_solo, log=escribir, **kw)
                ultima["carpeta"] = out
                ok = True
                if not descubrir_solo and abrir.get():
                    abrir_ruta(os.path.join(out, "informe.html"))
            except Exception as e:
                escribir("ERROR: %s" % e)
            finally:
                root.after(0, lambda: (estado.config(text="Terminado." if ok else "Con errores; revisa el registro.",
                                                     foreground="#1f7a4d" if ok else "#b4541a"),
                                       [b.state(["!disabled"]) for b in botones]))
        log.delete("1.0", "end")
        estado.config(text="Consultando…", foreground="#555")
        [b.state(["disabled"]) for b in botones]
        threading.Thread(target=tarea, daemon=True).start()

    botones = [ttk.Button(barra, text="Extraer lote", command=lambda: correr(False)),
               ttk.Button(barra, text="Inventario de capas", command=lambda: correr(True)),
               ttk.Button(barra, text="Abrir carpeta", command=lambda: ultima["carpeta"] and abrir_ruta(ultima["carpeta"]))]
    for b in botones:
        b.pack(side="left", padx=(0, 6))
    root.bind("<Return>", lambda _e: botones[0].instate(["!disabled"]) and correr(False))
    root.mainloop()


def abrir_ruta(ruta):
    if os.name == "nt":
        os.startfile(ruta)
    else:
        import subprocess
        import webbrowser
        if ruta.endswith(".html"):
            webbrowser.open("file://" + os.path.abspath(ruta))
        else:
            subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", ruta])


def main():
    if len(sys.argv) == 1:
        return gui()
    ap = argparse.ArgumentParser(description="Extractor catastral y normativo de lotes - Barranquilla")
    g = ap.add_argument_group("búsqueda (una opción)")
    g.add_argument("--ref", help="Número predial nacional (30 dígitos) o anterior (20)")
    g.add_argument("--dir", dest="direccion", help="Dirección, p.ej. \"Carrera 59 # 64-221\"")
    g.add_argument("--x", type=float, help="X o longitud de un punto dentro del lote")
    g.add_argument("--y", type=float, help="Y o latitud de un punto dentro del lote")
    g.add_argument("--sr", type=int, default=4326, help="EPSG del punto (def. 4326; 9377 = MAGNA Origen Nacional)")
    ap.add_argument("--salida", help="Carpeta de salida")
    ap.add_argument("--dxf-local", action="store_true", help="DXF con origen en el centroide")
    ap.add_argument("--sin-capas", action="store_true", help="No cruzar capas normativas (más rápido)")
    ap.add_argument("--inseguro", action="store_true", help="No verificar certificado SSL")
    ap.add_argument("--descubrir", action="store_true", help="Solo inventariar capas y campos")
    ap.add_argument("--catastro", default=CATASTRO, help="URL del MapServer de catastro abierto")
    ap.add_argument("--webmap", default=WEBMAP, help="ID del WebMap de Panorama Urbano en ArcGIS Online")
    a = ap.parse_args()
    if not a.descubrir and not a.ref and not a.direccion and (a.x is None or a.y is None):
        ap.error("indica --ref, --dir o --x/--y (o --descubrir)")
    try:
        ejecutar(ref=a.ref, direccion=a.direccion, x=a.x, y=a.y, sr_punto=a.sr, salida=a.salida,
                 inseguro=a.inseguro, dxf_local=a.dxf_local, solo_descubrir=a.descubrir,
                 sin_capas=a.sin_capas, catastro=a.catastro, webmap=a.webmap)
    except Exception as e:
        print("ERROR:", e)
        sys.exit(2)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    main()

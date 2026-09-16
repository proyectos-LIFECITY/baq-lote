# -*- coding: utf-8 -*-
"""Pruebas sin conexión: norma, geometría, direcciones y salidas.  python -m unittest discover tests"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import baq_lote as b  # noqa: E402
import norma_baq as n  # noqa: E402

CUADRADO = [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]]             # horario (exterior ArcGIS)
CON_HUECO = CUADRADO + [[[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]]      # hueco 2x2


class Norma(unittest.TestCase):
    def test_interpretar_dominios_capa(self):
        casos = {
            "Consolidacion Nivel 2 11": ("CONSOLIDACION", "2"),
            "CSD Consolidacion Nivel 1A": ("CONSOLIDACION", "1A"),
            "Consolidacion Nivel 1B": ("CONSOLIDACION", "1B"),
            "Consolidacion Especial": ("CONSOLIDACION", "ESPECIAL"),
            "MI Mejoramiento Integral Mejoramiento Integral 2": ("MEJORAMIENTO INTEGRAL", "2"),
            "Renovación Urbana Reactivación": ("RENOVACION", "REACTIVACION"),
            "RU Renovacion Urbana Redesarrollo": ("RENOVACION", "REDESARROLLO"),
            "CSV Conservacion Sector Normativo 2": (None, None),
        }
        for texto, esperado in casos.items():
            self.assertEqual(n.interpretar(texto), esperado, texto)

    def test_json_igual_a_tabla_interna(self):
        ruta = os.path.join(os.path.dirname(n.__file__), n.ARCHIVO_JSON)
        self.assertEqual(n.cargar_json(ruta), n.NORMA)

    def test_calculo_rangos(self):
        r = n.calcular("CONSOLIDACION", "2", 3000)
        self.assertEqual((r["base"]["viviendas_max"], r["base"]["altura_pisos"]), (60, 2))
        self.assertEqual((r["maxima"]["viviendas_max"], r["maxima"]["altura_pisos"]), (150, 8))
        r = n.calcular("MEJORAMIENTO INTEGRAL", "2", 484.2)
        self.assertEqual((r["base"]["viviendas_max"], r["maxima"]["viviendas_max"]), (4, 5))
        r = n.calcular("RENOVACION", "REACTIVACION", 6148)
        self.assertEqual(r["maxima"]["altura_pisos"], 40)
        self.assertIn("Plan Zonal", r["maxima"]["nota"])
        self.assertEqual(n.calcular("CONSOLIDACION", "2", 600)["maxima"]["rango"], "Hasta 600 m²")
        self.assertIn("error", n.calcular("CONSOLIDACION", "9", 100))


class Geometria(unittest.TestCase):
    def test_area_perimetro_centroide(self):
        self.assertAlmostEqual(b.area_anillos(CUADRADO), 100)
        self.assertAlmostEqual(b.area_anillos(CON_HUECO), 96)
        self.assertAlmostEqual(b.perimetro(CUADRADO), 40)
        cx, cy = b.centroide(CUADRADO)
        self.assertAlmostEqual(cx, 5)
        self.assertAlmostEqual(cy, 5)

    def test_punto_en_y_fraccion(self):
        self.assertTrue(b.punto_en(1, 1, CON_HUECO))
        self.assertFalse(b.punto_en(3, 3, CON_HUECO))
        muestras = b.muestrear(CUADRADO, 2500)
        mitad = [[[0, 0], [0, 10], [5, 10], [5, 0], [0, 0]]]
        self.assertAlmostEqual(b.fraccion_dentro(muestras, mitad), 0.5, delta=0.02)

    def test_punto_interior_en_forma_de_u(self):
        u = [[[0, 0], [0, 10], [3, 10], [3, 3], [7, 3], [7, 10], [10, 10], [10, 0], [0, 0]]]
        x, y = b.punto_interior(u)
        self.assertTrue(b.punto_en(x, y, u))


class Direcciones(unittest.TestCase):
    def test_parsear(self):
        d = b.parsear_direccion("Cra 59 # 64-221")
        self.assertEqual((d["clase"], d["via"], d["gen"], d["placa"]), ("Carrera", "59", "64", "221"))
        d = b.parsear_direccion("calle 14d 45f 23")
        self.assertEqual((d["clase"], d["letra"], d["letra_gen"]), ("Calle", "D", "F"))
        d = b.parsear_direccion("Av. Carrera 38 No. 70-15")
        self.assertEqual(d["clase"], "Avenida_Carrera")
        self.assertIsNone(b.parsear_direccion("Edificio Las Palmas"))


class Salidas(unittest.TestCase):
    def test_dxf_y_evaluar_norma(self):
        with tempfile.TemporaryDirectory() as tmp:
            ruta = os.path.join(tmp, "lote.dxf")
            cons = [{"rings": [[[1, 1], [1, 4], [4, 4], [4, 1], [1, 1]]]}]
            ox, oy = b.escribir_dxf(ruta, CUADRADO, cons, local=True, texto="LOTE X")
            self.assertEqual((ox, oy), (5, 5))
            with open(ruta, encoding="ascii") as fh:
                txt = fh.read()
            self.assertIn("CONSTRUCCIONES", txt)
            self.assertTrue(txt.rstrip().endswith("EOF"))
        cruces = [{"titulo": "TRATAMIENTOS URBANISTICOS", "nombre": "T", "url": "u1", "grupo": "POT",
                   "elementos": [{"fraccion": 0.97, "texto": "Consolidacion Nivel 2",
                                  "atributos": [{"campo": "Tipo_TratUrb", "alias": "Tipo", "valor": "Nivel 2"}]},
                                 {"fraccion": 0.01, "texto": "Consolidacion Nivel 3", "atributos": []}]},
                  {"titulo": "TRATAMIENTOS URBANISTICOS _ Tipo", "nombre": "T", "url": "u2", "grupo": "POT",
                   "elementos": [{"fraccion": 0.97, "texto": "Consolidacion Nivel 2", "atributos": []}]}]
        norma = b.evaluar_norma(cruces, 3000)
        self.assertEqual(len(norma), 1)                     # franja del 1% ignorada, capa repetida unificada
        self.assertAlmostEqual(norma[0]["fraccion"], 0.97)
        self.assertTrue(norma[0]["principal"])


if __name__ == "__main__":
    unittest.main()

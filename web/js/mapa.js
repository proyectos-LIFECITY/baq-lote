// Mapa Leaflet: bases, linderos catastrales, lote seleccionado y consultas guardadas
/* global L */
import { CATASTRO, L as CAPAS } from "./catastro.js";

const CENTRO_BAQ = [10.9685, -74.7813];

// Capa de imagen dinámica del MapServer de catastro (se regenera al mover el mapa)
const CapaDinamica = window.L.Layer.extend({
  initialize(url, opciones) { this.url = url; window.L.setOptions(this, opciones); },
  onAdd(mapa) { this._mapa = mapa; mapa.on("moveend", this._refrescar, this); this._refrescar(); },
  onRemove(mapa) {
    mapa.off("moveend", this._refrescar, this);
    if (this._img) mapa.removeLayer(this._img);
    this._img = null;
  },
  _refrescar() {
    const m = this._mapa;
    if (!m) return;
    if (m.getZoom() < this.options.zoomMin) {
      if (this._img) { m.removeLayer(this._img); this._img = null; }
      return;
    }
    const b = m.getBounds(), t = m.getSize();
    const sw = window.L.CRS.EPSG3857.project(b.getSouthWest()), ne = window.L.CRS.EPSG3857.project(b.getNorthEast());
    const src = `${this.url}/export?bbox=${sw.x},${sw.y},${ne.x},${ne.y}&bboxSR=3857&imageSR=3857` +
      `&size=${t.x},${t.y}&layers=show:${this.options.capas}&transparent=true&format=png32&dpi=96&f=image`;
    const img = window.L.imageOverlay(src, b, { opacity: this.options.opacity, interactive: false, zIndex: 250 });
    img.once("load", () => { if (this._img && this._img !== img) m.removeLayer(this._img); this._img = img; });
    img.once("error", () => m.removeLayer(img));
    img.addTo(m);
  },
});

export class Mapa {
  constructor(id, { alClic }) {
    const Lf = window.L;
    this.m = Lf.map(id, { zoomControl: false, attributionControl: true, maxZoom: 21 }).setView(CENTRO_BAQ, 13);
    Lf.control.zoom({ position: "bottomright" }).addTo(this.m);
    this.bases = {
      mapa: Lf.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        maxZoom: 21, maxNativeZoom: 20, subdomains: "abcd",
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      }),
      satelite: Lf.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 21, maxNativeZoom: 19, attribution: "Imágenes &copy; Esri, Maxar, Earthstar Geographics",
      }),
    };
    this.bases.mapa.addTo(this.m);
    this.predios = new CapaDinamica(CATASTRO, { capas: CAPAS.TERRENO, zoomMin: 16, opacity: 0.85 });
    this.predios.addTo(this.m);
    this.grupoLote = Lf.featureGroup().addTo(this.m);
    this.grupoGuardados = Lf.featureGroup().addTo(this.m);
    this.m.attributionControl.addAttribution("Catastro &copy; Alcaldía de Barranquilla");
    this.m.on("click", (e) => alClic?.(e.latlng));
  }

  base(nombre) {
    for (const [k, capa] of Object.entries(this.bases)) {
      if (k === nombre) capa.addTo(this.m); else this.m.removeLayer(capa);
    }
  }

  linderos(visible) { visible ? this.predios.addTo(this.m) : this.m.removeLayer(this.predios); }

  /** Dibuja el lote (anillos WGS84 [lon, lat]) y sus construcciones. */
  mostrarLote(lote, { encuadrar = true } = {}) {
    const Lf = window.L;
    this.grupoLote.clearLayers();
    const aLatLng = (rings) => rings.map((r) => r.map(([x, y]) => [y, x]));
    for (const c of lote.construcciones || [])
      if (c.rings_wgs84)
        Lf.polygon(aLatLng(c.rings_wgs84), { color: "#3d4a43", weight: 1, dashArray: "4 3", fillColor: "#5a6660", fillOpacity: 0.3, interactive: false }).addTo(this.grupoLote);
    if (lote.rings_wgs84) {
      const pol = Lf.polygon(aLatLng(lote.rings_wgs84), { color: "#1f7a4d", weight: 3, fillColor: "#2ecc71", fillOpacity: 0.22 }).addTo(this.grupoLote);
      pol.bindTooltip(lote.direcciones?.[0] || lote.npn, { sticky: true, direction: "top" });
      if (encuadrar) this.m.flyToBounds(pol.getBounds(), { padding: [60, 60], maxZoom: 19, duration: 0.8 });
    }
  }

  limpiarLote() { this.grupoLote.clearLayers(); }

  /** Marcadores de consultas guardadas. */
  guardados(items, alElegir) {
    const Lf = window.L;
    this.grupoGuardados.clearLayers();
    for (const it of items) {
      const c = it.resumen?.centro;
      if (!c) continue;
      Lf.marker([c[1], c[0]], { icon: Lf.divIcon({ className: "", html: '<div class="marcador-guardado"></div>', iconSize: [14, 14] }) })
        .bindTooltip(it.nombre, { direction: "top", offset: [0, -8] })
        .on("click", (e) => { Lf.DomEvent.stopPropagation(e); alElegir(it.id); })
        .addTo(this.grupoGuardados);
    }
  }

  popup(latlng, html) {
    return window.L.popup({ closeButton: true, autoPan: true }).setLatLng(latlng).setContent(html).openOn(this.m);
  }

  cerrarPopup() { this.m.closePopup(); }

  invalidar() { setTimeout(() => this.m.invalidateSize(), 50); }
}

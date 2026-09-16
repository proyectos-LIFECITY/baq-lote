// Geometría plana sin dependencias (anillos ArcGIS: [[x, y], ...])

export const abierto = (r) =>
  r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r;

const pares = (pts) => pts.map((a, i) => [a, pts[(i + 1) % pts.length]]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function areaFirmada(r) {
  return pares(abierto(r)).reduce((s, [a, b]) => s + a[0] * b[1] - b[0] * a[1], 0) / 2;
}

/** Área neta: ArcGIS usa anillos exteriores horarios (firmada negativa) y huecos antihorarios. */
export const areaAnillos = (rings) => Math.abs(rings.reduce((s, r) => s - areaFirmada(r), 0));

export const perimetro = (rings) =>
  rings.reduce((s, r) => s + pares(abierto(r)).reduce((t, [a, b]) => t + dist(a, b), 0), 0);

export function centroide(rings) {
  let sx = 0, sy = 0, sa = 0;
  for (const r of rings) {
    for (const [a, b] of pares(abierto(r))) {
      const c = a[0] * b[1] - b[0] * a[1];
      sx += (a[0] + b[0]) * c;
      sy += (a[1] + b[1]) * c;
      sa += c;
    }
  }
  if (Math.abs(sa) < 1e-9) {
    const pts = rings.flatMap(abierto);
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  }
  return [sx / (3 * sa), sy / (3 * sa)];
}

export function bbox(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const [x, y] of r) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** Regla par-impar sobre todos los anillos (respeta huecos). */
export function puntoEn(x, y, rings) {
  let dentro = false;
  for (const r of rings) {
    const pts = abierto(r);
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
    }
  }
  return dentro;
}

/** Malla regular de puntos dentro del polígono (para estimar superposiciones). */
export function muestrear(rings, n = 1600) {
  const [x0, y0, x1, y1] = bbox(rings);
  const paso = Math.sqrt(Math.max((x1 - x0) * (y1 - y0), 1e-12) / n);
  const pts = [];
  for (let y = y0 + paso / 2; y < y1; y += paso)
    for (let x = x0 + paso / 2; x < x1; x += paso)
      if (puntoEn(x, y, rings)) pts.push([x, y]);
  return pts.length ? pts : [centroide(rings)];
}

export function fraccionDentro(puntos, rings) {
  if (!puntos.length) return 0;
  const [x0, y0, x1, y1] = bbox(rings);
  let n = 0;
  for (const [x, y] of puntos) if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && puntoEn(x, y, rings)) n++;
  return n / puntos.length;
}

export function puntoInterior(rings) {
  const c = centroide(rings);
  if (puntoEn(c[0], c[1], rings)) return c;
  return muestrear(rings, 400).reduce((m, p) => (dist(p, c) < dist(m, c) ? p : m));
}

/** Longitud y punto medio de cada lado del anillo exterior. */
export function lados(rings) {
  const pts = abierto(rings[0]);
  return pares(pts).map(([a, b], i) => ({
    desde: i + 1, hasta: ((i + 1) % pts.length) + 1, longitud: dist(a, b),
    medio: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
  }));
}

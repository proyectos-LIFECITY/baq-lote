// Cliente ArcGIS REST para el navegador (y Node 18+)

export class ErrorLote extends Error {}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

export class ArcGIS {
  constructor({ log = () => {}, pausa = 120, timeout = 45000 } = {}) {
    this.log = log;
    this.pausa = pausa;
    this.timeout = timeout;
    this.bloqueados = new Set();
    this.rechazos = new Map();
  }

  async req(url, params = {}, reintentos = 3) {
    const host = new URL(url).host;
    if (this.bloqueados.has(host)) throw new ErrorLote(`servidor ${host} no disponible`);
    const cuerpo = new URLSearchParams({ ...params, f: "json" });
    for (let i = 0; i < reintentos; i++) {
      await esperar(this.pausa);
      let r, texto;
      try {
        r = await fetch(url, {
          method: "POST", body: cuerpo, signal: AbortSignal.timeout(this.timeout),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        texto = await r.text();
      } catch (e) {
        // CORS bloqueado por un reto anti-bots, red caída o tiempo agotado
        if (i < reintentos - 1) { await esperar(1500 * (i + 1)); continue; }
        this.bloquear(host, e.name === "TimeoutError" ? "sin respuesta" : "sin acceso desde el navegador");
        throw new ErrorLote(`servidor ${host} no disponible`);
      }
      if (!texto.trimStart().startsWith("{")) {
        if (texto.includes("Just a moment") || r.status >= 500) {
          this.bloquear(host, `HTTP ${r.status}`);
          throw new ErrorLote(`servidor ${host} no disponible`);
        }
        // Rechazos repetidos del firewall: se deja de consultar ese servidor
        this.rechazos.set(host, (this.rechazos.get(host) || 0) + 1);
        if (this.rechazos.get(host) >= 3) this.bloquear(host, `HTTP ${r.status}`);
        throw new ErrorLote(`${host} rechazó la consulta (HTTP ${r.status}, firewall)`);
      }
      const data = JSON.parse(texto);
      if (data.error) throw new ErrorLote(`${data.error.message || "error"} ${(data.error.details || []).join(" ")}`.trim());
      return data;
    }
  }

  bloquear(host, motivo) {
    if (this.bloqueados.has(host)) return;
    this.bloqueados.add(host);
    this.log(`${host} no responde (${motivo}); se omiten sus capas.`, "aviso");
  }

  info(url) { return this.req(url); }

  query(url, params) {
    return this.req(url.replace(/\/$/, "") + "/query", { outFields: "*", returnGeometry: "false", ...limpiar(params) });
  }

  async features(url, params) { return (await this.query(url, params)).features || []; }
}

const limpiar = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

export const sqlTxt = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Ejecuta tareas con concurrencia limitada, preservando el orden. */
export async function enParalelo(items, fn, hilos = 4) {
  const out = new Array(items.length);
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(hilos, items.length) }, async () => {
    while (k < items.length) { const i = k++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

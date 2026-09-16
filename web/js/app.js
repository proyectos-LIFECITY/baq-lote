// BAQ Lote · interfaz principal
import { Mapa } from "./mapa.js";
import { VERSION, ejecutar, resumir } from "./motor.js";
import { cargarNorma } from "./norma.js";
import * as nube from "./nube.js";
import { csv, dxf, fmt, geojson, informe } from "./salidas.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const titulo = (t) => String(t || "").toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

const estado = {
  usuario: null, tipo: "ref", ocupado: false,
  actual: null,          // { datos, resumen, id?, nombre?, notas? }
  consultas: [], desuscribir: null, mapa: null, registro: false,
};

// ============================================================ utilidades de UI
function toast(msg, tipo = "") {
  const t = Object.assign(document.createElement("div"), { className: `toast ${tipo}`, textContent: msg });
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 3800);
}

function descargar(nombre, contenido, tipo) {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = Object.assign(document.createElement("a"), { href: url, download: nombre });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function confirmar(tituloTxt, texto) {
  const dlg = $("#dlg-confirmar");
  $("#confirmar-titulo").textContent = tituloTxt;
  $("#confirmar-texto").textContent = texto;
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((ok) => dlg.addEventListener("close", () => ok(dlg.returnValue === "ok"), { once: true }));
}

const fechaCorta = (ts) => {
  const d = ts?.toDate ? ts.toDate() : ts ? new Date(ts) : null;
  return d ? d.toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric" }) : "";
};

// ============================================================ ingreso
let modoRegistro = false;

function alternarRegistro(valor = !modoRegistro) {
  modoRegistro = valor;
  $("#campo-nombre").hidden = !modoRegistro;
  $("#ingreso-titulo").textContent = modoRegistro ? "Crea tu cuenta" : "Ingresa a tu cuenta";
  $("#ingreso-sub").textContent = modoRegistro ? "Gratis. Guarda y organiza tus análisis de lotes." : "Tus consultas quedan guardadas en tu cuenta.";
  $("#btn-ingresar").textContent = modoRegistro ? "Crear cuenta" : "Ingresar";
  $("#btn-alternar").innerHTML = modoRegistro ? "¿Ya tienes cuenta? <b>Ingresar</b>" : "¿No tienes cuenta? <b>Crear cuenta</b>";
  $('[name="clave"]').autocomplete = modoRegistro ? "new-password" : "current-password";
  $("#ingreso-error").hidden = true;
}

function errorIngreso(e) {
  const p = $("#ingreso-error");
  p.textContent = typeof e === "string" ? e : nube.mensajeError(e);
  p.hidden = false;
}

async function conBoton(boton, fn) {
  const txt = boton.innerHTML;
  boton.disabled = true;
  boton.innerHTML = '<span class="girando"></span>';
  try { return await fn(); } finally { boton.disabled = false; boton.innerHTML = txt; }
}

function iniciarIngreso() {
  $("#btn-google").addEventListener("click", (e) =>
    conBoton(e.currentTarget, () => nube.ingresarGoogle().catch(errorIngreso)));
  $("#btn-alternar").addEventListener("click", () => alternarRegistro());
  $("#btn-recuperar").addEventListener("click", async () => {
    const correo = $('[name="correo"]').value.trim();
    if (!correo) return errorIngreso("Escribe tu correo y vuelve a pulsar «Olvidé mi contraseña».");
    try {
      await nube.recuperarClave(correo);
      $("#ingreso-error").hidden = true;
      toast("Te enviamos un correo para restablecer la contraseña.");
    } catch (e) { errorIngreso(e); }
  });
  $("#form-ingreso").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const correo = String(f.get("correo")).trim(), clave = String(f.get("clave"));
    if (!correo || clave.length < 6) return errorIngreso("Escribe tu correo y una contraseña de al menos 6 caracteres.");
    conBoton($("#btn-ingresar"), () => (modoRegistro
      ? nube.registrarCorreo(String(f.get("nombre")).trim(), correo, clave)
      : nube.ingresarCorreo(correo, clave)).catch(errorIngreso));
  });
}

// ============================================================ sesión
function mostrarUsuario(u) {
  const nombre = u.displayName || u.email?.split("@")[0] || "Usuario";
  $("#usuario-nombre").textContent = nombre;
  $("#menu-nombre").textContent = nombre;
  $("#menu-correo").textContent = u.email || "";
  const av = $("#avatar");
  if (u.photoURL) { av.style.backgroundImage = `url("${u.photoURL}")`; av.textContent = ""; }
  else { av.style.backgroundImage = ""; av.textContent = nombre.slice(0, 1).toUpperCase(); }
}

function alCambiarUsuario(u) {
  $("#cargando-inicial").hidden = true;
  estado.usuario = u;
  estado.desuscribir?.();
  estado.desuscribir = null;
  if (!u) {
    $("#app").hidden = true;
    $("#ingreso").hidden = false;
    return;
  }
  $("#ingreso").hidden = true;
  $("#app").hidden = false;
  mostrarUsuario(u);
  if (!estado.mapa) iniciarApp();
  estado.mapa.invalidar();
  estado.desuscribir = nube.escucharConsultas(
    (items) => { estado.consultas = items; pintarHistorial(); },
    (e) => toast(`No se pudo cargar tu historial: ${nube.mensajeError(e)}`, "error"));
}

// ============================================================ búsqueda
const PISTAS = {
  ref: {
    placeholder: "Número predial (30 dígitos)",
    html: 'Ej.: <button type="button" class="chip" data-ejemplo="080010105000000040001000000000">0800101050000000400010…</button> También acepta el número anterior (20 dígitos) o uno parcial.',
  },
  dir: {
    placeholder: "Carrera 59 # 64-221",
    html: 'Ej.: <button type="button" class="chip" data-ejemplo="Carrera 17 # 18-61">Carrera 17 # 18-61</button> <button type="button" class="chip" data-ejemplo="Calle 30 # 13C-19">Calle 30 # 13C-19</button>',
  },
};

function elegirTipo(tipo) {
  estado.tipo = tipo;
  $$(".seg").forEach((b) => { b.classList.toggle("activo", b.dataset.tipo === tipo); b.setAttribute("aria-checked", b.dataset.tipo === tipo); });
  const esMapa = tipo === "mapa";
  $("#entrada-texto").hidden = esMapa;
  $("#pista").hidden = esMapa;
  $("#aviso-mapa").hidden = !esMapa;
  document.body.classList.toggle("cursor-mapa", esMapa);
  if (!esMapa) {
    const q = $("#q");
    q.placeholder = PISTAS[tipo].placeholder;
    q.inputMode = tipo === "ref" ? "numeric" : "text";
    $("#pista").innerHTML = PISTAS[tipo].html;
    q.focus();
  }
}

function pasos(n, texto, fraccion) {
  $$("#pasos li").forEach((li) => {
    const p = +li.dataset.paso;
    li.classList.toggle("hecho", p < n || n >= 5);
    li.classList.toggle("activo", p === n);
  });
  const base = [0, 5, 22, 35, 92, 100][Math.min(n, 5)];
  const ancho = n === 3 && fraccion !== undefined ? 35 + 55 * fraccion : base;
  $("#barra-progreso").style.width = `${ancho}%`;
  $("#texto-progreso").textContent = n === 3 && fraccion !== undefined ? `${texto} · ${Math.round(100 * fraccion)}%` : `${texto}…`;
}

async function analizar(busqueda) {
  if (estado.ocupado) return;
  estado.ocupado = true;
  const registro = [];
  $("#btn-buscar").disabled = true;
  $("#error-busqueda").hidden = true;
  $("#vacio").hidden = true;
  $("#resultado").hidden = true;
  $("#progreso").hidden = false;
  pasos(1, "Buscando el lote en el catastro");
  mostrarVista("consulta");
  try {
    const datos = await ejecutar(busqueda, {
      sinCapas: !$("#chk-capas").checked,
      log: (msg, nivel = "") => registro.push({ msg, nivel }),
      etapa: pasos,
    });
    datos.registro = registro;
    estado.actual = { datos, resumen: resumir(datos) };
    pintarResultado();
    estado.mapa.mostrarLote(datos.lote);
  } catch (e) {
    console.error(e);
    const caja = $("#error-busqueda");
    caja.innerHTML = `<b>No se pudo completar la consulta.</b><br>${esc(e.message)}`;
    if (e.opciones?.length) {
      caja.innerHTML += `<div class="opciones">${e.opciones.map((o) => `<button type="button" class="chip" data-ref="${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
      $$("[data-ref]", caja).forEach((b) => b.addEventListener("click", () => { $("#q").value = b.dataset.ref; analizar({ tipo: "ref", valor: b.dataset.ref }); }));
    }
    caja.hidden = false;
    if (!estado.actual) $("#vacio").hidden = false;
    else $("#resultado").hidden = false;
  } finally {
    estado.ocupado = false;
    $("#btn-buscar").disabled = false;
    $("#progreso").hidden = true;
  }
}

// ============================================================ resultado
const ICONO_DESCARGA = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function tarjetaNorma(datos) {
  const p = datos.norma.find((n) => n.principal);
  if (!p) {
    return `<div class="tarjeta-norma sin-tabla"><div class="trat">Tratamiento urbanístico<b>${
      datos.cruces.length ? "No identificado sobre el lote" : "Sin cruce de capas normativas"}</b></div></div>`;
  }
  const nombre = `${titulo(p.tratamiento)}${p.nivel ? " · " + esc(p.nivel) : ""}`;
  const cubre = p.fraccion != null ? ` · cubre ${Math.round(100 * p.fraccion)}% del lote` : "";
  if (p.error) {
    return `<div class="tarjeta-norma sin-tabla"><div class="trat">Tratamiento principal${cubre}<b>${nombre}</b></div>
      <p class="sutil" style="margin-top:8px;font-size:13px">${esc(p.error)}</p></div>`;
  }
  const m = p.maxima, b = p.base;
  if (!m.rango) {
    return `<div class="tarjeta-norma"><div class="trat">Tratamiento principal${cubre}<b>${nombre}</b></div>
      <p style="margin:10px 0 0;font-size:14px">${esc(m.nota)}</p></div>`;
  }
  return `<div class="tarjeta-norma"><div class="trat">Tratamiento principal${cubre}<b>${nombre}</b></div>
    <div class="cifras">
      <div class="cifra"><span>Viviendas máximas</span><b>${m.viviendas_max}</b><small>base ${b.viviendas_max ?? "—"}</small></div>
      <div class="cifra"><span>Altura máxima</span><b>${m.altura_pisos}</b><small>pisos · base ${b.altura_pisos ?? "—"}</small></div>
    </div></div>`;
}

function tablaEscenarios(datos) {
  const filas = datos.norma.filter((n) => !n.error && n.base?.rango).map((n) => `
    <tr><td>${titulo(n.tratamiento)} ${esc(n.nivel)}<small>${esc(n.maxima.rango)}${n.principal ? "" : ` · ${Math.round(100 * (n.fraccion || 0))}%`}</small></td>
      <td>${n.base.viviendas_max} viv<small>${n.base.altura_pisos} pisos · ${fmt(n.base.densidad_viv_m2, 3)}</small></td>
      <td>${n.maxima.viviendas_max} viv<small>${n.maxima.altura_pisos} pisos · ${fmt(n.maxima.densidad_viv_m2, 3)}</small></td></tr>`).join("");
  return filas ? `<table class="tabla-esc"><thead><tr><th>Tratamiento</th><th>Base</th><th>Máxima</th></tr></thead><tbody>${filas}</tbody></table>` : "";
}

function pintarResultado() {
  const { datos, id, nombre } = estado.actual;
  const { lote } = datos;
  const direccion = lote.direcciones[0] || "Lote sin dirección registrada";
  const cont = $("#resultado");
  cont.innerHTML = `
    <div class="res-cab">
      <div>
        <h2>${esc(nombre || direccion)}</h2>
        ${nombre && nombre !== direccion ? `<div class="sutil" style="font-size:13px">${esc(direccion)}</div>` : ""}
        <button class="res-npn" id="copiar-npn" title="Copiar número predial">${esc(lote.npn)}
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>
      </div>
      ${id ? `<span class="etiqueta-guardado">Guardada</span>` : ""}
    </div>
    ${tarjetaNorma(datos)}
    <div class="kpis">
      <div class="kpi"><span>Área ${lote.area_oficial ? "catastral" : "geométrica"}</span><b>${fmt(lote.area_oficial || lote.area, 0)} m²</b></div>
      <div class="kpi"><span>Perímetro</span><b>${fmt(lote.perimetro, 1)} m</b></div>
      <div class="kpi"><span>Construcciones</span><b>${lote.construcciones.length}</b></div>
    </div>
    ${tablaEscenarios(datos)}
    ${datos.avisos.length ? `<ul class="avisos">${datos.avisos.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
    <div class="acciones">
      <button class="btn btn-primario" id="btn-informe">
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z M14 3v5h5 M9 13h6 M9 17h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        Ver informe</button>
      ${id
        ? `<button class="btn btn-secundario" id="btn-reconsultar" title="Consultar de nuevo con datos actualizados">
             <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>Actualizar</button>`
        : `<button class="btn btn-secundario" id="btn-guardar">
             <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>Guardar</button>`}
    </div>
    <div class="descargas">
      <h4>Descargas</h4>
      <button class="descarga" data-archivo="dxf"><span class="ext">DXF</span><div><b>Plano para Revit / AutoCAD</b><small>Coordenadas MAGNA-SIRGAS 9377 · lote, construcciones y cotas</small></div>${ICONO_DESCARGA}</button>
      <button class="descarga" data-archivo="dxf-local"><span class="ext">DXF</span><div><b>Plano en coordenadas locales</b><small>Origen en el centroide del lote</small></div>${ICONO_DESCARGA}</button>
      <button class="descarga" data-archivo="html"><span class="ext naranja">HTML</span><div><b>Informe</b><small>Ficha completa para compartir o imprimir</small></div>${ICONO_DESCARGA}</button>
      <button class="descarga" data-archivo="csv"><span class="ext naranja">CSV</span><div><b>Atributos</b><small>Excel · catastro, norma y capas</small></div>${ICONO_DESCARGA}</button>
      <button class="descarga" data-archivo="geojson"><span class="ext">GEO</span><div><b>GeoJSON</b><small>QGIS / Google Earth · WGS84</small></div>${ICONO_DESCARGA}</button>
    </div>
    ${datos.registro?.length ? `<details class="registro"><summary>Registro de la consulta (${datos.registro.length})</summary><ol>${
      datos.registro.map((r) => `<li class="${esc(r.nivel)}">${esc(r.msg)}</li>`).join("")}</ol></details>` : ""}`;
  cont.hidden = false;
  $("#vacio").hidden = true;

  $("#copiar-npn").addEventListener("click", () => navigator.clipboard?.writeText(lote.npn).then(() => toast("Número predial copiado")));
  $("#btn-informe").addEventListener("click", verInforme);
  $("#btn-guardar")?.addEventListener("click", () => abrirDialogoGuardar());
  $("#btn-reconsultar")?.addEventListener("click", () => analizar(datos.busqueda));
  $$(".descarga", cont).forEach((b) => b.addEventListener("click", () => descargarArchivo(b.dataset.archivo)));
  $$(".item").forEach((li) => li.classList.toggle("activo", li.dataset.id === id));
}

const nombreBase = () => `lote_${estado.actual.datos.lote.npn || "baq"}`;

function verInforme() {
  const { datos } = estado.actual;
  const url = URL.createObjectURL(new Blob([informe(datos, dxf(datos.lote))], { type: "text/html" }));
  const w = window.open(url, "_blank");
  if (!w) descargar(`${nombreBase()}_informe.html`, informe(datos, dxf(datos.lote)), "text/html");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function descargarArchivo(tipo) {
  const { datos } = estado.actual;
  const b = nombreBase();
  if (tipo === "dxf") descargar(`${b}.dxf`, dxf(datos.lote).texto, "application/dxf");
  if (tipo === "dxf-local") descargar(`${b}_local.dxf`, dxf(datos.lote, { local: true }).texto, "application/dxf");
  if (tipo === "html") descargar(`${b}_informe.html`, informe(datos, dxf(datos.lote)), "text/html");
  if (tipo === "csv") descargar(`${b}_atributos.csv`, csv(datos), "text/csv");
  if (tipo === "geojson") descargar(`${b}.geojson`, geojson(datos.lote), "application/geo+json");
}

// ============================================================ guardar / editar
let edicion = null; // id de la consulta que se edita, o null para guardar la actual

function abrirDialogoGuardar(item = null) {
  edicion = item?.id || null;
  const dlg = $("#dlg-guardar"), f = $("#form-guardar");
  $("#dlg-guardar-titulo").textContent = item ? "Editar consulta" : "Guardar consulta";
  $("#btn-confirmar-guardar").textContent = item ? "Guardar cambios" : "Guardar";
  const lote = estado.actual?.datos.lote;
  f.nombre.value = item ? item.nombre : (lote?.direcciones[0] || `Lote ${lote?.npn || ""}`);
  f.notas.value = item ? item.notas || "" : "";
  $("#guardar-error").hidden = true;
  dlg.showModal();
  f.nombre.select();
}

async function confirmarGuardar(ev) {
  const dlg = $("#dlg-guardar"), f = $("#form-guardar");
  if (ev.submitter?.value !== "ok") return;
  ev.preventDefault();
  const nombre = f.nombre.value.trim(), notas = f.notas.value.trim();
  if (!nombre) { f.nombre.focus(); return; }
  const boton = $("#btn-confirmar-guardar");
  try {
    await conBoton(boton, async () => {
      if (edicion) {
        await nube.editarConsulta(edicion, { nombre, notas });
        if (estado.actual?.id === edicion) Object.assign(estado.actual, { nombre, notas });
        toast("Cambios guardados");
      } else {
        const { id, recortado } = await nube.guardarConsulta({ nombre, notas, resumen: estado.actual.resumen, datos: estado.actual.datos });
        Object.assign(estado.actual, { id, nombre, notas });
        toast(recortado ? "Consulta guardada (sin geometría detallada de construcciones por tamaño)" : "Consulta guardada en tu cuenta");
      }
    });
    dlg.close();
    if (estado.actual) pintarResultado();
  } catch (e) {
    const p = $("#guardar-error");
    p.textContent = nube.mensajeError(e);
    p.hidden = false;
  }
}

// ============================================================ historial
function pintarHistorial() {
  const items = estado.consultas;
  $("#contador").textContent = items.length;
  const filtro = $("#filtro").value.trim().toLowerCase();
  const visibles = items.filter((it) => !filtro || [it.nombre, it.notas, it.resumen?.direccion, it.resumen?.npn, it.resumen?.tratamiento]
    .some((v) => String(v || "").toLowerCase().includes(filtro)));
  $("#historial-vacio").hidden = items.length > 0;
  $("#lista").innerHTML = visibles.map((it) => {
    const r = it.resumen || {};
    return `<li class="item${estado.actual?.id === it.id ? " activo" : ""}" data-id="${esc(it.id)}" tabindex="0">
      <h4>${esc(it.nombre)}</h4>
      <div class="sub">${esc(r.direccion && r.direccion !== it.nombre ? r.direccion : r.npn)}</div>
      <div class="item-acciones">
        <button class="btn-icono" data-accion="editar" title="Editar nombre y notas" aria-label="Editar"><svg width="15" height="15" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></button>
        <button class="btn-icono" data-accion="borrar" title="Eliminar" aria-label="Eliminar"><svg width="15" height="15" viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3m-7 0 1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></button>
      </div>
      ${it.notas ? `<div class="notas">${esc(it.notas)}</div>` : ""}
      <div class="meta">
        ${r.tratamiento ? `<span class="pastilla verde">${esc(titulo(r.tratamiento))}</span>` : ""}
        ${r.viviendas_max != null ? `<span class="pastilla">${r.viviendas_max} viv · ${r.pisos_max} pisos</span>` : ""}
        ${r.area ? `<span class="pastilla">${fmt(r.area, 0)} m²</span>` : ""}
        <span class="fecha">${fechaCorta(it.creado)}</span>
      </div></li>`;
  }).join("") || (items.length ? '<li class="vacio"><p>Ninguna consulta coincide con el filtro.</p></li>' : "");
  estado.mapa?.guardados(items, abrirGuardada);
}

async function abrirGuardada(id) {
  const it = estado.consultas.find((c) => c.id === id);
  mostrarVista("historial");
  $$(".item").forEach((li) => li.classList.toggle("activo", li.dataset.id === id));
  try {
    const c = await nube.abrirConsulta(id);
    estado.actual = { datos: c.datos, resumen: c.resumen, id, nombre: c.nombre, notas: c.notas };
    $("#error-busqueda").hidden = true;
    pintarResultado();
    estado.mapa.mostrarLote(c.datos.lote);
    mostrarVista("consulta");
  } catch (e) {
    toast(`No se pudo abrir «${it?.nombre || "la consulta"}»: ${nube.mensajeError(e)}`, "error");
  }
}

async function accionHistorial(ev) {
  const li = ev.target.closest(".item");
  if (!li) return;
  const it = estado.consultas.find((c) => c.id === li.dataset.id);
  const accion = ev.target.closest("[data-accion]")?.dataset.accion;
  if (accion === "editar") return abrirDialogoGuardar(it);
  if (accion === "borrar") {
    if (!(await confirmar("¿Eliminar consulta?", `Se eliminará «${it.nombre}» de tu cuenta. Esta acción no se puede deshacer.`))) return;
    try {
      await nube.borrarConsulta(it.id);
      if (estado.actual?.id === it.id) { delete estado.actual.id; pintarResultado(); }
      toast("Consulta eliminada");
    } catch (e) { toast(nube.mensajeError(e), "error"); }
    return;
  }
  abrirGuardada(it.id);
}

function mostrarVista(vista) {
  $$(".pestana").forEach((p) => { p.classList.toggle("activa", p.dataset.vista === vista); p.setAttribute("aria-selected", p.dataset.vista === vista); });
  $("#vista-consulta").hidden = vista !== "consulta";
  $("#vista-historial").hidden = vista !== "historial";
  $("#leyenda").hidden = false;
}

// ============================================================ mapa
function clicMapa(latlng) {
  if (estado.ocupado) return;
  const busqueda = { tipo: "punto", x: +latlng.lng.toFixed(7), y: +latlng.lat.toFixed(7), sr: 4326 };
  if (estado.tipo === "mapa") { estado.mapa.cerrarPopup(); return analizar(busqueda); }
  const pop = estado.mapa.popup(latlng, `<div class="popup-lote"><b>¿Analizar este lote?</b>
    <span class="sutil">${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</span>
    <button class="btn btn-primario" type="button">Analizar lote</button></div>`);
  pop.getElement()?.querySelector("button")?.addEventListener("click", () => { estado.mapa.cerrarPopup(); analizar(busqueda); });
}

// ============================================================ arranque
function iniciarApp() {
  estado.mapa = new Mapa("mapa", { alClic: clicMapa });

  $$(".seg").forEach((b) => b.addEventListener("click", () => elegirTipo(b.dataset.tipo)));
  $("#pista").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-ejemplo]");
    if (chip) { $("#q").value = chip.dataset.ejemplo; $("#form-busqueda").requestSubmit(); }
  });
  $("#form-busqueda").addEventListener("submit", (e) => {
    e.preventDefault();
    const valor = $("#q").value.trim();
    if (!valor) return $("#q").focus();
    analizar({ tipo: estado.tipo, valor });
  });

  $$(".pestana").forEach((p) => p.addEventListener("click", () => mostrarVista(p.dataset.vista)));
  $("#filtro").addEventListener("input", pintarHistorial);
  $("#lista").addEventListener("click", accionHistorial);
  $("#lista").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.classList.contains("item")) accionHistorial(e); });
  $("#form-guardar").addEventListener("submit", confirmarGuardar);

  $$(".capas-base button").forEach((b) => b.addEventListener("click", () => {
    $$(".capas-base button").forEach((x) => { x.classList.toggle("activo", x === b); x.setAttribute("aria-checked", x === b); });
    estado.mapa.base(b.dataset.base);
  }));
  $("#chk-predios").addEventListener("change", (e) => estado.mapa.linderos(e.target.checked));

  const menu = $("#menu-usuario"), btnU = $("#btn-usuario");
  btnU.addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btnU.setAttribute("aria-expanded", !menu.hidden); });
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) { menu.hidden = true; btnU.setAttribute("aria-expanded", "false"); } });
  $("#btn-salir").addEventListener("click", async () => {
    menu.hidden = true;
    estado.actual = null;
    $("#resultado").hidden = true;
    $("#vacio").hidden = false;
    estado.mapa.limpiarLote();
    await nube.salir();
  });
  window.addEventListener("resize", () => estado.mapa.invalidar());
  elegirTipo("ref");
  $("#leyenda").hidden = false;
}

async function arrancar() {
  document.documentElement.dataset.version = VERSION;
  iniciarIngreso();
  try { await cargarNorma(); } catch (e) { toast(e.message, "error"); }
  nube.alCambiarUsuario(alCambiarUsuario);
}

arrancar();

// Sustituto de nube.js para probar la interfaz sin iniciar sesión (solo local)
let consultas = [], oyentes = [];
const avisar = () => oyentes.forEach((f) => f([...consultas]));
export const LIMITE_BYTES = 900000;
export const mensajeError = (e) => e?.message || String(e);
export const alCambiarUsuario = (fn) => setTimeout(() => fn({ uid: "demo", displayName: "Juan Barona", email: "demo@lifecity.com.co" }), 200);
export const ingresarGoogle = async () => {}; export const ingresarCorreo = async () => {};
export const registrarCorreo = async () => {}; export const recuperarClave = async () => {}; export const salir = async () => {};
export function empaquetar(d) { return { json: JSON.stringify(d), recortado: false }; }
export async function guardarConsulta({ nombre, notas, resumen, datos }) {
  const id = "c" + Date.now(); consultas.unshift({ id, nombre, notas, resumen, busqueda: datos.busqueda, creado: new Date(), _d: JSON.stringify(datos) }); avisar(); return { id, recortado: false };
}
export function escucharConsultas(fn) { oyentes.push(fn); fn([...consultas]); return () => {}; }
export async function abrirConsulta(id) { const c = consultas.find((x) => x.id === id); return { ...c, datos: JSON.parse(c._d) }; }
export async function editarConsulta(id, cambios) { Object.assign(consultas.find((x) => x.id === id), cambios); avisar(); }
export async function borrarConsulta(id) { consultas = consultas.filter((x) => x.id !== id); avisar(); }

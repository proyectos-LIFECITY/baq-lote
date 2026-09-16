// Firebase: autenticación y consultas guardadas por usuario
//   users/{uid}/consultas/{id}                 nombre, notas, resumen, busqueda (liviano, para el historial)
//   users/{uid}/consultas/{id}/detalle/datos   resultado completo en JSON
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  GoogleAuthProvider, createUserWithEmailAndPassword, getAuth, onAuthStateChanged, sendPasswordResetEmail,
  signInWithEmailAndPassword, signInWithPopup, signOut, updateProfile,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  collection, doc, getDoc, getFirestore, onSnapshot, orderBy, query, serverTimestamp, updateDoc, writeBatch,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.languageCode = "es";
const db = getFirestore(app);

export const LIMITE_BYTES = 900_000; // Firestore admite ~1 MiB por documento

const MENSAJES = {
  "auth/invalid-credential": "Correo o contraseña incorrectos.",
  "auth/invalid-email": "El correo no es válido.",
  "auth/email-already-in-use": "Ya existe una cuenta con ese correo. Ingresa o recupera la contraseña.",
  "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
  "auth/popup-closed-by-user": "Se cerró la ventana de Google antes de terminar.",
  "auth/popup-blocked": "El navegador bloqueó la ventana de Google. Permite ventanas emergentes.",
  "auth/too-many-requests": "Demasiados intentos. Espera unos minutos.",
  "auth/network-request-failed": "Sin conexión. Revisa tu internet.",
  "auth/operation-not-allowed": "Este método de ingreso no está activado en Firebase.",
  "auth/configuration-not-found": "La autenticación aún no está activada en el proyecto de Firebase.",
  "permission-denied": "No tienes permiso para esta operación.",
};
export const mensajeError = (e) => MENSAJES[e?.code] || e?.message || String(e);

export const alCambiarUsuario = (fn) => onAuthStateChanged(auth, fn);
export const ingresarGoogle = () => signInWithPopup(auth, new GoogleAuthProvider());
export const ingresarCorreo = (correo, clave) => signInWithEmailAndPassword(auth, correo, clave);
export async function registrarCorreo(nombre, correo, clave) {
  const cred = await createUserWithEmailAndPassword(auth, correo, clave);
  if (nombre) await updateProfile(cred.user, { displayName: nombre });
  return cred;
}
export const recuperarClave = (correo) => sendPasswordResetEmail(auth, correo);
export const salir = () => signOut(auth);

const coleccion = () => {
  if (!auth.currentUser) throw new Error("Inicia sesión para guardar consultas.");
  return collection(db, "users", auth.currentUser.uid, "consultas");
};

/** Reduce el resultado si supera el límite de Firestore (sin tocar lo esencial). */
export function empaquetar(datos) {
  let json = JSON.stringify(datos);
  let recortado = false;
  if (json.length > LIMITE_BYTES) {
    const lote = { ...datos.lote, construcciones: datos.lote.construcciones.map((c) => ({ ...c, rings_wgs84: null })) };
    json = JSON.stringify({ ...datos, lote });
    recortado = true;
  }
  if (json.length > LIMITE_BYTES) {
    json = JSON.stringify({ ...datos, cruces: datos.cruces.filter((c) => /tratam/i.test(c.titulo)) });
  }
  if (json.length > LIMITE_BYTES) throw new Error("El resultado es demasiado grande para guardarlo.");
  return { json, recortado };
}

export async function guardarConsulta({ nombre, notas = "", resumen, datos }) {
  const { json, recortado } = empaquetar(datos);
  const ref = doc(coleccion());
  const lote = writeBatch(db);
  lote.set(ref, {
    nombre: nombre.slice(0, 140), notas: notas.slice(0, 2000), resumen, busqueda: datos.busqueda,
    version: datos.version, bytes: json.length, creado: serverTimestamp(), actualizado: serverTimestamp(),
  });
  lote.set(doc(ref, "detalle", "datos"), { json });
  await lote.commit();
  return { id: ref.id, recortado };
}

export function escucharConsultas(fn, alError) {
  const q = query(coleccion(), orderBy("creado", "desc"));
  return onSnapshot(q, (snap) => fn(snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))), alError);
}

export async function abrirConsulta(id) {
  const [cab, det] = await Promise.all([getDoc(doc(coleccion(), id)), getDoc(doc(coleccion(), id, "detalle", "datos"))]);
  if (!cab.exists() || !det.exists()) throw new Error("La consulta ya no existe.");
  return { id, ...cab.data(), datos: JSON.parse(det.data().json) };
}

export const editarConsulta = (id, cambios) =>
  updateDoc(doc(coleccion(), id), { ...cambios, actualizado: serverTimestamp() });

export async function borrarConsulta(id) {
  const lote = writeBatch(db);
  lote.delete(doc(coleccion(), id, "detalle", "datos"));
  lote.delete(doc(coleccion(), id));
  await lote.commit();
}

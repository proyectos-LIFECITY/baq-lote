// Genera web/test/demo.html: la app con una sesión simulada (sin Firebase) para probar la interfaz en local.
// Uso: npm run demo  →  http://localhost:5000/test/demo.html
import { readFileSync, writeFileSync } from "node:fs";
const html = readFileSync(new URL("../app.html", import.meta.url), "utf8").replace("<head>",
  '<head>\n  <base href="/">\n  <script type="importmap">{"imports":{"http://localhost:5000/js/nube.js":"http://localhost:5000/test/nube-demo.js"}}</script>');
writeFileSync(new URL("./demo.html", import.meta.url), html);
console.log("web/test/demo.html generado; abre http://localhost:5000/test/demo.html con npm run dev");

/**
 * Directorio privado de archivos subidos (UPLOADS_DIR); se crea si no existe.
 * Código movido desde src/server.js (tarea 1.7); las rutas relativas suben un nivel más (../ → ../../)
 * para seguir apuntando a la raíz del proyecto.
 */
require("./env");
const fs = require("fs");
const path = require("path");

// Configurar directorio de subidas privado (fuera del directorio estático público)
const UPLOADS_DIR =
  process.env.UPLOADS_DIR || path.join(__dirname, "../../storage/uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

module.exports = { UPLOADS_DIR };

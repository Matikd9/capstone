/**
 * Carga de variables de entorno: .env y, si DB_HOST no está definido y existe, .env.production.
 * Código movido desde src/server.js (tarea 1.7); las rutas relativas suben un nivel más (../ → ../../)
 * para seguir apuntando a la raíz del proyecto.
 */
const fs = require("fs");
const path = require("path");

require("dotenv").config();
if (
  !process.env.DB_HOST &&
  fs.existsSync(path.join(__dirname, "../../.env.production"))
) {
  require("dotenv").config({
    path: path.join(__dirname, "../../.env.production"),
  });
}

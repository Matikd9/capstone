/**
 * Entorno seguro y determinista para las pruebas.
 * Debe requerirse ANTES que cualquier módulo de src/: fija las variables que esos módulos leen al cargarse.
 *
 * - Nunca usa producción: host de BD local, NODE_ENV=test, sin Gemini ni SMTP reales.
 * - Cambia el directorio de trabajo a una carpeta temporal para que dotenv no cargue el .env del proyecto
 *   (src/geminiOcr.js lo recarga con override y pisaría estas variables).
 * - Los archivos subidos van a una carpeta temporal, no a storage/uploads.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LOCAL_DB_HOSTS = ["db", "localhost", "127.0.0.1"];
const inheritedHost = process.env.DB_HOST;
const inheritedIsLocal = LOCAL_DB_HOSTS.includes(inheritedHost);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexxo-test-"));
const uploadsDir = path.join(tmpRoot, "uploads");
fs.mkdirSync(uploadsDir);

const adminPassword = `Test-${crypto.randomBytes(12).toString("hex")}`;

Object.assign(process.env, {
  NODE_ENV: "test",
  JWT_SECRET: crypto.randomBytes(48).toString("hex"),
  ADMIN_DEFAULT_PASSWORD: adminPassword,
  // Valor centinela: impide cargar .env.production y deja a Gemini como "no disponible".
  GEMINI_API_KEY: "tu_api_key_aqui",
  DB_HOST:
    process.env.TEST_DB_HOST ||
    (inheritedIsLocal ? inheritedHost : "127.0.0.1"),
  DB_PORT: process.env.TEST_DB_PORT || "3306",
  DB_USER: process.env.TEST_DB_USER || "root",
  DB_PASSWORD:
    process.env.TEST_DB_PASSWORD ||
    (inheritedIsLocal && process.env.DB_PASSWORD) ||
    "rootpassword", // valor público de docker-compose.yml (solo BD local)
  DB_SSL: "false",
  DB_NAME: "web_app_test_sin_asignar",
  UPLOADS_DIR: uploadsDir,
});
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

if (!LOCAL_DB_HOSTS.includes(process.env.DB_HOST)) {
  throw new Error(
    `Las pruebas solo se ejecutan contra una BD local (host actual: ${process.env.DB_HOST}).`,
  );
}

process.chdir(tmpRoot);
// Limpieza al terminar el proceso (pruebas unitarias y de integración). Windows no borra la carpeta de trabajo actual.
process.on("exit", () => {
  process.chdir(os.tmpdir());
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Silencia el log de la aplicación (ver con TEST_VERBOSE=1); los errores quedan capturados para aserciones.
const capturedErrors = [];
if (!process.env.TEST_VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = (...args) => capturedErrors.push(args.map(String).join(" "));
}

module.exports = { adminPassword, uploadsDir, tmpRoot, capturedErrors };

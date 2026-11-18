/**
 * Configuración de conexión a MySQL (local) / TiDB Cloud (producción, TLS) / socket de Cloud SQL.
 * En producción exige DB_HOST, DB_USER y DB_PASSWORD (lanza un error al cargarse si faltan).
 * Código movido sin cambios desde src/server.js (tarea 1.7).
 * initDB() modifica dbConfig.host (fallback a 127.0.0.1): se exporta el mismo objeto, no una copia.
 */
require("./env");

// Configuración DB MySQL / TiDB (Compatible con desarrollo local TCP, TiDB Cloud TLS y sockets Unix Cloud SQL)
const isProduction = process.env.NODE_ENV === "production";
// En producción no hay credenciales por defecto: deben venir del entorno (Cloud Run / Secret Manager).
if (isProduction) {
  const missingDbVars = ["DB_HOST", "DB_USER", "DB_PASSWORD"].filter(
    (name) => !process.env[name],
  );
  if (missingDbVars.length > 0) {
    throw new Error(
      `Faltan variables de entorno de base de datos en producción: ${missingDbVars.join(", ")}.`,
    );
  }
}
// Valores por defecto solo para la BD local de docker-compose.yml.
const defaultHost = "db";
const defaultPort = isProduction ? 4000 : 3306;
const defaultUser = "root";
const defaultPassword = "rootpassword";

const host = process.env.DB_HOST || defaultHost;
const isCloudSqlSocket = host && host.startsWith("/cloudsql/");
const requiresSsl =
  process.env.DB_SSL === "true" ||
  host.includes("tidbcloud.com") ||
  (isProduction && !isCloudSqlSocket);

const dbConfig = {
  user: process.env.DB_USER || defaultUser,
  password: process.env.DB_PASSWORD || defaultPassword,
  database: process.env.DB_NAME || "web_app",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ...(requiresSsl
    ? { ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true } }
    : {}),
  ...(isCloudSqlSocket
    ? { socketPath: host }
    : {
        host: host,
        port: parseInt(process.env.DB_PORT || String(defaultPort), 10),
      }),
};

module.exports = { dbConfig };

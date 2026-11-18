const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { createWorker } = require("tesseract.js");
const rateLimit = require("express-rate-limit");
require("dotenv").config();
if (
  !process.env.DB_HOST &&
  fs.existsSync(path.join(__dirname, "../.env.production"))
) {
  require("dotenv").config({
    path: path.join(__dirname, "../.env.production"),
  });
}

const geminiOcr = require("./geminiOcr");
const mailer = require("./mailer");
const mammoth = require("mammoth");
const auth = require("./auth");
const fileSecurity = require("./security/fileSecurity");
const crypto = require("crypto");
const helmet = require("helmet");
const { AppError, errorHandler, notFoundApi, redact } = require("./errors");
const { schemas, validate } = require("./validation");
const documentDecision = require("./documentDecision");
const { runMigrations } = require("./db/migrate");
const { ensureSeedData } = require("./db/seeds");

// Evitar que errores asíncronos internos de workers OCR tumben el proceso Node.js
let serverListening = false;
process.on("uncaughtException", (err) => {
  console.error(
    "[Proceso - Excepción Capturada]:",
    redact(err && err.message ? err.message : err),
  );
  // Un error de arranque (configuración inválida) debe terminar el proceso con error, no quedar oculto.
  if (!serverListening) process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(
    "[Proceso - Promesa Rechazada]:",
    redact(reason && reason.message ? reason.message : reason),
  );
});

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

// Configurar directorio de subidas privado (fuera del directorio estático público)
const UPLOADS_DIR =
  process.env.UPLOADS_DIR || path.join(__dirname, "../storage/uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Limitadores de tasa (Anti-DoS y mitigación de abuso de cuota/servicios)
const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas solicitudes. Por favor intente más tarde." },
});

const ocrRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // 30 solicitudes OCR por IP cada 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      "Límite de solicitudes de análisis OCR alcanzado. Espere unos minutos antes de intentar nuevamente.",
  },
});

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      "Demasiados intentos fallidos de autenticación. Bloqueo temporal por 15 minutos.",
  },
});

// Cabeceras HTTP de seguridad. El único <script> inline (login.html) se autoriza por hash, calculado al arrancar.
const inlineScriptHashes = [
  ...fs
    .readFileSync(path.join(__dirname, "admin_portal/login.html"), "utf8")
    .matchAll(/<script>([\s\S]*?)<\/script>/g),
].map(
  (m) =>
    `'sha256-${crypto.createHash("sha256").update(m[1]).digest("base64")}'`,
);
const isProductionEnv = process.env.NODE_ENV === "production";
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", ...inlineScriptHashes],
        // shortcut: admin.js usa 12 onclick inline y la exportación un onclick de impresión; migrarlos a addEventListener para quitar esto
        "script-src-attr": ["'unsafe-inline'"],
        "style-src": [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com",
        ],
        "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
        "img-src": ["'self'", "data:", "blob:"],
        "media-src": ["'self'", "blob:"],
        "connect-src": ["'self'"],
        "frame-src": ["'self'"],
        "frame-ancestors": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
        "upgrade-insecure-requests": isProductionEnv ? [] : null,
      },
    },
    // HSTS solo en producción: en localhost (HTTP) fijaría HTTPS en el navegador.
    strictTransportSecurity: isProductionEnv
      ? { maxAge: 15552000, includeSubDomains: true }
      : false,
    crossOriginEmbedderPolicy: false,
  }),
);
// La cámara es necesaria para la selfie del mini-test (Fase 1.5); el resto de APIs sensibles se deniega.
app.use((req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
  );
  next();
});

// Aumentar límites para transferencia de documentos y fotos
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
// public/uploads (archivos legacy) nunca se sirve como estático: solo vía /uploads/:filename, con autenticación.
const publicStatic = express.static(path.join(__dirname, "../public"));
app.use((req, res, next) => {
  let p;
  try {
    p = path.posix.normalize(decodeURIComponent(req.path).replace(/\\/g, "/"));
  } catch (e) {
    return res.status(400).end();
  }
  if (/^\/uploads(\/|$)/i.test(p)) return next();
  publicStatic(req, res, next);
});

// Aplicar Rate Limiting a rutas de API y autenticación
app.use("/api/", generalApiLimiter);
app.use("/api/ocr/", ocrRateLimiter);
app.use("/api/auth/admin-login", loginRateLimiter);
// Defensa CSRF para rutas autenticadas por cookie
app.use("/api/", auth.requireSameOrigin);

// ==========================================
// RUTAS EXCLUSIVAS DEL PORTAL RR.HH.
// ==========================================
app.get("/admin/login", (req, res) => {
  res.sendFile(path.join(__dirname, "admin_portal/login.html"));
});

app.get("/admin", async (req, res) => {
  try {
    const user = await auth.getAdminFromSessionToken(
      auth.parseCookies(req)[auth.ADMIN_COOKIE],
    );
    if (!user) return res.redirect(302, "/admin/login");
    res.sendFile(path.join(__dirname, "admin_portal/admin.html"));
  } catch (err) {
    res.redirect(302, "/admin/login");
  }
});

// Bloqueo explícito de la URL pública previa
app.get("/admin.html", (req, res) => {
  res.status(404).send("Not Found");
});

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

let pool;

const VALID_STATES = [
  "POSTULADO",
  "DESCARTADO_TECNICO",
  "PRESELECCIONADO",
  "APROBADO_FAENA",
  "DOCS_CARGADOS",
  "EN_REVISION_MANUAL",
  "PRE_ACREDITADO",
  "CONTRATADO_FAENA",
  // Compatibilidad con registros antiguos
  "Pendiente",
  "Aprobado",
  "Rechazado",
];

async function initDB(retries = 10, delay = 3000) {
  const targetDb = process.env.DB_NAME || "web_app";
  const isTiDB =
    (process.env.DB_HOST && process.env.DB_HOST.includes("tidbcloud.com")) ||
    process.env.DB_PORT === "4000";
  const envMode = isTiDB
    ? "PRODUCCIÓN (TiDB Cloud)"
    : "DESARROLLO LOCAL (MySQL)";

  let connected = false;
  let lastError = null;
  for (let i = 0; i < retries; i++) {
    try {
      console.log(
        `[DB] Conectando a ${envMode} (Intento ${i + 1}/${retries})...`,
      );
      console.log(
        `[DB] Configuración: host=${dbConfig.host || dbConfig.socketPath}, port=${dbConfig.port || "default"}, db=${targetDb}`,
      );

      // 1. Intentar conexión directa al pool con la base de datos objetivo
      try {
        pool = mysql.createPool(dbConfig);
        const testConn = await pool.getConnection();
        testConn.release();
      } catch (connErr) {
        // Si la base de datos no existe aún (ER_BAD_DB_ERROR / 1049), conectamos a 'test' o sin DB para crearla
        if (connErr.code === "ER_BAD_DB_ERROR" || connErr.errno === 1049) {
          console.log(
            `[DB] La base de datos '${targetDb}' no existe. Creándola automáticamente en TiDB/MySQL...`,
          );
          const adminConnConfig = { ...dbConfig, database: "test" };
          const adminConn = await mysql.createConnection(adminConnConfig);
          await adminConn.query(
            `CREATE DATABASE IF NOT EXISTS \`${targetDb}\`;`,
          );
          await adminConn.end();
          pool = mysql.createPool(dbConfig);
        } else {
          throw connErr;
        }
      }

      connected = true;
      break;
    } catch (err) {
      lastError = err;
      console.error(`[DB Error] ${err.message}`);
      if (err.code === "ENOTFOUND" && dbConfig.host === "db") {
        console.warn(
          `[DB Aviso] Host 'db' no encontrado fuera de Docker. Cambiando host a '127.0.0.1'...`,
        );
        dbConfig.host = "127.0.0.1";
      }
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  if (!connected) {
    throw new Error(
      `No se pudo conectar a la base de datos tras ${retries} intentos (último error: ${lastError ? lastError.message : "desconocido"}).`,
    );
  }

  // Esquema: migraciones numeradas en src/db/migrations. Si una falla, el error se propaga y el servidor no arranca.
  await runMigrations(pool);

  // Datos semilla OBLIGATORIOS: cargos, banco de preguntas (TECNICA / SJT) y módulo de administradores
  // (initAdminAuth deja lista la autenticación; crear el usuario "admin" depende de ADMIN_DEFAULT_PASSWORD y solo avisa).
  // Sin ellos el portal no puede evaluar postulantes: si fallan, el arranque se detiene.
  try {
    const conn = await pool.getConnection();
    try {
      await ensureSeedData(conn);
      const [[seeded]] = await conn.query(
        `SELECT (SELECT COUNT(*) FROM positions) AS cargos,
                (SELECT COUNT(*) FROM questions WHERE category = 'TECNICA') AS tecnicas,
                (SELECT COUNT(*) FROM questions WHERE category = 'SJT') AS sjt`,
      );
      if (!(seeded.cargos > 0 && seeded.tecnicas > 0 && seeded.sjt > 0)) {
        throw new Error(
          `faltan datos (cargos=${seeded.cargos}, preguntas TECNICA=${seeded.tecnicas}, SJT=${seeded.sjt})`,
        );
      }
    } finally {
      conn.release();
    }
    await auth.initAdminAuth(pool);
  } catch (seedErr) {
    throw new Error(
      `No se inicializaron los datos semilla obligatorios: ${seedErr.message}`,
    );
  }
}

// Función auxiliar de sanitización HTML para prevenir Stored XSS
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Función auxiliar para guardar imágenes Base64 / PDFs con validación de seguridad
function saveBase64File(base64Data, prefix = "file") {
  if (!base64Data) return { url: null, absolutePath: null, error: null };
  try {
    const matches = base64Data.match(/^data:([A-Za-z0-9-+\/\.]+);base64,(.*)$/);
    const buffer = matches
      ? Buffer.from(matches[2], "base64")
      : Buffer.from(base64Data, "base64");

    if (!buffer || buffer.length === 0) {
      return {
        url: null,
        absolutePath: null,
        error: "El archivo está vacío o dañado.",
      };
    }

    // 1. Detectar tipo real de archivo examinando Magic Bytes de cabecera
    const realType = fileSecurity.detectRealFileType(buffer);

    // Bloquear inmediatamente ejecutables o scripts maliciosos camuflados
    if (
      realType === "executable_pe" ||
      realType === "executable_elf" ||
      realType === "executable_script"
    ) {
      console.warn(
        `[Seguridad Archivos] Intento de subida de ejecutable bloqueado (${prefix})`,
      );
      return {
        url: null,
        absolutePath: null,
        error:
          "Archivo ejecutable o binario bloqueado por políticas de ciberseguridad.",
      };
    }

    // Solo se aceptan formatos que el OCR y el visor pueden procesar, según el contenido real (no el MIME declarado).
    // HEIC y .doc antiguo quedan fuera: ni Tesseract, ni mammoth, ni el visor del panel los leen.
    if (!["pdf", "docx", "jpg", "png", "webp"].includes(realType)) {
      return {
        url: null,
        absolutePath: null,
        error:
          "Formato no admitido. Suba un archivo PDF, JPG, PNG, WEBP o DOCX.",
      };
    }
    const extension = realType;

    // 2. Escáner heurístico de macros y scripts peligrosos
    const scan = fileSecurity.scanDocumentHeuristics(buffer, extension);
    if (!scan.isSafe) {
      console.warn(
        `[Seguridad Archivos] Amenaza detectada: ${scan.threatReason}`,
      );
      return { url: null, absolutePath: null, error: scan.threatReason };
    }

    // 3. Generar nombre criptográficamente seguro (no enumerable ni predecible)
    const filename = fileSecurity.generateSecureFilename(prefix, extension);
    const filepath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filepath, buffer);

    // 4. Persistir permanentemente en TiDB Cloud para que los archivos no se pierdan al reiniciar Cloud Run
    if (!prefix.startsWith("tmp_") && pool) {
      let mimeType = "application/octet-stream";
      if (extension === "pdf") mimeType = "application/pdf";
      else if (extension === "jpg") mimeType = "image/jpeg";
      else if (extension === "png") mimeType = "image/png";
      else if (extension === "docx")
        mimeType =
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

      pool
        .query(
          "INSERT INTO file_storage (filename, mime_type, file_data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE file_data = VALUES(file_data)",
          [filename, mimeType, buffer],
        )
        .catch((dbErr) => {
          console.warn(
            `[File Storage DB Warning] Error respaldando ${filename} en TiDB:`,
            dbErr.message,
          );
        });
    }

    return { url: `/uploads/${filename}`, absolutePath: filepath, error: null };
  } catch (e) {
    console.error("Error guardando archivo Base64:", e);
    return {
      url: null,
      absolutePath: null,
      error: "Error procesando archivo.",
    };
  }
}

function formatTitleCase(str) {
  if (!str) return "";
  return str
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : ""))
    .join(" ");
}

function formatRut(rawRut) {
  if (!rawRut) return null;
  const clean = rawRut.replace(/[^0-9kK]/g, "").toUpperCase();
  if (clean.length < 8 || clean.length > 9) return null;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  const formattedBody = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${formattedBody}-${dv}`;
}

function normalizeTextForMatch(str) {
  if (!str) return "";
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

const MONTH_MAP = {
  ENE: 1,
  ENERO: 1,
  FEB: 2,
  FEBRERO: 2,
  MAR: 3,
  MARZO: 3,
  ABR: 4,
  ABRIL: 4,
  MAY: 5,
  MAYO: 5,
  JUN: 6,
  JUNIO: 6,
  JUL: 7,
  JULIO: 7,
  AGO: 8,
  AGOSTO: 8,
  SEP: 9,
  SEPT: 9,
  SEPTIEMBRE: 9,
  SETIEMBRE: 9,
  OCT: 10,
  OCTUBRE: 10,
  NOV: 11,
  NOVIEMBRE: 11,
  DIC: 12,
  DICIEMBRE: 12,
};

function extractDatesFromText(rawText) {
  const dates = [];
  if (!rawText) return dates;

  const numDateRegex =
    /\b([0-3]?\d)[\/\-\.]([0-1]?\d)[\/\-\.]((?:19|20)\d{2})\b|\b((?:19|20)\d{2})[\/\-\.]([0-1]?\d)[\/\-\.]([0-3]?\d)\b/g;
  for (const m of rawText.matchAll(numDateRegex)) {
    if (m[1]) {
      dates.push({
        day: parseInt(m[1], 10),
        month: parseInt(m[2], 10),
        year: parseInt(m[3], 10),
      });
    } else if (m[4]) {
      dates.push({
        year: parseInt(m[4], 10),
        month: parseInt(m[5], 10),
        day: parseInt(m[6], 10),
      });
    }
  }

  const textDateRegex =
    /\b([0-3]?\d)\s*(?:DE\s+|\.|\-|\s)\s*(ENE(?:RO)?|FEB(?:RERO)?|MAR(?:ZO)?|ABR(?:IL)?|MAY(?:O)?|JUN(?:IO)?|JUL(?:IO)?|AGO(?:STO)?|SEP(?:T(?:IEMBRE)?)?|SETIEMBRE|OCT(?:UBRE)?|NOV(?:IEMBRE)?|DIC(?:IEMBRE)?)\.?\s*(?:DE\s+|\.|\-|\s)\s*((?:19|20)\d{2})\b/gi;
  for (const m of rawText.matchAll(textDateRegex)) {
    const day = parseInt(m[1], 10);
    const monthKey = m[2].toUpperCase().replace(".", "");
    const month = MONTH_MAP[monthKey];
    const year = parseInt(m[3], 10);
    if (month) {
      dates.push({ day, month, year });
    }
  }

  return dates.filter(
    (d) => d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= 31,
  );
}

// Etiquetas legítimas de campos de nombre que pueden preceder al nombre del titular en una misma línea
const FIELD_LABEL_PREFIX_REGEX =
  /\b(?:FOTO\s+OFICIAL|NOMBRE\s+COMPLETO|NOMBRE\s+DEL\s+TITULAR|NOMBRE\s+DEL\s+POSTULANTE|NOMBRE\s+DEL\s+TRABAJADOR|NOMBRE\s+DEL\s+ALUMNO|CERTIFICA\s+QUE|APELLIDOS?|NOMBRES?|POSTULANTE|TRABAJADOR|TITULAR|ALUMNO|FOTO|OFICIAL)\b\s*:?\s*/gi;

// Palabras de contexto que DESCALIFICAN por completo una línea o frase como nombre de persona
// (Nunca se deben borrar dejando el resto de la línea, para no convertir "Universidad Adolfo Ibáñez" en "Adolfo Ibáñez"
// ni "Constructora Miguel Morales" en "Miguel Morales")
const NON_NAME_CONTEXT_WORDS = new Set([
  // Instituciones educativas y términos académicos
  "UNIVERSIDAD",
  "UNIVERSITARIO",
  "UNIVERSITARIA",
  "INSTITUTO",
  "COLEGIO",
  "LICEO",
  "ESCUELA",
  "FACULTAD",
  "ACADEMIA",
  "CAMPUS",
  "SEDE",
  "CENTRO",
  "CFT",
  "DUOC",
  "INACAP",
  "AIEP",
  "EDUCACION",
  "FORMACION",
  "ACADEMICA",
  "ACADEMICO",
  "ESTUDIOS",
  "CURSANDO",
  "EGRESADO",
  "TITULADO",
  "GRADUADO",
  "MEMORIA",
  "TESIS",
  "DISTINCION",
  "MAXIMA",
  "PRACTICA",
  "OPERARIA",
  "CURSOS",
  "CURSO",
  "CERTIFICACION",
  "CERTIFICACIONES",
  "DIPLOMADO",
  "MAGISTER",
  "DOCTORADO",
  "PREGRADO",
  "POSTGRADO",
  "LICENCIATURA",
  "LICENCIADO",
  "BACHILLERATO",
  "ALUMNO",
  "ESTUDIANTE",
  // Cargos, profesiones y oficios
  "INGENIERIA",
  "INGENIERO",
  "TECNICO",
  "TECNOLOGO",
  "ANALISTA",
  "BODEGUERO",
  "BODEGERO",
  "JORNAL",
  "OPERADOR",
  "SOLDADOR",
  "RIGGER",
  "MANIOBRISTA",
  "MAESTRO",
  "CAPATAZ",
  "SUPERVISOR",
  "JEFE",
  "GERENTE",
  "DIRECTOR",
  "CONSULTOR",
  "ASISTENTE",
  "AYUDANTE",
  "MECANICO",
  "ELECTRICO",
  "ELECTROMECANICO",
  "PREVENCIONISTA",
  "CONDUCTOR",
  "CHOFER",
  "OCUPACION",
  "PROFESION",
  "PROFESIONAL",
  "CARGO",
  "PUESTO",
  "ESPECIALIDAD",
  "MENCION",
  "TECNOLOGIAS",
  "INFORMACION",
  // Empresas, organizaciones e industria
  "CONSTRUCTORA",
  "CONSULTORIA",
  "EMPRESA",
  "SOCIEDAD",
  "COMPANIA",
  "CORPORACION",
  "FUNDACION",
  "GRUPO",
  "CABAL",
  "HOLDING",
  "MINERA",
  "DIVISION",
  "CODELCO",
  "TENIENTE",
  "MANDANTE",
  "CONTRATISTA",
  "SUBCONTRATISTA",
  "SERVICIOS",
  "SERVICIO",
  "COMERCIAL",
  "INDUSTRIAL",
  "INFORMATICO",
  "SOLUCIONES",
  "TECHSOLUTIONS",
  "GLOBAL",
  "SPA",
  "LTDA",
  "LIMITADA",
  "CLINICA",
  "HOSPITAL",
  "MUTUAL",
  "ACHS",
  "IST",
  "SERNAGEOMIN",
  "CHILEVALORA",
  "SENCE",
  "ALLIANCE",
  "SCRUM",
  "BIZAGI",
  "POWER",
  "DOCKER",
  "PYTHON",
  "EXCEL",
  // Secciones de CV, habilidades y descriptores
  "CURRICULUM",
  "VITAE",
  "INFOGRAFIA",
  "GRAFICO",
  "SIMPLE",
  "AZUL",
  "AMARILLO",
  "RESUMEN",
  "PERFIL",
  "EXPERIENCIA",
  "LABORAL",
  "HABILIDADES",
  "COMPETENCIAS",
  "CARACTERISTICAS",
  "CONTACTO",
  "TELEFONO",
  "CORREO",
  "REFERENCIAS",
  "OBJETIVO",
  "IDIOMAS",
  "ESPANOL",
  "INGLES",
  "NATIVO",
  "AVANZADO",
  "HERRAMIENTAS",
  "METODOLOGIAS",
  "AGILES",
  "KANBAN",
  "MEJORA",
  "CONTINUA",
  "NEGOCIO",
  "MODELAMIENTO",
  "OPTIMIZACION",
  "LOGISTICA",
  "ANALITICA",
  "TABLEROS",
  "PIPELINES",
  "BASES",
  "DISTRIBUIDAS",
  "REEMPLAZO",
  "LICENCIA",
  "PROYECTO",
  "PROYECTOS",
  "DATOS",
  "GESTION",
  "OPERACIONES",
  "PROCESOS",
  "EQUIPO",
  "TRABAJO",
  "DISPOSICION",
  "ORATORIA",
  "AFABLE",
  "EXTROVERTIDO",
  "RESPONSABLE",
  "PROACTIVO",
  "EDAD",
  "ANOS",
  "NACIONALIDAD",
  "CHILENO",
  "CHILENA",
  "SEXO",
  "OPCIONAL",
  // Direcciones, calles, comunas y ciudades
  "AVENIDA",
  "CALLE",
  "PASAJE",
  "CAMINO",
  "CARRETERA",
  "RUTA",
  "PANAMERICANA",
  "NORTE",
  "SUR",
  "ORIENTE",
  "PONIENTE",
  "COMUNA",
  "CIUDAD",
  "REGION",
  "SECTOR",
  "VILLA",
  "ROBLE",
  "LAMPA",
  "SANTIAGO",
  "RANCAGUA",
  "MACHALI",
  "CALAMA",
  "ANTOFAGASTA",
  "COPIAPO",
  "IQUIQUE",
  "CONCEPCION",
  "VALPARAISO",
  "VINA",
  "MAR",
  "SERENA",
  "COQUIMBO",
  "TEMUCO",
  "TALCA",
  "CURICO",
  "PENALOLEN",
  "PROVIDENCIA",
  "CONDES",
  "MAIPU",
  "QUILICURA",
  "COLINA",
  "CHILE",
  // Fechas, meses y términos legales / documentos oficiales
  "ENERO",
  "FEBRERO",
  "MARZO",
  "ABRIL",
  "MAYO",
  "JUNIO",
  "JULIO",
  "AGOSTO",
  "SEPTIEMBRE",
  "SETIEMBRE",
  "OCTUBRE",
  "NOVIEMBRE",
  "DICIEMBRE",
  "ACTUALIDAD",
  "PRESENTE",
  "ACTUALMENTE",
  "VIGENCIA",
  "EMISION",
  "VENCIMIENTO",
  "NACIMIENTO",
  "FECHA",
  "REPUBLICA",
  "REGISTRO",
  "CIVIL",
  "IDENTIFICACION",
  "CEDULA",
  "NUMERO",
  "DOCUMENTO",
  "FIRMA",
  "INFORMADA",
  "NACIO",
  "CERTIFICADO",
  "ANTECEDENTES",
  "PARTICULARES",
  "FINES",
  "CONDENAS",
  "ANOTACIONES",
  "GENERAL",
  "ESPECIAL",
  "VIOLENCIA",
  "INTRAFAMILIAR",
  "FOLIO",
  "CODIGO",
  "VERIFICACION",
  "TIMBRE",
  "ELECTRONICO",
  "GRATUITO",
  "IMPRESO",
  "ACREDITACION",
  "BAJO",
  "NORMA",
  "ASME",
  "NIVEL",
  "IZAJES",
  "CRITICOS",
  "HOMOLOGADO",
  "ESTANDAR",
  "CONTROL",
  "FATALIDADES",
  "ECF",
  "HABILITANTE",
  "CALIFICACION",
  "CLASE",
  "VALIDO",
  "PARA",
  "INCORPORA",
  "AVANZADA",
  "VERIFIQUE",
  "CENTER",
  "TELEFONOS",
  "FIJOS",
  "CELULARES",
  "PROXIMA",
  "OBTEN",
  "ESTE",
  "NOMBRE",
  "NOMBRES",
  "APELLIDO",
  "APELLIDOS",
  "COMPLETO",
  "TITULAR",
  "POSTULANTE",
  "TRABAJADOR",
  "FOTO",
  "OFICIAL",
  "CERTIFICA",
  "QUE",
  "RUN",
  "RUT",
]);

// Nombres epónimos de universidades, institutos, colegios y calles chilenas que jamás deben tomarse como el postulante
const BLOCKED_EPONYMOUS_NAMES = [
  "ADOLFO IBANEZ",
  "ANDRES BELLO",
  "FEDERICO SANTA MARIA",
  "DIEGO PORTALES",
  "ALBERTO HURTADO",
  "BERNARDO OHIGGINS",
  "BERNARDO O HIGGINS",
  "ARTURO PRAT",
  "GABRIELA MISTRAL",
  "PEDRO DE VALDIVIA",
  "FINIS TERRAE",
  "SANTO TOMAS",
  "SAN SEBASTIAN",
  "VIRGINIO GOMEZ",
  "GUILLERMO SUBERCASEAUX",
  "RAUL SILVA HENRIQUEZ",
  "MIGUEL DE CERVANTES",
  "VICENTE PEREZ ROSALES",
  "MANUEL RODRIGUEZ",
  "VICUNA MACKENNA",
  "BENJAMIN VICUNA MACKENNA",
  "JOSE MIGUEL CARRERA",
  "IGNACIO CARRERA PINTO",
  "ALONSO DE ERCILLA",
];

const NAME_CONNECTORS = /^(de|del|la|las|los|y|san|von|van)$/i;

function normalizeWordForCheck(word) {
  return (word || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase();
}

function isValidPersonName(candidateStr) {
  if (!candidateStr || typeof candidateStr !== "string") return false;

  const normFull = normalizeTextForMatch(candidateStr);
  if (!normFull) return false;

  for (const blocked of BLOCKED_EPONYMOUS_NAMES) {
    if (normFull.includes(blocked)) return false;
  }

  const words = candidateStr.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;

  let mainWordsCount = 0;
  let longWordsCount = 0;

  for (const w of words) {
    const cleanW = w.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ]/g, "");
    if (!cleanW) return false;

    const normW = normalizeWordForCheck(cleanW);
    if (!normW) return false;
    if (NON_NAME_CONTEXT_WORDS.has(normW)) return false;

    if (NAME_CONNECTORS.test(cleanW)) {
      continue;
    }

    // Cada nombre o apellido real debe tener al menos 3 letras (descarta basura de QR como "Ro Xt Ae Tu")
    if (cleanW.length < 3 || cleanW.length > 18) return false;
    // Debe contener al menos una vocal y una consonante
    if (!/[aeiouáéíóúAEIOUÁÉÍÓÚ]/.test(cleanW)) return false;
    if (!/[bcdfghjklmnñpqrstvwxyzBCDFGHJKLMNÑPQRSTVWXYZ]/.test(cleanW))
      return false;
    // Evitar repeticiones de 3 letras iguales seguidas por ruido OCR
    if (/(.)\1\1/i.test(cleanW)) return false;

    mainWordsCount++;
    if (cleanW.length >= 4) longWordsCount++;
  }

  return mainWordsCount >= 2 && longWordsCount >= 2;
}

function pickBestPersonName(candidatesList, referenceNameOrEmail = null) {
  const validList = [];
  const seen = new Set();

  for (const raw of candidatesList || []) {
    if (!raw || typeof raw !== "string") continue;
    const formatted = formatTitleCase(raw);
    if (!isValidPersonName(formatted)) continue;
    const key = normalizeTextForMatch(formatted);
    if (!seen.has(key)) {
      seen.add(key);
      validList.push(formatted);
    }
  }

  if (validList.length === 0) return null;

  let normRef = "";
  let emailLocal = "";
  if (referenceNameOrEmail && typeof referenceNameOrEmail === "string") {
    if (referenceNameOrEmail.includes("@")) {
      emailLocal = referenceNameOrEmail
        .split("@")[0]
        .replace(/[^a-zA-Z]/g, "")
        .toUpperCase();
    } else {
      normRef = normalizeTextForMatch(referenceNameOrEmail);
    }
  }
  const refTokens = normRef
    ? normRef.split(" ").filter((t) => t.length >= 3)
    : [];

  let bestName = validList[0];
  let bestScore = -999;

  for (let idx = 0; idx < validList.length; idx++) {
    const name = validList[idx];
    const words = name.split(/\s+/);
    const normCand = normalizeTextForMatch(name);
    const candTokens = normCand.split(" ").filter((t) => t.length >= 3);

    let score = Math.max(0, 15 - idx * 4);

    // Preferir nombres oficiales completos de 3 a 4 palabras (Nombres + 2 Apellidos) sobre nombres cortos de CV (2 palabras)
    if (words.length === 4) score += 42;
    else if (words.length === 3) score += 38;
    else if (words.length === 2) score += 15;
    else score += 10;

    // Si este nombre más completo contiene todos los tokens de otro nombre más corto de la lista (ej. "Cristóbal Mena Illanes" contiene "Cristóbal Mena")
    for (const other of validList) {
      if (other === name) continue;
      const otherTokens = normalizeTextForMatch(other)
        .split(" ")
        .filter((t) => t.length >= 3);
      if (otherTokens.length >= 2 && otherTokens.length < candTokens.length) {
        const allIncluded = otherTokens.every((t) => candTokens.includes(t));
        if (allIncluded) score += 45;
      }
    }

    // Cruce con nombre de referencia
    if (refTokens.length > 0) {
      const matched = refTokens.filter((t) => normCand.includes(t)).length;
      score += matched * 50;
    }

    // Cruce con el correo electrónico del CV (ej. nombre.apellido@correo.cl)
    if (emailLocal.length >= 5) {
      const emailMatched = candTokens.filter((t) =>
        emailLocal.includes(t),
      ).length;
      score += emailMatched * 45;
    }

    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }

  return bestName;
}

// Funciones de apoyo para documentDecision (definidas en este archivo).
const decisionHelpers = {
  isValidRut: (rut) => isValidChileanRutMod11(rut),
  normalize: (text) => normalizeTextForMatch(text),
};

// Construye una fecha solo si existe en el calendario (rechaza 31/02 o 99/99 en vez de desbordar al mes siguiente).
function buildCalendarDate(year, monthIndex, day) {
  const d = new Date(year, monthIndex, day, 12, 0, 0);
  return d.getFullYear() === year &&
    d.getMonth() === monthIndex &&
    d.getDate() === day
    ? d
    : null;
}

function parseChileanDate(rawDateStr) {
  if (!rawDateStr) return null;
  const str = String(rawDateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split("-").map(Number);
    return buildCalendarDate(y, m - 1, d);
  }
  if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(str)) {
    const parts = str.split(/[\/\-]/).map(Number);
    return buildCalendarDate(parts[2], parts[1] - 1, parts[0]);
  }
  const meses = {
    enero: 0,
    febrero: 1,
    marzo: 2,
    abril: 3,
    mayo: 4,
    junio: 5,
    julio: 6,
    agosto: 7,
    septiembre: 8,
    setiembre: 8,
    octubre: 9,
    noviembre: 10,
    diciembre: 11,
  };
  const match = str
    .toLowerCase()
    .match(/(\d{1,2})\s+(?:de\s+)?([a-z]+)\s+(?:de\s+)?(\d{4})/);
  if (match) {
    const d = parseInt(match[1], 10);
    const mName = match[2];
    const y = parseInt(match[3], 10);
    if (meses[mName] !== undefined) {
      return buildCalendarDate(y, meses[mName], d);
    }
  }
  const fallback = new Date(str);
  return isNaN(fallback.getTime()) ? null : fallback;
}

function isValidChileanRutMod11(rawRut) {
  if (!rawRut) return false;
  const clean = String(rawRut)
    .replace(/[^0-9kK]/g, "")
    .toUpperCase();
  if (clean.length < 8 || clean.length > 9) return false;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  if (!/^\d+$/.test(body)) return false;
  const num = parseInt(body, 10);
  if (num < 1000000 || num > 50000000) return false;
  let sum = 0;
  let mul = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body[i], 10) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const rem = 11 - (sum % 11);
  const expectedDv = rem === 11 ? "0" : rem === 10 ? "K" : String(rem);
  return dv === expectedDv;
}

// Segmenta el texto de un CV en secciones lógicas para evitar confundir datos de Experiencia, Educación o Referencias con Datos de Contacto
function splitCvIntoSections(rawText) {
  const sections = {
    HEADER: [],
    CONTACTO: [],
    PERFIL: [],
    EXPERIENCIA: [],
    EDUCACION: [],
    HABILIDADES: [],
    CARACTERISTICAS: [],
    CURSOS: [],
    REFERENCIAS: [],
  };

  let currentSection = "HEADER";
  const rawLines = (rawText || "").split(/\r?\n/);

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (
      !line ||
      line.startsWith("[PDF_HEADER_NAME]:") ||
      line.startsWith("[---")
    )
      continue;

    const cleanHeader = line
      .replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (
      /^(?:CONTACTO|DATOS\s+PERSONALES|INFORMACI[ÓO]N\s+DE\s+CONTACTO|INFORMACI[ÓO]N\s+PERSONAL|ANTECEDENTES\s+PERSONALES)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "CONTACTO";
      continue;
    }
    if (
      /^(?:PERFIL(?:\s+PROFESIONAL|\s+LABORAL)?|RESUMEN(?:\s+PROFESIONAL|\s+LABORAL|\s+EJECUTIVO)?|SOBRE\s+M[ÍI]|OBJETIVO(?:\s+PROFESIONAL|\s+LABORAL)?|PRESENTACI[ÓO]N)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "PERFIL";
      continue;
    }
    if (
      /^(?:EXPERIENCIA(?:\s+LABORAL|\s+PROFESIONAL|\s+T[ÉE]CNICA|\s+EN\s+FAENA)?|HISTORIAL\s+LABORAL|ANTECEDENTES\s+LABORALES|TRAYECTORIA(?:\s+LABORAL)?)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "EXPERIENCIA";
      continue;
    }
    if (
      /^(?:EDUCACI[ÓO]N|FORMACI[ÓO]N(?:\s+ACAD[ÉE]MICA)?|ESTUDIOS|ANTECEDENTES\s+ACAD[ÉE]MICOS)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "EDUCACION";
      continue;
    }
    if (
      /^(?:HABILIDADES(?:\s+Y\s+COMPETENCIAS)?|COMPETENCIAS|APTITUDES|CONOCIMIENTOS)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "HABILIDADES";
      continue;
    }
    if (
      /^(?:CARACTER[ÍI]STICAS|OTROS\s+DATOS|INFORMACI[ÓO]N\s+ADICIONAL)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "CARACTERISTICAS";
      continue;
    }
    if (
      /^(?:CERTIFICACIONES(?:\s+Y\s+CURSOS)?(?:\s+OPCIONAL)?|CURSOS(?:\s+Y\s+CERTIFICACIONES)?|CAPACITACIONES)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "CURSOS";
      continue;
    }
    if (
      /^(?:REFERENCIAS(?:\s+LABORALES|\s+PROFESIONALES|\s+PERSONALES)?)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "REFERENCIAS";
      continue;
    }

    sections[currentSection].push(line);
  }

  return {
    HEADER: sections.HEADER.join("\n"),
    CONTACTO: sections.CONTACTO.join("\n"),
    PERFIL: sections.PERFIL.join("\n"),
    EXPERIENCIA: sections.EXPERIENCIA.join("\n"),
    EDUCACION: sections.EDUCACION.join("\n"),
    HABILIDADES: sections.HABILIDADES.join("\n"),
    CARACTERISTICAS: sections.CARACTERISTICAS.join("\n"),
    CURSOS: sections.CURSOS.join("\n"),
    REFERENCIAS: sections.REFERENCIAS.join("\n"),
  };
}

// Calcula la experiencia laboral real sumando meses trabajados en la sección de Experiencia,
// ignorando prácticas estudiantiles y años de Educación
function calculateExperienceFromSections(sections, fullTextWithoutRefs) {
  const explicitMatch = (fullTextWithoutRefs || "").match(
    /(\d{1,2})\s*(?:\+\s*)?a[ñn]os?\s+de\s+experiencia/i,
  );
  if (explicitMatch) {
    const yrs = parseInt(explicitMatch[1], 10);
    return { years: yrs, months: yrs * 12 };
  }

  const expText = sections.EXPERIENCIA || "";
  if (!expText) {
    return { years: null, months: null };
  }

  // Si la experiencia solo contiene trabajos de retail/supermercado/panadería y no hay menciones industriales o mineras:
  const isRetailOnly =
    /\b(supermercado|jumbo|lider|panader[íi]a|panadero|cajer[oa]|reponedor|garz[óo]n|mesero|comida\s+r[áa]pida|mcdonald|retail|falabella|ripley|atenci[óo]n\s+al\s+cliente)\b/i.test(
      expText,
    );
  const hasIndustrialOrMining =
    /\b(miner[íi]a|minera|faena|parada|planta|concentradora|fundici[óo]n|refiner[íi]a|montaje|mantenimiento|izaje|rigger|soldad|calderer|maquinaria|ecf|subterr[áa]nea|rajo|codelco|bhp|anglo|pelambres|collahuasi|chute|tub[ée]r|piping|mecanic|estructur)\b/i.test(
      expText,
    );

  if (isRetailOnly && !hasIndustrialOrMining) {
    return { years: 0, months: 0 };
  }

  // Excluir bloques de prácticas estudiantiles/operarias/profesionales (ej. "Practica operaria ... enero-febrero 2025")
  const cleanedExp = expText.replace(
    /\bpr[áa]ctica\s+(?:operaria|profesional|laboral|industrial|estudiantil|universitaria|t[ée]cnica)[\s\S]{0,140}?\b(?:19|20)\d{2}\b/gi,
    " ",
  );
  const normExp = cleanedExp.replace(/\s+/g, " ");

  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;
  const workedMonths = new Set();

  const addMonthRange = (y1, m1, y2, m2) => {
    if (!y1 || !y2 || y1 < 1980 || y2 > curY + 1) return;
    const startIdx = y1 * 12 + (m1 - 1);
    const endIdx = y2 * 12 + (m2 - 1);
    if (endIdx < startIdx || endIdx - startIdx > 45 * 12) return;
    for (let idx = startIdx; idx <= endIdx; idx++) {
      workedMonths.add(idx);
    }
  };

  const monthNamesPattern =
    "ENE(?:RO)?|FEB(?:RERO)?|MAR(?:ZO)?|ABR(?:IL)?|MAY(?:O)?|JUN(?:IO)?|JUL(?:IO)?|AGO(?:STO)?|SEP(?:T(?:IEMBRE)?)?|SETIEMBRE|OCT(?:UBRE)?|NOV(?:IEMBRE)?|DIC(?:IEMBRE)?";
  const presentPattern =
    "ACTUALIDAD|PRESENTE|ACTUALMENTE|VIGENCIA\\s+ACTUAL|AL\\s+D[ÍI]A\\s+DE\\s+HOY|HOY";

  let workingStr = normExp;

  // 1. Rango "Mes Año - Mes Año" o "Mes Año - Actualidad"
  const rangeMonthYearRegex = new RegExp(
    `\\b(${monthNamesPattern})\\.?\\s*(?:de\\s+)?((?:19|20)\\d{2})\\s*(?:[\\-–—/]|a|hasta)\\s*(?:(${monthNamesPattern})\\.?\\s*(?:de\\s+)?((?:19|20)\\d{2})|(${presentPattern}))\\b`,
    "gi",
  );
  workingStr = workingStr.replace(
    rangeMonthYearRegex,
    (match, m1Str, y1Str, m2Str, y2Str, presStr) => {
      const m1 = MONTH_MAP[m1Str.toUpperCase().replace(".", "")];
      const y1 = parseInt(y1Str, 10);
      if (presStr) {
        addMonthRange(y1, m1, curY, curM);
      } else {
        const m2 = MONTH_MAP[m2Str.toUpperCase().replace(".", "")];
        const y2 = parseInt(y2Str, 10);
        addMonthRange(y1, m1, y2, m2);
      }
      return " ";
    },
  );

  // 2. Rango dentro del mismo año "Mes1 - Mes2 Año" (ej. "enero-febrero 2025")
  const sameYearMonthsRegex = new RegExp(
    `\\b(${monthNamesPattern})\\.?\\s*(?:[\\-–—/]|a)\\s*(${monthNamesPattern})\\.?\\s*(?:de\\s+)?((?:19|20)\\d{2})\\b`,
    "gi",
  );
  workingStr = workingStr.replace(
    sameYearMonthsRegex,
    (match, m1Str, m2Str, yStr) => {
      const m1 = MONTH_MAP[m1Str.toUpperCase().replace(".", "")];
      const m2 = MONTH_MAP[m2Str.toUpperCase().replace(".", "")];
      const y = parseInt(yStr, 10);
      addMonthRange(y, m1, y, m2);
      return " ";
    },
  );

  // 3. Mes único puntual "Mes Año" (ej. "julio 2021" -> 1 mes)
  const singleMonthYearRegex = new RegExp(
    `\\b(${monthNamesPattern})\\.?\\s*(?:de\\s+)?((?:19|20)\\d{2})\\b`,
    "gi",
  );
  workingStr = workingStr.replace(
    singleMonthYearRegex,
    (match, m1Str, y1Str) => {
      const m1 = MONTH_MAP[m1Str.toUpperCase().replace(".", "")];
      const y1 = parseInt(y1Str, 10);
      addMonthRange(y1, m1, y1, m1);
      return " ";
    },
  );

  // 4. Rango de años puros "Año1 - Año2 / Actualidad"
  const yearRangeRegex = new RegExp(
    `\\b((?:19|20)\\d{2})\\s*(?:[\\-–—/]|a|hasta)\\s*(?:((?:19|20)\\d{2})|(${presentPattern}))\\b`,
    "gi",
  );
  workingStr.replace(yearRangeRegex, (match, y1Str, y2Str, presStr) => {
    const y1 = parseInt(y1Str, 10);
    if (presStr) {
      addMonthRange(y1, 1, curY, curM);
    } else {
      const y2 = parseInt(y2Str, 10);
      addMonthRange(y1, 1, y2, 12);
    }
    return " ";
  });

  if (workedMonths.size === 0) {
    return { years: null, months: null };
  }

  const totalMonths = workedMonths.size;
  const totalYears = Math.floor(totalMonths / 12);
  return { years: totalYears, months: totalMonths };
}

// Analizador OCR general para documentos de Fase 1 (CV / Credencial) y Fase 2 (Carnet / Antecedentes)
function parseExtractedText(rawText) {
  if (!rawText) {
    return {
      detected_name: null,
      detected_rut: null,
      detected_email: null,
      detected_phone: null,
      detected_city: null,
      detected_experience_years: null,
      detected_experience_months: null,
      detected_credencial_status: null,
      birth_date: null,
      detected_age: null,
      carnet_vigencia: null,
      antecedentes_status: null,
    };
  }

  const currentYear = new Date().getFullYear();

  // Segmentar CV en secciones lógicas y aislar la sección de REFERENCIAS para no tomar datos de terceros
  const cvSections = splitCvIntoSections(rawText);
  const textWithoutRefs = [
    cvSections.HEADER,
    cvSections.CONTACTO,
    cvSections.PERFIL,
    cvSections.EXPERIENCIA,
    cvSections.EDUCACION,
    cvSections.HABILIDADES,
    cvSections.CARACTERISTICAS,
    cvSections.CURSOS,
  ]
    .filter(Boolean)
    .join("\n");

  const personalContactText = [
    cvSections.HEADER,
    cvSections.CONTACTO,
    cvSections.CARACTERISTICAS,
  ]
    .filter(Boolean)
    .join("\n");

  // Extraer pista de encabezado visual del PDF si fue inyectada por extractTextFromPdfWithPoppler
  let pdfHeaderName = null;
  const pdfHeaderMatch = rawText.match(/^\[PDF_HEADER_NAME\]:\s*(.+)$/m);
  if (pdfHeaderMatch && pdfHeaderMatch[1]) {
    const candidateHeader = formatTitleCase(pdfHeaderMatch[1].trim());
    if (isValidPersonName(candidateHeader)) {
      pdfHeaderName = candidateHeader;
    }
  }

  // 0. Detectar Zona de Lectura Mecánica (MRZ ICAO) del reverso de la Cédula de Identidad Chilena
  // Ejemplo MRZ Línea 2: 0404192M3404193CHL21559457<2<6
  // Ejemplo MRZ Línea 3: MEDINA<PAVEZ<<MATIAS<ALONSO<<< o MENA<ILLANES<<CRISTOBAL<<<<<<<
  let mrzName = null;
  let mrzRut = null;
  let mrzBirthDate = null;
  let mrzAge = null;
  let mrzExpiryDateObj = null;
  let mrzExpiryFormatted = null;

  const mrzDataMatch = rawText.match(
    /(\d{6})\d[MF<«](\d{6})\dCHL\s*(\d{7,8})\s*[<«\-K\s]\s*([0-9K])/i,
  );
  if (mrzDataMatch) {
    const bYY = parseInt(mrzDataMatch[1].slice(0, 2), 10);
    const bMM = parseInt(mrzDataMatch[1].slice(2, 4), 10);
    const bDD = parseInt(mrzDataMatch[1].slice(4, 6), 10);
    const birthYear = bYY <= currentYear % 100 ? 2000 + bYY : 1900 + bYY;
    if (bMM >= 1 && bMM <= 12 && bDD >= 1 && bDD <= 31) {
      mrzBirthDate = `${String(bDD).padStart(2, "0")}/${String(bMM).padStart(2, "0")}/${birthYear}`;
      const today = new Date();
      let age = today.getFullYear() - birthYear;
      const mDiff = today.getMonth() + 1 - bMM;
      if (mDiff < 0 || (mDiff === 0 && today.getDate() < bDD)) age--;
      mrzAge = age;
    }

    const eYY = parseInt(mrzDataMatch[2].slice(0, 2), 10);
    const eMM = parseInt(mrzDataMatch[2].slice(2, 4), 10);
    const eDD = parseInt(mrzDataMatch[2].slice(4, 6), 10);
    const expYear = 2000 + eYY;
    if (eMM >= 1 && eMM <= 12 && eDD >= 1 && eDD <= 31) {
      mrzExpiryDateObj = new Date(expYear, eMM - 1, eDD);
      mrzExpiryFormatted = `${String(eDD).padStart(2, "0")}/${String(eMM).padStart(2, "0")}/${expYear}`;
    }

    mrzRut = formatRut(`${mrzDataMatch[3]}-${mrzDataMatch[4]}`);
  }

  const mrzNameMatch = rawText.match(
    /([A-ZÑ]{3,})\s*[<«]+\s*([A-ZÑ]{3,})\s*[<«]{1,}\s*([A-ZÑ]+(?:[\s<«]+[A-ZÑ]+)*)/i,
  );
  if (mrzNameMatch) {
    const ap1 = mrzNameMatch[1].trim();
    const ap2 = mrzNameMatch[2].trim();
    const nomTokens = mrzNameMatch[3]
      .split(/[\s<«]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !/^[CKLX]+$/i.test(t));
    if (nomTokens.length > 0) {
      const candidateMrzName = formatTitleCase(
        `${nomTokens.join(" ")} ${ap1} ${ap2}`,
      );
      if (isValidPersonName(candidateMrzName)) {
        mrzName = candidateMrzName;
      }
    }
  }

  // 1. Extraer RUT / RUN chileno (ignorando sección de Referencias y validando Módulo 11 en números sin etiqueta)
  let detectedRut = mrzRut || null;
  if (!detectedRut) {
    const rutLabelMatch = textWithoutRefs.match(
      /(?:R\.?U\.?[NT]\.?|CEDULA\s+DE\s+IDENTIDAD)[^\d]{0,35}(\d{1,2}(?:[\.\s]\d{3}){2}[\-\s]?[0-9kK]|\d{7,8}[\-\s]?[0-9kK])/i,
    );
    if (rutLabelMatch && rutLabelMatch[1]) {
      detectedRut = formatRut(rutLabelMatch[1]);
    }
  }
  if (!detectedRut) {
    const genericRutMatches = [
      ...textWithoutRefs.matchAll(
        /\b(\d{1,2}(?:[\.\s]\d{3}){2}[\-][0-9kK]|\d{7,8}[\-][0-9kK])\b/g,
      ),
    ];
    for (const m of genericRutMatches) {
      if (isValidChileanRutMod11(m[1])) {
        detectedRut = formatRut(m[1]);
        break;
      }
    }
  }

  // 2. Extraer Email, Teléfono y Ciudad de Residencia (estrictamente desde Contacto/Encabezado, nunca desde Experiencia, Educación ni Referencias)
  const emailMatch =
    personalContactText.match(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    ) ||
    textWithoutRefs.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  const detectedEmail = emailMatch ? emailMatch[0].toLowerCase() : null;

  // 2a. Extracción de Teléfono Chileno (Etiqueta explícita o patrón numérico móvil)
  let detectedPhone = null;
  const combinedContactText = `${personalContactText}\n${textWithoutRefs}`;

  // Prioridad 1: Etiqueta explícita de contacto (Teléfono, Celular, Fono, WhatsApp, Móvil, Wsp, Cel)
  const explicitPhoneMatch = combinedContactText.match(
    /(?:tel[eé]fono|celular|m[oó]vil|fono|whatsapp|cel|wsp|contact[o]?)\s*[:.-]?\s*(\+?56[\s.-]*)?(?:9[\s.-]*)?(\d{4}[\s.-]*\d{4}|\d{8})/i,
  );
  if (explicitPhoneMatch) {
    const rawDigits = explicitPhoneMatch[0].replace(/\D/g, "");
    if (rawDigits.length >= 8) {
      const p8 = rawDigits.slice(-8);
      detectedPhone = `+56 9 ${p8.slice(0, 4)} ${p8.slice(4)}`;
    }
  }

  // Prioridad 2: Patrón genérico móvil chileno (ej. +56 9 8765 4321, 987654321, 9 8765 4321, etc.)
  if (!detectedPhone) {
    const phoneRegex =
      /(?:\+?56[\s.-]*)?9[\s.-]*\d{4}[\s.-]*\d{4}|\b9\d{8}\b|\b(?:\+?56[\s.-]*)?9[\s.-]*\d{8}\b/;
    const phoneMatch =
      personalContactText.match(phoneRegex) ||
      textWithoutRefs.match(phoneRegex);
    if (phoneMatch) {
      const rawDigits = phoneMatch[0].replace(/\D/g, "");
      if (rawDigits.length >= 8) {
        const p8 = rawDigits.slice(-8);
        detectedPhone = `+56 9 ${p8.slice(0, 4)} ${p8.slice(4)}`;
      }
    }
  }

  let detectedCity = null;
  const cityNamesRegex =
    /\b(Santiago|Rancagua|Machal[íi]|Calama|Antofagasta|Copiap[óo]|Iquique|Concepci[óo]n|Valpara[íi]so|Vi[ñn]a\s+del\s+Mar|La\s+Serena|Coquimbo|Talca|Temuco|Puerto\s+Montt|Punta\s+Arenas|Arica|Curic[óo]|Los\s+Andes|San\s+Fernando|Coya|Lampa|Colina|Quilicura|Maip[úu]|Puente\s+Alto|San\s+Bernardo|Providencia|Las\s+Condes|Pe[ñn]alol[ée]n)\b/i;

  // 2a. Primero buscar etiqueta explícita de residencia ("Ciudad:", "Comuna:", "Residencia:", "Domicilio:", "Ubicación:")
  const explicitCityLabel = personalContactText.match(
    /(?:Ciudad|Comuna|Residencia|Domicilio|Ubicaci[óo]n)\s*:\s*([^\n•|]+)/i,
  );
  if (explicitCityLabel && explicitCityLabel[1]) {
    const mCity = explicitCityLabel[1].match(cityNamesRegex);
    if (mCity) detectedCity = formatTitleCase(mCity[1]);
  }

  // 2b. Si no hay etiqueta explícita, buscar únicamente en las líneas de HEADER y CONTACTO (jamás en EXPERIENCIA ni EDUCACION)
  if (!detectedCity) {
    const headerAndContactLines = `${cvSections.HEADER}\n${cvSections.CONTACTO}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    for (const line of headerAndContactLines) {
      // Descartar líneas que mencionen universidades, empresas, reemplazos, prácticas o cargos
      if (
        /\b(?:Universidad|Instituto|Colegio|Liceo|Escuela|Reemplazo|Pr[áa]ctica|Constructora|Empresa|Grupo|Consultor[íi]a|Faena|Planta|Divisi[óo]n|Mandante)\b/i.test(
          line,
        )
      ) {
        continue;
      }
      const mCity = line.match(cityNamesRegex);
      if (mCity) {
        detectedCity = formatTitleCase(mCity[1]);
        break;
      }
    }
  }

  // 3. Extraer Años y Meses reales de Experiencia desde la sección EXPERIENCIA (ignorando prácticas estudiantiles y años de Educación)
  const expCalc = calculateExperienceFromSections(cvSections, textWithoutRefs);
  const detectedExpYears = expCalc.years;
  const detectedExpMonths = expCalc.months;

  // 4. Detectar tipo y vigencia de Credencial Técnica (Rigger, Soldador WPQ, Licencia Clase D / Hoja de Vida)
  let credencialStatus = null;
  const hasRigger =
    /\b(RIGGER|IZAJE|MANIOBRISTA|B30\.5|B30\.9|CHILEVALORA|GRUAS?)\b/i.test(
      rawText,
    );
  const hasSoldador =
    /\b(SOLDADOR|SOLDADURA|WPQ|AWS|3G|4G|6G|MIG|TIG|SMAW)\b/i.test(rawText);
  const hasOperador =
    /\b(CLASE\s*D|CLASE\s*A4|MAQUINARIA\s*PESADA|CONDUCTOR|EXCAVADORA|CARGADOR\s*FRONTAL)\b/i.test(
      rawText,
    );

  if (hasRigger) credencialStatus = "Credencial Rigger Detectada";
  else if (hasSoldador)
    credencialStatus = "Calificación Soldador (WPQ) Detectada";
  else if (hasOperador)
    credencialStatus = "Licencia Clase D / Conductor Detectada";

  // 5. Extraer Fechas (Nacimiento vs. Vigencia de Cédula / Emisión)
  const candidateDates = extractDatesFromText(rawText);

  let detectedBirthDate = mrzBirthDate || null;
  let detectedAge = mrzAge ?? null;
  let oldestYear = 9999;
  let latestDateObj = mrzExpiryDateObj || null;
  let latestDateFormatted = mrzExpiryFormatted || null;

  for (const d of candidateDates) {
    if (!detectedBirthDate && d.year >= 1940 && d.year <= currentYear - 17) {
      if (d.year < oldestYear) {
        oldestYear = d.year;
        const birthDateObj = new Date(d.year, d.month - 1, d.day);
        const today = new Date();
        let age = today.getFullYear() - birthDateObj.getFullYear();
        const mDiff = today.getMonth() - birthDateObj.getMonth();
        if (
          mDiff < 0 ||
          (mDiff === 0 && today.getDate() < birthDateObj.getDate())
        ) {
          age--;
        }
        detectedAge = age;
        detectedBirthDate = `${String(d.day).padStart(2, "0")}/${String(d.month).padStart(2, "0")}/${d.year}`;
      }
    }
    if (d.year >= 2020 && d.year <= 2040) {
      const dt = new Date(d.year, d.month - 1, d.day);
      if (!latestDateObj || dt > latestDateObj) {
        latestDateObj = dt;
        latestDateFormatted = `${String(d.day).padStart(2, "0")}/${String(d.month).padStart(2, "0")}/${d.year}`;
      }
    }
  }

  if (detectedAge === null) {
    const explicitAgeMatch =
      textWithoutRefs.match(/\bEdad\s*:\s*(\d{2})\s*a[ñn]os\b/i) ||
      textWithoutRefs.match(/\b(\d{2})\s*a[ñn]os\b[\s\S]{0,30}\bChilen[oa]\b/i);
    if (explicitAgeMatch) {
      detectedAge = parseInt(explicitAgeMatch[1], 10);
    }
  }

  let carnetVigencia = null;
  if (latestDateObj) {
    const now = new Date();
    if (latestDateObj >= now) {
      carnetVigencia = `Vigente (Vence: ${latestDateFormatted})`;
    } else {
      carnetVigencia = `Vencido (${latestDateFormatted})`;
    }
  }

  // 6. Extraer Nombre Completo (con descarte contextual estricto de instituciones, cargos, direcciones y referencias)
  let detectedName = mrzName || null;

  const rawLines = textWithoutRefs
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("[PDF_HEADER_NAME]:"));

  const lines = rawLines
    .map((l) =>
      l
        .replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s:]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);

  function stripFieldLabelOnly(line) {
    return (line || "")
      .replace(FIELD_LABEL_PREFIX_REGEX, " ")
      .replace(/:/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (!detectedName) {
    let apellidos = [];
    let nombres = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/\bAPELLIDOS?\b/i.test(line)) {
        const inline = stripFieldLabelOnly(line);
        if (
          inline &&
          !NON_NAME_CONTEXT_WORDS.has(normalizeWordForCheck(inline))
        )
          apellidos.push(inline);
        for (let j = 1; j <= 2 && i + j < lines.length; j++) {
          const nextLine = lines[i + j];
          if (/\b(NOMBRES?|NACIONALIDAD|SEXO|FECHA|RUN|RUT)\b/i.test(nextLine))
            break;
          const cleaned = stripFieldLabelOnly(nextLine);
          if (
            cleaned &&
            !NON_NAME_CONTEXT_WORDS.has(normalizeWordForCheck(cleaned))
          )
            apellidos.push(cleaned);
        }
      } else if (/\bNOMBRES\b/i.test(line)) {
        const inline = stripFieldLabelOnly(line);
        if (
          inline &&
          !NON_NAME_CONTEXT_WORDS.has(normalizeWordForCheck(inline))
        )
          nombres.push(inline);
        if (
          !inline &&
          i + 1 < lines.length &&
          !/\b(APELLIDOS?|NACIONALIDAD|SEXO|FECHA|RUN|RUT)\b/i.test(
            lines[i + 1],
          )
        ) {
          const cleaned = stripFieldLabelOnly(lines[i + 1]);
          if (
            cleaned &&
            !NON_NAME_CONTEXT_WORDS.has(normalizeWordForCheck(cleaned))
          )
            nombres.push(cleaned);
        }
      } else if (
        /\b(?:NOMBRE\s+COMPLETO|NOMBRE\s+DEL\s+TITULAR)\b/i.test(line) ||
        /\b(?:NOMBRE|POSTULANTE|ALUMNO|TRABAJADOR)\s*:/i.test(line)
      ) {
        const inline = stripFieldLabelOnly(line);
        if (isValidPersonName(inline)) {
          detectedName = formatTitleCase(inline);
          break;
        } else {
          for (let j = 1; j <= 2 && i + j < lines.length; j++) {
            const nextLine = lines[i + j];
            if (
              /\b(?:R\s*U\s*T|R\s*U\s*N|FECHA|NACIONALIDAD|SEXO)\b/i.test(
                nextLine,
              )
            )
              break;
            const cleanedNext = stripFieldLabelOnly(nextLine);
            if (isValidPersonName(cleanedNext)) {
              detectedName = formatTitleCase(cleanedNext);
              break;
            }
          }
          if (detectedName) break;
        }
      }
    }

    if (!detectedName && (nombres.length > 0 || apellidos.length > 0)) {
      const combined = [...nombres, ...apellidos]
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (isValidPersonName(combined)) {
        detectedName = formatTitleCase(combined);
      }
    }
  }

  // Si el documento es un PDF con encabezado tipográfico validado (ej. título principal del CV en 1 o 2 líneas), usarlo
  if (!detectedName && pdfHeaderName) {
    detectedName = pdfHeaderName;
  }

  // Fallback para CV o diplomas donde el nombre propio encabeza el documento (buscando solo en HEADER)
  const isIdCardBackOrCert =
    /\b(INCHL|NACIO\s+EN|SIN\s+ANTECEDENTES|REGISTRO\s+GENERAL\s+DE\s+CONDENAS)\b/i.test(
      rawText,
    );
  const headerLines = (cvSections.HEADER || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!detectedName && !isIdCardBackOrCert && headerLines.length > 0) {
    const cvNameCandidates = [];
    const maxScan = Math.min(10, headerLines.length);

    const isCleanSingleWordNameToken = (rawLineStr) => {
      if (!rawLineStr || /[\d@|/\\,•●\-()]/.test(rawLineStr)) return false;
      const cleaned = rawLineStr
        .replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const parts = cleaned.split(/\s+/).filter(Boolean);
      if (parts.length !== 1) return false;
      const w = parts[0];
      if (w.length < 3 || w.length > 18) return false;
      return !NON_NAME_CONTEXT_WORDS.has(normalizeWordForCheck(w));
    };

    for (let i = 0; i < maxScan; i++) {
      const rawLine = headerLines[i];
      if (/[\d@|/\\,•●]/.test(rawLine) || /^\s*[\-*]/.test(rawLine)) continue;

      const cleaned = stripFieldLabelOnly(
        rawLine.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s:]/g, " "),
      );
      if (isValidPersonName(cleaned)) {
        cvNameCandidates.push(formatTitleCase(cleaned));
      } else if (
        i + 1 < maxScan &&
        isCleanSingleWordNameToken(rawLine) &&
        isCleanSingleWordNameToken(headerLines[i + 1])
      ) {
        const twoLineCandidate =
          `${rawLine.trim()} ${headerLines[i + 1].trim()}`.replace(/\s+/g, " ");
        if (isValidPersonName(twoLineCandidate)) {
          cvNameCandidates.push(formatTitleCase(twoLineCandidate));
        }
      }
    }

    if (cvNameCandidates.length > 0) {
      detectedName = pickBestPersonName(cvNameCandidates, detectedEmail);
    }
  }

  // 7. Estado de Antecedentes Penales
  let antecedentesStatus = null;
  if (
    /SIN\s+ANTECEDENTES|SIN\s+ANOTACIONES|NO\s+REGISTRA\s+ANTECEDENTES/i.test(
      rawText,
    )
  ) {
    antecedentesStatus = "Sin Antecedentes (Al día)";
  } else if (/REGISTRA\s+ANTECEDENTES|CON\s+ANTECEDENTES/i.test(rawText)) {
    antecedentesStatus = "Con Anotaciones (Requiere Revisión)";
  }

  return {
    detected_name: detectedName,
    detected_rut: detectedRut,
    detected_email: detectedEmail,
    detected_phone: detectedPhone,
    detected_city: detectedCity,
    detected_experience_years: detectedExpYears,
    detected_experience_months: detectedExpMonths,
    detected_credencial_status: credencialStatus,
    birth_date: detectedBirthDate,
    detected_age: detectedAge,
    carnet_vigencia: carnetVigencia,
    antecedentes_status: antecedentesStatus,
  };
}

// Cola serializada para evitar colisiones concurrentes de workers Tesseract
let ocrQueuePromise = Promise.resolve();

function extractPdfVisualHeaderName(pdfPath) {
  try {
    const xml = execFileSync(
      "pdftotext",
      ["-bbox", "-f", "1", "-l", "1", pdfPath, "-"],
      {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    if (!xml) return null;

    const decodeEntities = (str) =>
      (str || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, code) =>
          String.fromCharCode(parseInt(code, 10)),
        );

    const words = [];
    const wordRegex =
      /<word\s+xMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)">([^<]+)<\/word>/g;
    for (const m of xml.matchAll(wordRegex)) {
      const xMin = parseFloat(m[1]);
      const yMin = parseFloat(m[2]);
      const xMax = parseFloat(m[3]);
      const yMax = parseFloat(m[4]);
      const text = decodeEntities(m[5]).trim();
      if (text) {
        words.push({ xMin, yMin, xMax, yMax, h: yMax - yMin, text });
      }
    }

    if (words.length === 0) return null;

    // Agrupar palabras en líneas visuales según coordenada Y, tamaño de fuente y cercanía horizontal
    const visualLines = [];
    for (const w of words) {
      const prev = visualLines[visualLines.length - 1];
      if (
        prev &&
        Math.abs(w.yMin - prev.yMin) <= 3.5 &&
        Math.abs(w.h - prev.h) <= 3.5 &&
        w.xMin - prev.xMax < 45.0 &&
        w.xMin - prev.xMax >= -10.0
      ) {
        prev.words.push(w.text);
        prev.xMax = Math.max(prev.xMax, w.xMax);
        prev.yMax = Math.max(prev.yMax, w.yMax);
      } else {
        visualLines.push({
          xMin: w.xMin,
          yMin: w.yMin,
          xMax: w.xMax,
          yMax: w.yMax,
          h: w.h,
          words: [w.text],
        });
      }
    }

    // Unir líneas consecutivas de título gigante en la misma columna (ej. "CRISTÓBAL" en línea 1 y "MENA" en línea 2)
    const mergedLines = [];
    for (let i = 0; i < visualLines.length; i++) {
      const cur = visualLines[i];
      if (i + 1 < visualLines.length) {
        const nxt = visualLines[i + 1];
        const sameLargeFont = cur.h >= 13.0 && Math.abs(cur.h - nxt.h) <= 3.5;
        const shortWordCount = cur.words.length <= 2 && nxt.words.length <= 2;
        const sameColumn = Math.abs(cur.xMin - nxt.xMin) < 100.0;
        const verticallyAdjacent =
          nxt.yMin - cur.yMax >= -6.0 && nxt.yMin - cur.yMax <= cur.h * 1.35;
        if (
          sameLargeFont &&
          shortWordCount &&
          sameColumn &&
          verticallyAdjacent
        ) {
          const combinedText = [...cur.words, ...nxt.words].join(" ");
          if (isValidPersonName(combinedText)) {
            mergedLines.push({ h: (cur.h + nxt.h) / 2, text: combinedText });
            i++;
            continue;
          }
        }
      }
      mergedLines.push({ h: cur.h, text: cur.words.join(" ") });
    }

    // Filtrar solo candidatos de nombre de persona válidos con tamaño de título/encabezado (h >= 13pt)
    // y ordenar de mayor a menor tamaño tipográfico
    const validHeaderCandidates = mergedLines
      .filter(
        (l) =>
          l.h >= 13.0 &&
          !/[\d@|/\\,•●]/.test(l.text) &&
          isValidPersonName(l.text),
      )
      .sort((a, b) => b.h - a.h);

    if (validHeaderCandidates.length > 0) {
      return formatTitleCase(validHeaderCandidates[0].text);
    }

    // Respaldo con metadato Author del PDF si coincide con palabras visibles del documento
    const authorMatch = xml.match(/<meta\s+name="Author"\s+content="([^"]+)"/i);
    if (authorMatch && authorMatch[1]) {
      const authorCandidate = formatTitleCase(
        decodeEntities(authorMatch[1]).trim(),
      );
      if (isValidPersonName(authorCandidate)) {
        const visibleNorm = normalizeTextForMatch(
          words.map((w) => w.text).join(" "),
        );
        const authorTokens = normalizeTextForMatch(authorCandidate)
          .split(" ")
          .filter((t) => t.length >= 3);
        if (
          authorTokens.length >= 2 &&
          authorTokens.every((t) => visibleNorm.includes(t))
        ) {
          return authorCandidate;
        }
      }
    }

    return null;
  } catch (err) {
    return null;
  }
}

function extractTextFromPdfWithPoppler(pdfPath) {
  try {
    // Usar -raw primero para mantener juntas las secciones en CVs de 2 columnas sin mezclar columnas en una misma línea
    let out = execFileSync("pdftotext", ["-raw", pdfPath, "-"], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!out || out.trim().length < 15) {
      out = execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    }
    const rawPdfText = (out || "").trim();
    const headerName = extractPdfVisualHeaderName(pdfPath);
    if (headerName && rawPdfText) {
      return `[PDF_HEADER_NAME]: ${headerName}\n${rawPdfText}`;
    }
    return rawPdfText;
  } catch (err) {
    return "";
  }
}

function renderPdfFirstPageToPng(pdfPath) {
  const outPng = `${pdfPath}_page1.png`;
  try {
    execFileSync(
      "gs",
      [
        "-dSAFER",
        "-dBATCH",
        "-dNOPAUSE",
        "-sDEVICE=png16m",
        "-r200",
        "-dFirstPage=1",
        "-dLastPage=1",
        `-sOutputFile=${outPng}`,
        pdfPath,
      ],
      {
        timeout: 15000,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    return fs.existsSync(outPng) ? outPng : null;
  } catch (err) {
    return null;
  }
}

function preprocessImageForOcr(imagePath) {
  const outPath = `${imagePath}_ocr_prep.png`;
  try {
    execFileSync(
      "convert",
      [
        imagePath,
        "-auto-orient",
        "-resize",
        "2000x2000>",
        "-colorspace",
        "Gray",
        "-normalize",
        "-sharpen",
        "0x1.0",
        outPath,
      ],
      {
        timeout: 10000,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    return fs.existsSync(outPath) ? outPath : imagePath;
  } catch (err) {
    return imagePath;
  }
}

// Ejecutar extracción de texto + OCR sobre imágenes (.png/.jpg/.webp) y documentos PDF (.pdf)
async function runTesseractOnFiles(fileItems) {
  const runTask = async () => {
    let combinedText = "";
    const parsedByType = {};

    const validItems = (fileItems || []).filter((item) => {
      if (!item || !item.filePath || !fs.existsSync(item.filePath))
        return false;
      const ext = path.extname(item.filePath).toLowerCase();
      return [
        ".jpg",
        ".jpeg",
        ".png",
        ".webp",
        ".bmp",
        ".pdf",
        ".docx",
        ".doc",
      ].includes(ext);
    });

    if (validItems.length === 0) {
      return { combinedText: "", parsedByType };
    }

    let worker = null;
    const ensureWorker = async () => {
      if (worker) return worker;
      const rootDir = path.join(__dirname, "..");
      const hasLocalTrainedData = fs.existsSync(
        path.join(rootDir, "spa.traineddata"),
      );
      const workerOpts = {
        errorHandler: (err) =>
          console.error(
            "[Tesseract Worker Warning]:",
            err && err.message ? err.message : err,
          ),
      };
      if (hasLocalTrainedData) {
        workerOpts.langPath = rootDir;
        workerOpts.cachePath = rootDir;
        workerOpts.gzip = false;
        workerOpts.cacheMethod = "readOnly";
      }
      worker = await createWorker("spa", 1, workerOpts);
      return worker;
    };

    try {
      for (const item of validItems) {
        const ext = path.extname(item.filePath).toLowerCase();
        let extractedText = "";

        if (ext === ".docx" || ext === ".doc") {
          console.log(
            `[DOCX] Extrayendo texto íntegro de Word (${item.type}): ${path.basename(item.filePath)}...`,
          );
          try {
            const docxRes = await mammoth.extractRawText({
              path: item.filePath,
            });
            extractedText = (docxRes.value || "").trim();
          } catch (mErr) {
            console.error("[DOCX Extraction Error]:", mErr.message);
          }
        } else if (ext === ".pdf") {
          console.log(
            `[OCR/PDF] Extrayendo texto de PDF (${item.type}): ${path.basename(item.filePath)}...`,
          );
          extractedText = extractTextFromPdfWithPoppler(item.filePath);
          if (!extractedText || extractedText.length < 15) {
            const renderedPng = renderPdfFirstPageToPng(item.filePath);
            if (renderedPng) {
              try {
                const w = await ensureWorker();
                const ret = await w.recognize(renderedPng);
                extractedText = (ret.data.text || "").trim();
              } finally {
                try {
                  if (fs.existsSync(renderedPng)) fs.unlinkSync(renderedPng);
                } catch (e) {}
              }
            }
          }
        } else {
          console.log(
            `[OCR] Procesando imagen ${item.type} con tesseract.js: ${path.basename(item.filePath)}...`,
          );
          const prepPath = preprocessImageForOcr(item.filePath);
          try {
            const w = await ensureWorker();
            const ret = await w.recognize(prepPath);
            extractedText = (ret.data.text || "").trim();
          } finally {
            if (prepPath !== item.filePath) {
              try {
                if (fs.existsSync(prepPath)) fs.unlinkSync(prepPath);
              } catch (e) {}
            }
          }
        }

        if (extractedText) {
          combinedText += `[--- ${item.type} ---]\n${extractedText}\n\n`;
          parsedByType[item.type] = parseExtractedText(extractedText);
        }
      }
    } catch (err) {
      console.error("[OCR Error]:", err && err.message ? err.message : err);
    } finally {
      if (worker) {
        try {
          await worker.terminate();
        } catch (e) {}
      }
    }

    return { combinedText: combinedText.trim(), parsedByType };
  };

  const resultPromise = ocrQueuePromise.then(runTask, runTask);
  ocrQueuePromise = resultPromise.catch(() => {});
  return resultPromise;
}

// ============================================================================
// REST ENDPOINTS
// ============================================================================

// ==========================================
// VALIDACIÓN DE ENTRADAS (Zod): se ejecuta antes del handler de cada ruta y descarta campos inesperados
// ==========================================
app.get("/api/positions/:id/questions", validate({ params: schemas.idParam }));
app.post("/api/ocr/phase1", validate({ body: schemas.ocrUpload }));
app.post("/api/ocr/extract", validate({ body: schemas.ocrUpload }));
app.post(
  ["/api/candidates", "/api/candidates/phase1-submit"],
  validate({ body: schemas.phase1Submit }),
);
app.post(
  "/api/candidates/:id/phase2-acreditacion",
  validate({ params: schemas.idParam, body: schemas.phase2Submit }),
);
app.post(
  "/api/candidates/session",
  validate({ body: schemas.candidateSession }),
);
app.post("/api/auth/admin-login", validate({ body: schemas.adminLogin }));
const statusUpdateSchema = schemas.statusUpdate(VALID_STATES);
// Las rutas /api/admin/* validan dentro de su definición, después de requireAdminAuth (401 antes que 400).

// 0. SERVIDOR SEGURO DE DOCUMENTOS PRIVADOS (Con Autenticación y Control de Acceso)
app.get(
  ["/api/files/:filename", "/uploads/:filename"],
  async (req, res, next) => {
    try {
      const rawFilename = req.params.filename;
      if (!rawFilename)
        return res
          .status(400)
          .json({ error: "Nombre de archivo no especificado." });

      // Prevenir ataques de Directory Traversal
      const filename = path.basename(rawFilename);
      const filePath = path.join(UPLOADS_DIR, filename);

      // 1. Obtener buffer del archivo (Caché local en disco o respaldo permanente en TiDB Cloud)
      let fileBuffer = null;
      let fileMime = null;

      if (fs.existsSync(filePath)) {
        fileBuffer = fs.readFileSync(filePath);
      } else {
        // Si el archivo no está en el disco efímero de Cloud Run (ej. tras reinicio), recuperarlo de TiDB Cloud
        try {
          if (pool) {
            const [fRows] = await pool.query(
              "SELECT mime_type, file_data FROM file_storage WHERE filename = ?",
              [filename],
            );
            if (fRows && fRows.length > 0) {
              fileBuffer = fRows[0].file_data;
              fileMime = fRows[0].mime_type;
              // Guardar en caché de disco local para próximas peticiones rápidas
              try {
                fs.writeFileSync(filePath, fileBuffer);
              } catch (e) {}
              console.log(
                `[File Server] Archivo ${filename} restaurado desde TiDB Cloud a disco efímero.`,
              );
            }
          }
        } catch (dbErr) {
          console.warn(
            `[File Server] Error consultando TiDB para ${filename}:`,
            dbErr.message,
          );
        }
      }

      if (!fileBuffer) {
        return res.status(404).json({
          error: "Documento no encontrado o expirado en el servidor.",
        });
      }

      // 2. Verificar si es administrador RR.HH. autenticado (cookie de sesión nexxo_admin)
      const adminUser = await auth.getAdminFromRequest(req);
      let isAuthorized = Boolean(adminUser);

      // 3. Si no es admin, verificar si es el candidato que posee el documento
      //    (cookie de sesión de postulante nexxo_cand)
      const fileLikeSql =
        "(cv_file LIKE ? OR credencial_file LIKE ? OR carnet_file LIKE ? OR carnet_back_file LIKE ? OR antecedentes_file LIKE ? OR initial_selfie LIKE ?)";
      const fileLikeParams = Array(6).fill(`%${filename}`);
      const sessionCid = !isAuthorized && auth.getCandidateIdFromRequest(req);
      if (sessionCid) {
        const [rows] = await pool.query(
          `SELECT id FROM candidates WHERE id = ? AND ${fileLikeSql}`,
          [sessionCid, ...fileLikeParams],
        );
        if (rows.length > 0) isAuthorized = true;
      }

      // 4. Denegar acceso si no está autorizado (Protección Ley N° 19.628 / Datos Personales Sensibles)
      if (!isAuthorized) {
        return res.status(401).json({
          error: "Acceso no autorizado al documento.",
          message:
            "Debe iniciar sesión en RR.HH. o contar con un token válido para acceder a este archivo.",
        });
      }

      // 5. Cabeceras de seguridad y despacho según tipo de archivo
      res.setHeader("X-Content-Type-Options", "nosniff");

      const ext = path.extname(filename).toLowerCase();
      const isDownload =
        req.query.download === "1" || req.query.download === "true";

      const mimeTypes = {
        ".pdf": "application/pdf",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".docx":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".doc": "application/msword",
      };

      // Si se solicita descarga explícita mediante ?download=1
      if (isDownload) {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${encodeURIComponent(filename)}"`,
        );
        res.setHeader(
          "Content-Type",
          fileMime || mimeTypes[ext] || "application/octet-stream",
        );
        return res.send(fileBuffer);
      }

      // Para archivos Word (.docx/.doc), los navegadores web no pueden renderizarlos dentro de un iframe.
      // Los convertimos en HTML seguro mediante mammoth para visualizarlos de forma inmediata y aislada.
      if (ext === ".docx" || ext === ".doc") {
        try {
          const conversion = await mammoth.convertToHtml({
            buffer: fileBuffer,
          });
          const docHtml =
            conversion.value ||
            "<p><em>(Documento sin contenido de texto legible)</em></p>";
          const renderedPage = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(filename)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #1e293b;
      background: #f8fafc;
      padding: 1.5rem 1rem;
      margin: 0;
    }
    .doc-container {
      max-width: 820px;
      margin: 0 auto;
      background: #ffffff;
      padding: 2.5rem;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      border: 1px solid #e2e8f0;
      word-break: break-word;
    }
    h1, h2, h3, h4 { color: #0f172a; margin-top: 1.25em; margin-bottom: 0.5em; }
    p { margin: 0.6em 0; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid #cbd5e1; padding: 6px 10px; text-align: left; font-size: 0.9rem; }
    th { background: #f1f5f9; font-weight: 600; }
    ul, ol { padding-left: 1.5rem; }
    hr { border: 0; border-top: 1px solid #e2e8f0; margin: 1.5rem 0; }
  </style>
</head>
<body>
  <div class="doc-container">
    ${docHtml}
  </div>
</body>
</html>`;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Content-Disposition", "inline");
          res.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline';",
          );
          return res.send(renderedPage);
        } catch (convErr) {
          console.warn(
            `[File Server] No se pudo convertir docx a HTML (${filename}):`,
            convErr.message,
          );
        }
      }

      // Cabeceras de seguridad para PDFs e Imágenes
      res.setHeader("Content-Disposition", "inline");
      if (fileMime || mimeTypes[ext]) {
        res.setHeader("Content-Type", fileMime || mimeTypes[ext]);
      }

      return res.send(fileBuffer);
    } catch (err) {
      next(
        new AppError(500, "Error interno sirviendo el archivo.", {
          cause: err,
        }),
      );
    }
  },
);

// 1. Obtener lista de cargos con requisitos ECF Codelco
app.get("/api/positions", async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM positions ORDER BY id ASC");
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// 2. Obtener 5 preguntas para el Mini-Test Técnico (3 Técnicas Específicas + 2 SJT de Seguridad Crítica ECF)
app.get("/api/positions/:id/questions", async (req, res, next) => {
  try {
    const { id } = req.params;
    // 3 Preguntas de Idoneidad Técnica Específica para el cargo
    const [techQuestions] = await pool.query(
      'SELECT id, position_id, question_text, option_a, option_b, option_c, option_d, category FROM questions WHERE position_id = ? AND category = "TECNICA" ORDER BY id ASC LIMIT 3',
      [id],
    );

    // 2 Preguntas de Juicio Situacional (SJT) sobre Seguridad Crítica / ECF Codelco
    const [sjtQuestions] = await pool.query(
      'SELECT id, position_id, question_text, option_a, option_b, option_c, option_d, category FROM questions WHERE category = "SJT" ORDER BY id ASC LIMIT 2',
    );

    const questions = [...techQuestions, ...sjtQuestions];
    res.json({ questions });
  } catch (err) {
    next(err);
  }
});

// 3. FASE 1: Extracción OCR de Entrada (Credencial Técnica + CV) — Sin pedir Carnet ni Antecedentes
app.post("/api/ocr/phase1", async (req, res, next) => {
  const tempFiles = [];
  let lastGeminiError = null;
  try {
    const { credencial_file, cv_file, position_id } = req.body;
    if (!credencial_file && !cv_file) {
      return res
        .status(400)
        .json({ error: "Adjunte su Credencial Técnica o CV para analizar." });
    }

    // Obtener contexto y requisitos normativos del cargo si fue seleccionado
    let positionContext = null;
    if (position_id) {
      try {
        const [posRows] = await pool.query(
          "SELECT * FROM positions WHERE id = ?",
          [position_id],
        );
        if (posRows && posRows.length > 0) {
          positionContext = posRows[0];
        }
      } catch (posErr) {
        console.warn(
          "[OCR/Phase1] Aviso al consultar cargo para contexto:",
          posErr.message,
        );
      }
    }

    const isAvail = geminiOcr.isGeminiAvailable();
    console.log(
      "[DEBUG OCR] isGeminiAvailable =",
      isAvail,
      "API_KEY len =",
      (process.env.GEMINI_API_KEY || "").length,
    );

    // Prioridad 1: Extracción con Gemini Flash (Comprensión Semántica de Alta Precisión con Anti-Prompt Injection)
    if (isAvail) {
      try {
        console.log(
          "[OCR/Gemini] Analizando Credencial y CV con Gemini Flash (Cargo:",
          positionContext ? positionContext.name : "General",
          ")...",
        );
        const geminiData = await geminiOcr.analyzePhase1Documents({
          credencialBase64: credencial_file,
          cvBase64: cv_file,
          positionContext,
        });

        return res.json({
          ocr_engine: "GEMINI_FLASH",
          model_used: geminiData.used_model || "gemini",
          full_name: geminiData.full_name || "",
          name_source:
            geminiData.name_source ||
            (geminiData.full_name
              ? geminiData.name_credencial
                ? "CREDENCIAL"
                : "CV"
              : "NO_DETECTADO"),
          name_credencial: geminiData.name_credencial || null,
          name_cv: geminiData.name_cv || null,
          name_discrepancia: Boolean(geminiData.name_discrepancia),
          rut_id: geminiData.rut_id || "",
          rut_source:
            geminiData.rut_source ||
            (geminiData.rut_id ? "CV" : "NO_DETECTADO"),
          rut_credencial: geminiData.rut_credencial || null,
          rut_cv: geminiData.rut_cv || null,
          rut_discrepancia: Boolean(geminiData.rut_discrepancia),
          discrepancia_nota: geminiData.discrepancia_nota || null,
          email: geminiData.email || "",
          phone: geminiData.phone || "",
          city: geminiData.city || "",
          experience_years: geminiData.experience_years ?? null,
          experience_months: geminiData.experience_months ?? null,
          experience_years_in_role:
            geminiData.experience_years_in_role ?? geminiData.experience_years,
          role_fit_percentage: geminiData.role_fit_percentage ?? null,
          detected_skills: geminiData.detected_skills || [],
          role_fit_verdict: geminiData.role_fit_verdict || "",
          credencial_status:
            geminiData.credencial_status || "No verificado (requiere revisión)",
          credencial_vigencia:
            geminiData.credencial_vigencia || "No verificada",
          ocr_text: `[MOTOR: IA (${geminiData.used_model || "GEMINI"})]\nPerfil: ${geminiData.resumen_perfil || "Sin resumen"}\nCargo: ${positionContext ? positionContext.name : "Operativo"} (Afinidad: ${geminiData.role_fit_percentage ?? "N/D"}%)\nCredencial: ${geminiData.credencial_status} (${geminiData.credencial_vigencia})${geminiData.rut_source ? `\nFuente RUT: ${geminiData.rut_source}` : ""}`,
        });
      } catch (geminiErr) {
        lastGeminiError = geminiErr.message;
        console.warn(
          "[OCR/Gemini Fallback] Excepción en Gemini, recurriendo a motor local:",
          geminiErr.message,
        );
      }
    }

    const items = [];
    if (credencial_file) {
      const saved = saveBase64File(credencial_file, "tmp_cred");
      if (saved.absolutePath) {
        tempFiles.push(saved.absolutePath);
        items.push({
          type: "CREDENCIAL_TECNICA",
          filePath: saved.absolutePath,
        });
      }
    }
    if (cv_file) {
      const saved = saveBase64File(cv_file, "tmp_cv");
      if (saved.absolutePath) {
        tempFiles.push(saved.absolutePath);
        items.push({ type: "CV", filePath: saved.absolutePath });
      }
    }

    const { combinedText, parsedByType } = await runTesseractOnFiles(items);
    const cred = parsedByType.CREDENCIAL_TECNICA || {};
    const cv = parsedByType.CV || {};

    const rutCred = cred.detected_rut || null;
    const rutCv = cv.detected_rut || null;
    let rutId = rutCv;
    let rutSource = "CV";
    let rutDiscrepancy = false;
    let discrepancyNote = null;

    if (!rutCv && rutCred) {
      rutId = rutCred;
      rutSource = "CREDENCIAL";
    } else if (rutCv && rutCred) {
      const cleanCv = rutCv.replace(/[^0-9kK]/g, "").toUpperCase();
      const cleanCred = rutCred.replace(/[^0-9kK]/g, "").toUpperCase();
      if (cleanCv !== cleanCred) {
        rutDiscrepancy = true;
        discrepancyNote = `Discrepancia detectada: RUT en CV (${rutCv}) difiere de Licencia/Credencial (${rutCred}).`;
        rutId = rutCred; // Prioridad oficial
        rutSource = "DISCREPANCIA";
      } else {
        rutSource = "AMBOS_COINCIDENTES";
      }
    } else if (!rutCv && !rutCred) {
      rutSource = "NO_DETECTADO";
      rutId = "";
    }

    const nameCred = cred.detected_name || null;
    const nameCv = cv.detected_name || null;
    let bestName = nameCv;
    let nameSource = "CV";
    let nameDiscrepancy = false;

    if (!nameCv && nameCred) {
      bestName = nameCred;
      nameSource = "CREDENCIAL";
    } else if (nameCv && nameCred) {
      const cleanCvName = normalizeTextForMatch(nameCv);
      const cleanCredName = normalizeTextForMatch(nameCred);
      if (cleanCvName && cleanCredName && cleanCvName !== cleanCredName) {
        nameDiscrepancy = true;
        bestName = nameCred; // Prioridad oficial
        nameSource = "DISCREPANCIA";
        const nameNote = `Nombre en CV (${nameCv}) difiere de Licencia/Credencial (${nameCred}).`;
        discrepancyNote = discrepancyNote
          ? `${discrepancyNote} | ${nameNote}`
          : `Discrepancia detectada: ${nameNote}`;
      } else {
        nameSource = "AMBOS_COINCIDENTES";
        bestName = nameCred || nameCv;
      }
    } else if (!nameCv && !nameCred) {
      nameSource = "NO_DETECTADO";
      bestName = "";
    }

    res.json({
      ocr_engine: "LOCAL_TESSERACT",
      full_name: bestName,
      name_source: nameSource,
      name_credencial: nameCred,
      name_cv: nameCv,
      name_discrepancia: nameDiscrepancy,
      rut_id: rutId,
      rut_source: rutSource,
      rut_credencial: rutCred,
      rut_cv: rutCv,
      rut_discrepancia: rutDiscrepancy,
      discrepancia_nota: discrepancyNote,
      email: cv.detected_email || cred.detected_email || "",
      phone: cv.detected_phone || cred.detected_phone || "",
      city: cv.detected_city || "",
      experience_years:
        cv.detected_experience_years ?? cred.detected_experience_years ?? null,
      experience_months: cv.detected_experience_months ?? null,
      credencial_status:
        cred.detected_credencial_status ||
        cv.detected_credencial_status ||
        "Documento técnico adjunto (no verificado)",
      credencial_vigencia: cred.carnet_vigencia || "No verificada",
      ocr_text: combinedText,
      gemini_fallback_reason: lastGeminiError,
      gemini_is_available: isAvail,
    });
  } catch (err) {
    next(new AppError(500, "Error procesando OCR de Fase 1.", { cause: err }));
  } finally {
    for (const f of tempFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (e) {}
    }
  }
});

// Compatibilidad con endpoint /api/ocr/extract
app.post("/api/ocr/extract", async (req, res, next) => {
  req.body.credencial_file = req.body.credencial_file || req.body.carnet_file;
  req.body.cv_file = req.body.cv_file || req.body.antecedentes_file;
  const tempFiles = [];
  try {
    const items = [];
    if (req.body.credencial_file) {
      const s = saveBase64File(req.body.credencial_file, "tmp_doc1");
      if (s.absolutePath) {
        tempFiles.push(s.absolutePath);
        items.push({ type: "DOC_1", filePath: s.absolutePath });
      }
    }
    if (req.body.cv_file) {
      const s = saveBase64File(req.body.cv_file, "tmp_doc2");
      if (s.absolutePath) {
        tempFiles.push(s.absolutePath);
        items.push({ type: "DOC_2", filePath: s.absolutePath });
      }
    }
    const { combinedText, parsedByType } = await runTesseractOnFiles(items);
    const d1 = parsedByType.DOC_1 || {};
    const d2 = parsedByType.DOC_2 || {};
    res.json({
      full_name:
        pickBestPersonName(
          [d1.detected_name, d2.detected_name],
          d2.detected_email || d1.detected_email,
        ) || "",
      rut_id: d1.detected_rut || d2.detected_rut || "",
      email: d2.detected_email || d1.detected_email || "",
      phone: d2.detected_phone || d1.detected_phone || "",
      city: d2.detected_city || d1.detected_city || "",
      age: d1.detected_age ?? d2.detected_age ?? null,
      birth_date: d1.birth_date || d2.birth_date || null,
      experience_years:
        d2.detected_experience_years ?? d1.detected_experience_years ?? null,
      credencial_status:
        d1.detected_credencial_status || d2.detected_credencial_status || null,
      antecedentes_status:
        d1.antecedentes_status || d2.antecedentes_status || null,
      ocr_text: combinedText,
    });
  } catch (err) {
    next(new AppError(500, "Error procesando OCR.", { cause: err }));
  } finally {
    for (const f of tempFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (e) {}
    }
  }
});

// 4. FASE 1 + FASE 1.5: Evaluar Filtro Curricular + Mini-Test Técnico (Nota >= 80%) + Selfie Transparente
app.post(
  ["/api/candidates", "/api/candidates/phase1-submit"],
  async (req, res, next) => {
    try {
      const {
        full_name,
        rut_id,
        email,
        phone,
        city,
        experience_years,
        position_id,
        cv_file,
        credencial_file,
        initial_selfie,
        random_selfie,
        consent_proctoring,
        answers,
        phase1_ocr_data,
      } = req.body;

      let formattedName = formatTitleCase(full_name);
      if (
        !isValidPersonName(formattedName) &&
        phase1_ocr_data &&
        isValidPersonName(phase1_ocr_data.full_name)
      ) {
        formattedName = formatTitleCase(phase1_ocr_data.full_name);
      }
      const formattedRut = formatRut(rut_id) || (rut_id || "").trim();
      const expYears = parseInt(experience_years || "0", 10);

      if (!formattedName || !formattedRut || !position_id) {
        return res.status(400).json({
          error: "Faltan datos obligatorios de identificación o cargo.",
        });
      }

      // Obtener requisitos ECF del cargo
      const [posRows] = await pool.query(
        "SELECT * FROM positions WHERE id = ?",
        [position_id],
      );
      const position = posRows[0] || {
        min_experience_years: 2,
        name: "Cargo Operativo",
      };
      const minExpRequired = position.min_experience_years || 2;

      // Guardar archivos de Fase 1 y Selfie Transparente del Mini-Test
      const cvResult = saveBase64File(cv_file, "cv");
      const credencialResult = saveBase64File(credencial_file, "credencial");
      const selfieResult = saveBase64File(initial_selfie, "selfie_test");
      const randomSelfieResult = saveBase64File(
        random_selfie,
        "selfie_test_random",
      );
      // Un archivo enviado pero rechazado (vacío, ejecutable, macros) no puede continuar como si no existiera.
      const rejectedPhase1File = [
        cvResult,
        credencialResult,
        selfieResult,
        randomSelfieResult,
      ].find((r) => r.error);
      if (rejectedPhase1File) {
        throw new AppError(
          400,
          `Archivo rechazado: ${rejectedPhase1File.error}`,
        );
      }

      // Evaluar respuestas del Mini-Test Técnico (3 Técnicas + 2 SJT de Seguridad Crítica ECF)
      const rawAnswers = Array.isArray(answers)
        ? answers
        : JSON.parse(answers || "[]");
      // Cada pregunta cuenta una sola vez: evita inflar el puntaje repitiendo una respuesta correcta.
      const seenQuestionIds = new Set();
      const parsedAnswers = (
        Array.isArray(rawAnswers) ? rawAnswers : []
      ).filter((a) => {
        const key = a && String(a.question_id);
        if (!a || seenQuestionIds.has(key)) return false;
        seenQuestionIds.add(key);
        return true;
      });
      let score = 0;
      let scoreTecnico = 0;
      let scoreSjt = 0;
      const totalQuestions = parsedAnswers.length;

      for (const ans of parsedAnswers) {
        const [qRow] = await pool.query(
          "SELECT correct_option, category, question_text, position_id FROM questions WHERE id = ?",
          [ans.question_id],
        );
        // Solo puntúan preguntas SJT o técnicas del cargo postulado.
        if (
          qRow.length > 0 &&
          ((qRow[0].category || "TECNICA") === "SJT" ||
            Number(qRow[0].position_id) === Number(position_id))
        ) {
          const qCat = qRow[0].category || "TECNICA";
          if (qRow[0].correct_option === ans.selected_option) {
            score++;
            ans.is_correct = true;
            if (qCat === "TECNICA") scoreTecnico++;
            else if (qCat === "SJT") scoreSjt++;
          } else {
            ans.is_correct = false;
          }
        } else {
          ans.is_correct = false;
        }
      }

      const sjtConforme = scoreSjt === 2;
      const scoreRatio = totalQuestions > 0 ? score / totalQuestions : 0;
      const passesScore = score >= 4; // Mínimo 80% (4 de 5)
      const meetsExperience = expYears >= minExpRequired;
      const passesQuiz = passesScore && sjtConforme;

      // Estado según regla de corte normativo de Fase 1 / 1.5
      const nextStatus =
        passesQuiz && meetsExperience
          ? "PRESELECCIONADO"
          : "DESCARTADO_TECNICO";

      const rejectionReasons = [];
      if (!sjtConforme) {
        rejectionReasons.push(
          "No conformidad con estándar ECF / Riesgo operacional crítico (Falló reactivo de Juicio Situacional / Paso Cero).",
        );
      }
      if (!passesScore) {
        rejectionReasons.push(
          `Puntaje en Mini-Test Técnico (${score}/${totalQuestions} — ${Math.round(scoreRatio * 100)}%) inferior al 80% mínimo requerido.`,
        );
      }
      if (!meetsExperience) {
        rejectionReasons.push(
          `Experiencia declarada (${expYears} años) menor al mínimo exigido por el ECF Codelco (${minExpRequired} años).`,
        );
      }

      const ocrTextPhase1 =
        phase1_ocr_data && phase1_ocr_data.ocr_text
          ? phase1_ocr_data.ocr_text
          : "";
      const ocrDetectedName =
        phase1_ocr_data &&
        phase1_ocr_data.full_name &&
        isValidPersonName(phase1_ocr_data.full_name)
          ? phase1_ocr_data.full_name
          : null;
      const ocrDetectedRut =
        phase1_ocr_data && phase1_ocr_data.rut_id
          ? phase1_ocr_data.rut_id
          : null;
      const ocrCredStatus =
        phase1_ocr_data && phase1_ocr_data.credencial_status
          ? phase1_ocr_data.credencial_status
          : "Credencial Técnica Cargada";

      // Auditar si editó manualmente respecto a la lectura de Fase 1
      const editedFields = [];
      if (
        ocrDetectedName &&
        normalizeTextForMatch(ocrDetectedName) !==
          normalizeTextForMatch(formattedName)
      ) {
        editedFields.push(`Nombre Fase 1 (OCR: "${ocrDetectedName}")`);
      }
      if (ocrDetectedRut && formatRut(ocrDetectedRut) !== formattedRut) {
        editedFields.push(`RUT Fase 1 (OCR: ${ocrDetectedRut})`);
      }

      const discrepancyNotesList = [...rejectionReasons];
      if (
        phase1_ocr_data &&
        (phase1_ocr_data.rut_discrepancia ||
          phase1_ocr_data.name_discrepancia) &&
        phase1_ocr_data.discrepancia_nota
      ) {
        discrepancyNotesList.push(
          `[AUDITORÍA DOCUMENTAL FASE 1]: ${phase1_ocr_data.discrepancia_nota}`,
        );
      }

      const [candRes] = await pool.query(
        `INSERT INTO candidates 
      (full_name, rut_id, email, phone, city, experience_years, age, position_id, cv_file, credencial_file, cert_file, initial_selfie, random_selfie, score, total_questions, score_tecnico, score_sjt, sjt_conforme, status, ocr_text, ocr_detected_name, ocr_detected_rut, ocr_credencial_status, ocr_manually_edited, ocr_edited_fields, discrepancy_notes, consent_proctoring)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          formattedName,
          formattedRut,
          email || null,
          phone || null,
          city || "Rancagua / El Teniente",
          expYears,
          30,
          parseInt(position_id, 10),
          cvResult.url,
          credencialResult.url,
          credencialResult.url,
          selfieResult.url,
          randomSelfieResult ? randomSelfieResult.url : null,
          score,
          totalQuestions,
          scoreTecnico,
          scoreSjt,
          sjtConforme ? 1 : 0,
          nextStatus,
          ocrTextPhase1,
          ocrDetectedName,
          ocrDetectedRut,
          ocrCredStatus,
          editedFields.length > 0 ? 1 : 0,
          editedFields.join(" | ") || null,
          discrepancyNotesList.join(" | ") || null,
          consent_proctoring ? 1 : 0,
        ],
      );

      const candidateId = candRes.insertId;

      for (const ans of parsedAnswers) {
        await pool.query(
          "INSERT INTO candidate_answers (candidate_id, question_id, selected_option, is_correct) VALUES (?, ?, ?, ?)",
          [candidateId, ans.question_id, ans.selected_option, ans.is_correct],
        );
      }

      res.status(201).json({
        candidateId,
        score,
        totalQuestions,
        scorePercent: Math.round(scoreRatio * 100),
        score_tecnico: scoreTecnico,
        score_sjt: scoreSjt,
        sjt_conforme: sjtConforme,
        status: nextStatus,
        qualifiedForPhase2: false, // Bloqueado: requiere aprobación formal de faena por RR.HH. para recibir enlace
        rejectionReasons,
        message:
          nextStatus === "PRESELECCIONADO"
            ? "Evaluación técnica aprobada. Su expediente quedó en estado PRESELECCIONADO en espera de asignación de cupo en faena por parte de RR.HH."
            : "No califica en esta convocatoria.",
      });
    } catch (err) {
      next(err);
    }
  },
);

// 5. FASE 2 & FASE 3: Subida de Carnet + Antecedentes (Solo Preseleccionados) + Motor OCR de Validación Cruzada
app.post("/api/candidates/:id/phase2-acreditacion", async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      carnet_file,
      carnet_back_file,
      antecedentes_file,
      consent_ley19628,
    } = req.body;

    // Regla de Integridad: Un evaluador administrativo no puede subir antecedentes a nombre del postulante
    const maybeAdmin = await auth.getAdminFromRequest(req);
    if (maybeAdmin) {
      return res.status(403).json({
        error:
          "Operación no permitida: Los administradores no pueden cargar documentos de identidad en nombre del postulante.",
      });
    }

    // Solo el postulante dueño de la sesión (cookie emitida al canjear el magic link) puede cargar su Fase 2
    const sessionCid = auth.getCandidateIdFromRequest(req);
    if (!sessionCid || sessionCid !== Number(id)) {
      return res.status(401).json({
        error:
          "Sesión de postulante no válida o expirada. Abra nuevamente el enlace enviado a su correo para continuar.",
      });
    }

    if (!carnet_file || !antecedentes_file) {
      return res.status(400).json({
        error:
          "Debe adjuntar la Cédula de Identidad y el Certificado de Antecedentes para la Pre-Acreditación.",
      });
    }
    if (!consent_ley19628) {
      return res.status(400).json({
        error:
          "Debe aceptar el Consentimiento Expreso (Ley N° 19.628) para procesar su documentación de faena.",
      });
    }

    const [candRows] = await pool.query(
      "SELECT * FROM candidates WHERE id = ?",
      [id],
    );
    if (candRows.length === 0) {
      return res.status(404).json({ error: "Postulación no encontrada." });
    }
    const candidate = candRows[0];

    // Regla de Integridad: Si la documentación ya fue finalizada previamente, bloquear reenvío
    if (
      candidate.phase2_submitted_at ||
      ["PRE_ACREDITADO", "CONTRATADO_FAENA"].includes(candidate.status)
    ) {
      return res.status(409).json({
        error:
          "Su documentación de Fase 2 ya fue enviada y se encuentra registrada en el sistema de acreditación.",
      });
    }

    // Regla de corte: El candidato solo puede acceder a Fase 2 si fue APROBADO_FAENA por RR.HH.
    const allowedStatuses = [
      "APROBADO_FAENA",
      "DOCS_CARGADOS",
      "EN_REVISION_MANUAL",
      "PRE_ACREDITADO",
    ];
    if (!allowedStatuses.includes(candidate.status)) {
      return res.status(403).json({
        error:
          "Su postulación aún no cuenta con autorización previa de acceso a faena por parte de RR.HH. Debe esperar la aprobación formal para subir sus antecedentes.",
      });
    }

    // Guardar archivos de Fase 2
    const carnetFrontRes = saveBase64File(carnet_file, `carnet_${id}`);
    const carnetBackRes = saveBase64File(carnet_back_file, `carnet_rev_${id}`);
    const antecedentesRes = saveBase64File(
      antecedentes_file,
      `antecedentes_${id}`,
    );

    const rejectedPhase2File = [
      carnetFrontRes,
      carnetBackRes,
      antecedentesRes,
    ].find((r) => r.error);
    if (rejectedPhase2File) {
      throw new AppError(400, `Archivo rechazado: ${rejectedPhase2File.error}`);
    }

    // Estado transitorio DOCS_CARGADOS antes del análisis cruzado
    await pool.query(
      "UPDATE candidates SET status = 'DOCS_CARGADOS' WHERE id = ?",
      [id],
    );

    let effectiveCandidateName = candidate.full_name;
    let ocrCarnetName = candidate.full_name;
    let ocrCarnetRut = candidate.rut_id;
    let ocrBirthDate = null;
    let ocrDetectedAge = candidate.age || 30;
    let ocrCarnetVigencia = null;
    let ocrAntecedentesStatus = null;
    let crossCheckOk = false;
    let evidence = null;
    let engineLabel = "";
    let facialMatchOk = null;
    let facialConfidence = null;
    let discrepancies = [];
    let combinedText = "";

    // Cargar Base64 de las selfies guardadas en Fase 1 para el cotejo biométrico facial anti-fraude
    const loadSelfieBase64 = (filePath) => {
      if (!filePath) return null;
      try {
        const basename = path.basename(filePath);
        const candidatesPaths = [
          path.join(UPLOADS_DIR, basename),
          path.join(__dirname, "..", filePath.replace(/^\//, "")),
          path.join(__dirname, "../storage/uploads", basename),
        ];
        for (const p of candidatesPaths) {
          if (fs.existsSync(p)) {
            const buf = fs.readFileSync(p);
            return `data:image/jpeg;base64,${buf.toString("base64")}`;
          }
        }
      } catch (err) {
        console.warn(`[Selfie Load Error] ${filePath}:`, err.message);
      }
      return null;
    };

    const initialSelfieBase64 = loadSelfieBase64(candidate.initial_selfie);
    const randomSelfieBase64 = loadSelfieBase64(candidate.random_selfie);

    let geminiProcessed = false;
    if (geminiOcr.isGeminiAvailable()) {
      try {
        console.log(
          `[OCR/Gemini] Analizando Cédula y Antecedentes con Gemini 1.5 Flash para #${id}...`,
        );
        const g2 = await geminiOcr.analyzePhase2IdentityDocuments({
          carnetFrontBase64: carnet_file,
          carnetBackBase64: carnet_back_file,
          antecedentesBase64: antecedentes_file,
          initialSelfieBase64,
          randomSelfieBase64,
          phase1Rut: candidate.rut_id,
          phase1Name: candidate.full_name,
        });

        if (g2) {
          geminiProcessed = true;
          engineLabel = "GEMINI FLASH";
          // Solo evidencia: los huecos quedan en null, nunca se rellenan con datos de Fase 1.
          evidence = documentDecision.evidenceFromGemini(g2, parseChileanDate);
          if (typeof g2.facial_confidence_percent === "number") {
            facialConfidence = Math.round(g2.facial_confidence_percent);
          }
        }
      } catch (geminiErr) {
        console.warn("[OCR/Gemini Fallback Phase 2]:", geminiErr.message);
      }
    }

    if (!geminiProcessed) {
      // Fallback a motor Tesseract/Poppler local
      const itemsToScan = [
        { type: "CEDULA_FRENTE", filePath: carnetFrontRes.absolutePath },
        { type: "CEDULA_REVERSO", filePath: carnetBackRes.absolutePath },
        { type: "CERT_ANTECEDENTES", filePath: antecedentesRes.absolutePath },
      ];

      const localOcr = await runTesseractOnFiles(itemsToScan);
      combinedText = localOcr.combinedText;
      const cedFront = localOcr.parsedByType.CEDULA_FRENTE || {};
      const cedBack = localOcr.parsedByType.CEDULA_REVERSO || {};
      const ant = localOcr.parsedByType.CERT_ANTECEDENTES || {};

      if (!isValidPersonName(effectiveCandidateName) && candidate.ocr_text) {
        const reparsedPhase1 = parseExtractedText(candidate.ocr_text);
        if (isValidPersonName(reparsedPhase1.detected_name)) {
          effectiveCandidateName = reparsedPhase1.detected_name;
          await pool.query("UPDATE candidates SET full_name = ? WHERE id = ?", [
            effectiveCandidateName,
            id,
          ]);
        }
      }

      ocrCarnetName = pickBestPersonName(
        [cedFront.detected_name, cedBack.detected_name, ant.detected_name],
        isValidPersonName(effectiveCandidateName)
          ? effectiveCandidateName
          : candidate.email,
      );
      ocrBirthDate =
        cedFront.birth_date || cedBack.birth_date || ant.birth_date || null;
      ocrDetectedAge =
        cedFront.detected_age ??
        cedBack.detected_age ??
        ant.detected_age ??
        candidate.age;
      engineLabel = "TESSERACT/POPPLER LOCAL";
      evidence = documentDecision.evidenceFromLocalOcr(
        { cedFront, cedBack, ant },
        parseChileanDate,
      );
      if (ocrCarnetName) evidence.carnetName = ocrCarnetName;
    }

    // Decisión única (Gemini u OCR local): sin evidencia comprobada no hay pre-acreditación automática.
    const decision = documentDecision.evaluatePhase2Evidence(
      evidence,
      { rut: candidate.rut_id, name: effectiveCandidateName },
      decisionHelpers,
    );
    crossCheckOk = decision.crossCheckOk;
    const finalStatus = decision.status;
    discrepancies = decision.discrepancies;
    ocrCarnetVigencia = decision.carnetVigenciaLabel;
    ocrAntecedentesStatus = decision.antecedentesLabel;
    ocrCarnetName = evidence.carnetName;
    ocrCarnetRut = evidence.carnetRut;
    facialMatchOk =
      evidence.facialMatch === true
        ? 1
        : evidence.facialMatch === false
          ? 0
          : null;
    // Si el nombre coincide y la cédula lo trae más completo, se adopta el de la cédula.
    const nameCheck = decision.checks.find((k) => k.key === "nombre_cedula");
    if (
      nameCheck.estado === documentDecision.VALIDO &&
      normalizeTextForMatch(ocrCarnetName).split(" ").length >
        normalizeTextForMatch(effectiveCandidateName).split(" ").length
    ) {
      effectiveCandidateName = ocrCarnetName;
    }
    const verdictText = `[MOTOR: ${engineLabel}]\nVeredicto documental: ${decision.verdict}\n${decision.checks
      .map((k) => `- ${k.key}: ${k.estado}`)
      .join("\n")}`;
    combinedText = geminiProcessed
      ? verdictText
      : `${combinedText}\n${verdictText}`;

    const updatedOcrText = [candidate.ocr_text, combinedText]
      .filter(Boolean)
      .join("\n\n");

    await pool.query(
      `UPDATE candidates SET
        full_name = ?,
        carnet_file = ?,
        carnet_back_file = ?,
        antecedentes_file = ?,
        status = ?,
        facial_match_ok = ?,
        facial_confidence = ?,
        ocr_text = ?,
        ocr_birth_date = ?,
        ocr_detected_age = ?,
        ocr_verified = ?,
        ocr_detected_name = COALESCE(?, ocr_detected_name),
        ocr_detected_rut = COALESCE(?, ocr_detected_rut),
        ocr_carnet_vigencia = ?,
        ocr_antecedentes_status = ?,
        ocr_cross_check_ok = ?,
        discrepancy_notes = ?,
        consent_ley19628 = 1,
        token_used_at = NOW(),
        phase2_submitted_at = NOW()
      WHERE id = ?`,
      [
        effectiveCandidateName,
        carnetFrontRes.url,
        carnetBackRes.url,
        antecedentesRes.url,
        finalStatus,
        facialMatchOk,
        facialConfidence,
        updatedOcrText,
        ocrBirthDate,
        ocrDetectedAge,
        crossCheckOk ? 1 : 0,
        ocrCarnetName,
        ocrCarnetRut,
        ocrCarnetVigencia,
        ocrAntecedentesStatus,
        crossCheckOk ? 1 : 0,
        discrepancies.length > 0
          ? discrepancies.join(" | ")
          : "Consistencia 100% verificada entre Fase 1 y Fase 2.",
        id,
      ],
    );

    res.json({
      candidateId: Number(id),
      status: finalStatus,
      crossCheckOk,
      facialMatchOk: facialMatchOk !== null ? Boolean(facialMatchOk) : null,
      facialConfidence,
      ocrCarnetName,
      ocrCarnetRut,
      ocrCarnetVigencia,
      ocrAntecedentesStatus,
      discrepancies,
    });
  } catch (err) {
    next(err);
  }
});

// 5.5 VALIDACIÓN DE TOKEN DE ACCESO ASÍNCRONO A FASE 2
// whereSql es una constante interna ("c.access_token = ?" o "c.id = ?"), nunca entrada del usuario.
async function loadCandidateAccess(whereSql, param) {
  const [rows] = await pool.query(
    `SELECT c.id, c.full_name, c.rut_id, c.email, c.phone, c.city, c.experience_years, 
              c.position_id, c.status, c.score_tecnico, c.score_sjt, c.sjt_conforme, 
              c.token_expires_at, c.token_used_at, c.phase2_submitted_at, c.carnet_file,
              c.ocr_carnet_vigencia, c.ocr_antecedentes_status, c.discrepancy_notes,
              p.name as position_name, p.required_credential
       FROM candidates c
       LEFT JOIN positions p ON c.position_id = p.id
       WHERE ${whereSql}`,
    [param],
  );

  if (rows.length === 0) {
    return {
      status: 404,
      body: {
        error: "Enlace de acceso no encontrado o no registrado en el sistema.",
      },
    };
  }

  const c = rows[0];

  // Verificar si expiró el token (7 días)
  if (c.token_expires_at && new Date() > new Date(c.token_expires_at)) {
    return {
      status: 403,
      body: {
        error:
          "Este enlace de acceso ha expirado (validez máxima de 7 días). Solicite a RR.HH. un nuevo enlace de acreditación.",
      },
    };
  }

  // Regla de corte: Debe estar aprobado para faena por RR.HH.
  const allowedStatuses = [
    "APROBADO_FAENA",
    "DOCS_CARGADOS",
    "EN_REVISION_MANUAL",
    "PRE_ACREDITADO",
    "CONTRATADO_FAENA",
    "DESCARTADO_TECNICO",
  ];
  if (!allowedStatuses.includes(c.status)) {
    return {
      status: 403,
      body: {
        error:
          "Su postulación aún no cuenta con la aprobación formal de acceso a faena por parte de RR.HH.",
      },
    };
  }

  return {
    status: 200,
    body: {
      id: c.id,
      full_name: c.full_name,
      rut_id: c.rut_id,
      email: c.email,
      phone: c.phone,
      city: c.city,
      experience_years: c.experience_years,
      position_id: c.position_id,
      position_name: c.position_name,
      required_credential: c.required_credential,
      status: c.status,
      score_tecnico: c.score_tecnico,
      score_sjt: c.score_sjt,
      sjt_conforme: c.sjt_conforme,
      token_used_at: c.token_used_at,
      phase2_submitted_at: c.phase2_submitted_at,
      carnet_file: c.carnet_file,
      ocr_carnet_vigencia: c.ocr_carnet_vigencia,
      ocr_antecedentes_status: c.ocr_antecedentes_status,
      discrepancy_notes: c.discrepancy_notes,
    },
  };
}

// Canje del magic link por una sesión de postulante en cookie HttpOnly (reutilizable hasta Fase 2)
app.post("/api/candidates/session", async (req, res) => {
  try {
    const token =
      req.body && typeof req.body.token === "string"
        ? req.body.token.trim()
        : "";
    if (token.length < 16) {
      return res
        .status(400)
        .json({ error: "Token de acceso no especificado o formato inválido." });
    }
    const result = await loadCandidateAccess("c.access_token = ?", token);
    if (result.status === 200) {
      auth.createCandidateSession(res, result.body.id);
    }
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("[Error /api/candidates/session]: fallo al crear sesión.");
    res.status(500).json({ error: "Error interno al validar el enlace." });
  }
});

app.get("/api/candidates/me", async (req, res) => {
  try {
    const cid = auth.getCandidateIdFromRequest(req);
    if (!cid) {
      return res.status(401).json({
        error:
          "Sesión de postulante no válida o expirada. Abra nuevamente el enlace de su correo.",
      });
    }
    const result = await loadCandidateAccess("c.id = ?", cid);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("[Error /api/candidates/me]: fallo al cargar la sesión.");
    res.status(500).json({ error: "Error interno al cargar la postulación." });
  }
});

// ==========================================
// AUTENTICACIÓN Y SEGURIDAD RR.HH. (ADMIN)
// ==========================================

app.post("/api/auth/admin-login", async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Debe ingresar usuario y contraseña." });
    }

    if (!pool) {
      return res.status(503).json({
        error:
          "El servicio de base de datos se está inicializando. Por favor intente en unos segundos.",
      });
    }

    const [rows] = await pool.query(
      "SELECT * FROM admin_users WHERE username = ?",
      [username.trim()],
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: "Credenciales inválidas." });
    }

    const admin = rows[0];
    const isMatch = auth.verifyPassword(password, admin.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: "Credenciales inválidas." });
    }

    console.log(
      `[AUTH] Inicio de sesión exitoso para operador: ${admin.username} (${admin.role})`,
    );

    const sessionToken = await auth.createAdminSession(admin.id);
    auth.setCookie(
      res,
      auth.ADMIN_COOKIE,
      sessionToken,
      auth.ADMIN_SESSION_SECONDS,
    );
    auth.clearCookie(res, "admin_token");

    res.json({
      success: true,
      user: {
        id: admin.id,
        username: admin.username,
        fullName: admin.full_name,
        role: admin.role,
      },
    });
  } catch (err) {
    next(new AppError(500, "Error interno de autenticación.", { cause: err }));
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const sessionToken = auth.parseCookies(req)[auth.ADMIN_COOKIE];
    if (sessionToken) await auth.revokeAdminSession(sessionToken);
  } catch (err) {
    console.error("[Error /api/auth/logout]: no se pudo revocar la sesión.");
  }
  auth.clearCookie(res, auth.ADMIN_COOKIE);
  auth.clearCookie(res, "admin_token");
  res.json({ success: true });
});

app.get("/api/auth/verify", async (req, res) => {
  try {
    const user = await auth.getAdminFromRequest(req);
    if (!user) {
      return res.status(401).json({ valid: false });
    }
    res.json({ valid: true, user });
  } catch (err) {
    console.error("[Error /api/auth/verify]: fallo al validar la sesión.");
    res.status(401).json({ valid: false });
  }
});

// 5.6 PANEL RR.HH.: APROBAR ACCESO A FAENA Y EMITIR ENLACE DE FASE 2
app.post(
  "/api/admin/candidates/:id/approve-faena",
  auth.requireAdminAuth,
  validate({ params: schemas.idParam }),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const [candRows] = await pool.query(
        `SELECT c.*, p.name as position_name 
       FROM candidates c 
       LEFT JOIN positions p ON c.position_id = p.id 
       WHERE c.id = ?`,
        [id],
      );

      if (candRows.length === 0) {
        return res.status(404).json({ error: "Candidato no encontrado." });
      }

      const candidate = candRows[0];
      const { token, expiresAt } = mailer.generateAccessToken(7);

      await pool.query(
        `UPDATE candidates 
       SET status = 'APROBADO_FAENA', 
           access_token = ?, 
           token_expires_at = ? 
       WHERE id = ?`,
        [token, expiresAt, id],
      );

      const protocol = req.protocol;
      const host = req.get("host");
      const magicLink = `${protocol}://${host}/?token=${token}`;

      const mailResult = await mailer.sendPhase2InvitationEmail({
        email: candidate.email,
        full_name: candidate.full_name,
        position_name: candidate.position_name,
        magic_link: magicLink,
        expires_at: expiresAt,
      });

      res.json({
        success: true,
        message: `Acceso a faena aprobado para ${candidate.full_name}. Enlace despachado a ${candidate.email || "correo del postulante"}.`,
        candidate_id: Number(id),
        new_status: "APROBADO_FAENA",
        magic_link: magicLink,
        expires_at: expiresAt,
        mail_sent: Boolean(mailResult.sent),
        mail_simulated: Boolean(mailResult.simulated),
        mail_recipient: mailResult.recipient,
        mail_note: mailResult.note || null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// 6. PANEL RR.HH. NEXXO: Obtener postulantes con filtro por Cargo y Estado de la Máquina de Estados
app.get(
  "/api/admin/candidates",
  auth.requireAdminAuth,
  validate({ query: schemas.candidatesQuery }),
  async (req, res, next) => {
    try {
      const { status, position_id } = req.query;
      let query = `
      SELECT c.*, p.name as position_name, p.required_credential, p.ecf_code
      FROM candidates c 
      JOIN positions p ON c.position_id = p.id 
    `;
      const params = [];
      const conditions = [];

      if (status) {
        conditions.push("c.status = ?");
        params.push(status);
      }
      if (position_id) {
        conditions.push("c.position_id = ?");
        params.push(position_id);
      }

      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }

      query += " ORDER BY c.created_at DESC";

      const [candidates] = await pool.query(query, params);
      res.json(candidates);
    } catch (err) {
      next(err);
    }
  },
);

// 7. PANEL RR.HH. NEXXO: Cambiar estado en la Máquina de Estados
app.patch(
  "/api/admin/candidates/:id/status",
  auth.requireAdminAuth,
  validate({ params: schemas.idParam, body: statusUpdateSchema }),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      await pool.query("UPDATE candidates SET status = ? WHERE id = ?", [
        status,
        id,
      ]);

      let mailSent = false;
      let mailSimulated = false;

      // Si es contratado para faena, despachar correo formal de acreditación y bienvenida
      if (status === "CONTRATADO_FAENA") {
        try {
          const [rows] = await pool.query(
            `SELECT c.full_name, c.email, p.name as position_name 
           FROM candidates c 
           LEFT JOIN positions p ON c.position_id = p.id 
           WHERE c.id = ?`,
            [id],
          );
          if (rows.length > 0 && rows[0].email) {
            const mailRes = await mailer.sendHiredConfirmationEmail({
              email: rows[0].email,
              full_name: rows[0].full_name,
              position_name: rows[0].position_name,
            });
            mailSent = mailRes.sent;
            mailSimulated = mailRes.simulated;
          }
        } catch (mailErr) {
          console.warn(
            "[Error despachando correo de contratación]:",
            mailErr.message,
          );
        }
      }

      res.json({
        message: `Candidato #${id} actualizado a estado "${status}".`,
        mail_sent: mailSent,
        mail_simulated: mailSimulated,
      });
    } catch (err) {
      next(err);
    }
  },
);

// 8. PANEL RR.HH. NEXXO: Estadísticas Operativas e Impacto en División El Teniente
app.get("/api/admin/stats", auth.requireAdminAuth, async (req, res, next) => {
  try {
    const [totalRows] = await pool.query(
      "SELECT COUNT(*) as count FROM candidates",
    );
    const [preAcreditadosRows] = await pool.query(
      "SELECT COUNT(*) as count FROM candidates WHERE status IN ('PRE_ACREDITADO', 'CONTRATADO_FAENA', 'Aprobado')",
    );
    const [revisionRows] = await pool.query(
      "SELECT COUNT(*) as count FROM candidates WHERE status IN ('EN_REVISION_MANUAL', 'PRESELECCIONADO', 'DOCS_CARGADOS', 'Pendiente')",
    );
    const [descartadosRows] = await pool.query(
      "SELECT COUNT(*) as count FROM candidates WHERE status IN ('DESCARTADO_TECNICO', 'Rechazado')",
    );

    const total = totalRows[0].count;
    const approved = preAcreditadosRows[0].count;
    const inReview = revisionRows[0].count;
    const rejected = descartadosRows[0].count;

    // Ahorro estimado: $1.000.000 CLP por rechazo evitado antes de enviar a acreditación WebControl / exámenes
    const savedTurnoverCosts = rejected * 1000000;

    res.json({
      total,
      approved,
      inReview,
      rejected,
      savedTurnoverCostsCLP: savedTurnoverCosts,
    });
  } catch (err) {
    next(err);
  }
});

// 8.5 PANEL RR.HH. NEXXO: Centro de Notificaciones de Fase 2
app.get(
  "/api/admin/notifications",
  auth.requireAdminAuth,
  async (req, res, next) => {
    try {
      const [rows] = await pool.query(`
      SELECT 
        c.id, 
        c.full_name, 
        c.rut_id, 
        c.status, 
        c.phase2_submitted_at, 
        c.token_used_at,
        c.ocr_cross_check_ok,
        p.name as position_name
      FROM candidates c
      LEFT JOIN positions p ON c.position_id = p.id
      WHERE c.phase2_submitted_at IS NOT NULL OR c.token_used_at IS NOT NULL
      ORDER BY COALESCE(c.phase2_submitted_at, c.token_used_at) DESC
      LIMIT 15
    `);

      const pendingReview = rows.filter(
        (r) =>
          r.status === "EN_REVISION_MANUAL" || r.status === "DOCS_CARGADOS",
      );

      res.json({
        success: true,
        pendingCount: pendingReview.length,
        notifications: rows,
      });
    } catch (err) {
      next(err);
    }
  },
);

// 9. FASE 4: Exportar "Carpeta de Acreditación Estandarizada WebControl" (Codelco División El Teniente)
app.get(
  "/api/admin/candidates/:id/export-webcontrol",
  auth.requireAdminAuth,
  validate({ params: schemas.idParam }),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const [rows] = await pool.query(
        `SELECT c.*, p.name as position_name, p.required_credential, p.ecf_code
       FROM candidates c
       JOIN positions p ON c.position_id = p.id
       WHERE c.id = ?`,
        [id],
      );

      if (rows.length === 0) {
        return res.status(404).send("Candidato no encontrado.");
      }

      const c = rows[0];
      const cleanRut = (c.rut_id || "SIN_RUT")
        .replace(/\./g, "")
        .replace(/\s+/g, "");
      const cleanNameSlug = normalizeTextForMatch(c.full_name).replace(
        /\s+/g,
        "_",
      );
      const prefix = `${cleanRut}_${cleanNameSlug}`;

      const scorePercent =
        c.total_questions > 0
          ? Math.round((c.score / c.total_questions) * 100)
          : 0;
      // La cookie HttpOnly de sesión viaja sola en la pestaña nueva: no se anexan tokens a la URL
      const fileUrlWithAuth = (fileUrl) => {
        if (!fileUrl) return "";
        return escapeHtml(fileUrl);
      };

      const htmlReport = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Carpeta WebControl - ${escapeHtml(prefix)}</title>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #0f1e2e; margin: 2rem; background: #f8fafc; }
    .sheet { max-width: 860px; margin: 0 auto; background: #fff; border: 2px solid #0f1e2e; padding: 2rem; border-radius: 6px; }
    .header { display: flex; justify-content: space-between; border-bottom: 3px solid #c25e00; padding-bottom: 1rem; margin-bottom: 1.5rem; }
    .badge { background: #14532d; color: #fff; padding: 0.35rem 0.75rem; border-radius: 4px; font-family: monospace; font-weight: bold; }
    h1 { font-size: 1.35rem; margin: 0 0 0.25rem 0; }
    h2 { font-size: 1.05rem; background: #eff4ff; padding: 0.5rem 0.75rem; border-left: 4px solid #0f1e2e; margin-top: 1.5rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.9rem; }
    th, td { border: 1px solid #cbd5e1; padding: 0.6rem 0.75rem; text-align: left; }
    th { background: #f1f5f9; width: 32%; }
    .photos { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 0.75rem; }
    .photo-box { border: 1px solid #cbd5e1; padding: 0.75rem; text-align: center; border-radius: 4px; }
    .photo-box img { max-width: 100%; max-height: 200px; object-fit: contain; margin-top: 0.5rem; }
    .print-bar { text-align: right; margin-bottom: 1rem; }
    .btn-print { background: #0f1e2e; color: #fff; border: none; padding: 0.6rem 1.2rem; border-radius: 4px; cursor: pointer; font-weight: bold; }
    @media print { .print-bar { display: none; } body { margin: 0; background: #fff; } .sheet { border: none; } }
  </style>
</head>
<body>
  <div class="print-bar">
    <button class="btn-print" onclick="window.print()">Imprimir / Guardar como PDF Estandarizado WebControl</button>
  </div>
  <div class="sheet">
    <div class="header">
      <div>
        <h1>CARPETA DE PRE-ACREDITACIÓN DE FAENA — NEXXO S.A.</h1>
        <p style="margin:0; font-size:0.88rem; color:#475569;">Mandante: <strong>CODELCO Chile — División El Teniente</strong> | Plataforma Destino: <strong>WebControl / SICEP</strong></p>
      </div>
      <div>
        <span class="badge">${escapeHtml(c.status)}</span>
      </div>
    </div>

    <h2>1. Identificación del Trabajador y Cargo Operativo</h2>
    <table>
      <tr><th>Nombre Completo</th><td><strong>${escapeHtml(c.full_name)}</strong></td></tr>
      <tr><th>RUT / RUN</th><td><code>${escapeHtml(c.rut_id)}</code></td></tr>
      <tr><th>Cargo Postulado</th><td>${escapeHtml(c.position_name)}</td></tr>
      <tr><th>Estándar de Control de Fatalidades</th><td>${escapeHtml(c.ecf_code || "ECF Codelco / DS N° 132 SERNAGEOMIN")}</td></tr>
      <tr><th>Experiencia Comprobable</th><td>${escapeHtml(c.experience_years || 2)} años en minería/industria</td></tr>
      <tr><th>Contacto</th><td>${escapeHtml(c.email || "S/I")} | ${escapeHtml(c.phone || "S/I")} (${escapeHtml(c.city || "Rancagua")})</td></tr>
    </table>

    <h2>2. Resultados de Pre-Filtro Técnico y Validación Cruzada OCR</h2>
    <table>
      <tr><th>Mini-Test Técnico (Umbral &ge; 80%)</th><td><strong>${c.score} / ${c.total_questions} (${scorePercent}%)</strong> | Idoneidad Técnica: <strong>${c.score_tecnico ?? 0}/3</strong> | Juicio Situacional ECF: <strong>${c.score_sjt ?? 0}/2 (${c.sjt_conforme ? "Conforme" : "No Conforme"})</strong></td></tr>
      <tr><th>Credencial Técnica Habilitante</th><td>${escapeHtml(c.ocr_credencial_status || c.required_credential)}</td></tr>
      <tr><th>Vigencia Cédula de Identidad (OCR)</th><td>${escapeHtml(c.ocr_carnet_vigencia || "Verificada")}</td></tr>
      <tr><th>Certificado de Antecedentes (OCR)</th><td>${escapeHtml(c.ocr_antecedentes_status || "Sin Antecedentes")}</td></tr>
      <tr><th>Diagnóstico de Consistencia Cruzada</th><td>${escapeHtml(c.discrepancy_notes || "Consistencia 100% verificada")}</td></tr>
      <tr><th>Consentimiento Ley N° 19.628</th><td>Aceptado expresamente por el titular para acreditación minera</td></tr>
    </table>

    <h2>3. Índice de Archivos Normalizados para Carga en WebControl</h2>
    <table>
      <thead>
        <tr><th>Nomenclatura Estandarizada WebControl</th><th>Tipo de Documento</th><th>Enlace Directo</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>${escapeHtml(prefix)}_Cedula_Identidad_Frente.jpg</code></td>
          <td>Cédula de Identidad (Frente)</td>
          <td>${c.carnet_file ? `<a href="${fileUrlWithAuth(c.carnet_file)}" target="_blank" download="${escapeHtml(prefix)}_Cedula_Identidad_Frente.jpg">Descargar Archivo</a>` : "Pendiente"}</td>
        </tr>
        <tr>
          <td><code>${escapeHtml(prefix)}_Cedula_Identidad_Reverso.jpg</code></td>
          <td>Cédula de Identidad (Reverso)</td>
          <td>${c.carnet_back_file ? `<a href="${fileUrlWithAuth(c.carnet_back_file)}" target="_blank" download="${escapeHtml(prefix)}_Cedula_Identidad_Reverso.jpg">Descargar Archivo</a>` : "Pendiente"}</td>
        </tr>
        <tr>
          <td><code>${escapeHtml(prefix)}_Certificado_Antecedentes.jpg</code></td>
          <td>Certificado de Antecedentes Fines Especiales</td>
          <td>${c.antecedentes_file ? `<a href="${fileUrlWithAuth(c.antecedentes_file)}" target="_blank" download="${escapeHtml(prefix)}_Certificado_Antecedentes.jpg">Descargar Archivo</a>` : "Pendiente"}</td>
        </tr>
        <tr>
          <td><code>${escapeHtml(prefix)}_Credencial_Tecnica_ECF.jpg</code></td>
          <td>${escapeHtml(c.required_credential || "Certificación Técnica")}</td>
          <td>${c.credencial_file || c.cert_file ? `<a href="${fileUrlWithAuth(c.credencial_file || c.cert_file)}" target="_blank" download="${escapeHtml(prefix)}_Credencial_Tecnica_ECF.jpg">Descargar Archivo</a>` : "Pendiente"}</td>
        </tr>
        <tr>
          <td><code>${escapeHtml(prefix)}_Curriculum_Vitae.pdf</code></td>
          <td>Currículum Vitae (CV)</td>
          <td>${c.cv_file ? `<a href="${fileUrlWithAuth(c.cv_file)}" target="_blank" download="${escapeHtml(prefix)}_Curriculum_Vitae">Descargar Archivo</a>` : "Pendiente"}</td>
        </tr>
      </tbody>
    </table>

    <h2>4. Respaldo Visual de Identidad (Selfie Proctoring Transparente vs. Cédula)</h2>
    <div class="photos">
      <div class="photo-box">
        <strong>Selfie Informada (Durante Mini-Test Técnico)</strong><br>
        ${c.initial_selfie ? `<img src="${fileUrlWithAuth(c.initial_selfie)}" alt="Selfie Test">` : "<p>Sin foto</p>"}
      </div>
      <div class="photo-box">
        <strong>Cédula de Identidad Cargada en Fase 2</strong><br>
        ${c.carnet_file ? `<img src="${fileUrlWithAuth(c.carnet_file)}" alt="Cédula Identidad">` : "<p>Pendiente de Fase 2</p>"}
      </div>
    </div>
  </div>
</body>
</html>`;

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(htmlReport);
    } catch (err) {
      next(err);
    }
  },
);

// Función para re-evaluar el expediente OCR de un candidato usando sus archivos almacenados
async function reprocessCandidateOcr(id) {
  const [candRows] = await pool.query("SELECT * FROM candidates WHERE id = ?", [
    id,
  ]);
  if (candRows.length === 0) return null;
  const c = candRows[0];

  const resolveUploadPath = (urlStr) => {
    if (!urlStr) return null;
    const baseName = path.basename(urlStr);
    const fullP = path.join(UPLOADS_DIR, baseName);
    return fs.existsSync(fullP) ? fullP : null;
  };

  const itemsToScan = [];
  const cvPath = resolveUploadPath(c.cv_file);
  const credPath = resolveUploadPath(c.credencial_file || c.cert_file);
  const carnetFrontPath = resolveUploadPath(c.carnet_file);
  const carnetBackPath = resolveUploadPath(c.carnet_back_file);
  const antPath = resolveUploadPath(c.antecedentes_file);

  if (credPath)
    itemsToScan.push({ type: "CREDENCIAL_TECNICA", filePath: credPath });
  if (cvPath) itemsToScan.push({ type: "CV", filePath: cvPath });
  if (carnetFrontPath)
    itemsToScan.push({ type: "CEDULA_FRENTE", filePath: carnetFrontPath });
  if (carnetBackPath)
    itemsToScan.push({ type: "CEDULA_REVERSO", filePath: carnetBackPath });
  if (antPath)
    itemsToScan.push({ type: "CERT_ANTECEDENTES", filePath: antPath });

  if (itemsToScan.length === 0) return null;

  const { combinedText, parsedByType } = await runTesseractOnFiles(itemsToScan);
  const cred = parsedByType.CREDENCIAL_TECNICA || {};
  const cv = parsedByType.CV || {};
  const cedFront = parsedByType.CEDULA_FRENTE || {};
  const cedBack = parsedByType.CEDULA_REVERSO || {};
  const ant = parsedByType.CERT_ANTECEDENTES || {};

  const emailHint = cv.detected_email || cred.detected_email || c.email || null;
  let phase1Name =
    pickBestPersonName(
      [
        cred.detected_name,
        cv.detected_name,
        isValidPersonName(c.full_name) ? c.full_name : null,
      ],
      emailHint,
    ) || (isValidPersonName(c.full_name) ? c.full_name : null);

  const phase2Name = pickBestPersonName(
    [cedFront.detected_name, cedBack.detected_name, ant.detected_name],
    phase1Name || emailHint,
  );

  if (!phase1Name && phase2Name) {
    phase1Name = phase2Name;
  } else if (!phase1Name) {
    phase1Name = c.full_name;
  }

  const ocrCarnetRut =
    cedFront.detected_rut ||
    cedBack.detected_rut ||
    ant.detected_rut ||
    cred.detected_rut ||
    c.ocr_detected_rut;
  const ocrBirthDate =
    cedFront.birth_date ||
    cedBack.birth_date ||
    ant.birth_date ||
    c.ocr_birth_date;
  const ocrDetectedAge =
    cedFront.detected_age ??
    cedBack.detected_age ??
    ant.detected_age ??
    c.ocr_detected_age ??
    c.age;
  const hasPhase2Docs = Boolean(carnetFrontPath || antPath);
  // El reproceso usa OCR local (sin cotejo facial ni fecha de emisión): nunca aprueba.
  // Solo deriva a revisión manual si encuentra una discordancia comprobada, y no toca la Fase 1.
  const evidence = documentDecision.evidenceFromLocalOcr(
    { cedFront, cedBack, ant },
    parseChileanDate,
  );
  if (phase2Name) evidence.carnetName = phase2Name;
  evidence.facialMatch =
    c.facial_match_ok === 1 ? true : c.facial_match_ok === 0 ? false : null;
  const decision = documentDecision.evaluatePhase2Evidence(
    evidence,
    { rut: c.rut_id, name: phase1Name },
    decisionHelpers,
  );
  const decisionByKey = Object.fromEntries(
    decision.checks.map((k) => [k.key, k]),
  );
  if (
    hasPhase2Docs &&
    decisionByKey.nombre_cedula.estado === documentDecision.VALIDO &&
    normalizeTextForMatch(phase2Name).split(" ").length >
      normalizeTextForMatch(phase1Name).split(" ").length
  ) {
    phase1Name = phase2Name;
  }

  let newStatus = c.status;
  let crossCheckOk = Boolean(c.ocr_cross_check_ok);
  let ocrCarnetVigencia = c.ocr_carnet_vigencia;
  let ocrAntecedentesStatus = c.ocr_antecedentes_status;
  let discrepancyNotes = c.discrepancy_notes;
  const discrepancies = hasPhase2Docs ? decision.discrepancies : [];
  if (hasPhase2Docs) {
    if (decisionByKey.vigencia_cedula.estado !== documentDecision.PENDIENTE) {
      ocrCarnetVigencia = decision.carnetVigenciaLabel;
    }
    if (decisionByKey.anotaciones.estado === documentDecision.INVALIDO) {
      ocrAntecedentesStatus = decision.antecedentesLabel;
    }
    if (
      c.status === "DOCS_CARGADOS" ||
      (decision.hasInvalid &&
        ["PRE_ACREDITADO", "EN_REVISION_MANUAL"].includes(c.status))
    ) {
      newStatus = "EN_REVISION_MANUAL";
      crossCheckOk = false;
      discrepancyNotes = decision.discrepancies.join(" | ");
    }
  }

  // Limpiar nota de edición manual si se debió a un falso positivo previo (ej. "Adolfo Ibañez")
  let cleanedEditedFields = c.ocr_edited_fields;
  let cleanedManuallyEdited = c.ocr_manually_edited;
  if (
    cleanedEditedFields &&
    /(Adolfo|Completo|Ro Xt)/i.test(cleanedEditedFields)
  ) {
    cleanedEditedFields = null;
    cleanedManuallyEdited = 0;
  }

  let updatedCity = cv.detected_city || c.city;
  if (!cv.detected_city && cvPath && c.city && /^lampa$/i.test(c.city.trim())) {
    updatedCity = "No especificada en CV";
  }
  const updatedExpYears =
    cvPath &&
    cv.detected_experience_years !== null &&
    cv.detected_experience_years !== undefined
      ? cv.detected_experience_years
      : c.experience_years;

  await pool.query(
    `UPDATE candidates SET
      full_name = ?,
      email = COALESCE(?, email),
      phone = COALESCE(?, phone),
      city = ?,
      experience_years = ?,
      status = ?,
      ocr_text = ?,
      ocr_birth_date = ?,
      ocr_detected_age = ?,
      ocr_verified = ?,
      ocr_detected_name = ?,
      ocr_detected_rut = ?,
      ocr_carnet_vigencia = ?,
      ocr_antecedentes_status = ?,
      ocr_cross_check_ok = ?,
      ocr_manually_edited = ?,
      ocr_edited_fields = ?,
      discrepancy_notes = ?
    WHERE id = ?`,
    [
      phase1Name,
      cv.detected_email || null,
      cv.detected_phone || null,
      updatedCity,
      updatedExpYears,
      newStatus,
      combinedText || c.ocr_text,
      ocrBirthDate,
      ocrDetectedAge,
      crossCheckOk ? 1 : 0,
      phase2Name || c.ocr_detected_name,
      ocrCarnetRut,
      ocrCarnetVigencia,
      ocrAntecedentesStatus,
      crossCheckOk ? 1 : 0,
      cleanedManuallyEdited,
      cleanedEditedFields,
      discrepancyNotes,
      id,
    ],
  );

  return {
    id,
    full_name: phase1Name,
    ocrCarnetName: phase2Name || null,
    city: updatedCity,
    experience_years: updatedExpYears,
    status: newStatus,
    crossCheckOk,
    discrepancies,
  };
}

app.post(
  "/api/admin/candidates/:id/reprocess-ocr",
  auth.requireAdminAuth,
  validate({ params: schemas.idParam }),
  async (req, res, next) => {
    try {
      const result = await reprocessCandidateOcr(req.params.id);
      if (!result)
        return res
          .status(404)
          .json({ error: "Candidato o archivos no encontrados." });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// Iniciar Servidor con manejo dinámico de puerto si el 3000 está ocupado
// Rutas /api inexistentes y manejador central de errores (siempre al final de la cadena)
app.use("/api/", notFoundApi);
app.use(errorHandler);

// Arranque fail-fast: el puerto solo se abre si la BD conecta, las migraciones terminan y los datos
// semilla obligatorios están cargados. Cualquier fallo ahí detiene el proceso con código 1.
async function main(portToUse) {
  try {
    await initDB();
  } catch (dbErr) {
    console.error(`[Arranque] Detenido: ${redact(dbErr.message)}`);
    process.exit(1);
  }
  startServer(portToUse);
}

function startServer(portToUse) {
  const server = app.listen(portToUse, async () => {
    serverListening = true;
    console.log(
      `[Servidor] Portal de Convocatoria y Pre-Filtro Normativo Nexxo S.A. listo en http://localhost:${portToUse}`,
    );
    // Tarea OPCIONAL de arranque (auto-reparación OCR): si falla se informa y la aplicación sigue operativa.
    try {
      const [rows] = await pool.query(
        "SELECT id, full_name, city, ocr_detected_name, discrepancy_notes, ocr_edited_fields FROM candidates",
      );
      for (const r of rows) {
        const hasInvalidFullName = !isValidPersonName(r.full_name);
        const hasInvalidOcrName = Boolean(
          r.ocr_detected_name && !isValidPersonName(r.ocr_detected_name),
        );
        const hasLegacyNoise = /(Adolfo|Completo|Ro Xt)/i.test(
          `${r.discrepancy_notes || ""} ${r.ocr_edited_fields || ""}`,
        );
        const hasWorkplaceCityBug = Boolean(
          r.city && /^lampa$/i.test(r.city.trim()),
        );
        if (
          hasInvalidFullName ||
          hasInvalidOcrName ||
          hasLegacyNoise ||
          hasWorkplaceCityBug
        ) {
          console.log(
            `[Auto-Repair OCR] Reparando expediente #${r.id} ("${r.full_name}")...`,
          );
          await reprocessCandidateOcr(r.id);
        }
      }
    } catch (e) {
      console.error(
        `[Arranque] Tarea opcional "auto-reparación OCR" falló; la aplicación sigue operativa: ${redact(e.message)}`,
      );
    }
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(
        `[AVISO] El puerto ${portToUse} está ocupado por otro proceso. Intentando en http://localhost:${portToUse + 1}...`,
      );
      startServer(portToUse + 1);
    } else {
      console.error("[ERROR] Error fatal al iniciar servidor:", err);
    }
  });
}

// Solo arranca al ejecutarse directamente (node src/server.js); al importarse (pruebas) no abre puerto ni BD.
if (require.main === module) {
  main(parseInt(PORT, 10));
}

module.exports = {
  app,
  dbConfig,
  initDB,
  getPool: () => pool,
  closeDB: async () => {
    if (pool) await pool.end();
  },
  reprocessCandidateOcr,
  VALID_STATES,
  saveBase64File,
  escapeHtml,
  formatTitleCase,
  formatRut,
  normalizeTextForMatch,
  extractDatesFromText,
  isValidPersonName,
  pickBestPersonName,
  parseChileanDate,
  isValidChileanRutMod11,
  splitCvIntoSections,
  calculateExperienceFromSections,
  parseExtractedText,
};

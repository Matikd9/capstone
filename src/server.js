const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { createWorker } = require("tesseract.js");
const rateLimit = require("express-rate-limit");
require("./config/env");

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
const {
  escapeHtml,
  formatTitleCase,
  normalizeTextForMatch,
} = require("./shared/text");
const { formatRut, isValidChileanRutMod11 } = require("./shared/rut");
const { extractDatesFromText, parseChileanDate } = require("./shared/dates");
const { VALID_STATES } = require("./shared/candidateStates");
const { isValidPersonName, pickBestPersonName } = require("./cv/names");
const {
  splitCvIntoSections,
  calculateExperienceFromSections,
} = require("./cv/experience");
const { parseExtractedText } = require("./cv/parser");
const { runMigrations } = require("./db/migrate");
const { ensureSeedData } = require("./db/seeds");
const { dbConfig } = require("./config/database");
const { UPLOADS_DIR } = require("./config/uploads");

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

let pool;

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

// Funciones de apoyo para documentDecision (implementadas en src/shared/rut.js y src/shared/text.js).
const decisionHelpers = {
  isValidRut: (rut) => isValidChileanRutMod11(rut),
  normalize: (text) => normalizeTextForMatch(text),
};

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

/**
 * Módulo de Seguridad Documental e Inspección Heurística de Archivos
 * Implementa:
 * 1. Validación estricta de Magic Bytes (Firmas Binarias Reales)
 * 2. Bloqueo de ejecutables, scripts camuflados y archivos maliciosos
 * 3. Inspección heurística de Macros VBA en DOCX y JavaScript/Launch en PDFs
 * 4. Generación criptográficamente segura de nombres de archivo (anti-enumeración)
 */

const crypto = require("crypto");

// Firmas de Magic Bytes estándar
const MAGIC_BYTES = {
  PDF: [0x25, 0x50, 0x44, 0x46], // %PDF
  PNG: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // .PNG....
  JPEG: [0xff, 0xd8, 0xff], // JPEG SOI marker
  ZIP: [0x50, 0x4b, 0x03, 0x04], // PK.. (ZIP container, base de DOCX)
  WEBP_RIFF: [0x52, 0x49, 0x46, 0x46], // RIFF
  PE_EXE: [0x4d, 0x5a], // MZ (Windows Executable / DLL)
  ELF_EXE: [0x7f, 0x45, 0x4c, 0x46], // \x7fELF (Linux Binary)
  SHEBANG: [0x23, 0x21], // #! (Script ejecutable)
};

function matchesHeader(buffer, signature) {
  if (!buffer || buffer.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Detecta el tipo real de archivo examinando los bytes de cabecera
 * @param {Buffer} buffer
 * @returns {string|null} 'pdf' | 'docx' | 'jpg' | 'png' | 'webp' | 'executable' | 'script' | null
 */
function detectRealFileType(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null;
  }

  // 1. Detectar ejecutables o scripts camuflados
  if (matchesHeader(buffer, MAGIC_BYTES.PE_EXE)) {
    return "executable_pe";
  }
  if (matchesHeader(buffer, MAGIC_BYTES.ELF_EXE)) {
    return "executable_elf";
  }
  if (matchesHeader(buffer, MAGIC_BYTES.SHEBANG)) {
    return "executable_script";
  }

  // 2. Detectar tipos permitidos
  if (matchesHeader(buffer, MAGIC_BYTES.PDF)) {
    return "pdf";
  }
  if (matchesHeader(buffer, MAGIC_BYTES.JPEG)) {
    return "jpg";
  }
  if (matchesHeader(buffer, MAGIC_BYTES.PNG)) {
    return "png";
  }
  if (matchesHeader(buffer, MAGIC_BYTES.WEBP_RIFF) && buffer.length >= 12) {
    const webpTag = buffer.toString("ascii", 8, 12);
    if (webpTag === "WEBP") return "webp";
  }

  // 3. Detectar documentos Word (ZIP con estructura OpenXML)
  if (matchesHeader(buffer, MAGIC_BYTES.ZIP)) {
    const headerSlice = buffer.slice(0, 4096).toString("binary");
    if (
      headerSlice.includes("[Content_Types].xml") ||
      headerSlice.includes("word/")
    ) {
      return "docx";
    }
    // Es un ZIP genérico, no DOCX validado
    return "zip_archive";
  }

  return "unknown";
}

/**
 * Escáner heurístico de amenazas y código activo en documentos
 * @param {Buffer} buffer
 * @param {string} fileType
 * @returns {{ isSafe: boolean, threatReason: string|null }}
 */
function scanDocumentHeuristics(buffer, fileType) {
  if (!buffer || buffer.length === 0) {
    return { isSafe: false, threatReason: "Archivo vacío o buffer corrupto." };
  }

  // Comprobación de límites de tamaño (Máximo 25 MB por archivo individual)
  const MAX_FILE_SIZE = 25 * 1024 * 1024;
  if (buffer.length > MAX_FILE_SIZE) {
    return {
      isSafe: false,
      threatReason: "El archivo excede el tamaño máximo permitido (25MB).",
    };
  }

  // Análisis según tipo de archivo
  if (fileType === "docx") {
    // Escanear si contiene macros VBA (Office OpenXML con macros es .docm o vbaProject.bin)
    const content = buffer.toString("binary");
    if (
      content.includes("vbaProject.bin") ||
      content.includes("word/vbaData.xml") ||
      content.includes("VBA") ||
      content.includes("AutoExec") ||
      content.includes("AutoOpen")
    ) {
      return {
        isSafe: false,
        threatReason:
          "Se detectaron macros activas o código ejecutable VBA en el documento Word. Por seguridad, no se admiten archivos con macros.",
      };
    }
  }

  if (fileType === "pdf") {
    const pdfRaw = buffer.toString("latin1");
    // Detección de acciones peligrosas en PDFs (JavaScript incrustado o ejecución externa)
    const dangerousPdfPatterns = [
      /\/JavaScript\b/i,
      /\/JS\s*[\(\<]/i,
      /\/Launch\b/i,
      /\/EmbeddedFiles\b/i,
    ];

    for (const pattern of dangerousPdfPatterns) {
      if (pattern.test(pdfRaw)) {
        return {
          isSafe: false,
          threatReason:
            "El archivo PDF contiene acciones ejecutables, scripts o llamadas de sistema sospechosas (/JavaScript o /Launch).",
        };
      }
    }
  }

  // Análisis para imágenes: evitar exploits SVG o HTML camuflado
  if (["jpg", "png", "webp"].includes(fileType)) {
    const sample = buffer
      .slice(0, 1024)
      .toString("utf8", 0, Math.min(buffer.length, 1024))
      .toLowerCase();
    if (
      sample.includes("<script") ||
      sample.includes("<html") ||
      sample.includes("<?php")
    ) {
      return {
        isSafe: false,
        threatReason:
          "El archivo de imagen contiene código script o etiquetas web no permitidas.",
      };
    }
  }

  return { isSafe: true, threatReason: null };
}

/**
 * Genera un nombre de archivo seguro y no enumerable con UUID criptográfico
 * @param {string} prefix
 * @param {string} ext
 * @returns {string}
 */
function generateSecureFilename(prefix = "doc", ext = "bin") {
  const cleanPrefix = String(prefix)
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 15);
  const randomHex = crypto.randomBytes(16).toString("hex");
  const cleanExt = String(ext)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 6);
  return `${cleanPrefix}_${Date.now()}_${randomHex}.${cleanExt}`;
}

module.exports = {
  detectRealFileType,
  scanDocumentHeuristics,
  generateSecureFilename,
};

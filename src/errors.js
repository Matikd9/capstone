/**
 * Manejo centralizado de errores HTTP.
 * Los errores esperados (AppError) devuelven su mensaje; los internos, uno genérico.
 * El registro enmascara valores que pueden contener datos personales o secretos.
 */

class AppError extends Error {
  constructor(status, message, { details, cause } = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.details = details;
    this.cause = cause;
  }
}

const GENERIC_MESSAGE =
  "Error interno del servidor. Intente nuevamente más tarde.";

// Los mensajes de MySQL incluyen valores de la consulta (RUT, nombres, correos): se enmascaran antes de registrar.
function redact(text) {
  return String(text || "")
    .replace(/'[^']*'/g, "'[redactado]'")
    .replace(/"[^"]*"/g, '"[redactado]"')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[correo]")
    .replace(/\b\d{1,2}\.?\d{3}\.?\d{3}-?[\dkK]\b/g, "[rut]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[token]");
}

function logInternal(req, err) {
  const root = err.cause || err;
  const frames = String(root.stack || "")
    .split("\n")
    .slice(1, 4)
    .map((l) => l.trim())
    .join(" | ");
  console.error(
    `[Error] ${req.method} ${req.path}: ${root.name || "Error"}${root.code ? ` (${root.code})` : ""} - ${redact(root.message)}${frames ? ` @ ${frames}` : ""}`,
  );
}

function notFoundApi(req, res) {
  res.status(404).json({ error: "Recurso no encontrado." });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = 500;
  let message = GENERIC_MESSAGE;
  let details;

  if (err instanceof AppError) {
    status = err.status;
    message = status >= 500 ? err.message || GENERIC_MESSAGE : err.message;
    details = err.details;
  } else if (err && err.type === "entity.too.large") {
    status = 413;
    message = "Los archivos enviados superan el tamaño máximo permitido.";
  } else if (err && err.type === "entity.parse.failed") {
    status = 400;
    message = "El cuerpo de la solicitud no es un JSON válido.";
  }

  if (status >= 500) logInternal(req, err);
  if (res.headersSent) return res.end();

  const body = { error: message };
  if (details) body.details = details;
  res.status(status).json(body);
}

module.exports = { AppError, errorHandler, notFoundApi, redact };

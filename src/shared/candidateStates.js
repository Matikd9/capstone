/**
 * Estados válidos de candidates.status (máquina de estados del proceso de postulación).
 * Código movido sin cambios desde src/server.js (tarea 1.7).
 */

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

module.exports = { VALID_STATES };

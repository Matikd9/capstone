/**
 * Decisión de pre-acreditación documental (Fase 2).
 *
 * Regla: solo hay PRE_ACREDITADO cuando TODAS las verificaciones son positivas y fueron comprobadas.
 * Un dato que no se pudo leer o verificar deja la verificación PENDIENTE (revisión humana);
 * nunca se asume "vigente", "sin anotaciones" ni "coincide". Es una función pura: no consulta la BD.
 */

const ANTECEDENTES_MAX_DIAS = 60; // Vigencia normativa del Certificado de Antecedentes
const TOLERANCIA_FECHA_FUTURA_DIAS = 2; // Desfase horario / zona

const VALIDO = "VALIDO";
const INVALIDO = "INVALIDO";
const PENDIENTE = "PENDIENTE";

const DAY_MS = 24 * 60 * 60 * 1000;

function cleanRut(rut) {
  return String(rut || "")
    .replace(/[^0-9kK]/g, "")
    .toUpperCase();
}

function formatDate(d) {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

function isDate(d) {
  return d instanceof Date && !isNaN(d.getTime());
}

/**
 * Compara nombres por tokens (>2 letras): exige al menos 2 tokens del registro de Fase 1
 * (o todos, si tiene menos) presentes en el nombre leído del documento.
 */
function namesMatch(expected, read, normalize) {
  const exp = normalize(expected || "");
  const got = normalize(read || "");
  const tokens = exp.split(" ").filter((t) => t.length > 2);
  if (tokens.length === 0 || !got) return null;
  const matched = tokens.filter((t) => got.includes(t));
  return matched.length >= Math.min(2, tokens.length);
}

/**
 * @param {object} ev Evidencia normalizada extraída de los documentos (null = no se pudo determinar):
 *   carnetRut, carnetName, carnetExpiry (Date), carnetMarkedExpired (bool),
 *   antecedentesRut, antecedentesIssued (Date), anotaciones (bool|null), facialMatch (bool|null)
 * @param {object} candidate { rut, name } registrados en Fase 1
 * @param {object} helpers { isValidRut(rut), normalize(text) }
 * @param {Date} [now]
 */
function evaluatePhase2Evidence(ev, candidate, helpers, now = new Date()) {
  const checks = [];
  const add = (key, estado, nota) => checks.push({ key, estado, nota });
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Una conclusión negativa (vencida, con anotaciones, suplantación) solo se acepta si el documento se leyó:
  // con imágenes en blanco, el modelo de IA puede inventar fechas o anotaciones.
  const carnetRead = Boolean(ev.carnetRut || ev.carnetName);
  const antecedentesRead = Boolean(
    ev.antecedentesRut || isDate(ev.antecedentesIssued),
  );

  const anyData = Boolean(
    ev.carnetRut ||
    ev.carnetName ||
    isDate(ev.carnetExpiry) ||
    ev.antecedentesRut ||
    isDate(ev.antecedentesIssued) ||
    ev.anotaciones !== null,
  );
  if (!anyData) {
    add(
      "legibilidad",
      PENDIENTE,
      "No se pudo extraer información de los documentos (ilegibles, vacíos o fallo del OCR): requiere revisión humana.",
    );
  }

  // 1. RUT de la cédula vs. Fase 1
  const candRut = cleanRut(candidate.rut);
  const carnetRut = cleanRut(ev.carnetRut);
  if (!carnetRut) {
    add("rut_cedula", PENDIENTE, "No se pudo leer el RUT de la cédula.");
  } else if (!helpers.isValidRut(ev.carnetRut)) {
    add(
      "rut_cedula",
      PENDIENTE,
      `El RUT leído en la cédula (${ev.carnetRut}) no es válido: posible error de lectura.`,
    );
  } else if (carnetRut !== candRut) {
    add(
      "rut_cedula",
      INVALIDO,
      `Discordancia de RUT: Fase 1 (${candidate.rut}) vs. Cédula (${ev.carnetRut}).`,
    );
  } else {
    add("rut_cedula", VALIDO);
  }

  // 2. Nombre de la cédula vs. Fase 1
  const nameOk = namesMatch(candidate.name, ev.carnetName, helpers.normalize);
  if (nameOk === null) {
    add(
      "nombre_cedula",
      PENDIENTE,
      "No se pudo leer el nombre del titular en la cédula.",
    );
  } else if (!nameOk) {
    add(
      "nombre_cedula",
      INVALIDO,
      `Discordancia de nombre: Fase 1 ("${candidate.name}") vs. Cédula ("${ev.carnetName}").`,
    );
  } else {
    add("nombre_cedula", VALIDO);
  }

  // 3. Vigencia de la cédula: exige una fecha de vencimiento leída en una cédula legible
  if (!carnetRead && (isDate(ev.carnetExpiry) || ev.carnetMarkedExpired)) {
    add(
      "vigencia_cedula",
      PENDIENTE,
      "El OCR informó una vigencia, pero la cédula no se pudo leer: verificar manualmente.",
    );
  } else if (isDate(ev.carnetExpiry)) {
    if (ev.carnetExpiry < today) {
      add(
        "vigencia_cedula",
        INVALIDO,
        `Cédula de identidad vencida (venció el ${formatDate(ev.carnetExpiry)}).`,
      );
    } else {
      add("vigencia_cedula", VALIDO);
    }
  } else if (ev.carnetMarkedExpired === true) {
    add(
      "vigencia_cedula",
      PENDIENTE,
      "El OCR indica que la cédula estaría vencida, pero no se leyó la fecha: verificar manualmente.",
    );
  } else {
    add(
      "vigencia_cedula",
      PENDIENTE,
      "No se pudo verificar la fecha de vencimiento de la cédula.",
    );
  }

  // 4. Antigüedad del Certificado de Antecedentes (máx. 60 días)
  if (isDate(ev.antecedentesIssued)) {
    const issued = new Date(
      ev.antecedentesIssued.getFullYear(),
      ev.antecedentesIssued.getMonth(),
      ev.antecedentesIssued.getDate(),
    );
    const dias = Math.round((today - issued) / DAY_MS);
    if (dias < -TOLERANCIA_FECHA_FUTURA_DIAS) {
      add(
        "fecha_antecedentes",
        INVALIDO,
        `El certificado de antecedentes tiene fecha de emisión futura (${formatDate(issued)}).`,
      );
    } else if (dias > ANTECEDENTES_MAX_DIAS) {
      add(
        "fecha_antecedentes",
        INVALIDO,
        `Certificado de antecedentes vencido (emitido hace ${dias} días; límite normativo ${ANTECEDENTES_MAX_DIAS} días).`,
      );
    } else {
      add("fecha_antecedentes", VALIDO, Math.max(dias, 0));
    }
  } else {
    add(
      "fecha_antecedentes",
      PENDIENTE,
      "No se pudo verificar la fecha de emisión del certificado de antecedentes.",
    );
  }

  // 5. RUT del certificado de antecedentes vs. Fase 1
  const antRut = cleanRut(ev.antecedentesRut);
  if (!antRut) {
    add(
      "rut_antecedentes",
      PENDIENTE,
      "No se pudo leer el RUT del certificado de antecedentes.",
    );
  } else if (antRut !== candRut) {
    add(
      "rut_antecedentes",
      INVALIDO,
      `El RUT del certificado de antecedentes (${ev.antecedentesRut}) no coincide con el de Fase 1 (${candidate.rut}).`,
    );
  } else {
    add("rut_antecedentes", VALIDO);
  }

  // 6. Anotaciones penales: "sin anotaciones" debe constar expresamente
  if (ev.anotaciones === true && !antecedentesRead) {
    add(
      "anotaciones",
      PENDIENTE,
      "El OCR informó anotaciones, pero el certificado no se pudo leer: verificar manualmente.",
    );
  } else if (ev.anotaciones === true) {
    add(
      "anotaciones",
      INVALIDO,
      "El certificado de antecedentes registra anotaciones penales: requiere revisión de RR.HH.",
    );
  } else if (ev.anotaciones === false) {
    add("anotaciones", VALIDO);
  } else {
    add(
      "anotaciones",
      PENDIENTE,
      "No se pudo determinar si el certificado registra anotaciones.",
    );
  }

  // 7. Cotejo facial cédula vs. selfies del mini-test
  if (ev.facialMatch === false && !carnetRead) {
    add(
      "cotejo_facial",
      PENDIENTE,
      "El cotejo facial no coincidió, pero la cédula no se pudo leer: verificar manualmente.",
    );
  } else if (ev.facialMatch === false) {
    add(
      "cotejo_facial",
      INVALIDO,
      "[ALERTA SUPLANTACIÓN FACIAL] La fotografía de la cédula no coincide con las selfies del mini-test.",
    );
  } else if (ev.facialMatch === true) {
    add("cotejo_facial", VALIDO);
  } else {
    add(
      "cotejo_facial",
      PENDIENTE,
      "No se pudo realizar el cotejo facial automático.",
    );
  }

  const invalid = checks.filter((c) => c.estado === INVALIDO);
  const pending = checks.filter((c) => c.estado === PENDIENTE);
  const allValid = invalid.length === 0 && pending.length === 0;
  const byKey = Object.fromEntries(checks.map((c) => [c.key, c]));

  const vig = byKey.vigencia_cedula;
  const carnetVigenciaLabel =
    vig.estado === VALIDO
      ? `Vigente (Vence: ${formatDate(ev.carnetExpiry)})`
      : vig.estado === INVALIDO
        ? `Vencido (${formatDate(ev.carnetExpiry)})`
        : "No verificada (requiere revisión)";

  let antecedentesLabel;
  if (byKey.anotaciones.estado === INVALIDO) {
    antecedentesLabel = "Con Anotaciones Penales";
  } else if (byKey.fecha_antecedentes.estado === INVALIDO) {
    antecedentesLabel = "Certificado fuera de plazo (> 60 días)";
  } else if (
    byKey.anotaciones.estado === VALIDO &&
    byKey.fecha_antecedentes.estado === VALIDO
  ) {
    antecedentesLabel = `Limpio / Vigente (${byKey.fecha_antecedentes.nota} días)`;
  } else {
    antecedentesLabel = "No verificado (requiere revisión)";
  }

  return {
    status: allValid ? "PRE_ACREDITADO" : "EN_REVISION_MANUAL",
    verdict: allValid ? VALIDO : invalid.length > 0 ? INVALIDO : PENDIENTE,
    crossCheckOk: allValid,
    checks,
    hasInvalid: invalid.length > 0,
    discrepancies: [...invalid, ...pending].map((c) => c.nota),
    carnetVigenciaLabel,
    antecedentesLabel,
  };
}

// Extrae la primera fecha (DD/MM/AAAA, DD-MM-AAAA o AAAA-MM-DD) de un texto como "Vigente (Vence: 10/05/2030)".
function dateFromText(text, parseDate) {
  const m = String(text || "").match(
    /(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})/,
  );
  if (!m) return null;
  const d = parseDate(m[1]);
  return isDate(d) ? d : null;
}

/** Normaliza la respuesta de Gemini (Fase 2) sin rellenar huecos con datos de Fase 1. */
function evidenceFromGemini(g2, parseDate) {
  const vigText = String(g2.carnet_vigencia || "");
  const carnetExpiry =
    (g2.carnet_fecha_vencimiento &&
    isDate(parseDate(String(g2.carnet_fecha_vencimiento)))
      ? parseDate(String(g2.carnet_fecha_vencimiento))
      : null) || dateFromText(vigText, parseDate);
  const antecedentesIssued = g2.antecedentes_fecha_emision
    ? parseDate(String(g2.antecedentes_fecha_emision).trim())
    : null;
  const statusText = String(g2.antecedentes_status || "");

  let anotaciones = null;
  if (
    g2.tiene_anotaciones_penales === true ||
    /con anotaciones/i.test(statusText)
  ) {
    anotaciones = true;
  } else if (
    g2.tiene_anotaciones_penales === false &&
    isDate(antecedentesIssued) &&
    /sin anotaciones|limpio|no registra/i.test(statusText)
  ) {
    // "Sin anotaciones" solo cuenta si el certificado se leyó (tiene fecha de emisión) y lo declara expresamente.
    anotaciones = false;
  }

  return {
    carnetRut: g2.carnet_rut || null,
    carnetName: g2.carnet_name || null,
    carnetExpiry,
    carnetMarkedExpired:
      g2.carnet_vigente_bool === false || /^\s*vencid/i.test(vigText),
    antecedentesRut: g2.antecedentes_rut || null,
    antecedentesIssued: isDate(antecedentesIssued) ? antecedentesIssued : null,
    anotaciones,
    facialMatch:
      typeof g2.facial_match_ok === "boolean" ? g2.facial_match_ok : null,
  };
}

/** Normaliza el resultado del OCR local (Tesseract/Poppler). No hace cotejo facial ni lee la fecha de emisión. */
function evidenceFromLocalOcr(
  { cedFront = {}, cedBack = {}, ant = {} },
  parseDate,
) {
  const vigText = cedFront.carnet_vigencia || cedBack.carnet_vigencia || "";
  const antText = ant.antecedentes_status || "";
  return {
    carnetRut: cedFront.detected_rut || cedBack.detected_rut || null,
    carnetName: cedFront.detected_name || cedBack.detected_name || null,
    carnetExpiry: dateFromText(vigText, parseDate),
    carnetMarkedExpired: /^\s*vencid/i.test(vigText),
    antecedentesRut: ant.detected_rut || null,
    // El parser local no distingue la fecha de emisión de otras fechas del certificado.
    antecedentesIssued: null,
    anotaciones: /con anotaciones/i.test(antText)
      ? true
      : /sin antecedentes|sin anotaciones/i.test(antText)
        ? false
        : null,
    facialMatch: null,
  };
}

module.exports = {
  evaluatePhase2Evidence,
  evidenceFromGemini,
  evidenceFromLocalOcr,
  VALIDO,
  INVALIDO,
  PENDIENTE,
};

// Pruebas de la decisión documental de Fase 2 (node:test, sin dependencias). Ejecutar: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  evaluatePhase2Evidence,
  evidenceFromGemini,
  evidenceFromLocalOcr,
  VALIDO,
  INVALIDO,
  PENDIENTE,
} = require("../../src/documentDecision");

// Equivalentes mínimos de isValidChileanRutMod11 / normalizeTextForMatch / parseChileanDate de server.js.
function isValidRut(rut) {
  const clean = String(rut || "")
    .replace(/[^0-9kK]/g, "")
    .toUpperCase();
  if (clean.length < 2) return false;
  const body = clean.slice(0, -1);
  let sum = 0;
  let mul = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const res = 11 - (sum % 11);
  const dv = res === 11 ? "0" : res === 10 ? "K" : String(res);
  return dv === clean.slice(-1);
}
const normalize = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
function parseDate(str) {
  const s = String(str || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T12:00:00Z");
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12) : null;
}

const helpers = { isValidRut, normalize };
const NOW = new Date(2026, 10, 13, 12); // 13/11/2026
const daysAgo = (n) => new Date(2026, 10, 13 - n, 12);
const candidate = { rut: "12.345.678-5", name: "Juan Pablo Pérez Soto" };

const validEvidence = () => ({
  carnetRut: "12.345.678-5",
  carnetName: "JUAN PABLO PEREZ SOTO",
  carnetExpiry: new Date(2030, 4, 10),
  carnetMarkedExpired: false,
  antecedentesRut: "12345678-5",
  antecedentesIssued: daysAgo(10),
  anotaciones: false,
  facialMatch: true,
});
const evaluate = (ev) => evaluatePhase2Evidence(ev, candidate, helpers, NOW);
const estado = (r, key) => r.checks.find((c) => c.key === key).estado;

test("la evidencia completa y verificada pre-acredita", () => {
  const r = evaluate(validEvidence());
  assert.equal(r.status, "PRE_ACREDITADO");
  assert.equal(r.verdict, VALIDO);
  assert.equal(r.crossCheckOk, true);
  assert.deepEqual(r.discrepancies, []);
  assert.match(r.carnetVigenciaLabel, /^Vigente \(Vence: 10\/05\/2030\)$/);
  assert.match(r.antecedentesLabel, /^Limpio \/ Vigente \(10 días\)$/);
});

test("documento vacío (nada extraído) queda pendiente de revisión", () => {
  const r = evaluate({
    carnetRut: null,
    carnetName: null,
    carnetExpiry: null,
    carnetMarkedExpired: false,
    antecedentesRut: null,
    antecedentesIssued: null,
    anotaciones: null,
    facialMatch: null,
  });
  assert.equal(r.status, "EN_REVISION_MANUAL");
  assert.equal(r.verdict, PENDIENTE);
  assert.equal(estado(r, "legibilidad"), PENDIENTE);
  assert.equal(r.carnetVigenciaLabel, "No verificada (requiere revisión)");
  assert.equal(r.antecedentesLabel, "No verificado (requiere revisión)");
});

test("OCR fallido de Gemini con booleanos optimistas no aprueba (caso imagen en blanco)", () => {
  // Gemini devolvía booleanos por defecto aunque no leyera nada.
  const ev = evidenceFromGemini(
    {
      carnet_rut: null,
      carnet_name: null,
      carnet_vigencia: "",
      carnet_vigente_bool: true,
      antecedentes_fecha_emision: null,
      tiene_anotaciones_penales: false,
      antecedentes_status: "Limpio / Sin Anotaciones",
      facial_match_ok: true,
    },
    parseDate,
  );
  assert.equal(
    ev.anotaciones,
    null,
    "sin certificado leído no hay 'sin anotaciones'",
  );
  assert.equal(ev.carnetExpiry, null);
  const r = evaluate(ev);
  assert.equal(r.status, "EN_REVISION_MANUAL");
  assert.notEqual(r.status, "PRE_ACREDITADO");
});

test("RUT ilegible o con dígito verificador inválido queda pendiente", () => {
  const r1 = evaluate({ ...validEvidence(), carnetRut: null });
  assert.equal(estado(r1, "rut_cedula"), PENDIENTE);
  const r2 = evaluate({ ...validEvidence(), carnetRut: "12.345.678-9" });
  assert.equal(estado(r2, "rut_cedula"), PENDIENTE);
  assert.equal(r2.status, "EN_REVISION_MANUAL");
});

test("fecha de vencimiento desconocida no se asume vigente", () => {
  const r = evaluate({ ...validEvidence(), carnetExpiry: null });
  assert.equal(estado(r, "vigencia_cedula"), PENDIENTE);
  assert.equal(r.status, "EN_REVISION_MANUAL");
  assert.equal(r.carnetVigenciaLabel, "No verificada (requiere revisión)");
});

test("fecha de emisión de antecedentes desconocida queda pendiente", () => {
  const r = evaluate({ ...validEvidence(), antecedentesIssued: null });
  assert.equal(estado(r, "fecha_antecedentes"), PENDIENTE);
  assert.equal(r.status, "EN_REVISION_MANUAL");
});

test("cédula vencida es inválida", () => {
  const r = evaluate({ ...validEvidence(), carnetExpiry: daysAgo(1) });
  assert.equal(estado(r, "vigencia_cedula"), INVALIDO);
  assert.equal(r.verdict, INVALIDO);
  assert.match(r.carnetVigenciaLabel, /^Vencido/);
});

test("cédula marcada vencida sin fecha legible queda pendiente", () => {
  const r = evaluate({
    ...validEvidence(),
    carnetExpiry: null,
    carnetMarkedExpired: true,
  });
  assert.equal(estado(r, "vigencia_cedula"), PENDIENTE);
  assert.equal(r.status, "EN_REVISION_MANUAL");
});

test("conclusiones negativas sobre documentos ilegibles quedan pendientes (IA que inventa datos)", () => {
  // Caso real: con imágenes en blanco Gemini devolvió vencimiento 2000-01-01, anotaciones y rostro distinto.
  const r = evaluate({
    carnetRut: null,
    carnetName: null,
    carnetExpiry: new Date(2000, 0, 1),
    carnetMarkedExpired: true,
    antecedentesRut: null,
    antecedentesIssued: null,
    anotaciones: true,
    facialMatch: false,
  });
  assert.equal(r.status, "EN_REVISION_MANUAL");
  assert.equal(r.verdict, PENDIENTE);
  assert.equal(estado(r, "vigencia_cedula"), PENDIENTE);
  assert.equal(estado(r, "anotaciones"), PENDIENTE);
  assert.equal(estado(r, "cotejo_facial"), PENDIENTE);
  assert.equal(r.carnetVigenciaLabel, "No verificada (requiere revisión)");
  assert.equal(r.antecedentesLabel, "No verificado (requiere revisión)");
  assert.ok(!r.discrepancies.some((d) => /SUPLANTACIÓN/.test(d)));
});

test("antecedentes con más de 60 días o fecha futura son inválidos", () => {
  assert.equal(
    estado(
      evaluate({ ...validEvidence(), antecedentesIssued: daysAgo(61) }),
      "fecha_antecedentes",
    ),
    INVALIDO,
  );
  assert.equal(
    estado(
      evaluate({ ...validEvidence(), antecedentesIssued: daysAgo(60) }),
      "fecha_antecedentes",
    ),
    VALIDO,
  );
  assert.equal(
    estado(
      evaluate({ ...validEvidence(), antecedentesIssued: daysAgo(-5) }),
      "fecha_antecedentes",
    ),
    INVALIDO,
  );
});

test("anotaciones penales: true es inválido y desconocido es pendiente", () => {
  const r1 = evaluate({ ...validEvidence(), anotaciones: true });
  assert.equal(estado(r1, "anotaciones"), INVALIDO);
  assert.equal(r1.antecedentesLabel, "Con Anotaciones Penales");
  const r2 = evaluate({ ...validEvidence(), anotaciones: null });
  assert.equal(estado(r2, "anotaciones"), PENDIENTE);
  assert.equal(r2.status, "EN_REVISION_MANUAL");
});

test("cotejo facial: falso es inválido y sin cotejo es pendiente", () => {
  assert.equal(
    estado(
      evaluate({ ...validEvidence(), facialMatch: false }),
      "cotejo_facial",
    ),
    INVALIDO,
  );
  const r = evaluate({ ...validEvidence(), facialMatch: null });
  assert.equal(estado(r, "cotejo_facial"), PENDIENTE);
  assert.equal(r.status, "EN_REVISION_MANUAL");
});

test("RUT o nombre distintos a Fase 1 son inválidos", () => {
  assert.equal(
    estado(
      evaluate({ ...validEvidence(), carnetRut: "11.111.111-1" }),
      "rut_cedula",
    ),
    INVALIDO,
  );
  assert.equal(
    estado(
      evaluate({ ...validEvidence(), antecedentesRut: "11.111.111-1" }),
      "rut_antecedentes",
    ),
    INVALIDO,
  );
  assert.equal(
    estado(
      evaluate({ ...validEvidence(), carnetName: "MARIA GONZALEZ ROJAS" }),
      "nombre_cedula",
    ),
    INVALIDO,
  );
});

test("Gemini con datos completos y fecha en el texto de vigencia pre-acredita", () => {
  const ev = evidenceFromGemini(
    {
      carnet_rut: "12.345.678-5",
      carnet_name: "Juan Pablo Pérez Soto",
      carnet_vigencia: "Vigente (Vence 10/05/2030)",
      carnet_vigente_bool: true,
      antecedentes_rut: "12.345.678-5",
      antecedentes_fecha_emision: "2026-11-03",
      tiene_anotaciones_penales: false,
      antecedentes_status: "Limpio / Sin Anotaciones",
      facial_match_ok: true,
    },
    parseDate,
  );
  assert.equal(evaluate(ev).status, "PRE_ACREDITADO");
});

test("el OCR local nunca pre-acredita (sin cotejo facial ni fecha de emisión)", () => {
  const ev = evidenceFromLocalOcr(
    {
      cedFront: {
        detected_rut: "12.345.678-5",
        detected_name: "JUAN PABLO PEREZ SOTO",
        carnet_vigencia: "Vigente (Vence: 10/05/2030)",
      },
      ant: {
        detected_rut: "12.345.678-5",
        antecedentes_status: "Sin Antecedentes (Al día)",
      },
    },
    parseDate,
  );
  const r = evaluate(ev);
  assert.equal(estado(r, "rut_cedula"), VALIDO);
  assert.equal(estado(r, "vigencia_cedula"), VALIDO);
  assert.equal(estado(r, "anotaciones"), VALIDO);
  assert.equal(r.status, "EN_REVISION_MANUAL");
});

test("las etiquetas caben en las columnas VARCHAR(80)", () => {
  for (const ev of [
    validEvidence(),
    { ...validEvidence(), anotaciones: true },
    { ...validEvidence(), carnetExpiry: null },
    { ...validEvidence(), antecedentesIssued: daysAgo(90) },
  ]) {
    const r = evaluate(ev);
    assert.ok(r.carnetVigenciaLabel.length <= 80);
    assert.ok(r.antecedentesLabel.length <= 80);
  }
});

/**
 * Pruebas de caracterización (red de seguridad de la tarea 1.7).
 *
 * Fijan el comportamiento ACTUAL del parser de CV y de las utilidades de server.js con entradas sintéticas
 * (tests/fixtures/caracterizacion-entradas.js) y lo comparan con una instantánea guardada
 * (tests/fixtures/caracterizacion.snapshot.json). No juzgan si el resultado es correcto: detectan cualquier cambio.
 *
 * - Reloj fijo (15/06/2026 12:00 UTC) y zona horaria UTC: edades, vigencias y "hasta la actualidad" no cambian con el tiempo.
 * - Si una función lanza un error, se registra el mensaje: también es parte del comportamiento.
 * - Regenerar la instantánea SOLO cuando un cambio de comportamiento sea intencional y revisado:
 *     UPDATE_SNAPSHOT=1 node --test tests/unit/caracterizacion.test.js
 */
process.env.TZ = "UTC";
require("../helpers/env");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const s = require("../../src/server");
const input = require("../fixtures/caracterizacion-entradas");

const SNAPSHOT = path.join(
  __dirname,
  "../fixtures/caracterizacion.snapshot.json",
);
const FIXED_NOW = new Date("2026-06-15T12:00:00Z");

// Fechas, undefined y errores pasan a una forma JSON estable.
const run = (fn) => {
  try {
    const value = fn();
    return value === undefined
      ? { undefined: true }
      : JSON.parse(JSON.stringify(value));
  } catch (err) {
    return { error: `${err.name}: ${err.message}` };
  }
};
const label = (v) => (v === undefined ? "undefined" : JSON.stringify(v));

function computeAll() {
  const out = {};
  out.parseExtractedText = {};
  out.splitCvIntoSections = {};
  out.calculateExperienceFromSections = {};
  for (const [name, text] of Object.entries(input.documentos)) {
    out.parseExtractedText[name] = run(() => s.parseExtractedText(text));
    out.splitCvIntoSections[name] = run(() => s.splitCvIntoSections(text));
    out.calculateExperienceFromSections[name] = run(() =>
      s.calculateExperienceFromSections(s.splitCvIntoSections(text), text),
    );
  }
  out.parseExtractedText.null = run(() => s.parseExtractedText(null));

  out.isValidPersonName = Object.fromEntries(
    input.nombres.map((n) => [label(n), run(() => s.isValidPersonName(n))]),
  );
  out.pickBestPersonName = input.elecciones.map((c) => ({
    ...c,
    resultado: run(() => s.pickBestPersonName(c.candidatos, c.referencia)),
  }));
  out.extractDatesFromText = Object.fromEntries(
    input.textosConFechas.map((t) => [
      label(t),
      run(() => s.extractDatesFromText(t)),
    ]),
  );
  out.parseChileanDate = Object.fromEntries(
    input.fechasChilenas.map((f) => [
      label(f),
      run(() => s.parseChileanDate(f)),
    ]),
  );
  out.formatRut = Object.fromEntries(
    input.ruts.map((r) => [label(r), run(() => s.formatRut(r))]),
  );
  out.isValidChileanRutMod11 = Object.fromEntries(
    input.ruts.map((r) => [label(r), run(() => s.isValidChileanRutMod11(r))]),
  );
  for (const fn of ["formatTitleCase", "normalizeTextForMatch", "escapeHtml"]) {
    out[fn] = Object.fromEntries(
      input.textos.map((t) => [label(t), run(() => s[fn](t))]),
    );
  }
  out.VALID_STATES = run(() => s.VALID_STATES);
  return out;
}

test("caracterización: parser de CV y utilidades sin cambios de comportamiento", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: FIXED_NOW });
  const actual = computeAll();
  t.mock.timers.reset();

  if (process.env.UPDATE_SNAPSHOT === "1") {
    fs.writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
    t.diagnostic(`Instantánea regenerada en ${SNAPSHOT}`);
    return;
  }
  assert.ok(
    fs.existsSync(SNAPSHOT),
    "Falta la instantánea; genérela con UPDATE_SNAPSHOT=1 a partir del código sin cambios.",
  );
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
  // Una comparación por función y caso, para que el fallo indique exactamente qué cambió.
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const fn of Object.keys(expected)) {
    if (
      expected[fn] &&
      typeof expected[fn] === "object" &&
      !Array.isArray(expected[fn])
    ) {
      assert.deepEqual(Object.keys(actual[fn]), Object.keys(expected[fn]), fn);
      for (const key of Object.keys(expected[fn]))
        assert.deepEqual(actual[fn][key], expected[fn][key], `${fn} → ${key}`);
    } else {
      assert.deepEqual(actual[fn], expected[fn], fn);
    }
  }
});

test("caracterización: el reloj fijo realmente controla los cálculos dependientes de la fecha", (t) => {
  const vence = "CEDULA\nRUN 12.345.678-5\nFECHA DE VENCIMIENTO 10/05/2027";
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-06-15T12:00:00Z"),
  });
  const antes = s.parseExtractedText(vence).carnet_vigencia;
  t.mock.timers.reset();
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2028-01-01T12:00:00Z"),
  });
  const despues = s.parseExtractedText(vence).carnet_vigencia;
  t.mock.timers.reset();
  assert.match(antes, /^Vigente/);
  assert.match(despues, /^Vencido/);
});

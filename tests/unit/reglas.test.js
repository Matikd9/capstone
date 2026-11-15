// Reglas de negocio puras de src/server.js: RUT, fechas, nombres, experiencia y parser de documentos.
require("../helpers/env");
const test = require("node:test");
const assert = require("node:assert/strict");
const s = require("../../src/server");

test("RUT: acepta dígito verificador correcto con o sin puntos", () => {
  for (const rut of ["12.345.678-5", "12345678-5", "123456785", "11.111.111-1"])
    assert.equal(s.isValidChileanRutMod11(rut), true, rut);
});

test("RUT: acepta dígito verificador K en mayúscula o minúscula", () => {
  assert.equal(s.isValidChileanRutMod11("10.000.013-K"), true);
  assert.equal(s.isValidChileanRutMod11("10000013-k"), true);
});

test("RUT: rechaza dígito verificador incorrecto y entradas inválidas", () => {
  for (const rut of ["12.345.678-9", "12.345.678-K", "abc", "", null, "1-9"])
    assert.equal(s.isValidChileanRutMod11(rut), false, String(rut));
});

test("RUT: formatRut normaliza a XX.XXX.XXX-X y rechaza largos inválidos", () => {
  assert.equal(s.formatRut("123456785"), "12.345.678-5");
  assert.equal(s.formatRut("12.345.678-5"), "12.345.678-5");
  assert.equal(s.formatRut("12345678k"), "12.345.678-K");
  assert.equal(s.formatRut("1234"), null);
  assert.equal(s.formatRut(null), null);
});

const ymd = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()];

test("fechas: parsea ISO, DD/MM/AAAA, DD-MM-AAAA y texto en español", () => {
  for (const txt of [
    "2030-05-10",
    "10/05/2030",
    "10-05-2030",
    "10 de mayo de 2030",
  ])
    assert.deepEqual(ymd(s.parseChileanDate(txt)), [2030, 5, 10], txt);
  assert.deepEqual(ymd(s.parseChileanDate("3 Setiembre 2025")), [2025, 9, 3]);
});

test("fechas: texto sin fecha o vacío devuelve null", () => {
  for (const txt of ["no es fecha", "", null, undefined])
    assert.equal(s.parseChileanDate(txt), null);
});

test("fechas: rechaza fechas imposibles en vez de desbordar al mes siguiente", () => {
  for (const txt of [
    "31/02/2030",
    "99/99/2030",
    "2030-02-31",
    "2030-13-01",
    "31 de abril de 2030",
  ])
    assert.equal(s.parseChileanDate(txt), null, txt);
  assert.deepEqual(ymd(s.parseChileanDate("29/02/2028")), [2028, 2, 29]);
  assert.equal(s.parseChileanDate("29/02/2027"), null);
});

test("fechas: extractDatesFromText encuentra fechas numéricas en ambos órdenes", () => {
  assert.deepEqual(
    s.extractDatesFromText("Nacimiento 15/03/1990, vence 2030-05-10"),
    [
      { day: 15, month: 3, year: 1990 },
      { year: 2030, month: 5, day: 10 },
    ],
  );
  assert.deepEqual(s.extractDatesFromText(""), []);
});

test("nombres: acepta nombres de persona y rechaza instituciones, títulos y ruido", () => {
  for (const n of [
    "Juan Pablo Pérez Soto",
    "JUAN PEREZ",
    "María-José O'Higgins Núñez",
  ])
    assert.equal(s.isValidPersonName(n), true, n);
  for (const n of [
    "Juan",
    "Universidad Adolfo Ibáñez",
    "Curriculum Vitae",
    "Rancagua Chile",
    "Juan Perez 123",
    "",
    null,
  ])
    assert.equal(s.isValidPersonName(n), false, String(n));
});

test("nombres: pickBestPersonName prefiere el nombre más completo y descarta instituciones", () => {
  assert.equal(
    s.pickBestPersonName(
      ["Juan Perez", "Juan Pablo Perez Soto", null, "Universidad de Chile"],
      "Juan Perez",
    ),
    "Juan Pablo Perez Soto",
  );
});

test("texto: normalización, capitalización y escape de HTML", () => {
  assert.equal(
    s.normalizeTextForMatch("  José Ñandú-Pérez, 3° "),
    "JOSE NANDU PEREZ 3",
  );
  assert.equal(s.normalizeTextForMatch(null), "");
  assert.equal(s.formatTitleCase("  jUAN  pABLO pérez "), "Juan Pablo Pérez");
  assert.equal(
    s.escapeHtml(`<a href="x">'&`),
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;",
  );
});

const CV = `JUAN PABLO PEREZ SOTO
RUT: 12.345.678-5
Email: juan.perez@example.invalid
Teléfono: +56 9 1234 5678
Rancagua

EXPERIENCIA LABORAL
Rigger - Empresa Uno
Enero 2018 - Diciembre 2020
Soldador - Empresa Dos
03/2021 - 03/2023

EDUCACIÓN
Liceo Industrial 2010 - 2014

REFERENCIAS
Pedro Soto 2001 - 2015`;

test("experiencia: una declaración explícita de años tiene prioridad", () => {
  assert.deepEqual(
    s.calculateExperienceFromSections(
      s.splitCvIntoSections("x"),
      "Cuento con 7 años de experiencia en izaje",
    ),
    { years: 7, months: 84 },
  );
});

test("experiencia: sin información devuelve null (no inventa años)", () => {
  assert.deepEqual(
    s.calculateExperienceFromSections(s.splitCvIntoSections("Hola"), "Hola"),
    { years: null, months: null },
  );
});

test("experiencia: solo cuenta la sección de experiencia, no educación ni referencias", () => {
  const sections = s.splitCvIntoSections(CV);
  assert.match(sections.EXPERIENCIA, /Empresa Uno/);
  assert.doesNotMatch(sections.EXPERIENCIA, /Liceo|Pedro Soto/);
  const exp = s.calculateExperienceFromSections(sections, CV);
  // Educación (2010-2014) y referencias (2001-2015) sumarían mucho más si se contaran.
  assert.ok(exp.years >= 3 && exp.years <= 5, `años calculados: ${exp.years}`);
  assert.equal(exp.months, exp.years * 12);
});

test("parser: extrae datos de contacto y experiencia de un CV sintético", () => {
  const p = s.parseExtractedText(CV);
  assert.equal(p.detected_name, "Juan Pablo Perez Soto");
  assert.equal(p.detected_rut, "12.345.678-5");
  assert.equal(p.detected_email, "juan.perez@example.invalid");
  assert.equal(p.detected_city, "Rancagua");
  assert.ok(p.detected_experience_years >= 3);
});

test("parser: cédula vigente, cédula vencida y sin fecha", () => {
  const vigente = s.parseExtractedText(
    "REPUBLICA DE CHILE\nCEDULA DE IDENTIDAD\nAPELLIDOS\nPEREZ SOTO\nNOMBRES\nJUAN PABLO\nRUN 12.345.678-5\nFECHA DE VENCIMIENTO 10/05/2030",
  );
  assert.equal(vigente.detected_name, "Juan Pablo Perez Soto");
  assert.equal(vigente.detected_rut, "12.345.678-5");
  assert.equal(vigente.carnet_vigencia, "Vigente (Vence: 10/05/2030)");
  assert.equal(
    s.parseExtractedText("CEDULA\nRUN 12.345.678-5\nVENCE 10/05/2021")
      .carnet_vigencia,
    "Vencido (10/05/2021)",
  );
  assert.equal(
    s.parseExtractedText("CEDULA\nRUN 12.345.678-5").carnet_vigencia,
    null,
  );
});

test("parser: antecedentes sin anotaciones, con anotaciones e indeterminado", () => {
  const estado = (t) => s.parseExtractedText(t).antecedentes_status;
  assert.equal(
    estado("CERTIFICADO\nSIN ANTECEDENTES"),
    "Sin Antecedentes (Al día)",
  );
  assert.equal(
    estado("CERTIFICADO\nNO REGISTRA ANTECEDENTES"),
    "Sin Antecedentes (Al día)",
  );
  assert.equal(
    estado("CERTIFICADO\nREGISTRA ANTECEDENTES: condena"),
    "Con Anotaciones (Requiere Revisión)",
  );
  assert.equal(estado("texto cualquiera"), null);
});

test("parser: texto vacío devuelve todos los campos en null", () => {
  const p = s.parseExtractedText(null);
  assert.equal(p.detected_name, null);
  assert.equal(p.detected_rut, null);
  assert.equal(p.carnet_vigencia, null);
  assert.equal(p.antecedentes_status, null);
});

test("estados: la máquina de estados expone los 8 estados vigentes", () => {
  for (const st of [
    "POSTULADO",
    "PRESELECCIONADO",
    "DESCARTADO_TECNICO",
    "APROBADO_FAENA",
    "DOCS_CARGADOS",
    "PRE_ACREDITADO",
    "EN_REVISION_MANUAL",
    "CONTRATADO_FAENA",
  ])
    assert.ok(s.VALID_STATES.includes(st), st);
});

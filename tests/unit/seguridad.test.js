// Autenticación (src/auth.js), archivos (src/security/fileSecurity.js), errores y validación de entradas.
const env = require("../helpers/env");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const auth = require("../../src/auth");
const fileSecurity = require("../../src/security/fileSecurity");
const {
  AppError,
  errorHandler,
  notFoundApi,
  redact,
} = require("../../src/errors");
const { schemas, validate } = require("../../src/validation");
const { saveBase64File, VALID_STATES } = require("../../src/server");

const bin = (str) => Buffer.from(str, "latin1");
const fakeRes = () => {
  const res = { headers: [], statusCode: 200, body: undefined };
  res.append = (k, v) => res.headers.push([k, v]);
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  res.end = () => res;
  return res;
};
const fakeReq = (o = {}) => ({
  method: "POST",
  path: "/api/x",
  headers: {},
  get(name) {
    return this.headers[name.toLowerCase()];
  },
  ...o,
});

// ---------- Contraseñas y tokens ----------
test("contraseñas: el hash verifica la clave correcta y rechaza la incorrecta", () => {
  const hash = auth.hashPassword("clave-de-prueba-123");
  assert.notEqual(hash, auth.hashPassword("clave-de-prueba-123"), "sal única");
  assert.equal(auth.verifyPassword("clave-de-prueba-123", hash), true);
  assert.equal(auth.verifyPassword("otra", hash), false);
});

test("contraseñas: un hash malformado devuelve false sin lanzar", () => {
  for (const h of ["", null, "sin-separador", "sal:abcd", "sal:zz"])
    assert.equal(auth.verifyPassword("x", h), false, String(h));
});

test("tokens: válido, manipulado, expirado y con formato inválido", () => {
  const token = auth.generateToken({ cid: 7, typ: "cand" }, 60);
  assert.equal(auth.verifyToken(token).cid, 7);
  const [h, b, sig] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ cid: 8, typ: "cand", exp: 9e9 }),
  ).toString("base64url");
  assert.equal(
    auth.verifyToken(`${h}.${forged}.${sig}`),
    null,
    "cuerpo alterado",
  );
  assert.equal(
    auth.verifyToken(`${h}.${b}.${sig.slice(0, -2)}xx`),
    null,
    "firma alterada",
  );
  assert.equal(
    auth.verifyToken(auth.generateToken({ cid: 7 }, -10)),
    null,
    "expirado",
  );
  for (const bad of ["", null, "a.b", "a.b.c.d", 123])
    assert.equal(auth.verifyToken(bad), null);
});

test("sesión de postulante: la cookie firmada devuelve su id y rechaza otros tokens", () => {
  const res = fakeRes();
  auth.createCandidateSession(res, 42);
  const [, cookie] = res.headers[0];
  assert.match(cookie, /^nexxo_cand=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=7200/);
  const value = cookie.split(";")[0];
  assert.equal(
    auth.getCandidateIdFromRequest({ headers: { cookie: value } }),
    42,
  );
  assert.equal(auth.getCandidateIdFromRequest({ headers: {} }), null);
  const adminLike = auth.generateToken({ id: 1, role: "SUPERADMIN" }, 60);
  assert.equal(
    auth.getCandidateIdFromRequest({
      headers: { cookie: `nexxo_cand=${adminLike}` },
    }),
    null,
    "un token sin typ=cand no sirve como sesión de postulante",
  );
});

test("cookies: Secure solo en producción y parseo tolerante", () => {
  const prev = process.env.NODE_ENV;
  try {
    const dev = fakeRes();
    auth.setCookie(dev, "x", "1", 10);
    assert.doesNotMatch(dev.headers[0][1], /Secure/);
    process.env.NODE_ENV = "production";
    const prod = fakeRes();
    auth.setCookie(prod, "x", "1", 10);
    assert.match(prod.headers[0][1], /; Secure/);
    const cleared = fakeRes();
    auth.clearCookie(cleared, "x");
    assert.match(cleared.headers[0][1], /Max-Age=0/);
  } finally {
    process.env.NODE_ENV = prev;
  }
  assert.deepEqual(
    auth.parseCookies({
      headers: { cookie: "a=1; b=hola%20mundo; roto; c=%E0%A4%A" },
    }),
    {
      a: "1",
      b: "hola mundo",
      c: "%E0%A4%A",
    },
  );
  assert.deepEqual(auth.parseCookies({ headers: {} }), {});
});

test("CSRF: requireSameOrigin bloquea orígenes cruzados y deja pasar el mismo origen", () => {
  const run = (req) => {
    const res = fakeRes();
    let passed = false;
    auth.requireSameOrigin(req, res, () => (passed = true));
    return passed ? "next" : res.statusCode;
  };
  assert.equal(
    run(
      fakeReq({ method: "GET", headers: { origin: "https://evil.example" } }),
    ),
    "next",
  );
  assert.equal(
    run(fakeReq({ headers: { "sec-fetch-site": "cross-site" } })),
    403,
  );
  assert.equal(
    run(fakeReq({ headers: { "sec-fetch-site": "same-site" } })),
    403,
  );
  assert.equal(
    run(fakeReq({ headers: { "sec-fetch-site": "same-origin" } })),
    "next",
  );
  assert.equal(
    run(
      fakeReq({
        headers: { origin: "https://evil.example", host: "nexxo.cl" },
      }),
    ),
    403,
  );
  assert.equal(
    run(fakeReq({ headers: { origin: "https://nexxo.cl", host: "nexxo.cl" } })),
    "next",
  );
  assert.equal(
    run(fakeReq({ headers: { origin: "no-es-url", host: "nexxo.cl" } })),
    403,
  );
  assert.equal(
    run(fakeReq({ headers: {} })),
    "next",
    "clientes sin navegador no portan cookies de la víctima",
  );
});

test("arranque: sin JWT_SECRET no carga; en producción exige uno fuerte y no público", () => {
  const authPath = path.join(__dirname, "../../src/auth.js");
  const load = (extra) =>
    spawnSync(
      process.execPath,
      ["-e", `require(${JSON.stringify(authPath)})`],
      {
        env: { PATH: process.env.PATH, ...extra },
        encoding: "utf8",
      },
    );
  const strong = "a".repeat(20) + "b".repeat(20) + "0123456789";
  assert.notEqual(load({}).status, 0, "sin secreto");
  assert.match(load({}).stderr, /JWT_SECRET no está configurado/);
  assert.notEqual(
    load({ NODE_ENV: "production", JWT_SECRET: "corto" }).status,
    0,
  );
  assert.notEqual(
    load({ NODE_ENV: "production", JWT_SECRET: "super_secret_jwt_key_here" })
      .status,
    0,
  );
  assert.notEqual(
    load({
      NODE_ENV: "production",
      JWT_SECRET: "dev-jwt-secret-nexxo-2026-local",
    }).status,
    0,
  );
  assert.equal(load({ NODE_ENV: "production", JWT_SECRET: strong }).status, 0);
  assert.equal(
    load({ NODE_ENV: "development", JWT_SECRET: "corto" }).status,
    0,
  );
});

// ---------- Archivos ----------
test("archivos: detecta el tipo real por magic bytes", () => {
  const cases = {
    pdf: bin("%PDF-1.7 hola"),
    png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]),
    jpg: Buffer.from([255, 216, 255, 224, 0, 16]),
    webp: bin("RIFF\x00\x00\x00\x00WEBPVP8 "),
    zip_archive: Buffer.from([80, 75, 3, 4, 0, 0, 0, 0]),
    executable_pe: bin("MZ\x90\x00\x03"),
    executable_elf: Buffer.from([127, 69, 76, 70, 2, 1]),
    executable_script: bin("#!/bin/bash\nrm -rf"),
    unknown: bin("hola mundo texto"),
  };
  for (const [expected, buf] of Object.entries(cases))
    assert.equal(fileSecurity.detectRealFileType(buf), expected);
  assert.equal(fileSecurity.detectRealFileType(bin("ab")), null);
  assert.equal(fileSecurity.detectRealFileType("no-buffer"), null);
});

test("archivos: bloquea PDF con JavaScript, DOCX con macros y archivos vacíos", () => {
  assert.equal(
    fileSecurity.scanDocumentHeuristics(
      bin("%PDF-1.7 certificado normal"),
      "pdf",
    ).isSafe,
    true,
  );
  const js = fileSecurity.scanDocumentHeuristics(
    bin("%PDF-1.7 /JavaScript (app.alert(1)) /OpenAction"),
    "pdf",
  );
  assert.equal(js.isSafe, false);
  assert.match(js.threatReason, /PDF/);
  const macro = fileSecurity.scanDocumentHeuristics(
    Buffer.concat([Buffer.from([80, 75, 3, 4]), bin("word/vbaProject.bin")]),
    "docx",
  );
  assert.equal(macro.isSafe, false);
  assert.match(macro.threatReason, /macros/i);
  assert.equal(
    fileSecurity.scanDocumentHeuristics(Buffer.alloc(0), "pdf").isSafe,
    false,
  );
});

test("archivos: los nombres generados no son predecibles ni permiten salir de la carpeta", () => {
  const a = fileSecurity.generateSecureFilename("carnet_12/../x", "jpg");
  const b = fileSecurity.generateSecureFilename("carnet_12/../x", "jpg");
  assert.match(a, /^carnet_12x_\d+_[0-9a-f]{32}\.jpg$/);
  assert.notEqual(a, b);
});

test("archivos: saveBase64File rechaza ejecutables y guarda imágenes válidas en la carpeta de subidas", () => {
  const exe = saveBase64File(
    `data:application/octet-stream;base64,${bin("MZ\x90\x00\x03\x00\x00").toString("base64")}`,
    "cv",
  );
  assert.equal(exe.url, null);
  assert.match(exe.error, /ejecutable/i);
  const script = saveBase64File(
    `data:image/jpeg;base64,${bin("#!/bin/sh\ncurl x|sh").toString("base64")}`,
    "selfie",
    "jpg",
  );
  assert.match(
    script.error,
    /ejecutable/i,
    "la extensión declarada no engaña al detector",
  );
  const pdfJs = saveBase64File(
    `data:application/pdf;base64,${bin("%PDF-1.7 /JavaScript /Launch").toString("base64")}`,
    "ant",
    "pdf",
  );
  assert.match(pdfJs.error, /PDF/);
  assert.deepEqual(saveBase64File(null, "cv"), {
    url: null,
    absolutePath: null,
    error: null,
  });
  const png = saveBase64File(
    `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).toString("base64")}`,
    "cv",
  );
  assert.equal(png.error, null);
  assert.match(
    png.url,
    /^\/uploads\/cv_\d+_[0-9a-f]{32}\.png$/,
    "la extensión sale del contenido real",
  );
  assert.ok(png.absolutePath.startsWith(env.uploadsDir));
  assert.ok(fs.existsSync(png.absolutePath));
});

test("archivos: rechaza vacíos y formatos no admitidos según el contenido real, sin escribir nada en disco", () => {
  const before = fs.readdirSync(env.uploadsDir).length;
  const b64 = (buf) => buf.toString("base64");
  const rejected = {
    "data URL sin contenido": "data:image/png;base64,",
    "data URL de canvas vacío": "data:,",
    "texto plano declarado como JPEG": `data:image/jpeg;base64,${b64(bin("hola, esto no es una imagen"))}`,
    "HEIC (foto de iPhone sin convertir)": `data:image/heic;base64,${b64(Buffer.concat([Buffer.from([0, 0, 0, 24]), bin("ftypheic\x00\x00\x00\x00mif1heic")]))}`,
    "DOC antiguo (OLE)": `data:application/msword;base64,${b64(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))}`,
    "ZIP genérico declarado como DOCX": `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${b64(Buffer.concat([Buffer.from([80, 75, 3, 4]), bin("otro/archivo.txt")]))}`,
    GIF: `data:image/gif;base64,${b64(bin("GIF89a\x01\x00\x01\x00"))}`,
  };
  for (const [name, dataUrl] of Object.entries(rejected)) {
    const r = saveBase64File(dataUrl, "cv");
    assert.equal(r.url, null, name);
    assert.match(r.error, /vacío|Formato no admitido/, name);
  }
  assert.match(saveBase64File("data:image/png;base64,", "cv").error, /vacío/);
  assert.equal(fs.readdirSync(env.uploadsDir).length, before);
});

test("archivos: acepta PDF, JPG, PNG, WEBP y DOCX y usa la extensión del contenido real", () => {
  const b64 = (buf) => buf.toString("base64");
  const valid = {
    pdf: bin("%PDF-1.7 certificado sintetico"),
    jpg: Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]),
    png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]),
    webp: bin("RIFF\x00\x00\x00\x00WEBPVP8 "),
    docx: Buffer.concat([
      Buffer.from([80, 75, 3, 4]),
      bin("[Content_Types].xml word/document.xml"),
    ]),
  };
  for (const [ext, buf] of Object.entries(valid)) {
    // El MIME declarado es deliberadamente incorrecto: manda el contenido.
    const r = saveBase64File(
      `data:application/octet-stream;base64,${b64(buf)}`,
      "doc",
    );
    assert.equal(r.error, null, ext);
    assert.ok(r.url.endsWith(`.${ext}`), `${ext}: ${r.url}`);
    assert.ok(fs.existsSync(r.absolutePath));
  }
});

// ---------- Errores ----------
test("errores: redact enmascara valores entre comillas, RUT, correos y tokens", () => {
  const out = redact(
    `Duplicate entry 'Juan Pérez' for key "uq"; rut 12.345.678-5 y 12345678-5; correo juan@example.invalid; token ${"ab".repeat(32)}`,
  );
  for (const leaked of [
    "Juan Pérez",
    "12.345.678-5",
    "12345678-5",
    "juan@example.invalid",
    "abab",
  ])
    assert.ok(!out.includes(leaked), `filtró: ${leaked}`);
  assert.equal(redact(null), "");
});

const handle = (err, req = fakeReq()) => {
  const res = fakeRes();
  env.capturedErrors.length = 0;
  errorHandler(err, req, res, () => {});
  return res;
};

test("errores: AppError devuelve su mensaje y código; con detalles los incluye", () => {
  const res = handle(new AppError(409, "Ya fue enviado."));
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: "Ya fue enviado." });
  const withDetails = handle(
    new AppError(400, "Inválido", { details: [{ campo: "id" }] }),
  );
  assert.deepEqual(withDetails.body.details, [{ campo: "id" }]);
  assert.equal(
    env.capturedErrors.length,
    0,
    "los errores esperados no se registran como internos",
  );
});

test("errores: un error interno responde 500 genérico y se registra enmascarado", () => {
  const dbErr = Object.assign(
    new Error(
      "Duplicate entry '12.345.678-5' for key 'candidates.rut' at SELECT * FROM candidates",
    ),
    { code: "ER_DUP_ENTRY" },
  );
  const res = handle(
    dbErr,
    fakeReq({ method: "GET", path: "/api/admin/candidates" }),
  );
  assert.equal(res.statusCode, 500);
  assert.equal(
    res.body.error,
    "Error interno del servidor. Intente nuevamente más tarde.",
  );
  assert.ok(!JSON.stringify(res.body).includes("Duplicate"));
  const logged = env.capturedErrors.join("\n");
  assert.match(logged, /GET \/api\/admin\/candidates/);
  assert.match(logged, /ER_DUP_ENTRY/);
  assert.ok(
    !logged.includes("12.345.678-5"),
    "el RUT no debe quedar en el log",
  );
});

test("errores: AppError 500 conserva su mensaje público y registra la causa", () => {
  const res = handle(
    new AppError(500, "Error procesando OCR.", {
      cause: new Error("fallo interno x"),
    }),
  );
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, "Error procesando OCR.");
  assert.match(env.capturedErrors.join("\n"), /fallo interno x/);
});

test("errores: JSON inválido 400, cuerpo excesivo 413 y ruta desconocida 404", () => {
  assert.equal(handle({ type: "entity.parse.failed" }).statusCode, 400);
  const big = handle({ type: "entity.too.large" });
  assert.equal(big.statusCode, 413);
  assert.match(big.body.error, /tamaño máximo/);
  const nf = fakeRes();
  notFoundApi(fakeReq(), nf);
  assert.equal(nf.statusCode, 404);
});

// ---------- Validación ----------
const check = (shape, req) => {
  let err;
  validate(shape)(req, {}, (e) => (err = e));
  return err;
};

test("validación: ids enteros positivos; se convierten a número", () => {
  const req = { params: { id: "15" } };
  assert.equal(check({ params: schemas.idParam }, req), undefined);
  assert.equal(req.params.id, 15);
  for (const id of ["abc", "-3", "0", "1.5", "", "99999999999"]) {
    const err = check({ params: schemas.idParam }, { params: { id } });
    assert.ok(err instanceof AppError, id);
    assert.equal(err.status, 400);
  }
});

test("validación: el mensaje nombra el campo y está en español", () => {
  const err = check({ body: schemas.adminLogin }, { body: { username: 123 } });
  assert.match(err.message, /^Datos de entrada inválidos \(username\)/);
  assert.ok(err.details.some((d) => d.campo === "password"));
});

test("validación: descarta campos inesperados y recorta espacios", () => {
  const req = {
    body: {
      username: "  admin ",
      password: "x",
      role: "SUPERADMIN",
      isAdmin: true,
    },
  };
  assert.equal(check({ body: schemas.adminLogin }, req), undefined);
  assert.deepEqual(req.body, { username: "admin", password: "x" });
});

test("validación: canje de magic link exige un token de texto de 16 a 128 caracteres", () => {
  const ok = { body: { token: "a".repeat(64) } };
  assert.equal(check({ body: schemas.candidateSession }, ok), undefined);
  for (const token of ["corto", 1234567890123456789, "a".repeat(129), null])
    assert.ok(
      check({ body: schemas.candidateSession }, { body: { token } }),
      String(token),
    );
});

test("validación: Fase 1 exige cargo, limita largos y valida la forma de las respuestas", () => {
  const base = {
    position_id: 1,
    full_name: "Juan Pérez",
    experience_years: "5",
  };
  const req = {
    body: {
      ...base,
      answers: [{ question_id: "3", selected_option: "A" }],
      status: "CONTRATADO_FAENA",
    },
  };
  assert.equal(check({ body: schemas.phase1Submit }, req), undefined);
  assert.equal(req.body.status, undefined);
  assert.equal(req.body.answers[0].question_id, 3);
  const bad = [
    { full_name: "Juan" },
    { ...base, position_id: "abc" },
    { ...base, full_name: 42 },
    { ...base, full_name: "x".repeat(151) },
    { ...base, answers: [{ question_id: "x" }] },
    {
      ...base,
      answers: Array.from({ length: 51 }, (_, i) => ({ question_id: i + 1 })),
    },
    { ...base, cv_file: "a".repeat(16 * 1024 * 1024 + 1) },
  ];
  for (const body of bad)
    assert.ok(
      check({ body: schemas.phase1Submit }, { body }),
      JSON.stringify(body).slice(0, 60),
    );
});

test("validación: filtros del listado admin y cambio de estado", () => {
  const q = { query: { status: "", position_id: "" } };
  assert.equal(check({ query: schemas.candidatesQuery }, q), undefined);
  assert.equal(q.query.status, undefined);
  assert.equal(q.query.position_id, undefined);
  assert.ok(
    check(
      { query: schemas.candidatesQuery },
      { query: { position_id: "abc" } },
    ),
  );
  const statusSchema = schemas.statusUpdate(VALID_STATES);
  assert.equal(
    check({ body: statusSchema }, { body: { status: "EN_REVISION_MANUAL" } }),
    undefined,
  );
  for (const status of ["HACKEADO", "", null, 5])
    assert.ok(
      check({ body: statusSchema }, { body: { status } }),
      String(status),
    );
});

test("arranque: en producción sin variables de BD el servidor no carga (sin credenciales por defecto)", () => {
  const serverPath = path.join(__dirname, "../../src/server.js");
  const base = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    JWT_SECRET: "a".repeat(20) + "b".repeat(20) + "0123456789",
    GEMINI_API_KEY: "tu_api_key_aqui",
  };
  const load = (extra) =>
    spawnSync(
      process.execPath,
      ["-e", `require(${JSON.stringify(serverPath)})`],
      { env: { ...base, ...extra }, cwd: env.tmpRoot, encoding: "utf8" },
    );
  // DB_HOST definido evita que se cargue un .env.production local.
  const missing = load({ DB_HOST: "127.0.0.1" });
  assert.notEqual(missing.status, 0);
  assert.match(
    missing.stderr,
    /Faltan variables de entorno.*DB_USER, DB_PASSWORD/,
  );
  const ok = load({ DB_HOST: "127.0.0.1", DB_USER: "u", DB_PASSWORD: "p" });
  assert.equal(ok.status, 0, ok.stderr);
});

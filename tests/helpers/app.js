/**
 * Arranca la aplicación en proceso para pruebas de integración:
 * - BD MySQL local propia de cada archivo de pruebas (web_app_test_<nombre>), creada y borrada aquí.
 * - Puerto efímero; Gemini y el envío de correos simulados (sin servicios externos).
 */
const env = require("./env");
const zlib = require("zlib");
const mysql = require("mysql2/promise");

async function startTestApp(name) {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("Nombre de BD inválido");
  const dbName = `web_app_test_${name}`;
  process.env.DB_NAME = dbName;

  const adminConn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  await adminConn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await adminConn.query(`CREATE DATABASE \`${dbName}\``);

  // Dobles de prueba: se reemplazan las funciones del módulo que server.js invoca.
  const mailer = require("../../src/mailer");
  const geminiOcr = require("../../src/geminiOcr");
  const ctx = {
    mails: [],
    // Respuesta simulada de Gemini en Fase 2; {} equivale a "no se pudo leer nada".
    geminiPhase2: async () => ({}),
  };
  mailer.sendPhase2InvitationEmail = async (data) => {
    ctx.mails.push({ type: "invitacion", ...data });
    return { sent: false, simulated: true, recipient: data.email };
  };
  mailer.sendHiredConfirmationEmail = async (data) => {
    ctx.mails.push({ type: "contratacion", ...data });
    return { sent: false, simulated: true, recipient: data.email };
  };
  geminiOcr.isGeminiAvailable = () => true;
  geminiOcr.analyzePhase2IdentityDocuments = (args) => ctx.geminiPhase2(args);
  geminiOcr.analyzePhase1Documents = async () => {
    throw new Error("Gemini Fase 1 no está simulado en las pruebas");
  };

  const server = require("../../src/server");
  await server.initDB(3, 1000);
  const pool = server.getPool();
  if (!pool) throw new Error("No se pudo inicializar la BD de pruebas");
  const [[{ db }]] = await pool.query("SELECT DATABASE() AS db");
  if (db !== dbName) throw new Error(`BD inesperada: ${db}`);

  const http = server.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => http.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${http.address().port}`;

  Object.assign(ctx, {
    baseUrl,
    pool,
    server,
    dbName,
    adminPassword: env.adminPassword,
    capturedErrors: env.capturedErrors,
    client: () => createClient(baseUrl),
    async adminClient() {
      const c = createClient(baseUrl);
      const res = await c.post("/api/auth/admin-login", {
        body: { username: "admin", password: env.adminPassword },
      });
      if (res.status !== 200)
        throw new Error(`Login admin falló: ${res.status}`);
      return c;
    },
    async close() {
      await new Promise((resolve) => http.close(resolve));
      try {
        await server.closeDB();
      } catch (e) {
        // el pool ya estaba cerrado por una prueba
      }
      await adminConn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await adminConn.end();
    },
  });
  return ctx;
}

/** Cliente HTTP mínimo con tarro de cookies (fetch nativo, sin seguir redirecciones). */
function createClient(baseUrl) {
  const jar = new Map();
  async function request(method, path, { body, headers = {}, rawBody } = {}) {
    const h = { ...headers };
    if (jar.size && !h.cookie)
      h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    let payload = rawBody;
    if (body !== undefined) payload = JSON.stringify(body);
    if (payload !== undefined && !h["content-type"])
      h["content-type"] = "application/json";
    const res = await fetch(baseUrl + path, {
      method,
      headers: h,
      body: payload,
      redirect: "manual",
    });
    const setCookies = res.headers.getSetCookie();
    for (const sc of setCookies) {
      const pair = sc.split(";")[0];
      const i = pair.indexOf("=");
      const cookieName = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /max-age=0/i.test(sc)) jar.delete(cookieName);
      else jar.set(cookieName, value);
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      // respuesta no JSON (HTML, archivo)
    }
    return { status: res.status, headers: res.headers, setCookies, text, json };
  }
  return {
    jar,
    get: (p, o) => request("GET", p, o),
    post: (p, o) => request("POST", p, o),
    patch: (p, o) => request("PATCH", p, o),
  };
}

// ---------- Datos sintéticos ----------

/** PNG válido en blanco (data URL). No contiene ningún documento real. */
function blankPng(size = 16) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    let crc = ~0;
    for (const x of td) {
      crc ^= x;
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    const c = Buffer.alloc(4);
    c.writeUInt32BE(~crc >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = 1 + size * 3;
  const raw = Buffer.alloc(size * row, 255);
  for (let y = 0; y < size; y++) raw[y * row] = 0;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const EXE_DATA_URL = `data:application/octet-stream;base64,${Buffer.from(
  "MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00PE-carga-sintetica",
  "latin1",
).toString("base64")}`;

const PERSONA = {
  full_name: "Juan Pablo Pérez Soto",
  rut_id: "12.345.678-5",
  email: "postulante@example.invalid",
  phone: "+56 9 1234 5678",
  city: "Rancagua",
  experience_years: "10",
};

/** Respuestas del mini-test del cargo: `wrong` indica cuántas técnicas y cuántas SJT se responden mal. */
async function buildAnswers(pool, positionId, wrong = {}) {
  const [tech] = await pool.query(
    "SELECT id, correct_option FROM questions WHERE position_id = ? AND category = 'TECNICA' ORDER BY id LIMIT 3",
    [positionId],
  );
  const [sjt] = await pool.query(
    "SELECT id, correct_option FROM questions WHERE category = 'SJT' ORDER BY id LIMIT 2",
  );
  const other = (opt) => (opt === "A" ? "B" : "A");
  const pick = (rows, nWrong) =>
    rows.map((q, i) => ({
      question_id: q.id,
      selected_option: i < nWrong ? other(q.correct_option) : q.correct_option,
    }));
  return [...pick(tech, wrong.tecnicas || 0), ...pick(sjt, wrong.sjt || 0)];
}

async function firstPositionId(pool) {
  const [[row]] = await pool.query(
    "SELECT id FROM positions ORDER BY id LIMIT 1",
  );
  return row.id;
}

/** Crea por la API un postulante que aprueba Fase 1 (PRESELECCIONADO). Devuelve su id. */
async function createPreselected(ctx, overrides = {}) {
  const positionId = await firstPositionId(ctx.pool);
  const res = await ctx.client().post("/api/candidates/phase1-submit", {
    body: {
      ...PERSONA,
      position_id: positionId,
      answers: await buildAnswers(ctx.pool, positionId),
      consent_proctoring: true,
      ...overrides,
    },
  });
  if (res.status !== 201 || res.json.status !== "PRESELECCIONADO")
    throw new Error(
      `No se pudo crear el postulante: ${res.status} ${res.text}`,
    );
  return res.json.candidateId;
}

/** Postulante aprobado por RR.HH. con su magic link ya canjeado. */
async function createApprovedWithSession(ctx, admin, overrides) {
  const id = await createPreselected(ctx, overrides);
  const approve = await admin.post(`/api/admin/candidates/${id}/approve-faena`);
  if (approve.status !== 200)
    throw new Error(`Aprobación falló: ${approve.text}`);
  const token = new URL(approve.json.magic_link).searchParams.get("token");
  const candidate = ctx.client();
  const session = await candidate.post("/api/candidates/session", {
    body: { token },
  });
  if (session.status !== 200) throw new Error(`Canje falló: ${session.text}`);
  return { id, token, candidate };
}

const isoDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Respuesta de Gemini para documentos sintéticos válidos y coincidentes con PERSONA. */
const geminiValid = (overrides = {}) => ({
  carnet_rut: PERSONA.rut_id,
  carnet_name: "JUAN PABLO PÉREZ SOTO",
  carnet_vigencia: "Vigente (Vence 10/05/2035)",
  carnet_fecha_vencimiento: "2035-05-10",
  carnet_vigente_bool: true,
  antecedentes_rut: PERSONA.rut_id,
  antecedentes_name: "JUAN PABLO PÉREZ SOTO",
  antecedentes_fecha_emision: isoDaysAgo(5),
  tiene_anotaciones_penales: false,
  antecedentes_status: "Limpio / Sin Anotaciones",
  facial_match_ok: true,
  facial_confidence_percent: 97,
  cross_check_ok: true,
  discrepancy_notes: "Consistencia 100% verificada entre Fase 1 y Fase 2.",
  ...overrides,
});

module.exports = {
  startTestApp,
  blankPng,
  EXE_DATA_URL,
  PERSONA,
  buildAnswers,
  firstPositionId,
  createPreselected,
  createApprovedWithSession,
  geminiValid,
  isoDaysAgo,
};

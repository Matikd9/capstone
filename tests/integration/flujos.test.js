// Integración: flujo completo del postulante (Fase 1 -> aprobación RR.HH. -> magic link -> Fase 2) y panel admin.
const h = require("../helpers/app");
const test = require("node:test");
const assert = require("node:assert/strict");

let ctx, admin, positionId;
test.before(async () => {
  ctx = await h.startTestApp("flujos");
  admin = await ctx.adminClient();
  positionId = await h.firstPositionId(ctx.pool);
});
test.after(async () => {
  await ctx.close();
});

const row = async (id, cols = "*") =>
  (
    await ctx.pool.query(`SELECT ${cols} FROM candidates WHERE id = ?`, [id])
  )[0][0];
const count = async () =>
  (await ctx.pool.query("SELECT COUNT(*) n FROM candidates"))[0][0].n;
const phase1 = (body) =>
  ctx.client().post("/api/candidates/phase1-submit", {
    body: { ...h.PERSONA, position_id: positionId, ...body },
  });
const docs = (extra = {}) => ({
  carnet_file: h.blankPng(),
  carnet_back_file: h.blankPng(),
  antecedentes_file: h.blankPng(),
  consent_ley19628: true,
  ...extra,
});

// ---------- Fase 1 ----------
test("cargos y preguntas: 3 técnicas + 2 SJT, sin exponer la respuesta correcta", async () => {
  const positions = await ctx.client().get("/api/positions");
  assert.equal(positions.status, 200);
  const q = await ctx.client().get(`/api/positions/${positionId}/questions`);
  const cats = q.json.questions.map((x) => x.category);
  assert.equal(cats.filter((c) => c === "TECNICA").length, 3);
  assert.equal(cats.filter((c) => c === "SJT").length, 2);
  assert.ok(q.json.questions.every((x) => !("correct_option" in x)));
});

test("Fase 1: 5/5 con experiencia suficiente queda PRESELECCIONADO y guarda las respuestas", async () => {
  const res = await phase1({
    rut_id: "123456785",
    answers: await h.buildAnswers(ctx.pool, positionId),
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.status, "PRESELECCIONADO");
  assert.equal(res.json.score, 5);
  assert.equal(
    res.json.qualifiedForPhase2,
    false,
    "Fase 2 sigue bloqueada hasta que RR.HH. apruebe",
  );
  const c = await row(res.json.candidateId);
  assert.equal(c.rut_id, "12.345.678-5", "el RUT se guarda normalizado");
  assert.equal(
    c.access_token,
    null,
    "no hay magic link antes de la aprobación",
  );
  const [answers] = await ctx.pool.query(
    "SELECT is_correct FROM candidate_answers WHERE candidate_id = ?",
    [c.id],
  );
  assert.equal(answers.length, 5);
});

test("Fase 1: regla de corte (80% y 2/2 SJT) y experiencia mínima", async () => {
  const cases = [
    [{ tecnicas: 1 }, {}, "PRESELECCIONADO"], // 4/5 con SJT completo
    [{ tecnicas: 2 }, {}, "DESCARTADO_TECNICO"], // 3/5
    [{ sjt: 1 }, {}, "DESCARTADO_TECNICO"], // 4/5 pero falla seguridad crítica
    [{}, { experience_years: "0" }, "DESCARTADO_TECNICO"],
  ];
  for (const [wrong, extra, expected] of cases) {
    const res = await phase1({
      answers: await h.buildAnswers(ctx.pool, positionId, wrong),
      ...extra,
    });
    assert.equal(res.json.status, expected, JSON.stringify({ wrong, extra }));
    if (expected === "DESCARTADO_TECNICO")
      assert.ok(res.json.rejectionReasons.length > 0);
  }
});

test("Fase 1: respuestas repetidas o de otro cargo no inflan el puntaje", async () => {
  const good = await h.buildAnswers(ctx.pool, positionId);
  const dup = await phase1({ answers: Array(5).fill(good[4]) });
  assert.equal(dup.json.status, "DESCARTADO_TECNICO");
  const [[other]] = await ctx.pool.query(
    "SELECT id FROM positions WHERE id <> ? LIMIT 1",
    [positionId],
  );
  const foreign = await h.buildAnswers(ctx.pool, other.id);
  const res = await phase1({ answers: foreign });
  assert.equal(res.json.status, "DESCARTADO_TECNICO");
});

test("Fase 1: campos inyectados se ignoran y las entradas inválidas no crean postulantes", async () => {
  const injected = await phase1({
    answers: [],
    status: "CONTRATADO_FAENA",
    score: 999,
    access_token: "b".repeat(64),
  });
  const c = await row(injected.json.candidateId, "status, score, access_token");
  assert.deepEqual(
    [c.status, c.score, c.access_token],
    ["DESCARTADO_TECNICO", 0, null],
  );

  const before = await count();
  for (const body of [
    { position_id: "abc" },
    { full_name: "", rut_id: "" },
    { cv_file: h.EXE_DATA_URL },
    { position_id: 999999 }, // cargo inexistente (clave foránea)
  ]) {
    const res = await phase1(body);
    assert.ok(res.status >= 400, JSON.stringify(body).slice(0, 40));
    assert.doesNotMatch(res.text, /SQL|foreign key|candidates|at \//i);
  }
  assert.equal(await count(), before);
});

// ---------- Aprobación y magic link ----------
test("aprobación: emite magic link de 7 días y despacha la invitación", async () => {
  const id = await h.createPreselected(ctx);
  ctx.mails.length = 0;
  const res = await admin.post(`/api/admin/candidates/${id}/approve-faena`);
  assert.equal(res.status, 200);
  const c = await row(id);
  assert.equal(c.status, "APROBADO_FAENA");
  assert.match(c.access_token, /^[0-9a-f]{64}$/);
  const days = (new Date(c.token_expires_at) - Date.now()) / 864e5;
  assert.ok(days > 6.9 && days < 7.1);
  assert.equal(ctx.mails.length, 1);
  assert.equal(ctx.mails[0].email, h.PERSONA.email);
  assert.ok(ctx.mails[0].magic_link.endsWith(c.access_token));
});

test("magic link: canje crea sesión HttpOnly; inválido, expirado o sin aprobación se rechazan", async () => {
  const { id, token, candidate } = await h.createApprovedWithSession(
    ctx,
    admin,
  );
  assert.match(candidate.jar.get("nexxo_cand"), /\./);
  const me = await candidate.get("/api/candidates/me");
  assert.equal(me.status, 200);
  assert.equal(me.json.id, id);
  assert.equal((await ctx.client().get("/api/candidates/me")).status, 401);

  const redeem = (t) =>
    ctx.client().post("/api/candidates/session", { body: { token: t } });
  assert.equal((await redeem("a".repeat(64))).status, 404);
  assert.equal(
    (await redeem(token)).status,
    200,
    "reutilizable hasta enviar Fase 2 (política vigente)",
  );
  assert.equal(
    (await ctx.client().get(`/api/candidates/access/${token}`)).status,
    404,
    "el token ya no se acepta en la URL",
  );
  await ctx.pool.query(
    "UPDATE candidates SET status = 'PRESELECCIONADO' WHERE id = ?",
    [id],
  );
  assert.equal((await redeem(token)).status, 403);
  await ctx.pool.query(
    "UPDATE candidates SET status = 'APROBADO_FAENA', token_expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?",
    [id],
  );
  assert.equal((await redeem(token)).status, 403);
});

// ---------- Fase 2 ----------
test("Fase 2: exige la sesión del propio postulante, archivos y consentimiento", async () => {
  const a = await h.createApprovedWithSession(ctx, admin);
  const b = await h.createApprovedWithSession(ctx, admin);
  const url = `/api/candidates/${a.id}/phase2-acreditacion`;
  assert.equal((await ctx.client().post(url, { body: docs() })).status, 401);
  assert.equal(
    (await b.candidate.post(url, { body: docs() })).status,
    401,
    "sesión de otro postulante",
  );
  assert.equal(
    (await admin.post(url, { body: docs() })).status,
    403,
    "RR.HH. no carga documentos ajenos",
  );
  assert.equal((await a.candidate.post(url, { body: {} })).status, 400);
  assert.equal(
    (await a.candidate.post(url, { body: docs({ consent_ley19628: false }) }))
      .status,
    400,
  );
  const exe = await a.candidate.post(url, {
    body: docs({ carnet_file: h.EXE_DATA_URL }),
  });
  assert.equal(exe.status, 400);
  assert.match(exe.json.error, /Archivo rechazado/);
  const c = await row(a.id, "status, phase2_submitted_at");
  assert.deepEqual([c.status, c.phase2_submitted_at], ["APROBADO_FAENA", null]);
});

test("Fase 2: documentos válidos y verificados quedan PRE_ACREDITADO; no se puede reenviar", async () => {
  const { id, token, candidate } = await h.createApprovedWithSession(
    ctx,
    admin,
  );
  ctx.geminiPhase2 = async () => h.geminiValid();
  const url = `/api/candidates/${id}/phase2-acreditacion`;
  const res = await candidate.post(url, { body: docs() });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, "PRE_ACREDITADO");
  const c = await row(id);
  assert.equal(c.ocr_cross_check_ok, 1);
  assert.equal(c.consent_ley19628, 1);
  assert.equal(c.facial_match_ok, 1);
  assert.ok(c.phase2_submitted_at && c.carnet_file && c.antecedentes_file);

  assert.equal((await candidate.post(url, { body: docs() })).status, 409);
  const again = await ctx
    .client()
    .post("/api/candidates/session", { body: { token } });
  assert.equal(
    again.status,
    200,
    "tras Fase 2 el enlace solo muestra el estado",
  );
  assert.equal(again.json.status, "PRE_ACREDITADO");

  // Archivos: el dueño y RR.HH. acceden; anónimos y otros postulantes no.
  const other = await h.createApprovedWithSession(ctx, admin);
  assert.equal((await candidate.get(c.carnet_file)).status, 200);
  assert.equal((await admin.get(c.carnet_file)).status, 200);
  assert.equal((await ctx.client().get(c.carnet_file)).status, 401);
  assert.equal((await other.candidate.get(c.carnet_file)).status, 401);
});

test("Fase 2: toda incertidumbre o discordancia deriva a revisión manual, nunca pre-acredita", async () => {
  const cases = {
    "documentos ilegibles (IA sin datos)": {},
    "IA optimista sin datos leídos": {
      carnet_vigente_bool: true,
      tiene_anotaciones_penales: false,
      facial_match_ok: true,
    },
    "RUT distinto": h.geminiValid({ carnet_rut: "11.111.111-1" }),
    "anotaciones penales": h.geminiValid({
      tiene_anotaciones_penales: true,
      antecedentes_status: "Con Anotaciones Penales",
    }),
    "antecedentes de más de 60 días": h.geminiValid({
      antecedentes_fecha_emision: h.isoDaysAgo(90),
    }),
    "cédula vencida": h.geminiValid({
      carnet_fecha_vencimiento: "2020-01-01",
      carnet_vigencia: "Vencido",
      carnet_vigente_bool: false,
    }),
    "sin fecha de vencimiento": h.geminiValid({
      carnet_fecha_vencimiento: null,
      carnet_vigencia: "",
    }),
    "sin cotejo facial": h.geminiValid({ facial_match_ok: null }),
    "rostro no coincide": h.geminiValid({ facial_match_ok: false }),
  };
  for (const [name, gemini] of Object.entries(cases)) {
    const { id, candidate } = await h.createApprovedWithSession(ctx, admin);
    ctx.geminiPhase2 = async () => gemini;
    const res = await candidate.post(
      `/api/candidates/${id}/phase2-acreditacion`,
      { body: docs() },
    );
    assert.equal(res.status, 200, name);
    const c = await row(id, "status, ocr_cross_check_ok, discrepancy_notes");
    assert.equal(c.status, "EN_REVISION_MANUAL", name);
    assert.equal(c.ocr_cross_check_ok, 0, name);
    assert.ok(c.discrepancy_notes.length > 10, name);
  }
});

// ---------- Panel RR.HH. ----------
test("admin: listado con filtros, estadísticas y notificaciones", async () => {
  const list = async (qs = "") => {
    const res = await admin.get(`/api/admin/candidates${qs}`);
    assert.equal(res.status, 200);
    return res.json.candidates || res.json;
  };
  const all = await list();
  assert.equal(all.length, await count());
  const pre = await list("?status=PRE_ACREDITADO");
  assert.ok(pre.length >= 1 && pre.every((c) => c.status === "PRE_ACREDITADO"));
  assert.equal((await list(`?position_id=${positionId}`)).length, all.length);
  assert.equal(
    (await admin.get("/api/admin/candidates?position_id=abc")).status,
    400,
  );

  const stats = (await admin.get("/api/admin/stats")).json;
  assert.equal(stats.total, all.length);
  assert.equal(stats.approved, pre.length);
  assert.equal((await admin.get("/api/admin/notifications")).status, 200);
});

test("admin: cambio de estado válido, inválido y contratación con aviso por correo", async () => {
  const id = await h.createPreselected(ctx);
  const patch = (status, target = id) =>
    admin.patch(`/api/admin/candidates/${target}/status`, { body: { status } });
  assert.equal((await patch("EN_REVISION_MANUAL")).status, 200);
  assert.equal((await row(id, "status")).status, "EN_REVISION_MANUAL");
  assert.equal((await patch("HACKEADO")).status, 400);
  assert.equal((await patch("POSTULADO", "abc")).status, 400);
  ctx.mails.length = 0;
  assert.equal((await patch("CONTRATADO_FAENA")).status, 200);
  assert.equal(ctx.mails.filter((m) => m.type === "contratacion").length, 1);
});

test("admin: la exportación del expediente escapa HTML y no lleva tokens", async () => {
  const id = await h.createPreselected(ctx);
  await ctx.pool.query("UPDATE candidates SET full_name = ? WHERE id = ?", [
    '<img src=x onerror="alert(1)">',
    id,
  ]);
  const res = await admin.get(`/api/admin/candidates/${id}/export-webcontrol`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.ok(!res.text.includes("<img src=x"), "el nombre debe ir escapado");
  assert.doesNotMatch(res.text, /token=/);
  assert.equal(
    (await admin.get("/api/admin/candidates/999999/export-webcontrol")).status,
    404,
  );
});

// ---------- Base de datos y errores ----------
test("BD: integridad referencial y unicidad del magic link", async () => {
  const id = await h.createPreselected(ctx);
  await assert.rejects(
    ctx.pool.query(
      "INSERT INTO candidates (full_name, rut_id, position_id) VALUES ('X Y', '1-9', 999999)",
    ),
    /foreign key/i,
  );
  await ctx.pool.query("UPDATE candidates SET access_token = ? WHERE id = ?", [
    "c".repeat(64),
    id,
  ]);
  const other = await h.createPreselected(ctx);
  await assert.rejects(
    ctx.pool.query("UPDATE candidates SET access_token = ? WHERE id = ?", [
      "c".repeat(64),
      other,
    ]),
    /Duplicate/i,
  );
  await ctx.pool.query("DELETE FROM candidates WHERE id = ?", [id]);
  const [[left]] = await ctx.pool.query(
    "SELECT COUNT(*) n FROM candidate_answers WHERE candidate_id = ?",
    [id],
  );
  assert.equal(left.n, 0, "las respuestas se borran en cascada");
});

test("errores HTTP: JSON inválido 400 y ruta desconocida 404, siempre en JSON", async () => {
  const bad = await ctx
    .client()
    .post("/api/auth/admin-login", { rawBody: '{"username":' });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.error);
  const nf = await ctx.client().get("/api/no-existe");
  assert.equal(nf.status, 404);
  assert.ok(nf.json.error);
});

// Debe ir al final: cierra la conexión a la BD.
test("BD caída: respuesta 500 genérica, sin detalles internos, y error registrado", async () => {
  await ctx.server.closeDB();
  ctx.capturedErrors.length = 0;
  const res = await ctx.client().get("/api/positions");
  assert.equal(res.status, 500);
  assert.equal(
    res.json.error,
    "Error interno del servidor. Intente nuevamente más tarde.",
  );
  assert.doesNotMatch(res.text, /pool|mysql|closed|stack|server\.js/i);
  assert.ok(ctx.capturedErrors.some((l) => l.includes("GET /api/positions")));
});

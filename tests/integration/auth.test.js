// Integración: autenticación del panel RR.HH., sesiones, CSRF y cabeceras de seguridad.
const { startTestApp } = require("../helpers/app");
const test = require("node:test");
const assert = require("node:assert/strict");

let ctx;
test.before(async () => {
  ctx = await startTestApp("auth");
});
test.after(async () => {
  await ctx.close();
});

test("sin sesión: /admin redirige al login y las rutas admin responden 401", async () => {
  const c = ctx.client();
  const page = await c.get("/admin");
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/admin/login");
  for (const [method, path] of [
    ["get", "/api/admin/stats"],
    ["get", "/api/admin/candidates"],
    ["get", "/api/admin/notifications"],
    ["get", "/api/admin/candidates/1/export-webcontrol"],
    ["post", "/api/admin/candidates/1/approve-faena"],
    ["patch", "/api/admin/candidates/1/status"],
    ["post", "/api/admin/candidates/1/reprocess-ocr"],
  ]) {
    const res = await c[method](path, method === "get" ? {} : { body: {} });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  assert.equal((await c.get("/api/auth/verify")).status, 401);
});

test("login: credenciales inválidas dan 401 con el mismo mensaje", async () => {
  const c = ctx.client();
  const badPass = await c.post("/api/auth/admin-login", {
    body: { username: "admin", password: "incorrecta" },
  });
  const badUser = await c.post("/api/auth/admin-login", {
    body: { username: "no-existe", password: "incorrecta" },
  });
  assert.equal(badPass.status, 401);
  assert.equal(badUser.status, 401);
  assert.equal(
    badPass.json.error,
    badUser.json.error,
    "no revela si el usuario existe",
  );
  assert.equal(c.jar.size, 0);
});

test("login: crea cookie HttpOnly SameSite=Strict y no entrega el token en el cuerpo", async () => {
  const c = ctx.client();
  const res = await c.post("/api/auth/admin-login", {
    body: { username: "admin", password: ctx.adminPassword },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.token, undefined);
  assert.equal(res.json.user.username, "admin");
  const cookie = res.setCookies.find((s) => s.startsWith("nexxo_admin="));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);

  const value = c.jar.get("nexxo_admin");
  const [rows] = await ctx.pool.query("SELECT token_hash FROM admin_sessions");
  assert.ok(rows.length >= 1);
  assert.ok(
    rows.every((r) => r.token_hash !== value),
    "la BD guarda el hash, nunca el token de sesión",
  );
});

test("con sesión: verify, panel y rutas protegidas responden 200", async () => {
  const admin = await ctx.adminClient();
  const verify = await admin.get("/api/auth/verify");
  assert.equal(verify.status, 200);
  assert.equal(verify.json.valid, true);
  assert.equal((await admin.get("/admin")).status, 200);
  assert.equal((await admin.get("/api/admin/stats")).status, 200);
});

test("credenciales antiguas o falsas no autentican (Bearer, ?token=, cookie inventada)", async () => {
  const c = ctx.client();
  const fake = "a".repeat(64);
  assert.equal(
    (
      await c.get("/api/admin/stats", {
        headers: { authorization: `Bearer ${fake}` },
      })
    ).status,
    401,
  );
  assert.equal((await c.get(`/api/admin/stats?token=${fake}`)).status, 401);
  assert.equal(
    (
      await c.get("/api/admin/stats", {
        headers: { cookie: `nexxo_admin=${fake}` },
      })
    ).status,
    401,
  );
});

test("CSRF: una petición de otro origen se bloquea aunque lleve la sesión", async () => {
  const admin = await ctx.adminClient();
  const cross = await admin.post("/api/auth/logout", {
    headers: { origin: "https://evil.example" },
  });
  assert.equal(cross.status, 403);
  const fetchSite = await admin.patch("/api/admin/candidates/1/status", {
    body: { status: "POSTULADO" },
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(fetchSite.status, 403);
  assert.equal(
    (await admin.get("/api/admin/stats")).status,
    200,
    "la sesión sigue activa",
  );
});

test("sesión expirada: deja de autenticar", async () => {
  const admin = await ctx.adminClient();
  assert.equal((await admin.get("/api/admin/stats")).status, 200);
  await ctx.pool.query(
    "UPDATE admin_sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE revoked_at IS NULL",
  );
  assert.equal((await admin.get("/api/admin/stats")).status, 401);
  assert.equal((await admin.get("/admin")).status, 302);
});

test("logout: revoca la sesión en el servidor; la cookie copiada ya no sirve", async () => {
  const admin = await ctx.adminClient();
  const stolen = admin.jar.get("nexxo_admin");
  const out = await admin.post("/api/auth/logout");
  assert.equal(out.status, 200);
  assert.equal(
    admin.jar.has("nexxo_admin"),
    false,
    "el navegador recibe la orden de borrar la cookie",
  );
  const replay = await ctx
    .client()
    .get("/api/admin/stats", { headers: { cookie: `nexxo_admin=${stolen}` } });
  assert.equal(replay.status, 401);
});

test("cabeceras de seguridad presentes en páginas y API", async () => {
  for (const path of ["/", "/admin/login", "/api/positions"]) {
    const res = await ctx.client().get(path);
    const h = res.headers;
    assert.match(h.get("content-security-policy"), /default-src 'self'/, path);
    assert.match(h.get("content-security-policy"), /object-src 'none'/);
    assert.doesNotMatch(
      h.get("content-security-policy").match(/script-src [^;]*/)[0],
      /unsafe-inline/,
    );
    assert.equal(h.get("x-content-type-options"), "nosniff");
    assert.equal(h.get("x-frame-options"), "SAMEORIGIN");
    assert.match(h.get("permissions-policy"), /camera=\(self\)/);
    assert.equal(h.get("x-powered-by"), null);
    assert.equal(
      h.get("strict-transport-security"),
      null,
      "HSTS solo en producción",
    );
  }
});

test("archivos heredados de public/uploads no se sirven como estáticos", async () => {
  for (const path of [
    "/uploads/x.jpg",
    "/UPLOADS/x.jpg",
    "/%75ploads/x.jpg",
    "/uploads/",
  ]) {
    const res = await ctx.client().get(path);
    assert.ok([401, 404].includes(res.status), `${path} -> ${res.status}`);
  }
});

// Debe ir al final: agota el límite de intentos de login de este proceso.
test("límite de intentos: el login responde 429 tras demasiados intentos", async () => {
  const c = ctx.client();
  let got429 = false;
  for (let i = 0; i < 20 && !got429; i++) {
    const res = await c.post("/api/auth/admin-login", {
      body: { username: "admin", password: "incorrecta" },
    });
    got429 = res.status === 429;
  }
  assert.equal(got429, true);
});

// Integración: ejecutor de migraciones (src/db/migrate.js) contra bases desechables (MySQL local o TiDB local).
const env = require("../helpers/env");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const mysql = require("mysql2/promise");
const migrate = require("../../src/db/migrate");
const { ensureSeedData } = require("../../src/db/seeds");

const REAL_DIR = path.join(__dirname, "../../src/db/migrations");
const SERVER_JS = path.join(__dirname, "../../src/server.js");
const server = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
};
const quiet = { log: () => {} };
const pools = [];
let admin;
let isTiDB = false;

test.before(async () => {
  admin = await mysql.createConnection(server);
  const [[v]] = await admin.query("SELECT VERSION() AS v");
  isTiDB = /tidb/i.test(v.v);
});
test.after(async () => {
  for (const { pool, name } of pools) {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  }
  await admin.end();
});

async function emptyDb(suffix) {
  const name = `web_app_test_mig_${suffix}`;
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\``);
  const pool = mysql.createPool({ ...server, database: name });
  pools.push({ pool, name });
  return pool;
}

const baselineSql = () => migrate.loadMigrations(REAL_DIR)[0].sql;
const dbName = async (pool) =>
  (await pool.query("SELECT DATABASE() AS db"))[0][0].db;

/** BD "antigua": esquema creado sin el ejecutor, con las diferencias halladas en la BD local real y con datos. */
async function legacyDb(suffix) {
  const pool = await emptyDb(suffix);
  for (const st of migrate.splitStatements(baselineSql())) {
    if (!st.tidbOnly) await pool.query(st.sql);
  }
  await pool.query(
    "ALTER TABLE candidates MODIFY COLUMN ocr_antecedentes_status VARCHAR(60) DEFAULT NULL",
  );
  await pool.query("ALTER TABLE positions ADD COLUMN audio_prompt TEXT");
  await pool.query(
    "CREATE TABLE audio_prompts (id INT AUTO_INCREMENT PRIMARY KEY, prompt_text TEXT NOT NULL)",
  );
  await pool.query(
    "INSERT INTO positions (name, audio_prompt) VALUES ('Cargo antiguo', 'texto heredado')",
  );
  const [[pos]] = await pool.query("SELECT id FROM positions LIMIT 1");
  await pool.query(
    "INSERT INTO candidates (full_name, rut_id, position_id, status, ocr_antecedentes_status) VALUES ('Persona Existente', '12.345.678-5', ?, 'PRE_ACREDITADO', 'Limpio / Vigente (5 días)')",
    [pos.id],
  );
  return pool;
}

const registry = async (pool) =>
  (
    await pool.query(
      "SELECT id, name, baselined FROM schema_migrations ORDER BY id",
    )
  )[0];
const runsTable = async (pool) =>
  (
    await pool.query(
      "SELECT id, status, done, total, error FROM schema_migration_runs ORDER BY id",
    )
  )[0];
const columnType = async (pool, table, column) => {
  const [rows] = await pool.query(
    "SELECT COLUMN_TYPE AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
    [table, column],
  );
  return rows.length ? rows[0].t : null;
};
const tables = async (pool) =>
  (await pool.query("SHOW TABLES"))[0].map((r) => Object.values(r)[0]).sort();
const schemaSnapshot = async (pool) => {
  const out = [];
  for (const t of await tables(pool)) {
    const [[row]] = await pool.query(`SHOW CREATE TABLE \`${t}\``);
    out.push(row["Create Table"].replace(/AUTO_INCREMENT=\d+ /, ""));
  }
  return out;
};
const verify = async (pool) => {
  const conn = await pool.getConnection();
  try {
    return await migrate.verifyBaseline(conn, baselineSql());
  } finally {
    conn.release();
  }
};

function tempMigrations(name, extra = {}, { withReal = true } = {}) {
  const dir = path.join(env.tmpRoot, name);
  fs.mkdirSync(dir);
  if (withReal) {
    for (const f of fs.readdirSync(REAL_DIR))
      fs.copyFileSync(path.join(REAL_DIR, f), path.join(dir, f));
  }
  for (const [file, sql] of Object.entries(extra))
    fs.writeFileSync(path.join(dir, file), sql);
  return dir;
}

function runServer(dbEnv, timeout = 90000) {
  return spawnSync(process.execPath, [SERVER_JS], {
    env: { ...process.env, PORT: "0", ...dbEnv },
    cwd: env.tmpRoot,
    encoding: "utf8",
    timeout,
  });
}

// ---------------------------------------------------------------------------
// Archivos
// ---------------------------------------------------------------------------

test("archivos: orden numérico, nombres válidos, números únicos y verificación por sentencia", () => {
  const real = migrate.loadMigrations(REAL_DIR);
  assert.deepEqual(
    real.map((m) => m.id),
    [...real.map((m) => m.id)].sort(),
  );
  assert.equal(real[0].id, "001");
  assert.ok(real.every((m) => /^[0-9a-f]{64}$/.test(m.checksum)));
  assert.ok(real.every((m) => m.statements.every((s) => s.check)));
  assert.throws(
    () =>
      migrate.loadMigrations(
        tempMigrations("mal_nombre", { "3-Cosa.sql": "SELECT 1;" }),
      ),
    /Nombre de migración inválido/,
  );
  assert.throws(
    () =>
      migrate.loadMigrations(
        tempMigrations("repetida", {
          "002_otra.sql": "-- @idempotente\nSELECT 1;\n",
        }),
      ),
    /dos migraciones con el número 002/,
  );
  assert.throws(
    () =>
      migrate.loadMigrations(
        tempMigrations("sin_verifica", {
          "003_datos.sql": "UPDATE positions SET name = name;\n",
        }),
      ),
    /003_datos\.sql: la sentencia 1 no tiene verificación/,
  );
  assert.throws(
    () =>
      migrate.loadMigrations(
        tempMigrations("verifica_no_select", {
          "003_datos.sql":
            "-- @verifica: DELETE FROM positions\nUPDATE positions SET name = name;\n",
        }),
      ),
    /debe ser un SELECT/,
  );
});

test("sentencias: separación, marcas @tidb-only / @verifica / @idempotente y verificación derivada", () => {
  const st = migrate.splitStatements(
    [
      "-- comentario",
      "CREATE TABLE a (",
      "  id INT",
      ");",
      "",
      "-- @tidb-only: motivo",
      "ALTER TABLE a AUTO_ID_CACHE = 10;",
      "ALTER TABLE a ADD COLUMN b INT;",
      "ALTER TABLE a MODIFY COLUMN b VARCHAR(20) NOT NULL;",
      "CREATE UNIQUE INDEX ux_b ON a (b);",
      "ALTER TABLE a ADD COLUMN c INT, ADD COLUMN d INT;",
      "-- @verifica: SELECT COUNT(*) FROM a",
      "INSERT INTO a (b) VALUES ('x');",
      "-- @idempotente",
      "UPDATE a SET b = 'y';",
    ].join("\n") + "\n",
  );
  assert.deepEqual(
    st.map((s) => s.tidbOnly),
    [false, true, false, false, false, false, false, false],
  );
  assert.deepEqual(
    st.map((s) => s.check && s.check.kind),
    [
      "table",
      "idempotent",
      "column",
      "columnType",
      "index",
      null, // varias cláusulas: exige @verifica explícita
      "query",
      "idempotent",
    ],
  );
  assert.deepEqual(st[3].check, {
    kind: "columnType",
    table: "a",
    column: "b",
    type: "varchar(20)",
    nullable: false,
  });
  assert.throws(() => migrate.splitStatements("SELECT 1"), /sin ';' final/);
});

// ---------------------------------------------------------------------------
// Instalación limpia y BD existente
// ---------------------------------------------------------------------------

test("BD vacía: crea el esquema completo, registra las migraciones y no las repite", async () => {
  const pool = await emptyDb("vacia");
  const first = await migrate.runMigrations(pool, quiet);
  assert.equal(first.baselined, false);
  assert.deepEqual(
    first.applied,
    migrate.loadMigrations(REAL_DIR).map((m) => m.name),
  );
  assert.deepEqual(await tables(pool), [
    "admin_sessions",
    "admin_users",
    "candidate_answers",
    "candidates",
    "file_storage",
    "positions",
    "questions",
    "schema_migration_runs",
    "schema_migrations",
  ]);
  const reg = await registry(pool);
  assert.ok(reg.every((r) => r.baselined === 0));
  assert.deepEqual(await runsTable(pool), []);

  const snapshot = await schemaSnapshot(pool);
  const second = await migrate.runMigrations(pool, quiet);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(await registry(pool), reg);
  assert.deepEqual(await schemaSnapshot(pool), snapshot);

  // Un esquema recién creado coincide exactamente con el baseline en todas las propiedades.
  assert.deepEqual(await verify(pool), { critical: [], review: [] });
  if (isTiDB) {
    const [[row]] = await pool.query("SHOW CREATE TABLE candidates");
    assert.match(row["Create Table"], /AUTO_ID_CACHE=10/);
  }
});

test("verificación del baseline: tipos, nulabilidad, defaults, índices, únicos, FK y otras restricciones (solo lectura)", async () => {
  const pool = await emptyDb("propiedades");
  await migrate.runMigrations(pool, quiet);
  const alter = [
    "ALTER TABLE candidates MODIFY COLUMN email VARCHAR(150) NOT NULL",
    "ALTER TABLE candidates MODIFY COLUMN city VARCHAR(200) DEFAULT NULL",
    "ALTER TABLE candidates MODIFY COLUMN score VARCHAR(10) DEFAULT '0'",
    "ALTER TABLE positions ALTER COLUMN min_experience_years SET DEFAULT 5",
    "ALTER TABLE questions MODIFY COLUMN category VARCHAR(30) NOT NULL DEFAULT 'TECNICA'",
    "ALTER TABLE candidates DROP INDEX uq_candidates_access_token",
    "ALTER TABLE admin_sessions DROP INDEX idx_admin_sessions_admin",
    "ALTER TABLE candidate_answers DROP FOREIGN KEY candidate_answers_ibfk_2",
    "ALTER TABLE questions DROP FOREIGN KEY questions_ibfk_1",
    "ALTER TABLE questions ADD CONSTRAINT questions_fk_sin_cascada FOREIGN KEY (position_id) REFERENCES positions (id)",
    "CREATE INDEX idx_extra_rut ON candidates (rut_id)",
  ];
  for (const sql of alter) await pool.query(sql);
  if (!isTiDB) {
    // TiDB no admite triggers, ignora ENGINE y, por defecto, no guarda CHECK.
    await pool.query(
      "ALTER TABLE candidates ADD CONSTRAINT chk_age CHECK (age >= 18)",
    );
    await pool.query(
      "CREATE TRIGGER trg_extra BEFORE INSERT ON positions FOR EACH ROW SET NEW.name = TRIM(NEW.name)",
    );
    await pool.query("ALTER TABLE admin_users ENGINE=MyISAM");
    // TiDB no permite quitar AUTO_INCREMENT (tidb_allow_remove_auto_inc).
    await pool.query("ALTER TABLE file_storage MODIFY COLUMN id INT NOT NULL");
  }

  const before = await schemaSnapshot(pool);
  const { critical, review } = await verify(pool);
  assert.deepEqual(await schemaSnapshot(pool), before, "no modifica nada");

  const has = (list, re) =>
    assert.ok(
      list.some((x) => re.test(x)),
      `falta ${re} en:\n${list.join("\n")}`,
    );
  has(critical, /candidates\.email es NOT NULL sin valor por defecto/);
  has(critical, /candidates\.score es varchar\(10\), se esperaba int/);
  has(critical, /falta el índice único sobre candidates\(access_token\)/);
  has(
    critical,
    /falta la clave foránea candidate_answers\(question_id\) → questions\(id\)/,
  );
  has(
    critical,
    /clave foránea questions\(position_id\) → positions\(id\) tiene ON DELETE RESTRICT .* se esperaba ON DELETE CASCADE/,
  );
  has(review, /candidates\.city es varchar\(200\)/);
  has(review, /positions\.min_experience_years tiene DEFAULT '5'.*'2'/);
  has(review, /questions\.category es NOT NULL \(el baseline declara NULL\)/);
  has(
    review,
    /falta el índice idx_admin_sessions_admin sobre admin_sessions\(admin_id\)/,
  );
  has(review, /índice adicional idx_extra_rut sobre candidates\(rut_id\)/);
  if (!isTiDB) {
    has(critical, /admin_users usa el motor MyISAM, se esperaba InnoDB/);
    has(critical, /file_storage\.id no es AUTO_INCREMENT/);
    has(review, /restricción CHECK adicional chk_age en candidates/);
    has(review, /trigger adicional trg_extra en positions/);
  }
  // Los mismos cambios hacen que runMigrations rechace registrar el baseline en una BD "existente".
  await pool.query("DELETE FROM schema_migrations");
  await assert.rejects(
    migrate.runMigrations(pool, quiet),
    /no coincide con el baseline[\s\S]*Diferencias críticas[\s\S]*Requieren revisión/,
  );
  assert.deepEqual(await registry(pool), []);
});

test("BD existente: se verifica y registra el baseline sin ejecutarlo; los datos quedan intactos", async () => {
  const pool = await legacyDb("existente");
  const before = (await pool.query("SELECT * FROM candidates"))[0];

  const result = await migrate.runMigrations(pool, quiet);
  assert.equal(result.baselined, true);
  assert.deepEqual(result.applied, ["002_ampliar_ocr_antecedentes_status.sql"]);
  const reg = await registry(pool);
  assert.deepEqual(
    reg.map((r) => [r.id, r.baselined]),
    [
      ["001", 1],
      ["002", 0],
    ],
  );

  // Datos y sobrantes intactos; la única modificación es el ancho de la columna (002).
  assert.deepEqual((await pool.query("SELECT * FROM candidates"))[0], before);
  assert.equal(
    (await pool.query("SELECT audio_prompt FROM positions"))[0][0].audio_prompt,
    "texto heredado",
  );
  assert.ok((await tables(pool)).includes("audio_prompts"));
  assert.equal(
    await columnType(pool, "candidates", "ocr_antecedentes_status"),
    "varchar(80)",
  );
  const has = (re) =>
    assert.ok(
      result.warnings.some((w) => re.test(w)),
      `${re}:\n${result.warnings.join("\n")}`,
    );
  has(/columna sobrante positions\.audio_prompt \(no se toca\)/);
  has(/tabla sobrante audio_prompts/);
  has(/ocr_antecedentes_status es varchar\(60\)/);

  assert.deepEqual((await migrate.runMigrations(pool, quiet)).applied, []);
});

test("BD existente incompatible: se detiene, lista las diferencias y no marca nada", async () => {
  const pool = await legacyDb("incompatible");
  await pool.query("ALTER TABLE candidates DROP COLUMN phase2_submitted_at");
  await pool.query("ALTER TABLE candidates MODIFY COLUMN score VARCHAR(10)");
  await pool.query("DROP TABLE file_storage");

  await assert.rejects(migrate.runMigrations(pool, quiet), (err) => {
    assert.match(err.message, /no coincide con el baseline/);
    assert.match(
      err.message,
      /falta la columna candidates\.phase2_submitted_at/,
    );
    assert.match(
      err.message,
      /candidates\.score es varchar\(10\), se esperaba int/,
    );
    assert.match(err.message, /falta la tabla file_storage/);
    return true;
  });
  assert.deepEqual(
    await tables(pool).then((t) => t.filter((x) => x.startsWith("schema_"))),
    [],
  );
  assert.equal(
    await columnType(pool, "candidates", "ocr_antecedentes_status"),
    "varchar(60)",
    "ninguna migración posterior se ejecutó",
  );
});

test("migración pendiente: solo se ejecuta la nueva", async () => {
  const pool = await emptyDb("pendiente");
  await migrate.runMigrations(pool, quiet);
  const dir = tempMigrations("con_nueva", {
    "003_tabla_nueva.sql":
      "CREATE TABLE tabla_nueva (id INT NOT NULL, PRIMARY KEY (id));\n",
  });
  const conn = await pool.getConnection();
  const status = await migrate.getStatus(conn, dir);
  conn.release();
  assert.deepEqual(
    status.pending.map((m) => m.name),
    ["003_tabla_nueva.sql"],
  );
  const result = await migrate.runMigrations(pool, { ...quiet, dir });
  assert.deepEqual(result.applied, ["003_tabla_nueva.sql"]);
  assert.ok((await tables(pool)).includes("tabla_nueva"));
});

test("migración ya aplicada y luego modificada: se rechaza", async () => {
  const pool = await emptyDb("modificada");
  await migrate.runMigrations(pool, quiet);
  const dir = tempMigrations("alterada");
  fs.appendFileSync(
    path.join(dir, "002_ampliar_ocr_antecedentes_status.sql"),
    "\n-- cambio posterior\n",
  );
  await assert.rejects(
    migrate.runMigrations(pool, { ...quiet, dir }),
    /ya aplicadas fueron modificadas: 002_ampliar_ocr_antecedentes_status\.sql/,
  );
});

// ---------------------------------------------------------------------------
// Fallos e interrupciones
// ---------------------------------------------------------------------------

test("migración que falla: queda FALLIDA, no se registra, y al corregirla continúa sin repetir lo aplicado", async () => {
  const pool = await emptyDb("falla");
  const failing = [
    "ALTER TABLE positions ADD COLUMN nota VARCHAR(20) DEFAULT NULL;",
    "ALTER TABLE tabla_que_no_existe ADD COLUMN x INT;",
    "CREATE TABLE despues_del_fallo (id INT NOT NULL, PRIMARY KEY (id));",
  ].join("\n");
  const dir = tempMigrations("con_fallo", {
    "003_falla.sql": failing + "\n",
    "004_despues.sql":
      "CREATE TABLE despues (id INT NOT NULL, PRIMARY KEY (id));\n",
  });
  await assert.rejects(
    migrate.runMigrations(pool, { ...quiet, dir }),
    /La migración 003_falla\.sql falló en la sentencia 2 de 3: .*tabla_que_no_existe.*continuará desde la sentencia 2/,
  );
  assert.deepEqual(
    (await registry(pool)).map((r) => r.id),
    ["001", "002"],
  );
  const [run] = await runsTable(pool);
  assert.deepEqual(
    [run.id, run.status, run.done, run.total],
    ["003", "FALLIDA", 1, 3],
  );
  assert.match(run.error, /tabla_que_no_existe/);
  assert.ok(
    await columnType(pool, "positions", "nota"),
    "la sentencia 1 quedó aplicada",
  );
  assert.ok(!(await tables(pool)).includes("despues"), "la 004 no se ejecutó");

  // Reintento sin corregir: el bloqueo se liberó, vuelve a fallar en la sentencia 2 (la 1 no se repite).
  await assert.rejects(
    migrate.runMigrations(pool, { ...quiet, dir }),
    /003_falla\.sql falló en la sentencia 2/,
  );

  // --status (solo lectura) identifica la migración, el error y lo que alcanzó a aplicarse.
  const conn = await pool.getConnection();
  const status = await migrate.getStatus(conn, dir);
  conn.release();
  assert.equal(status.interrupted.length, 1);
  assert.deepEqual(status.interrupted[0].assessment, {
    states: ["aplicada", "pendiente", "pendiente"],
    consistent: true,
  });

  // Se corrige el archivo (no estaba registrado, así que es legítimo): continúa desde la sentencia 2.
  // Si la sentencia 1 se repitiera, fallaría con "Duplicate column".
  fs.writeFileSync(
    path.join(dir, "003_falla.sql"),
    failing.replace(
      "tabla_que_no_existe ADD COLUMN x",
      "positions ADD COLUMN x",
    ) + "\n",
  );
  const logs = [];
  const ok = await migrate.runMigrations(pool, {
    dir,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(ok.applied, ["003_falla.sql", "004_despues.sql"]);
  assert.ok(
    logs.some((l) =>
      /Recuperando 003_falla\.sql \(intento anterior FALLIDA, 1\/3/.test(l),
    ),
  );
  assert.deepEqual(await runsTable(pool), []);
  assert.deepEqual(
    (await registry(pool)).map((r) => r.id),
    ["001", "002", "003", "004"],
  );
});

test("interrupción real: el proceso muere a mitad de una migración y el siguiente arranque la completa sin duplicar", async () => {
  const pool = await emptyDb("muere");
  await migrate.runMigrations(pool, quiet);
  const dir = tempMigrations("interrumpida", {
    "003_larga.sql": [
      "CREATE TABLE paso_uno (id INT NOT NULL, PRIMARY KEY (id));",
      "-- @idempotente",
      "DO SLEEP(3);",
      "CREATE TABLE paso_tres (id INT NOT NULL, PRIMARY KEY (id));",
      "",
    ].join("\n"),
  });
  const childJs = path.join(env.tmpRoot, "migrar_hijo.js");
  fs.writeFileSync(
    childJs,
    `const mysql = require(${JSON.stringify(require.resolve("mysql2/promise"))});
const migrate = require(${JSON.stringify(require.resolve("../../src/db/migrate"))});
const pool = mysql.createPool(JSON.parse(process.env.HIJO_DB));
migrate.runMigrations(pool, { dir: process.env.HIJO_DIR, log: () => {} });\n`,
  );
  const child = spawn(process.execPath, [childJs], {
    env: {
      ...process.env,
      HIJO_DB: JSON.stringify({ ...server, database: await dbName(pool) }),
      HIJO_DIR: dir,
    },
    stdio: "ignore",
  });
  const exited = new Promise((r) => child.on("exit", r));
  // Espera a que la sentencia 1 termine (la 2 dura 3 s) y mata el proceso sin darle opción a limpiar.
  const deadline = Date.now() + 30000;
  let progress = null;
  while (Date.now() < deadline) {
    const [rows] = await pool.query(
      "SELECT done FROM schema_migration_runs WHERE id = '003'",
    );
    if (rows.length && rows[0].done >= 1) {
      progress = rows[0].done;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  await exited;
  assert.equal(
    progress,
    1,
    "la migración llegó a la sentencia 2 antes de morir",
  );

  const conn = await pool.getConnection();
  const status = await migrate.getStatus(conn, dir);
  conn.release();
  assert.equal(status.interrupted[0].status, "EN_CURSO");
  assert.deepEqual(status.interrupted[0].assessment.states, [
    "aplicada",
    "idempotente",
    "pendiente",
  ]);
  assert.ok(!(await tables(pool)).includes("paso_tres"));

  const result = await migrate.runMigrations(pool, { ...quiet, dir });
  assert.deepEqual(result.applied, ["003_larga.sql"]);
  assert.ok((await tables(pool)).includes("paso_tres"));
  assert.deepEqual(await runsTable(pool), []);
  assert.equal((await registry(pool)).length, 3);
});

test("estado inexplicable por una interrupción: exige intervención manual y no ejecuta nada", async () => {
  const pool = await emptyDb("inconsistente");
  await migrate.runMigrations(pool, quiet);
  const dir = tempMigrations("desordenada", {
    "003_dos_tablas.sql":
      "CREATE TABLE tabla_a (id INT NOT NULL, PRIMARY KEY (id));\nCREATE TABLE tabla_b (id INT NOT NULL, PRIMARY KEY (id));\n",
  });
  await pool.query("CREATE TABLE tabla_b (id INT NOT NULL, PRIMARY KEY (id))");
  const before = await schemaSnapshot(pool);
  await assert.rejects(
    migrate.runMigrations(pool, { ...quiet, dir }),
    /003_dos_tablas\.sql está en un estado que no corresponde a una interrupción \(sentencia 1: pendiente; sentencia 2: aplicada\)[\s\S]*intervención manual/,
  );
  assert.deepEqual(await schemaSnapshot(pool), before);
  assert.deepEqual(
    (await registry(pool)).map((r) => r.id),
    ["001", "002"],
  );
});

test("sentencia cuyo efecto no se verifica tras ejecutarse: se detiene sin registrar", async () => {
  const pool = await emptyDb("postcondicion");
  await migrate.runMigrations(pool, quiet);
  const dir = tempMigrations("mal_verificada", {
    "003_rara.sql":
      "-- @verifica: SELECT COUNT(*) FROM positions WHERE name = 'no existe'\nCREATE TABLE tabla_c (id INT NOT NULL, PRIMARY KEY (id));\n",
  });
  await assert.rejects(
    migrate.runMigrations(pool, { ...quiet, dir }),
    /003_rara\.sql falló en la sentencia 1 de 1: la sentencia se ejecutó pero su verificación no se cumple/,
  );
  assert.equal((await registry(pool)).length, 2);
  assert.equal((await runsTable(pool))[0].status, "FALLIDA");
});

test("instalación limpia interrumpida: la 001 se completa (no se confunde con una BD existente)", async () => {
  const pool = await emptyDb("baseline_cortado");
  const baseline = migrate.loadMigrations(REAL_DIR)[0];
  // Estado que deja un corte tras crear 3 tablas: tablas de control, avance EN_CURSO y 3 tablas creadas.
  await pool.query(
    "CREATE TABLE schema_migrations (id VARCHAR(10) NOT NULL, name VARCHAR(150) NOT NULL, checksum CHAR(64) NOT NULL, baselined TINYINT(1) NOT NULL DEFAULT 0, applied_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id))",
  );
  await pool.query(
    "CREATE TABLE schema_migration_runs (id VARCHAR(10) NOT NULL, name VARCHAR(150) NOT NULL, checksum CHAR(64) NOT NULL, total INT NOT NULL, done INT NOT NULL DEFAULT 0, status VARCHAR(20) NOT NULL, error TEXT, updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id))",
  );
  await pool.query(
    "INSERT INTO schema_migration_runs (id, name, checksum, total, done, status) VALUES ('001', ?, ?, ?, 3, 'EN_CURSO')",
    [baseline.name, baseline.checksum, baseline.statements.length],
  );
  for (const st of baseline.statements.slice(0, 3)) await pool.query(st.sql);

  const result = await migrate.runMigrations(pool, quiet);
  assert.equal(result.baselined, false);
  assert.deepEqual(
    result.applied,
    migrate.loadMigrations(REAL_DIR).map((m) => m.name),
  );
  assert.deepEqual(
    (await registry(pool)).map((r) => [r.id, r.baselined]),
    [
      ["001", 0],
      ["002", 0],
    ],
  );
  assert.deepEqual(await verify(pool), { critical: [], review: [] });
});

test("semillas: cargan cargos y preguntas una vez y no se duplican al repetir", async () => {
  const pool = await emptyDb("semillas");
  await migrate.runMigrations(pool, quiet);
  const counts = async () => {
    const [[p]] = await pool.query("SELECT COUNT(*) n FROM positions");
    const [[q]] = await pool.query("SELECT COUNT(*) n FROM questions");
    return [Number(p.n), Number(q.n)];
  };
  const conn = await pool.getConnection();
  await ensureSeedData(conn);
  const first = await counts();
  await ensureSeedData(conn);
  await ensureSeedData(conn);
  conn.release();
  assert.ok(first[0] >= 3 && first[1] >= 5);
  assert.deepEqual(await counts(), first);
});

// ---------------------------------------------------------------------------
// Arranque fail-fast (proceso real de src/server.js)
// ---------------------------------------------------------------------------

test("arranque: esquema existente incompatible → código 1, sin abrir el puerto ni registrar nada", async () => {
  const pool = await legacyDb("arranque");
  await pool.query("ALTER TABLE candidates DROP COLUMN access_token");
  const run = runServer({ DB_NAME: await dbName(pool) });
  assert.equal(run.status, 1, run.stderr.slice(-400));
  assert.match(run.stderr, /\[Arranque\] Detenido/);
  assert.match(run.stderr, /falta la columna candidates\.access_token/);
  assert.doesNotMatch(run.stdout, /listo en/);
  assert.ok(!(await tables(pool)).includes("schema_migrations"));
});

test("arranque: sin conexión a la BD → código 1 sin abrir el puerto", () => {
  // Puerto cerrado: los 10 intentos fallan con ECONNREFUSED (≈27 s por la espera entre intentos).
  const run = runServer({
    DB_HOST: "127.0.0.1",
    DB_PORT: "1",
    DB_NAME: "web_app_test_sin_bd",
  });
  assert.equal(run.status, 1, run.stderr.slice(-400));
  assert.match(
    run.stderr,
    /\[Arranque\] Detenido: No se pudo conectar a la base de datos tras 10 intentos/,
  );
  assert.doesNotMatch(run.stdout, /listo en/);
});

test("arranque: si fallan los datos semilla obligatorios → código 1 sin abrir el puerto", async () => {
  const pool = await emptyDb("semilla_falla");
  await migrate.runMigrations(pool, quiet);
  // Columna heredada NOT NULL sin default (como positions.audio_prompt en la BD local): impide insertar cargos.
  await pool.query(
    "ALTER TABLE positions ADD COLUMN audio_prompt TEXT NOT NULL",
  );
  const run = runServer({ DB_NAME: await dbName(pool) });
  assert.equal(run.status, 1, run.stderr.slice(-400));
  assert.match(
    run.stderr,
    /No se inicializaron los datos semilla obligatorios/,
  );
  assert.doesNotMatch(run.stdout, /listo en/);
});

test("arranque: BD sana → abre el puerto y un segundo arranque no aplica cambios", async () => {
  const pool = await emptyDb("arranque_ok");
  const db = await dbName(pool);
  // El proceso no termina solo: se usa un timeout corto y se inspecciona la salida.
  const first = runServer({ DB_NAME: db }, 20000);
  assert.match(
    first.stdout,
    /Aplicada 001_baseline\.sql[\s\S]*Aplicada 002[\s\S]*listo en/,
  );
  const snapshot = await schemaSnapshot(pool);
  const second = runServer({ DB_NAME: db }, 20000);
  assert.match(second.stdout, /Esquema al día[\s\S]*listo en/);
  assert.deepEqual(await schemaSnapshot(pool), snapshot);
});

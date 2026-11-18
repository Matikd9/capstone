/**
 * Ejecutor de migraciones SQL numeradas (sin ORM).
 *
 * - Cada archivo src/db/migrations/NNN_nombre.sql se ejecuta una sola vez, en orden numérico,
 *   y queda registrado en schema_migrations con la huella (SHA-256) de su contenido.
 * - BD existente sin registro de la 001 (baseline): la 001 NO se ejecuta; se compara el esquema real
 *   con el declarado (solo lecturas a information_schema) y únicamente se registra si no hay
 *   diferencias críticas. Nunca se modifica el esquema para "hacerlo coincidir".
 * - Las sentencias precedidas por un comentario con "@tidb-only" se omiten en MySQL.
 *
 * Recuperación ante interrupciones (el DDL de MySQL/TiDB no es transaccional):
 * - Cada sentencia tiene una verificación de su efecto ("postcondición"): derivada automáticamente para
 *   CREATE TABLE, ADD COLUMN, MODIFY COLUMN y CREATE INDEX, o declarada con "-- @verifica: SELECT ..."
 *   (devuelve un valor verdadero si el efecto ya está presente) o "-- @idempotente" (re-ejecutable sin daño).
 *   Una sentencia sin verificación hace que el archivo se rechace al cargarlo.
 * - Mientras una migración corre, su avance queda en schema_migration_runs (EN_CURSO / FALLIDA y error).
 * - Antes de ejecutar una migración pendiente se evalúa cada postcondición contra el esquema real:
 *   las sentencias ya aplicadas se omiten (no se repiten) y se continúa desde la primera pendiente.
 *   Si las aplicadas no forman un prefijo (p. ej. la 1 falta y la 2 está), el estado no es explicable
 *   por una interrupción: se detiene y pide intervención manual sin ejecutar nada.
 * - Tras ejecutar cada sentencia se comprueba su postcondición; si no se cumple, se detiene.
 *
 * Uso manual:  node src/db/migrate.js --status   (solo lectura)
 *              node src/db/migrate.js --run      (aplica las pendientes)
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const BASELINE_ID = "001";
const LOCK_NAME = "nexxo_schema_migrations";
const LOCK_TIMEOUT_SECONDS = 60;
const META_TABLES = ["schema_migrations", "schema_migration_runs"];

// ---------------------------------------------------------------------------
// Lectura de archivos
// ---------------------------------------------------------------------------

/** Quita literales y paréntesis para saber si un ALTER tiene varias cláusulas separadas por coma. */
const hasTopLevelComma = (sql) => {
  let s = sql.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  while (/\([^()]*\)/.test(s)) s = s.replace(/\([^()]*\)/g, "");
  return s.includes(",");
};

const ident = "`?(\\w+)`?";
const columnTypeRe = "([A-Za-z]+(?:\\(\\d+(?:,\\d+)?\\))?)";

/** Postcondición de una sentencia, o null si no se puede verificar. */
function deriveCheck(st) {
  if (st.verifica) return { kind: "query", sql: st.verifica };
  if (st.idempotente) return { kind: "idempotent" };
  const s = st.sql.replace(/\s+/g, " ").trim();
  let m = s.match(new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?${ident}`, "i"));
  if (m) return { kind: "table", table: m[1] };
  m = s.match(
    new RegExp(`^ALTER TABLE ${ident} AUTO_ID_CACHE\\s*=\\s*\\d+$`, "i"),
  );
  if (m) return { kind: "idempotent" };
  m = s.match(
    new RegExp(`^CREATE (?:UNIQUE )?INDEX ${ident} ON ${ident}`, "i"),
  );
  if (m) return { kind: "index", table: m[2], index: m[1] };
  if (/^ALTER TABLE /i.test(s) && hasTopLevelComma(s)) return null;
  m = s.match(
    new RegExp(`^ALTER TABLE ${ident} ADD (?:COLUMN )?${ident} `, "i"),
  );
  if (m && !/^(INDEX|KEY|UNIQUE|CONSTRAINT|PRIMARY|FOREIGN)$/i.test(m[2]))
    return { kind: "column", table: m[1], column: m[2] };
  m = s.match(
    new RegExp(
      `^ALTER TABLE ${ident} MODIFY (?:COLUMN )?${ident} ${columnTypeRe}(.*)$`,
      "i",
    ),
  );
  if (m)
    return {
      kind: "columnType",
      table: m[1],
      column: m[2],
      type: normalizeType(m[3]),
      nullable: !/\bNOT NULL\b/i.test(m[4]),
    };
  return null;
}

// shortcut: divide por ";" al final de línea; no admite procedimientos ni triggers. Ampliar si algún día se necesitan.
function splitStatements(sql) {
  const statements = [];
  let comments = [];
  let lines = [];
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("--")) {
      if (lines.length === 0) comments.push(trimmed);
      continue;
    }
    if (!trimmed) continue;
    lines.push(line);
    if (trimmed.endsWith(";")) {
      const verifica = comments
        .map((c) => c.match(/^--\s*@verifica:\s*(.+)$/))
        .find(Boolean);
      const st = {
        sql: lines.join("\n").trim().replace(/;$/, ""),
        tidbOnly: comments.some((c) => c.includes("@tidb-only")),
        verifica: verifica ? verifica[1].trim().replace(/;$/, "") : null,
        idempotente: comments.some((c) => /^--\s*@idempotente\b/.test(c)),
      };
      st.check = deriveCheck(st);
      statements.push(st);
      comments = [];
      lines = [];
    }
  }
  if (lines.length > 0) {
    throw new Error("Sentencia sin ';' final en la migración.");
  }
  return statements;
}

function loadMigrations(dir = MIGRATIONS_DIR) {
  const migrations = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => {
      const match = file.match(/^(\d{3})_[a-z0-9_]+\.sql$/);
      if (!match) {
        throw new Error(
          `Nombre de migración inválido: ${file} (formato: NNN_nombre_en_minusculas.sql).`,
        );
      }
      // Finales de línea normalizados: la huella no debe cambiar entre Windows y Linux.
      const sql = fs
        .readFileSync(path.join(dir, file), "utf8")
        .replace(/\r\n/g, "\n");
      const statements = splitStatements(sql);
      statements.forEach((st, i) => {
        if (!st.check) {
          throw new Error(
            `${file}: la sentencia ${i + 1} no tiene verificación de su efecto. Añada antes un comentario "-- @verifica: SELECT ..." o "-- @idempotente".`,
          );
        }
        if (st.check.kind === "query" && !/^SELECT\s/i.test(st.check.sql)) {
          throw new Error(
            `${file}: la verificación de la sentencia ${i + 1} debe ser un SELECT (solo lectura).`,
          );
        }
      });
      return {
        id: match[1],
        name: file,
        sql,
        statements,
        checksum: crypto.createHash("sha256").update(sql).digest("hex"),
      };
    });
  const ids = migrations.map((m) => m.id);
  const repeated = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repeated)
    throw new Error(`Hay dos migraciones con el número ${repeated}.`);
  return migrations;
}

// ---------------------------------------------------------------------------
// Verificación del baseline (solo lectura)
// ---------------------------------------------------------------------------

const splitCols = (s) => s.split(",").map((c) => c.trim().replace(/`/g, ""));

// RESTRICT y NO ACTION son equivalentes en InnoDB/TiDB; sin cláusula ON DELETE/UPDATE, el motor aplica RESTRICT.
const normalizeRule = (r) =>
  !r || /^(NO ACTION|RESTRICT)$/i.test(r) ? "RESTRICT" : r.toUpperCase();

/**
 * Esquema que declara el baseline. Lee nuestro propio formato (una columna o restricción por línea):
 * columnas (tipo, nulabilidad, valor por defecto, AUTO_INCREMENT), clave primaria, índices únicos,
 * índices, claves foráneas (con reglas ON DELETE/UPDATE) y motor.
 */
function parseBaselineSpec(sql) {
  const spec = {};
  let table = null;
  for (const raw of sql.split("\n")) {
    const line = raw.trim().replace(/,$/, "");
    const create = line.match(/^CREATE TABLE (\w+) \($/);
    if (create) {
      table = create[1];
      spec[table] = {
        columns: {},
        primaryKey: [],
        uniques: [],
        indexes: [],
        foreignKeys: [],
        engine: "InnoDB",
      };
      continue;
    }
    if (!table) continue;
    const def = spec[table];
    let m;
    if (line.startsWith(")")) {
      m = line.match(/ENGINE=(\w+)/);
      if (m) def.engine = m[1];
      table = null;
    } else if ((m = line.match(/^PRIMARY KEY \(([^)]+)\)/))) {
      def.primaryKey = splitCols(m[1]);
    } else if ((m = line.match(/^UNIQUE KEY (\w+) \(([^)]+)\)/))) {
      def.uniques.push({ name: m[1], columns: splitCols(m[2]) });
    } else if ((m = line.match(/^KEY (\w+) \(([^)]+)\)/))) {
      def.indexes.push({ name: m[1], columns: splitCols(m[2]) });
    } else if (
      (m = line.match(
        /^CONSTRAINT (\w+) FOREIGN KEY \(([^)]+)\) REFERENCES (\w+) \(([^)]+)\)(.*)$/,
      ))
    ) {
      const del = m[5].match(/ON DELETE (CASCADE|SET NULL|RESTRICT|NO ACTION)/);
      const upd = m[5].match(/ON UPDATE (CASCADE|SET NULL|RESTRICT|NO ACTION)/);
      def.foreignKeys.push({
        name: m[1],
        columns: splitCols(m[2]),
        refTable: m[3],
        refColumns: splitCols(m[4]),
        onDelete: normalizeRule(del && del[1]),
        onUpdate: normalizeRule(upd && upd[1]),
      });
    } else if ((m = line.match(new RegExp(`^(\\w+) ${columnTypeRe}(.*)$`)))) {
      const rest = m[3];
      const dflt = rest.match(/\bDEFAULT\s+('(?:[^']*)'|[^\s,]+)/i);
      def.columns[m[1]] = {
        type: normalizeType(m[2]),
        nullable: !/\bNOT NULL\b/i.test(rest),
        default: normalizeDefault(dflt ? dflt[1] : null),
        autoIncrement: /\bAUTO_INCREMENT\b/i.test(rest),
      };
    }
  }
  return spec;
}

// "int(11)" (MySQL 5.7 / TiDB) e "int" (MySQL 8) son el mismo tipo; tinyint(1) se conserva en ambos.
function normalizeType(t) {
  return String(t)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^(int|bigint|smallint|mediumint)\(\d+\)/, "$1");
}

function normalizeDefault(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/^'(.*)'$/, "$1");
  if (/^NULL$/i.test(s)) return null;
  if (/^current_timestamp(\(\))?$/i.test(s)) return "CURRENT_TIMESTAMP";
  return s;
}

const baseType = (t) => t.replace(/\(.*$/, "");
const sameCols = (a, b) => a.join(",") === b.join(",");
const fmtCols = (c) => `(${c.join(", ")})`;

/** Esquema real de la BD actual, leído solo de information_schema. */
async function readActualSchema(conn) {
  const q = async (sql) => (await conn.query(sql))[0];
  const tablesRows = await q(
    "SELECT TABLE_NAME AS t, ENGINE AS engine FROM information_schema.tables WHERE table_schema = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
  );
  const cols = await q(
    "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS ty, IS_NULLABLE AS n, COLUMN_DEFAULT AS d, EXTRA AS x FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION",
  );
  const stats = await q(
    "SELECT TABLE_NAME AS t, INDEX_NAME AS i, NON_UNIQUE AS nu, COLUMN_NAME AS c FROM information_schema.statistics WHERE table_schema = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
  );
  const fks = await q(
    `SELECT k.TABLE_NAME AS t, k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS c,
            k.REFERENCED_TABLE_NAME AS rt, k.REFERENCED_COLUMN_NAME AS rc,
            r.DELETE_RULE AS del, r.UPDATE_RULE AS upd
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
      WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
  );
  const checks = await q(
    "SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS name FROM information_schema.table_constraints WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'CHECK'",
  );
  const triggers = await q(
    "SELECT EVENT_OBJECT_TABLE AS t, TRIGGER_NAME AS name FROM information_schema.triggers WHERE TRIGGER_SCHEMA = DATABASE()",
  );

  const actual = {};
  for (const r of tablesRows)
    actual[r.t] = {
      engine: r.engine,
      columns: {},
      indexes: {},
      foreignKeys: {},
      checks: [],
      triggers: [],
    };
  for (const r of cols) {
    if (!actual[r.t]) continue;
    actual[r.t].columns[r.c] = {
      type: normalizeType(r.ty),
      nullable: r.n === "YES",
      default: normalizeDefault(r.d),
      autoIncrement: /auto_increment/i.test(r.x || ""),
      onUpdate: /on update/i.test(r.x || ""),
    };
  }
  for (const r of stats) {
    if (!actual[r.t]) continue;
    const idx = (actual[r.t].indexes[r.i] = actual[r.t].indexes[r.i] || {
      name: r.i,
      unique: Number(r.nu) === 0,
      columns: [],
    });
    idx.columns.push(r.c);
  }
  for (const r of fks) {
    if (!actual[r.t]) continue;
    const fk = (actual[r.t].foreignKeys[r.name] = actual[r.t].foreignKeys[
      r.name
    ] || {
      name: r.name,
      columns: [],
      refTable: r.rt,
      refColumns: [],
      onDelete: normalizeRule(r.del),
      onUpdate: normalizeRule(r.upd),
    });
    fk.columns.push(r.c);
    fk.refColumns.push(r.rc);
  }
  for (const r of checks) if (actual[r.t]) actual[r.t].checks.push(r.name);
  for (const r of triggers) if (actual[r.t]) actual[r.t].triggers.push(r.name);
  return actual;
}

/**
 * Compara la BD actual con el baseline, solo con lecturas a information_schema.
 * critical: diferencias que pueden romper la aplicación o perder integridad; impiden registrar el baseline.
 * review:   diferencias que no impiden operar pero deben revisarse (sobrantes, longitudes, defaults...).
 */
async function verifyBaseline(conn, baselineSql) {
  const spec = parseBaselineSpec(baselineSql);
  const actual = await readActualSchema(conn);
  const critical = [];
  const review = [];

  for (const [table, def] of Object.entries(spec)) {
    const real = actual[table];
    if (!real) {
      critical.push(`falta la tabla ${table}`);
      continue;
    }
    if (String(real.engine).toLowerCase() !== def.engine.toLowerCase())
      critical.push(
        `${table} usa el motor ${real.engine}, se esperaba ${def.engine}`,
      );

    // Columnas
    for (const [column, exp] of Object.entries(def.columns)) {
      const col = real.columns[column];
      const name = `${table}.${column}`;
      if (!col) {
        critical.push(`falta la columna ${name}`);
        continue;
      }
      if (col.type !== exp.type) {
        if (baseType(col.type) !== baseType(exp.type))
          critical.push(`${name} es ${col.type}, se esperaba ${exp.type}`);
        else
          review.push(
            `${name} es ${col.type} (el baseline declara ${exp.type})`,
          );
      }
      if (col.nullable !== exp.nullable) {
        if (!col.nullable && col.default === null && !col.autoIncrement)
          critical.push(
            `${name} es NOT NULL sin valor por defecto (el baseline la declara NULL): las inserciones que la omiten fallarían`,
          );
        else
          review.push(
            `${name} es ${col.nullable ? "NULL" : "NOT NULL"} (el baseline declara ${exp.nullable ? "NULL" : "NOT NULL"})`,
          );
      }
      if (exp.autoIncrement && !col.autoIncrement)
        critical.push(`${name} no es AUTO_INCREMENT`);
      if (!exp.autoIncrement && col.autoIncrement)
        review.push(`${name} es AUTO_INCREMENT (el baseline no lo declara)`);
      if (!exp.autoIncrement && col.default !== exp.default)
        review.push(
          `${name} tiene DEFAULT ${col.default === null ? "NULL" : `'${col.default}'`} (el baseline declara ${exp.default === null ? "NULL" : `'${exp.default}'`})`,
        );
      if (col.onUpdate)
        review.push(`${name} tiene ON UPDATE (el baseline no lo declara)`);
    }
    for (const [column, col] of Object.entries(real.columns)) {
      if (def.columns[column]) continue;
      if (!col.nullable && col.default === null && !col.autoIncrement)
        review.push(
          `columna sobrante ${table}.${column} NOT NULL sin valor por defecto (no se toca; las inserciones de la aplicación en ${table} fallarían)`,
        );
      else review.push(`columna sobrante ${table}.${column} (no se toca)`);
    }

    // Clave primaria e índices (se comparan por columnas; los nombres pueden variar entre instalaciones)
    const realIdx = Object.values(real.indexes);
    const pk = realIdx.find((i) => i.name === "PRIMARY");
    if (!pk) critical.push(`${table} no tiene clave primaria`);
    else if (!sameCols(pk.columns, def.primaryKey))
      critical.push(
        `clave primaria de ${table} es ${fmtCols(pk.columns)}, se esperaba ${fmtCols(def.primaryKey)}`,
      );
    for (const u of def.uniques) {
      if (!realIdx.some((i) => i.unique && sameCols(i.columns, u.columns)))
        critical.push(
          `falta el índice único sobre ${table}${fmtCols(u.columns)}`,
        );
    }
    for (const k of def.indexes) {
      const covered = realIdx.some((i) =>
        sameCols(i.columns.slice(0, k.columns.length), k.columns),
      );
      if (!covered)
        review.push(
          `falta el índice ${k.name} sobre ${table}${fmtCols(k.columns)}`,
        );
    }
    const realFks = Object.values(real.foreignKeys);
    const expectedIdx = [
      ...def.uniques.map((u) => ({ unique: true, columns: u.columns })),
      ...def.indexes.map((k) => ({ unique: false, columns: k.columns })),
    ];
    const seen = new Set();
    for (const i of realIdx) {
      if (i.name === "PRIMARY") continue;
      const key = `${i.unique}:${i.columns.join(",")}`;
      const expected = expectedIdx.some(
        (e) => e.unique === i.unique && sameCols(e.columns, i.columns),
      );
      // Índice que el motor crea para respaldar una clave foránea.
      const fkBacking =
        !i.unique &&
        [...def.foreignKeys, ...realFks].some((f) =>
          sameCols(f.columns, i.columns),
        );
      if ((expected || fkBacking) && !seen.has(key)) {
        seen.add(key);
        continue;
      }
      review.push(
        `índice ${i.unique ? "único " : ""}adicional ${i.name} sobre ${table}${fmtCols(i.columns)} (no se toca)`,
      );
    }

    // Claves foráneas
    for (const fk of def.foreignKeys) {
      const found = realFks.find((f) => sameCols(f.columns, fk.columns));
      const desc = `${table}${fmtCols(fk.columns)} → ${fk.refTable}${fmtCols(fk.refColumns)}`;
      if (!found) {
        critical.push(`falta la clave foránea ${desc}`);
      } else if (
        found.refTable !== fk.refTable ||
        !sameCols(found.refColumns, fk.refColumns)
      ) {
        critical.push(
          `la clave foránea de ${table}${fmtCols(fk.columns)} apunta a ${found.refTable}${fmtCols(found.refColumns)}, se esperaba ${fk.refTable}${fmtCols(fk.refColumns)}`,
        );
      } else if (
        found.onDelete !== fk.onDelete ||
        found.onUpdate !== fk.onUpdate
      ) {
        critical.push(
          `la clave foránea ${desc} tiene ON DELETE ${found.onDelete} / ON UPDATE ${found.onUpdate}, se esperaba ON DELETE ${fk.onDelete} / ON UPDATE ${fk.onUpdate}`,
        );
      }
    }
    for (const f of realFks) {
      if (!def.foreignKeys.some((fk) => sameCols(fk.columns, f.columns)))
        review.push(
          `clave foránea adicional ${f.name} en ${table}${fmtCols(f.columns)} → ${f.refTable} (no se toca)`,
        );
    }

    // Otras restricciones: el baseline no declara CHECK ni triggers.
    for (const c of real.checks)
      review.push(`restricción CHECK adicional ${c} en ${table} (no se toca)`);
    for (const t of real.triggers)
      review.push(`trigger adicional ${t} en ${table} (no se toca)`);
  }
  for (const table of Object.keys(actual)) {
    if (!spec[table] && !META_TABLES.includes(table))
      review.push(`tabla sobrante ${table} (no se toca)`);
  }
  return { critical, review };
}

// ---------------------------------------------------------------------------
// Estado y recuperación
// ---------------------------------------------------------------------------

async function tableExists(conn, name) {
  const [rows] = await conn.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
    [name],
  );
  return rows.length > 0;
}

/** true si el efecto de la sentencia ya está en la BD, false si no, null si es idempotente (no verificable). */
async function evaluateCheck(conn, check) {
  const one = async (sql, params) => (await conn.query(sql, params))[0];
  switch (check.kind) {
    case "idempotent":
      return null;
    case "table":
      return tableExists(conn, check.table);
    case "column":
      return (
        (
          await one(
            "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
            [check.table, check.column],
          )
        ).length > 0
      );
    case "columnType": {
      const [row] = await one(
        "SELECT COLUMN_TYPE AS ty, IS_NULLABLE AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
        [check.table, check.column],
      );
      return Boolean(
        row &&
        normalizeType(row.ty) === check.type &&
        (row.n === "YES") === check.nullable,
      );
    }
    case "index":
      return (
        (
          await one(
            "SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?",
            [check.table, check.index],
          )
        ).length > 0
      );
    case "query": {
      const rows = await one(check.sql);
      if (rows.length === 0) return false;
      const v = Object.values(rows[0])[0];
      return v !== null && v !== 0 && v !== "0" && v !== false;
    }
    default:
      throw new Error(`Verificación desconocida: ${check.kind}`);
  }
}

/**
 * Evalúa, sin modificar nada, qué sentencias de una migración ya tienen su efecto aplicado.
 * consistent=false: hay sentencias aplicadas después de una pendiente (no se explica por una interrupción).
 */
async function assessMigration(conn, migration, isTiDB) {
  const states = [];
  for (const st of migration.statements) {
    if (st.tidbOnly && !isTiDB) states.push("omitida");
    else {
      const r = await evaluateCheck(conn, st.check);
      states.push(r === null ? "idempotente" : r ? "aplicada" : "pendiente");
    }
  }
  const firstPending = states.indexOf("pendiente");
  const consistent =
    firstPending < 0 || !states.slice(firstPending + 1).includes("aplicada");
  return { states, consistent };
}

const describeStates = (states) =>
  states.map((s, i) => `sentencia ${i + 1}: ${s}`).join("; ");

const isTiDBConn = async (conn) => {
  const [[version]] = await conn.query("SELECT VERSION() AS v");
  return /tidb/i.test(version.v);
};

/** Estado sin modificar nada: qué está aplicado, qué falta, qué quedó interrumpido y cómo se ve la BD frente al baseline. */
async function getStatus(conn, dir = MIGRATIONS_DIR) {
  const migrations = loadMigrations(dir);
  const baseline = migrations.find((m) => m.id === BASELINE_ID);
  if (!baseline)
    throw new Error(`Falta la migración baseline (${BASELINE_ID}).`);
  const isTiDB = await isTiDBConn(conn);

  const applied = (await tableExists(conn, "schema_migrations"))
    ? (
        await conn.query(
          "SELECT id, name, checksum, baselined, applied_at FROM schema_migrations ORDER BY id",
        )
      )[0]
    : [];
  const runs = (await tableExists(conn, "schema_migration_runs"))
    ? (
        await conn.query(
          "SELECT id, name, checksum, total, done, status, error, updated_at FROM schema_migration_runs ORDER BY id",
        )
      )[0]
    : [];
  const appliedIds = new Set(applied.map((a) => a.id));
  let hasAppTables = false;
  for (const t of Object.keys(parseBaselineSpec(baseline.sql))) {
    if (await tableExists(conn, t)) hasAppTables = true;
  }
  // Si la 001 quedó interrumpida por este ejecutor, la BD no es "existente": se recupera como cualquier migración.
  const baselineInterrupted = runs.some((r) => r.id === BASELINE_ID);
  const needsBaselineCheck =
    !appliedIds.has(BASELINE_ID) && hasAppTables && !baselineInterrupted;
  const pending = migrations.filter((m) => !appliedIds.has(m.id));

  const interrupted = [];
  for (const run of runs) {
    const m = pending.find((x) => x.id === run.id);
    interrupted.push({
      ...run,
      fileChanged: Boolean(m && m.checksum !== run.checksum),
      assessment: m ? await assessMigration(conn, m, isTiDB) : null,
    });
  }

  return {
    isTiDB,
    migrations,
    applied,
    pending,
    interrupted,
    changed: applied.filter((a) => {
      const m = migrations.find((x) => x.id === a.id);
      return m && m.checksum !== a.checksum;
    }),
    unknown: applied.filter((a) => !migrations.some((m) => m.id === a.id)),
    needsBaselineCheck,
    baselineCheck: needsBaselineCheck
      ? await verifyBaseline(conn, baseline.sql)
      : null,
  };
}

async function ensureMetaTables(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(10) NOT NULL,
      name VARCHAR(150) NOT NULL,
      checksum CHAR(64) NOT NULL,
      baselined TINYINT(1) NOT NULL DEFAULT 0,
      applied_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB
  `);
  // Avance de la migración en curso; la fila se borra al registrarse la migración.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migration_runs (
      id VARCHAR(10) NOT NULL,
      name VARCHAR(150) NOT NULL,
      checksum CHAR(64) NOT NULL,
      total INT NOT NULL,
      done INT NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL,
      error TEXT,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB
  `);
}

/** Ejecuta una migración pendiente reanudando desde la primera sentencia cuyo efecto falta. */
async function applyMigration(conn, m, { isTiDB, previousRun, log }) {
  const { states, consistent } = await assessMigration(conn, m, isTiDB);
  const total = m.statements.length;
  if (!consistent) {
    const msg = `La migración ${m.name} está en un estado que no corresponde a una interrupción (${describeStates(states)}). No se ejecutó nada: requiere intervención manual. Deje el esquema con las sentencias aplicadas en orden (complete las faltantes o revierta las posteriores) y reinicie.`;
    if (previousRun) {
      await conn.query(
        "UPDATE schema_migration_runs SET status = 'FALLIDA', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [msg.slice(0, 2000), m.id],
      );
    }
    throw new Error(msg);
  }
  if (previousRun) {
    log(
      `[Migraciones] Recuperando ${m.name} (intento anterior ${previousRun.status}, ${previousRun.done}/${previousRun.total} sentencias${previousRun.checksum !== m.checksum ? ", archivo corregido desde entonces" : ""}): ${describeStates(states)}. Se omiten las ya aplicadas.`,
    );
  } else if (states.includes("aplicada")) {
    log(
      `[Migraciones] ${m.name}: el efecto de algunas sentencias ya está en el esquema (${describeStates(states)}); esas no se ejecutan.`,
    );
  }

  await conn.query(
    `REPLACE INTO schema_migration_runs (id, name, checksum, total, done, status, error)
     VALUES (?, ?, ?, ?, 0, 'EN_CURSO', NULL)`,
    [m.id, m.name, m.checksum, total],
  );
  const progress = (done) =>
    conn.query(
      "UPDATE schema_migration_runs SET done = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [done, m.id],
    );

  for (let i = 0; i < total; i++) {
    const st = m.statements[i];
    if (states[i] === "aplicada" || states[i] === "omitida") {
      await progress(i + 1);
      continue;
    }
    try {
      await conn.query(st.sql);
      if (
        st.check.kind !== "idempotent" &&
        !(await evaluateCheck(conn, st.check))
      ) {
        throw new Error(
          "la sentencia se ejecutó pero su verificación no se cumple (revise la sentencia o su @verifica)",
        );
      }
    } catch (err) {
      const msg = `La migración ${m.name} falló en la sentencia ${i + 1} de ${total}: ${err.message}. No se registró; ${i === 0 ? "no se aplicó ninguna sentencia" : `las sentencias 1 a ${i} quedaron aplicadas u omitidas`}. Al reiniciar se verificará el esquema y se continuará desde la sentencia ${i + 1} sin repetir las anteriores.`;
      await conn.query(
        "UPDATE schema_migration_runs SET status = 'FALLIDA', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [msg.slice(0, 2000), m.id],
      );
      throw new Error(msg);
    }
    await progress(i + 1);
  }

  // Registro y limpieza del avance en una sola transacción.
  await conn.beginTransaction();
  try {
    await conn.query(
      "INSERT INTO schema_migrations (id, name, checksum, baselined) VALUES (?, ?, ?, 0)",
      [m.id, m.name, m.checksum],
    );
    await conn.query("DELETE FROM schema_migration_runs WHERE id = ?", [m.id]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

/**
 * Aplica las migraciones pendientes. Lanza un Error si algo impide dejar el esquema en un estado conocido.
 * @returns {{ applied: string[], baselined: boolean, warnings: string[] }}
 */
async function runMigrations(
  pool,
  { dir = MIGRATIONS_DIR, log = console.log } = {},
) {
  const conn = await pool.getConnection();
  let locked = false;
  try {
    // Evita que dos instancias (p. ej. en Cloud Run) migren a la vez.
    const [[lock]] = await conn.query("SELECT GET_LOCK(?, ?) AS ok", [
      LOCK_NAME,
      LOCK_TIMEOUT_SECONDS,
    ]);
    if (Number(lock.ok) !== 1) {
      throw new Error(
        "No se pudo obtener el bloqueo de migraciones (otra instancia está migrando).",
      );
    }
    locked = true;

    const status = await getStatus(conn, dir);
    if (status.changed.length > 0) {
      throw new Error(
        `Migraciones ya aplicadas fueron modificadas: ${status.changed.map((c) => c.name).join(", ")}. Restaure el archivo original y cree una migración nueva.`,
      );
    }
    for (const u of status.unknown) {
      log(
        `[Migraciones] Aviso: la BD registra ${u.name}, que no existe en este código (¿versión anterior desplegada?).`,
      );
    }
    const baseline = status.migrations.find((m) => m.id === BASELINE_ID);
    if (status.needsBaselineCheck && status.baselineCheck.critical.length > 0) {
      const { critical, review } = status.baselineCheck;
      throw new Error(
        `La base de datos existente no coincide con el baseline y no se marcará como migrada.\n  Diferencias críticas:\n  - ${critical.join("\n  - ")}${review.length ? `\n  Requieren revisión:\n  - ${review.join("\n  - ")}` : ""}`,
      );
    }

    await ensureMetaTables(conn);

    const warnings = [];
    let baselined = false;
    let pending = status.pending;
    if (status.needsBaselineCheck) {
      const { review } = status.baselineCheck;
      warnings.push(...review);
      await conn.query(
        "INSERT INTO schema_migrations (id, name, checksum, baselined) VALUES (?, ?, ?, 1)",
        [baseline.id, baseline.name, baseline.checksum],
      );
      baselined = true;
      pending = pending.filter((m) => m.id !== BASELINE_ID);
      log(
        `[Migraciones] BD existente verificada: ${baseline.name} registrada como baseline (no se ejecutó).`,
      );
      for (const r of review) log(`[Migraciones] Requiere revisión: ${r}`);
    }

    const applied = [];
    for (const m of pending) {
      const previousRun = status.interrupted.find((r) => r.id === m.id);
      await applyMigration(conn, m, {
        isTiDB: status.isTiDB,
        previousRun,
        log,
      });
      applied.push(m.name);
      log(`[Migraciones] Aplicada ${m.name}.`);
      if (m.id === BASELINE_ID) {
        // Comprobación de cordura: lo recién creado debe coincidir con el baseline.
        const check = await verifyBaseline(conn, m.sql);
        if (check.critical.length > 0) {
          throw new Error(
            `El esquema creado por ${m.name} no coincide con lo declarado:\n  - ${check.critical.join("\n  - ")}`,
          );
        }
        for (const r of check.review)
          log(`[Migraciones] Requiere revisión: ${r}`);
      }
    }
    if (applied.length === 0 && !baselined) {
      log("[Migraciones] Esquema al día; no hay migraciones pendientes.");
    }
    return { applied, baselined, warnings };
  } finally {
    if (locked) await conn.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
    conn.release();
  }
}

module.exports = {
  runMigrations,
  getStatus,
  loadMigrations,
  splitStatements,
  parseBaselineSpec,
  verifyBaseline,
  assessMigration,
};

// Uso manual desde la terminal, con las mismas variables de entorno que la aplicación.
if (require.main === module) {
  const mode = process.argv[2];
  if (!["--status", "--run"].includes(mode)) {
    console.error("Uso: node src/db/migrate.js --status | --run");
    process.exit(2);
  }
  (async () => {
    const mysql = require("mysql2/promise");
    const { dbConfig } = require("../server");
    const pool = mysql.createPool(dbConfig);
    try {
      if (mode === "--run") {
        await runMigrations(pool);
      } else {
        const conn = await pool.getConnection();
        let s;
        try {
          s = await getStatus(conn);
        } finally {
          conn.release();
        }
        console.log(
          `Base de datos: ${dbConfig.database} en ${dbConfig.host || dbConfig.socketPath} (${s.isTiDB ? "TiDB" : "MySQL"})`,
        );
        for (const m of s.migrations) {
          const a = s.applied.find((x) => x.id === m.id);
          const run = s.interrupted.find((x) => x.id === m.id);
          console.log(
            `  ${a ? (a.baselined ? "baseline   " : "aplicada   ") : run ? "INTERRUMPIDA" : "PENDIENTE  "}  ${m.name}`,
          );
        }
        for (const c of s.changed) {
          console.log(`  MODIFICADA tras aplicarse: ${c.name}`);
          process.exitCode = 1;
        }
        for (const r of s.interrupted) {
          console.log(
            `Migración interrumpida ${r.name}: ${r.status}, ${r.done}/${r.total} sentencias (${r.updated_at}).`,
          );
          if (r.error) console.log(`  Error: ${r.error}`);
          if (r.assessment) {
            console.log(
              `  Estado real: ${describeStates(r.assessment.states)}`,
            );
            console.log(
              r.assessment.consistent
                ? "  Se puede continuar: al ejecutar se omitirán las sentencias ya aplicadas."
                : "  REQUIERE INTERVENCIÓN MANUAL: hay sentencias aplicadas después de una pendiente.",
            );
            if (!r.assessment.consistent) process.exitCode = 1;
          }
        }
        if (s.baselineCheck) {
          const { critical, review } = s.baselineCheck;
          console.log(
            critical.length
              ? "BD existente INCOMPATIBLE con el baseline (no se registrará):"
              : "BD existente compatible con el baseline (se registraría sin ejecutarlo).",
          );
          for (const c of critical) console.log(`  CRÍTICA: ${c}`);
          for (const r of review) console.log(`  revisar: ${r}`);
          if (critical.length) process.exitCode = 1;
        }
      }
    } catch (err) {
      console.error(`[Migraciones] ${err.message}`);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}

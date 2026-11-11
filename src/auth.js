/**
 * Módulo de Autenticación y Seguridad Criptográfica de Nexxo S.A.
 * Implementa cifrado con sal (scrypt) y tokens JWT HMAC-SHA256 nativos sin dependencias externas.
 */

const crypto = require("crypto");

const JWT_SECRET =
  process.env.JWT_SECRET ||
  (process.env.NODE_ENV === "production"
    ? "super_secret_jwt_key_here"
    : "dev-jwt-secret-nexxo-2026");
const TOKEN_EXPIRY_SECONDS = 8 * 60 * 60; // 8 horas (Jornada laboral completa)

/**
 * Genera un hash criptográfico con sal única de 16 bytes usando scrypt
 * @param {string} password
 * @returns {string} salt:derivedKeyHex
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derivedKey}`;
}

/**
 * Verifica una contraseña contra su hash almacenado en tiempo constante
 * @param {string} password
 * @param {string} storedHash
 * @returns {boolean}
 */
function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, key] = storedHash.split(":");
  const keyBuffer = Buffer.from(key, "hex");
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

/**
 * Emite un token JWT (HS256) firmado criptográficamente
 * @param {object} payload
 * @param {number} expiresIn
 * @returns {string} Token JWT
 */
function generateToken(payload, expiresIn = TOKEN_EXPIRY_SECONDS) {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString(
    "base64url",
  );
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

/**
 * Valida la firma y la fecha de expiración de un token JWT
 * @param {string} token
 * @returns {object|null} Payload decodificado si es válido, null en caso contrario
 */
function verifyToken(token) {
  try {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const expectedSig = crypto
      .createHmac("sha256", JWT_SECRET)
      .update(`${header}.${body}`)
      .digest("base64url");

    // Comparación segura en tiempo constante para evitar ataques de temporización
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);
    if (
      sigBuf.length !== expBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expBuf)
    ) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now > payload.exp) {
      return null; // Token expirado
    }

    return payload;
  } catch (err) {
    return null;
  }
}

let authPool = null;

const ADMIN_COOKIE = "nexxo_admin";
const CANDIDATE_COOKIE = "nexxo_cand";
const ADMIN_SESSION_SECONDS = TOKEN_EXPIRY_SECONDS;
const CANDIDATE_SESSION_SECONDS = 2 * 60 * 60;

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch (e) {
      out[name] = raw;
    }
  }
  return out;
}

function cookieAttrs(maxAge) {
  return (
    `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` +
    (process.env.NODE_ENV === "production" ? "; Secure" : "")
  );
}

function setCookie(res, name, value, maxAge) {
  res.append(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; ${cookieAttrs(maxAge)}`,
  );
}

function clearCookie(res, name) {
  res.append("Set-Cookie", `${name}=; ${cookieAttrs(0)}`);
}

function sha256hex(str) {
  return crypto.createHash("sha256").update(String(str)).digest("hex");
}

async function createAdminSession(adminId) {
  const token = crypto.randomBytes(32).toString("hex");
  await authPool.query(
    "INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 8 HOUR))",
    [sha256hex(token), adminId],
  );
  return token;
}

async function getAdminFromSessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const [rows] = await authPool.query(
    `SELECT a.id, a.username, a.full_name, a.role
     FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
    [sha256hex(token)],
  );
  if (rows.length === 0) return null;
  const a = rows[0];
  return {
    id: a.id,
    username: a.username,
    fullName: a.full_name,
    role: a.role,
  };
}

async function revokeAdminSession(token) {
  if (!token) return;
  await authPool.query(
    "UPDATE admin_sessions SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL",
    [sha256hex(token)],
  );
}

async function getAdminFromRequest(req) {
  const cookieToken = parseCookies(req)[ADMIN_COOKIE];
  if (!cookieToken) return null;
  return getAdminFromSessionToken(cookieToken);
}

/**
 * Middleware para proteger rutas de administración en Express
 */
async function requireAdminAuth(req, res, next) {
  const hasCredential = Boolean(parseCookies(req)[ADMIN_COOKIE]);

  if (!hasCredential) {
    return res.status(401).json({
      error: "Acceso no autorizado.",
      message:
        "Debe iniciar sesión con credenciales de RR.HH. para acceder a este recurso.",
    });
  }

  let user;
  try {
    user = await getAdminFromRequest(req);
  } catch (err) {
    console.error("[AUTH] Error validando sesión de administrador.");
    return res.status(500).json({ error: "Error interno de autenticación." });
  }

  if (!user) {
    return res.status(401).json({
      error: "Sesión expirada o token no válido.",
      message:
        "Su sesión ha caducado. Inicie sesión nuevamente en /admin/login.",
    });
  }

  req.adminUser = user;
  next();
}

function requireSameOrigin(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const blocked = () =>
    res.status(403).json({ error: "Solicitud de origen cruzado bloqueada." });
  const site = req.get("sec-fetch-site");
  if (site) {
    if (site !== "same-origin" && site !== "none") return blocked();
    return next();
  }
  const origin = req.get("origin");
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch (e) {
      return blocked();
    }
    if (host !== req.get("host")) return blocked();
  }
  next();
}

function createCandidateSession(res, candidateId) {
  const token = generateToken(
    { cid: Number(candidateId), typ: "cand" },
    CANDIDATE_SESSION_SECONDS,
  );
  setCookie(res, CANDIDATE_COOKIE, token, CANDIDATE_SESSION_SECONDS);
}

function getCandidateIdFromRequest(req) {
  const payload = verifyToken(parseCookies(req)[CANDIDATE_COOKIE]);
  if (payload && payload.typ === "cand") return Number(payload.cid);
  return null;
}

/**
 * Inicializa la tabla admin_users y asegura el usuario por defecto admin / papa123
 */
async function initAdminAuth(pool) {
  authPool = pool;
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(150) NOT NULL,
        role VARCHAR(30) DEFAULT 'RRHH',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash CHAR(64) PRIMARY KEY,
        admin_id INT NOT NULL,
        expires_at DATETIME NOT NULL,
        revoked_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_admin_sessions_admin (admin_id)
      ) ENGINE=InnoDB;
    `);

    // Comprobar si existe el usuario 'admin'
    const [rows] = await conn.query(
      "SELECT id FROM admin_users WHERE username = ?",
      ["admin"],
    );
    if (rows.length === 0) {
      const defaultPassword = process.env.ADMIN_DEFAULT_PASSWORD || "papa123";
      const defaultHash = hashPassword(defaultPassword);
      await conn.query(
        `
        INSERT INTO admin_users (username, password_hash, full_name, role)
        VALUES (?, ?, ?, ?)
      `,
        ["admin", defaultHash, "Administrador RR.HH. Nexxo", "SUPERADMIN"],
      );
      console.log(
        '[AUTH] Usuario inicial "admin" creado exitosamente con clave configurada.',
      );
    }
  } finally {
    conn.release();
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  requireAdminAuth,
  initAdminAuth,
  ADMIN_COOKIE,
  CANDIDATE_COOKIE,
  ADMIN_SESSION_SECONDS,
  CANDIDATE_SESSION_SECONDS,
  parseCookies,
  setCookie,
  clearCookie,
  sha256hex,
  createAdminSession,
  getAdminFromSessionToken,
  revokeAdminSession,
  getAdminFromRequest,
  requireSameOrigin,
  createCandidateSession,
  getCandidateIdFromRequest,
};
